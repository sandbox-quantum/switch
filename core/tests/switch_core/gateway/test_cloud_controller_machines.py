"""Switch cloud machines that run the agents controller, end to end against Postgres.

The hosted controller prepares a cloud machine; Core hands it a
one-time enrollment code (the same one on every retry of a revision); the
controller enrolls with it and becomes the machine's, as a Switch cloud
controller; its status reports make the machine ready; and the managed agents
placed on it are the machine's agents.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    AgentController,
    HostedMachine,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineStore,
    bump_revision,
    lock_claims,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.cloud_controllers import (
    set_cloud_enrollment,
    wake_controller_machine,
)
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import router as controller_router
from switch_core.gateway.hosted_machines import router as machines_router
from switch_core.management.placement import placement_refusal
from switch_core.management.process_lease import ProcessLeases
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.management.harness import (
    TEST_KEYRING,
    Harness,
    add_member,
    bearer,
    build_harness,
    cookies_for,
    create_managed_agent,
    platform,
    report_status,
)

TOKEN = "SYNTHETIC-CLOUD-CONTROLLER-CREDENTIAL-0123456789"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
API_ENDPOINT = "https://switch.example.test/api/agent"
FIXTURES = Path(__file__).parent.parent / "fixtures" / "hosted_machines"


@pytest.fixture(autouse=True)
def _no_enrollment_left_installed() -> Iterator[None]:
    """Building management installs it process-wide; take it away again."""
    set_cloud_enrollment(None)
    yield
    set_cloud_enrollment(None)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _hosted_app(
    session_factory: async_sessionmaker[AsyncSession], owner: User
) -> httpx.AsyncClient:
    app = FastAPI()
    app.state.hosted_controller_settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=TOKEN,
        machine_slots=["slot-a"],
        agent_api_endpoint=API_ENDPOINT,
    )
    app.include_router(controller_router)
    app.include_router(machines_router)
    config = SimpleNamespace(
        keyring=TEST_KEYRING,
        hosted_idle_stop_minutes=30,
        hosted_disk_retention_days=7,
        hosted_launch_capacity=1,
    )

    async def session():
        async with session_factory() as opened:
            yield opened

    async def current_user():
        return owner

    app.dependency_overrides[get_session] = session
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_current_user] = current_user
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.test"
    )


async def _claim(
    session_factory: async_sessionmaker[AsyncSession], owner: User
) -> HostedMachine:
    async with session_factory() as session:
        await lock_claims(session)
        machine = await HostedMachineStore().claim(
            session,
            owner_id=owner.id,
            slots=["slot-a"],
            capacity=1,
            now=datetime.now(UTC),
        )
        await session.commit()
        return machine


async def _machine(
    session_factory: async_sessionmaker[AsyncSession], machine_id: str
) -> HostedMachine:
    async with session_factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        return machine


async def _update(
    session_factory: async_sessionmaker[AsyncSession], machine_id: str, **values
) -> None:
    async with session_factory() as session:
        machine = await HostedMachineStore().locked(session, machine_id)
        assert machine is not None
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()


async def _new_revision(
    session_factory: async_sessionmaker[AsyncSession], machine_id: str
) -> None:
    async with session_factory() as session:
        machine = await HostedMachineStore().locked(session, machine_id)
        assert machine is not None
        bump_revision(machine, datetime.now(UTC))
        await session.commit()


async def _prepare(hosted: httpx.AsyncClient, machine_id: str) -> dict:
    response = await hosted.post(
        f"/hosted-controller/machines/{machine_id}/prepare", headers=HEADERS
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


async def _enroll(client: httpx.AsyncClient, code: str) -> dict:
    response = await client.post(
        "/v1/management/controllers/enroll",
        json={
            "proof": {"kind": "enrollment_code", "code": code},
            "controller": {
                "kind": "daemon",
                "name": "ip-10-0-0-1",
                "platform": platform(),
                "version": "0.1.1",
            },
        },
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


async def _connected(
    client: httpx.AsyncClient, harness: Harness, owner: User, enrolled: dict
) -> SimpleNamespace:
    """The enrolled controller, with a token, connected and reporting as a running one."""
    token = await client.post(
        f"/v1/management/controllers/{enrolled['controller_id']}/token",
        json={"credential": enrolled["credential"]},
    )
    assert token.status_code == 200, token.text
    controller = SimpleNamespace(
        controller_id=enrolled["controller_id"],
        credential=enrolled["credential"],
        access_token=token.json()["access_token"],
        owner=owner,
        harness=harness,
        headers=bearer(token.json()["access_token"]),
    )
    await report_status(client, controller, 1)  # type: ignore[arg-type]
    return controller


class TestControllerMachines:
    async def test_a_machine_enrolls_its_controller_with_a_code_core_hands_over(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        machine = await _claim(harness.session_factory, owner)
        async with _hosted_app(harness.session_factory, owner) as hosted:
            first = await _prepare(hosted, machine.id)
            retried = await _prepare(hosted, machine.id)
            assert first["bundle_revision"] == first["revision"]
            assert first["api_endpoint"] == API_ENDPOINT
            code = first["controller"]["enrollment_code"]
            assert code.startswith("swce_")
            assert first["controller"]["id"] is None
            # A retry of the same revision hands over the same code.
            assert retried["controller"] == first["controller"]
            assert "machine_capability" not in first
            # The shape the hosted controller is tested against.
            fixture = json.loads(
                (FIXTURES / "prepare_controller_response.json").read_text()
            )
            assert set(first) == set(fixture)
            assert set(first["controller"]) == set(fixture["controller"])

            async with harness.client() as client:
                enrolled = await _enroll(client, code)
                again = await client.post(
                    "/v1/management/controllers/enroll",
                    json={
                        "proof": {"kind": "enrollment_code", "code": code},
                        "controller": {
                            "kind": "daemon",
                            "name": "x",
                            "platform": platform(),
                            "version": "0.1.1",
                        },
                    },
                )
            assert again.status_code == 401, again.text
            async with harness.session_factory() as session:
                controller = await session.get(
                    AgentController, enrolled["controller_id"]
                )
                assert controller is not None
                assert controller.kind == "ec2"
                assert controller.name == "Switch cloud"
            assert (
                await _machine(harness.session_factory, machine.id)
            ).controller_id == (enrolled["controller_id"])

            await _new_revision(harness.session_factory, machine.id)
            enrolled_since = await _prepare(hosted, machine.id)
            assert enrolled_since["controller"] == {
                "id": enrolled["controller_id"],
                "enrollment_code": None,
            }

    async def test_its_status_reports_make_it_ready_and_its_agents_are_the_machines(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        machine = await _claim(harness.session_factory, owner)
        async with _hosted_app(harness.session_factory, owner) as hosted:
            code = (await _prepare(hosted, machine.id))["controller"]["enrollment_code"]
            async with harness.client() as client:
                enrolled = await _enroll(client, code)
                token = await client.post(
                    f"/v1/management/controllers/{enrolled['controller_id']}/token",
                    json={"credential": enrolled["credential"]},
                )
                assert token.status_code == 200, token.text
                controller = SimpleNamespace(
                    controller_id=enrolled["controller_id"],
                    credential=enrolled["credential"],
                    access_token=token.json()["access_token"],
                    owner=owner,
                    harness=harness,
                    headers=bearer(token.json()["access_token"]),
                )
                # Not ready before the machine was seen running at this revision.
                await report_status(client, controller, 1)  # type: ignore[arg-type]
                assert (await _machine(harness.session_factory, machine.id)).state == (
                    "provisioning"
                )
                await _update(
                    harness.session_factory,
                    machine.id,
                    running_observed_at=datetime.now(UTC),
                )
                await report_status(client, controller, 2)  # type: ignore[arg-type]
                ready = await _machine(harness.session_factory, machine.id)
                assert ready.state == "ready"
                assert ready.heartbeat is not None
                assert ready.heartbeat["disk"]["total_bytes"] > 0

                created = await create_managed_agent(
                    client,
                    owner,
                    name="reviewer",
                    controller_id=enrolled["controller_id"],
                )
                assert created.status_code == 201, created.text
            summary = await hosted.get(f"/hosted-machines/{machine.id}")
            assert summary.status_code == 200, summary.text
            assert summary.json()["controller_id"] == enrolled["controller_id"]
            assert summary.json()["agents"] == [created.json()["agent_id"]]

    async def test_a_revoked_controller_is_replaced_by_enrolling_again(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        machine = await _claim(harness.session_factory, owner)
        async with _hosted_app(harness.session_factory, owner) as hosted:
            code = (await _prepare(hosted, machine.id))["controller"]["enrollment_code"]
            async with harness.client() as client:
                first = await _enroll(client, code)
                revoked = await client.delete(
                    f"/gateway/management/controllers/{first['controller_id']}",
                    cookies=cookies_for(owner),
                )
                assert revoked.status_code == 200, revoked.text
                await _new_revision(harness.session_factory, machine.id)
                prepared = await _prepare(hosted, machine.id)
                assert prepared["controller"]["id"] is None
                second_code = prepared["controller"]["enrollment_code"]
                assert second_code not in {None, code}
                second = await _enroll(client, second_code)
            assert (
                await _machine(harness.session_factory, machine.id)
            ).controller_id == (second["controller_id"])

    async def test_an_agentless_machine_is_retained_only_once_its_agents_are_gone(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        machine = await _claim(harness.session_factory, owner)
        async with _hosted_app(harness.session_factory, owner) as hosted:
            code = (await _prepare(hosted, machine.id))["controller"]["enrollment_code"]
            async with harness.client() as client:
                enrolled = await _enroll(client, code)
                await _connected(client, harness, owner, enrolled)
                created = await create_managed_agent(
                    client,
                    owner,
                    name="reviewer",
                    controller_id=enrolled["controller_id"],
                    desired_state="stopped",
                )
                assert created.status_code == 201, created.text
        store = HostedMachineStore()
        async with harness.session_factory() as session:
            locked = await store.locked(session, machine.id)
            assert locked is not None
            assert await store.has_agents(session, locked)
            assert not await store.retain_if_empty(
                session, locked, retention_days=7, now=datetime.now(UTC)
            )
            assert await store.ever_hosted(session, locked)
            await session.commit()
        async with harness.client() as client:
            deleted = await client.delete(
                f"/gateway/management/agents/{created.json()['agent_id']}",
                cookies=cookies_for(owner),
            )
            assert deleted.status_code == 200, deleted.text
        async with harness.session_factory() as session:
            locked = await store.locked(session, machine.id)
            assert locked is not None
            assert not await store.has_agents(session, locked)
            now = datetime.now(UTC)
            assert await store.retain_if_empty(
                session, locked, retention_days=7, now=now
            )
            assert (locked.desired_state, locked.retain_until) == (
                "retained",
                now + timedelta(days=7),
            )

    @pytest.mark.parametrize(
        ("heartbeat_age", "sessions", "sleeps"),
        [
            (timedelta(minutes=1), 0, True),
            (timedelta(minutes=1), 2, False),
            # A machine that stopped reporting is not known to be idle.
            (timedelta(hours=1), 0, False),
        ],
    )
    async def test_a_controller_machine_sleeps_once_its_reports_say_it_is_idle(
        self, harness: Harness, heartbeat_age, sessions, sleeps
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        machine = await _claim(harness.session_factory, owner)
        now = datetime.now(UTC)
        await _update(
            harness.session_factory,
            machine.id,
            state="ready",
            active_at=now - timedelta(hours=2),
            heartbeat={"disk": None, "memory": None, "sessions_running": sessions},
            heartbeat_at=now - heartbeat_age,
        )
        async with _hosted_app(harness.session_factory, owner) as hosted:
            listed = await hosted.get("/hosted-controller/machines", headers=HEADERS)
        assert listed.status_code == 200, listed.text
        after = await _machine(harness.session_factory, machine.id)
        if sleeps:
            # With no agent on it, an idle machine is released rather than stopped.
            assert after.desired_state == "retained"
        else:
            assert after.desired_state == "running"

    async def test_an_idle_machine_with_agents_is_put_to_sleep(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        machine = await _claim(harness.session_factory, owner)
        async with _hosted_app(harness.session_factory, owner) as hosted:
            code = (await _prepare(hosted, machine.id))["controller"]["enrollment_code"]
            async with harness.client() as client:
                enrolled = await _enroll(client, code)
                await _connected(client, harness, owner, enrolled)
                created = await create_managed_agent(
                    client,
                    owner,
                    name="reviewer",
                    controller_id=enrolled["controller_id"],
                )
                assert created.status_code == 201, created.text
            now = datetime.now(UTC)
            await _update(
                harness.session_factory,
                machine.id,
                state="ready",
                active_at=now - timedelta(hours=2),
                heartbeat={"disk": None, "memory": None, "sessions_running": 0},
                heartbeat_at=now,
            )
            listed = await hosted.get("/hosted-controller/machines", headers=HEADERS)
        assert listed.status_code == 200, listed.text
        after = await _machine(harness.session_factory, machine.id)
        assert (after.desired_state, after.stop_reason) == ("stopped", "idle")

    async def test_a_message_or_a_placement_wakes_a_sleeping_machine(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        machine = await _claim(harness.session_factory, owner)
        async with _hosted_app(harness.session_factory, owner) as hosted:
            code = (await _prepare(hosted, machine.id))["controller"]["enrollment_code"]
            async with harness.client() as client:
                enrolled = await _enroll(client, code)
        await _update(
            harness.session_factory,
            machine.id,
            state="stopped",
            desired_state="stopped",
            stop_reason="idle",
        )
        before = await _machine(harness.session_factory, machine.id)
        async with harness.session_factory() as session:
            woken = await wake_controller_machine(
                session, enrolled["controller_id"], datetime.now(UTC)
            )
            await session.commit()
        assert woken is not None
        after = await _machine(harness.session_factory, machine.id)
        assert (after.desired_state, after.stop_reason) == ("running", None)
        assert after.revision == before.revision + 1

        await _update(
            harness.session_factory,
            machine.id,
            desired_state="stopped",
            stop_reason="owner",
        )
        async with harness.session_factory() as session:
            await wake_controller_machine(
                session, enrolled["controller_id"], datetime.now(UTC)
            )
            await session.commit()
        # A machine its owner stopped stays stopped.
        assert (await _machine(harness.session_factory, machine.id)).desired_state == (
            "stopped"
        )


async def test_a_controller_machine_needs_agent_management(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    owner = await add_member(session_factory, "ada")
    machine = await _claim(session_factory, owner)
    async with _hosted_app(session_factory, owner) as hosted:
        response = await hosted.post(
            f"/hosted-controller/machines/{machine.id}/prepare", headers=HEADERS
        )
    assert response.status_code == 409, response.text
    assert "AGENT_MANAGEMENT_ENABLED" in response.json()["detail"]


def test_a_waking_machine_is_judged_by_its_last_report() -> None:
    now = datetime.now(UTC)
    controller = AgentController(
        owner_id="owner",
        name="Switch cloud",
        kind="ec2",
        api_key_id="key",
        connected_at=now - timedelta(hours=3),
        disconnected_at=now - timedelta(hours=2),
        last_seen_at=now - timedelta(hours=2),
        status={"providers": [{"provider": "claude", "installed": True, "auth": "ok"}]},
    )
    leases = ProcessLeases(read_at=now, leases={})
    asleep = placement_refusal(
        controller, "claude", leases=leases, now=now, interval_seconds=60, waking=False
    )
    waking = placement_refusal(
        controller, "claude", leases=leases, now=now, interval_seconds=60, waking=True
    )
    not_installed = placement_refusal(
        controller, "codex", leases=leases, now=now, interval_seconds=60, waking=True
    )
    assert asleep is not None and asleep[0] == "controller_offline"
    assert waking is None
    assert not_installed is not None and not_installed[0] == "provider_not_installed"

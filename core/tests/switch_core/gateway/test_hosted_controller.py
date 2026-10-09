"""The hosted-controller routes: listing and sweeping cloud machines, preparing
one to boot (the controller it enrolled as, or a one-time code to enroll with),
and recording what the operator controller observed of it."""

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    AgentController,
    HostedMachine,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import HostedMachineStore, lock_claims
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.cloud_controllers import (
    record_controller_status,
    set_cloud_enrollment,
)
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import router
from switch_core.gateway.hosted_machines import router as machines_router
from switch_core.keys import Keyring
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.hosted_machine_helpers import (
    link_controller,
    place_managed_agent,
    seed_machine,
)

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

TOKEN = "SYNTHETIC-CONTROLLER-CREDENTIAL-FOR-TESTS"
HEADERS = {"Authorization": "Bearer " + TOKEN}
FIXTURES = Path(__file__).parent.parent / "fixtures" / "hosted_machines"
MACHINE_ITEM_KEYS = {
    "machine_id",
    "state",
    "desired_state",
    "revision",
    "data_volume_id",
    "retain_until",
    "bundle_revision",
}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


class FakeEnrollment:
    """Agent management's side of enrollment: mints a fresh code per call."""

    def __init__(self) -> None:
        self.minted: list[tuple[str, int]] = []

    async def machine_enrollment_code(
        self, session: AsyncSession, machine: HostedMachine, now: datetime
    ) -> str:
        self.minted.append((machine.id, machine.revision))
        return f"swce_synthetic-{len(self.minted)}"


@dataclass
class ControllerApp:
    client: httpx.AsyncClient
    factory: async_sessionmaker[AsyncSession]
    machine_id: str
    owner_id: str
    config: SimpleNamespace
    settings: HostedControllerSettings
    enrollment: FakeEnrollment


@pytest.fixture
async def controller_app(session_factory):
    """A member's queued cloud machine, behind the hosted-controller and the
    owner's hosted-machines routes."""
    async with session_factory() as session:
        owner = User(
            name="owner", email="owner@example.com", role="user", password_hash="x"
        )
        session.add(owner)
        await session.flush()
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner.id, role="member")
        )
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            state="queued",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        await session.commit()
    settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=TOKEN,
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    config = SimpleNamespace(
        keyring=TEST_KEYRING,
        hosted_idle_stop_minutes=0,
        hosted_disk_retention_days=7,
        hosted_launch_capacity=2,
        hosted_agents_enabled=True,
    )
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.include_router(router)
    app.include_router(machines_router)

    async def session():
        async with session_factory() as opened:
            yield opened

    async def current_user():
        return owner

    app.dependency_overrides[get_session] = session
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_current_user] = current_user
    enrollment = FakeEnrollment()
    set_cloud_enrollment(enrollment)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://switch.example.com",
        ) as client:
            yield ControllerApp(
                client=client,
                factory=session_factory,
                machine_id=machine.id,
                owner_id=owner.id,
                config=config,
                settings=settings,
                enrollment=enrollment,
            )
    finally:
        set_cloud_enrollment(None)


async def machine_of(factory, machine_id: str) -> HostedMachine:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        return machine


async def update_machine(factory, machine_id: str, **values) -> None:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()


async def enrolled(app: ControllerApp, *, agents: int) -> tuple[str, list[str]]:
    """Link the machine to the controller it enrolled as, with `agents`
    managed agents placed on it; the controller and agent ids."""
    async with app.factory() as session:
        machine = await session.get(
            HostedMachine, (require_tenant_id(), app.machine_id)
        )
        assert machine is not None
        controller = await link_controller(session, machine)
        placed = [
            await place_managed_agent(
                session,
                owner_id=app.owner_id,
                controller_id=controller.id,
                name=f"agent-{index}",
            )
            for index in range(agents)
        ]
        await session.commit()
        return controller.id, [definition.agent_id for definition in placed]


async def report_status(app: ControllerApp, controller_id: str, **reading) -> None:
    """A status report from the machine's controller."""
    async with app.factory() as session:
        await record_controller_status(session, controller_id, reading)
        await session.commit()


async def list_machines(client) -> list[dict]:
    response = await client.get("/hosted-controller/machines", headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()["machines"]


async def listed(client, machine_id: str) -> dict:
    return {item["machine_id"]: item for item in await list_machines(client)}[
        machine_id
    ]


async def observe(client, machine_id: str, **body) -> dict:
    response = await client.post(
        f"/hosted-controller/machines/{machine_id}/observation",
        headers=HEADERS,
        json=body,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def prepare(client, machine_id: str) -> httpx.Response:
    return await client.post(
        f"/hosted-controller/machines/{machine_id}/prepare", headers=HEADERS, json={}
    )


async def test_controller_requires_its_own_credential(controller_app):
    app = controller_app
    for method, path, body in (
        ("GET", "/hosted-controller/machines", None),
        ("POST", f"/hosted-controller/machines/{app.machine_id}/prepare", {}),
        (
            "POST",
            f"/hosted-controller/machines/{app.machine_id}/observation",
            {"state": "running", "revision": 1},
        ),
    ):
        for token in (None, "Bearer wrong"):
            response = await app.client.request(
                method,
                path,
                headers={} if token is None else {"Authorization": token},
                json=body,
            )
            assert response.status_code == 401
    saved = await machine_of(app.factory, app.machine_id)
    assert (saved.state, saved.enrollment_code_revision) == ("queued", None)
    assert app.enrollment.minted == []


async def test_routes_are_unavailable_without_controller_settings(controller_app):
    app = controller_app
    app.client._transport.app.state.hosted_controller_settings = None
    response = await app.client.get("/hosted-controller/machines", headers=HEADERS)
    assert response.status_code == 503
    assert response.json() == {
        "detail": "Switch cloud machines are not enabled on this server."
    }


async def test_machines_lists_every_live_machine_with_the_contract_keys(
    controller_app,
):
    app = controller_app
    async with app.factory() as session:
        gone = await seed_machine(
            session,
            owner_id=app.owner_id,
            state="deleted",
            desired_state="deleted",
            stop_reason=None,
            revision=3,
        )
        await session.commit()
    items = await list_machines(app.client)
    assert [item["machine_id"] for item in items] == [app.machine_id]
    assert gone.id not in {item["machine_id"] for item in items}
    assert set(items[0]) == MACHINE_ITEM_KEYS
    [contract] = fixture("machines_response.json")["machines"]
    assert set(contract) == MACHINE_ITEM_KEYS
    assert items[0] == {
        "machine_id": app.machine_id,
        "state": "queued",
        "desired_state": "running",
        "revision": 1,
        "data_volume_id": None,
        "retain_until": None,
        "bundle_revision": None,
    }


async def test_queued_machine_times_out_with_an_actionable_error(controller_app):
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        updated_at=datetime.now(UTC) - timedelta(minutes=11),
    )
    [item] = await list_machines(app.client)
    assert item["state"] == "error"
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.error_code == "machine_connect_timeout"
    assert "10 minutes" in saved.error
    assert "Retry" in saved.error


async def test_recent_queued_machine_is_left_alone(controller_app):
    [item] = await list_machines(controller_app.client)
    assert item["state"] == "queued"


async def test_running_machine_that_never_connects_times_out(controller_app):
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        state="provisioning",
        running_observed_at=datetime.now(UTC) - timedelta(minutes=11),
    )
    [item] = await list_machines(app.client)
    assert item["state"] == "error"
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.error_code == "machine_connect_timeout"
    assert "did not connect to Switch within 10 minutes" in saved.error


async def test_a_status_report_since_the_running_observation_stops_the_timeout(
    controller_app,
):
    app = controller_app
    observed = datetime.now(UTC) - timedelta(minutes=11)
    await update_machine(
        app.factory,
        app.machine_id,
        state="provisioning",
        running_observed_at=observed,
        heartbeat_at=observed + timedelta(minutes=1),
    )
    [item] = await list_machines(app.client)
    assert item["state"] == "provisioning"


async def test_connect_timeout_counts_from_the_running_observation(controller_app):
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        state="provisioning",
        updated_at=datetime.now(UTC) - timedelta(minutes=30),
        running_observed_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    [item] = await list_machines(app.client)
    assert item["state"] == "provisioning"


async def test_provisioning_machine_never_observed_running_times_out(controller_app):
    app = controller_app
    before = datetime.now(UTC)
    await update_machine(
        app.factory,
        app.machine_id,
        state="provisioning",
        updated_at=before - timedelta(minutes=11),
    )
    [item] = await list_machines(app.client)
    assert item["state"] == "error"
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.error_code == "machine_connect_timeout"
    assert (
        saved.error
        == "The cloud machine did not start within 10 minutes. Retry it in Switch Console, or contact your administrator if it still cannot start."
    )
    assert saved.updated_at >= before


async def test_recent_provisioning_machine_is_left_alone(controller_app):
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        state="provisioning",
        updated_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    [item] = await list_machines(app.client)
    assert item["state"] == "provisioning"


async def test_retention_sweep_deletes_an_expired_retained_machine(controller_app):
    app = controller_app
    expired = datetime.now(UTC) - timedelta(seconds=1)
    await update_machine(
        app.factory,
        app.machine_id,
        state="retained",
        desired_state="retained",
        retain_until=expired,
        revision=3,
    )
    [item] = await list_machines(app.client)
    assert item["desired_state"] == "deleted"
    assert item["revision"] == 4
    assert item["retain_until"] == expired.isoformat()


async def test_retention_sweep_keeps_a_machine_inside_its_window(controller_app):
    app = controller_app
    until = datetime.now(UTC) + timedelta(days=3)
    await update_machine(
        app.factory,
        app.machine_id,
        state="retained",
        desired_state="retained",
        retain_until=until,
        revision=3,
    )
    [item] = await list_machines(app.client)
    assert item["desired_state"] == "retained"
    assert item["revision"] == 3
    assert item["retain_until"] == until.isoformat()


async def test_prepare_hands_over_one_enrollment_code_per_revision(controller_app):
    app = controller_app
    first = await prepare(app.client, app.machine_id)
    again = await prepare(app.client, app.machine_id)
    assert first.status_code == again.status_code == 200, first.text
    assert first.headers["cache-control"] == "no-store"
    assert first.json() == again.json()
    body = first.json()
    contract = fixture("prepare_controller_response.json")
    assert set(body) == set(contract)
    assert set(body["controller"]) == set(contract["controller"])
    assert body["machine_id"] == app.machine_id
    assert body["revision"] == body["bundle_revision"] == 1
    assert body["api_endpoint"] == app.settings.agent_api_endpoint
    assert body["controller"] == {"id": None, "enrollment_code": "swce_synthetic-1"}
    assert app.enrollment.minted == [(app.machine_id, 1)]
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.state == "provisioning"
    assert saved.enrollment_code_revision == 1
    assert "swce_synthetic-1" not in (saved.enrollment_code_encrypted or "")
    [item] = await list_machines(app.client)
    assert item["bundle_revision"] == 1
    assert "swce_" not in json.dumps(item)

    await update_machine(app.factory, app.machine_id, revision=2)
    rotated = (await prepare(app.client, app.machine_id)).json()
    assert rotated["revision"] == rotated["bundle_revision"] == 2
    assert rotated["controller"] == {"id": None, "enrollment_code": "swce_synthetic-2"}
    assert app.enrollment.minted == [(app.machine_id, 1), (app.machine_id, 2)]
    assert (await machine_of(app.factory, app.machine_id)).enrollment_code_revision == 2


async def test_prepare_names_the_controller_the_machine_enrolled_as(controller_app):
    app = controller_app
    controller_id, _ = await enrolled(app, agents=0)
    response = await prepare(app.client, app.machine_id)
    assert response.status_code == 200, response.text
    assert response.json()["controller"] == {
        "id": controller_id,
        "enrollment_code": None,
    }
    assert app.enrollment.minted == []


async def test_prepare_mints_a_code_again_once_the_controller_is_revoked(
    controller_app,
):
    app = controller_app
    controller_id, _ = await enrolled(app, agents=0)
    async with app.factory() as session:
        controller = await session.get(AgentController, controller_id)
        controller.revoked_at = datetime.now(UTC)
        await session.commit()
    response = await prepare(app.client, app.machine_id)
    assert response.status_code == 200, response.text
    assert response.json()["controller"] == {
        "id": None,
        "enrollment_code": "swce_synthetic-1",
    }


async def test_prepare_leaves_a_machine_past_queued_in_its_state(controller_app):
    app = controller_app
    await update_machine(app.factory, app.machine_id, state="stopped")
    assert (await prepare(app.client, app.machine_id)).status_code == 200
    assert (await machine_of(app.factory, app.machine_id)).state == "stopped"


async def test_prepare_refuses_unknown_and_deleted_machines(controller_app):
    app = controller_app
    missing = await prepare(app.client, str(uuid4()))
    assert missing.status_code == 404
    for values in (
        {"desired_state": "deleted"},
        {"state": "deleted", "desired_state": "deleted"},
    ):
        await update_machine(app.factory, app.machine_id, **values)
        deleted = await prepare(app.client, app.machine_id)
        assert deleted.status_code == 409
        assert deleted.json() == {"detail": "machine is deleted"}
    assert (
        await machine_of(app.factory, app.machine_id)
    ).enrollment_code_revision is None
    assert app.enrollment.minted == []


async def test_prepare_for_a_departed_owner_errors_the_machine(controller_app):
    app = controller_app
    async with app.factory() as session:
        await session.delete(
            await session.get(TenantMember, (require_tenant_id(), app.owner_id))
        )
        await session.commit()
    response = await prepare(app.client, app.machine_id)
    assert response.status_code == 409
    assert "enrollment_code" not in response.text
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.state == "error"
    assert "workspace member" in saved.error
    assert saved.enrollment_code_revision is None
    assert app.enrollment.minted == []


async def test_controller_observation_fixture_is_accepted(controller_app):
    app = controller_app
    body = fixture("controller_observation.json")
    await update_machine(
        app.factory, app.machine_id, state="provisioning", revision=body["revision"]
    )
    item = await observe(app.client, app.machine_id, **body)
    assert set(item) == MACHINE_ITEM_KEYS
    assert item["state"] == "provisioning"
    assert item["data_volume_id"] == body["data_volume_id"]
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.instance_id == body["instance_id"]
    assert saved.instance_type == body["instance_type"]
    assert saved.running_observed_at is not None


async def test_observation_rejects_unknown_fields_and_codes(controller_app):
    app = controller_app
    path = f"/hosted-controller/machines/{app.machine_id}/observation"
    for body in (
        {"state": "running", "revision": 1, "surprise": True},
        {"state": "error", "revision": 1, "error_code": "worker_needs_attention"},
        {"state": "sleeping", "revision": 1},
        {"state": "running", "revision": 0},
    ):
        response = await app.client.post(path, headers=HEADERS, json=body)
        assert response.status_code == 422
    missing = await app.client.post(
        f"/hosted-controller/machines/{uuid4()}/observation",
        headers=HEADERS,
        json={"state": "running", "revision": 1},
    )
    assert missing.status_code == 404


async def test_stale_observation_is_ignored_unless_it_carries_an_error(
    controller_app,
):
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        state="stopping",
        desired_state="stopped",
        stop_reason="owner",
        revision=2,
    )
    ignored = await observe(
        app.client,
        app.machine_id,
        state="running",
        revision=1,
        data_volume_id="vol-stale",
    )
    assert ignored["state"] == "stopping"
    assert ignored["desired_state"] == "stopped"
    assert ignored["data_volume_id"] is None
    ahead = await observe(app.client, app.machine_id, state="stopped", revision=3)
    assert ahead["state"] == "stopping"
    recorded = await observe(
        app.client,
        app.machine_id,
        state="error",
        revision=1,
        error="The instance could not be stopped.",
        error_code="machine_needs_attention",
    )
    assert recorded["state"] == "error"
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.error == "The instance could not be stopped."
    assert saved.error_code == "machine_needs_attention"


async def test_an_observation_ahead_of_core_is_ignored_even_with_an_error(
    controller_app,
):
    app = controller_app
    await update_machine(app.factory, app.machine_id, state="ready", revision=2)
    item = await observe(
        app.client,
        app.machine_id,
        state="error",
        revision=3,
        error="The instance failed its status checks.",
    )
    assert item["state"] == "ready"
    assert (await machine_of(app.factory, app.machine_id)).error is None


@pytest.mark.parametrize("state", ["queued", "provisioning"])
async def test_stale_error_does_not_overwrite_a_newer_retry(controller_app, state):
    app = controller_app
    await update_machine(app.factory, app.machine_id, state=state, revision=2)
    item = await observe(
        app.client,
        app.machine_id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
    )
    assert item["state"] == state
    saved = await machine_of(app.factory, app.machine_id)
    assert (saved.state, saved.error, saved.error_code) == (state, None, None)


async def test_stale_error_is_recorded_on_a_ready_machine(controller_app):
    app = controller_app
    await update_machine(app.factory, app.machine_id, state="ready", revision=2)
    item = await observe(
        app.client,
        app.machine_id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
    )
    assert item["state"] == "error"
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.error == "The instance failed its status checks."


async def test_running_observation_waits_for_a_status_report(controller_app):
    app = controller_app
    controller_id, _ = await enrolled(app, agents=0)
    await update_machine(app.factory, app.machine_id, state="provisioning")
    first = await observe(app.client, app.machine_id, state="running", revision=1)
    assert first["state"] == "provisioning"
    observed = (await machine_of(app.factory, app.machine_id)).running_observed_at
    assert observed is not None
    again = await observe(app.client, app.machine_id, state="running", revision=1)
    assert again["state"] == "provisioning"
    assert (
        await machine_of(app.factory, app.machine_id)
    ).running_observed_at == observed
    await report_status(app, controller_id, sessions_running=0)
    assert (await machine_of(app.factory, app.machine_id)).state == "ready"
    for state in ("running", "provisioning"):
        item = await observe(app.client, app.machine_id, state=state, revision=1)
        assert item["state"] == "ready"


async def test_a_status_report_does_not_ready_a_machine_being_stopped(
    controller_app,
):
    app = controller_app
    controller_id, _ = await enrolled(app, agents=0)
    await update_machine(
        app.factory,
        app.machine_id,
        state="provisioning",
        desired_state="stopped",
        stop_reason="owner",
        running_observed_at=datetime.now(UTC),
    )
    await report_status(app, controller_id, sessions_running=0)
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.state == "provisioning"
    assert saved.heartbeat_at is not None


@pytest.mark.parametrize(
    "state", ["stopping", "stopped", "deleting", "deleted", "retained"]
)
async def test_lifecycle_observations_are_copied(controller_app, state):
    app = controller_app
    await update_machine(
        app.factory, app.machine_id, state="ready", error_code="disk_full"
    )
    item = await observe(app.client, app.machine_id, state=state, revision=1)
    assert item["state"] == state
    assert (await machine_of(app.factory, app.machine_id)).error_code is None


async def test_a_deleted_machine_leaves_the_listing_and_ignores_observations(
    controller_app,
):
    app = controller_app
    await observe(app.client, app.machine_id, state="deleted", revision=1)
    assert await list_machines(app.client) == []
    item = await observe(app.client, app.machine_id, state="running", revision=1)
    assert item["state"] == "deleted"


async def test_error_observation_is_kept_until_retry(controller_app):
    app = controller_app
    await update_machine(app.factory, app.machine_id, state="provisioning")
    errored = await observe(
        app.client,
        app.machine_id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
    )
    assert errored["state"] == "error"
    for state in ("running", "provisioning", "stopped"):
        item = await observe(app.client, app.machine_id, state=state, revision=1)
        assert item["state"] == "error"
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.error == "The instance failed its status checks."
    assert saved.error_code == "machine_needs_attention"
    defaulted = await observe(app.client, app.machine_id, state="error", revision=1)
    assert defaulted["state"] == "error"
    saved = await machine_of(app.factory, app.machine_id)
    assert "Retry" in saved.error
    assert saved.error_code is None


async def _errored_retained(app: ControllerApp, retain_until: datetime) -> None:
    await update_machine(
        app.factory,
        app.machine_id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=retain_until,
        revision=2,
    )


@pytest.mark.parametrize("state", ["retained", "deleting", "deleted"])
async def test_retiring_an_errored_machine_replaces_its_error(controller_app, state):
    app = controller_app
    await _errored_retained(app, datetime.now(UTC) + timedelta(days=7))
    item = await observe(app.client, app.machine_id, state=state, revision=2)
    assert item["state"] == state
    saved = await machine_of(app.factory, app.machine_id)
    assert (saved.error, saved.error_code) == (None, None)


async def test_errored_machine_retained_after_its_last_agent_expires(controller_app):
    app = controller_app
    await _errored_retained(app, datetime.now(UTC) - timedelta(seconds=1))
    await observe(app.client, app.machine_id, state="retained", revision=2)
    [item] = await list_machines(app.client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "retained",
        "deleted",
        3,
    )


async def test_retention_sweep_deletes_an_expired_errored_machine(controller_app):
    app = controller_app
    await _errored_retained(app, datetime.now(UTC) - timedelta(seconds=1))
    [item] = await list_machines(app.client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "deleted",
        3,
    )
    item = await observe(app.client, app.machine_id, state="deleting", revision=3)
    assert item["state"] == "deleting"
    saved = await machine_of(app.factory, app.machine_id)
    assert (saved.error, saved.error_code) == (None, None)


async def test_retention_sweep_keeps_an_errored_machine_inside_its_window(
    controller_app,
):
    app = controller_app
    until = datetime.now(UTC) + timedelta(days=3)
    await _errored_retained(app, until)
    [item] = await list_machines(app.client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "retained",
        2,
    )
    assert item["retain_until"] == until.isoformat()


async def _idle_ready(
    app: ControllerApp,
    *,
    minutes: int,
    agents: int = 1,
    sessions: int | None = 0,
    reported: timedelta = timedelta(minutes=1),
) -> str:
    """A ready machine whose controller, with `agents` placed on it, last
    reported `reported` ago that `sessions` run, and which went quiet 31
    minutes ago. The controller id."""
    app.config.hosted_idle_stop_minutes = minutes
    controller_id, _ = await enrolled(app, agents=agents)
    heartbeat: dict = {"disk": None, "memory": None}
    if sessions is not None:
        heartbeat["sessions_running"] = sessions
    now = datetime.now(UTC)
    await update_machine(
        app.factory,
        app.machine_id,
        state="ready",
        active_at=now - timedelta(minutes=31),
        heartbeat=heartbeat,
        heartbeat_at=now - reported,
        running_observed_at=now - timedelta(hours=1),
    )
    return controller_id


async def test_idle_machine_sleeps_once_its_controller_reports_it_idle(
    controller_app,
):
    app = controller_app
    await _idle_ready(app, minutes=30)
    [item] = await list_machines(app.client)
    assert (item["desired_state"], item["revision"]) == ("stopped", 2)
    saved = await machine_of(app.factory, app.machine_id)
    assert saved.stop_reason == "idle"
    assert saved.running_observed_at is None
    assert saved.retain_until is None


async def test_recent_machine_activity_keeps_it_awake(controller_app):
    app = controller_app
    await _idle_ready(app, minutes=30)
    await update_machine(
        app.factory,
        app.machine_id,
        active_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    [item] = await list_machines(app.client)
    assert (item["desired_state"], item["revision"]) == ("running", 1)


async def test_running_sessions_keep_it_awake(controller_app):
    app = controller_app
    await _idle_ready(app, minutes=30, sessions=2)
    [item] = await list_machines(app.client)
    assert item["desired_state"] == "running"


async def test_a_report_of_running_sessions_renews_its_activity(controller_app):
    app = controller_app
    controller_id = await _idle_ready(app, minutes=30)
    before = datetime.now(UTC)
    await report_status(app, controller_id, sessions_running=1)
    await report_status(app, controller_id, sessions_running=0)
    [item] = await list_machines(app.client)
    assert item["desired_state"] == "running"
    assert (await machine_of(app.factory, app.machine_id)).active_at >= before


@pytest.mark.parametrize(
    ("sessions", "reported"),
    [(0, timedelta(minutes=10)), (None, timedelta(minutes=1))],
    ids=["stopped-reporting", "no-session-count"],
)
async def test_a_machine_not_known_to_be_idle_is_kept_awake(
    controller_app, sessions, reported
):
    app = controller_app
    await _idle_ready(app, minutes=30, sessions=sessions, reported=reported)
    [item] = await list_machines(app.client)
    assert item["desired_state"] == "running"


async def test_idle_stop_is_off_when_the_setting_is_zero(controller_app):
    app = controller_app
    await _idle_ready(app, minutes=0)
    [item] = await list_machines(app.client)
    assert (item["desired_state"], item["revision"]) == ("running", 1)


async def test_only_a_ready_running_machine_is_put_to_sleep(controller_app):
    app = controller_app
    await _idle_ready(app, minutes=30)
    await update_machine(app.factory, app.machine_id, state="provisioning")
    [item] = await list_machines(app.client)
    assert item["desired_state"] == "running"


async def test_idle_machine_whose_agents_were_removed_keeps_its_disk(controller_app):
    app = controller_app
    await _idle_ready(app, minutes=30, agents=0)
    before = datetime.now(UTC)
    [item] = await list_machines(app.client)
    assert (item["desired_state"], item["revision"]) == ("retained", 2)
    retain_until = datetime.fromisoformat(item["retain_until"])
    assert before + timedelta(days=7) <= retain_until
    assert retain_until <= datetime.now(UTC) + timedelta(days=7)


async def test_a_machine_asleep_with_agents_stays_asleep(controller_app):
    app = controller_app
    await enrolled(app, agents=1)
    await update_machine(
        app.factory,
        app.machine_id,
        state="stopped",
        desired_state="stopped",
        stop_reason="idle",
        revision=2,
    )
    [item] = await list_machines(app.client)
    assert (item["desired_state"], item["revision"]) == ("stopped", 2)


async def _empty_machine(app: ControllerApp, **values) -> tuple[str, str]:
    """Another owner's machine whose controller never enrolled, quiet for 31 minutes."""
    async with app.factory() as session:
        owner = User(
            name="empty", email="empty@example.com", role="user", password_hash="x"
        )
        session.add(owner)
        await session.flush()
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        machine.active_at = datetime.now(UTC) - timedelta(minutes=31)
        machine.heartbeat = {"disk": None, "memory": None, "sessions_running": 0}
        machine.heartbeat_at = datetime.now(UTC)
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()
        return machine.id, owner.id


@pytest.mark.parametrize(
    ("minutes", "values"),
    [
        (30, {}),
        (0, {"state": "stopped", "desired_state": "stopped", "stop_reason": "idle"}),
    ],
    ids=["idle", "idle-sleeping"],
)
async def test_machine_that_never_hosted_an_agent_is_released(
    controller_app, minutes, values
):
    app = controller_app
    app.config.hosted_idle_stop_minutes = minutes
    machine_id, _ = await _empty_machine(app, **values)
    before = datetime.now(UTC)
    item = await listed(app.client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("retained", 2)
    assert before <= datetime.fromisoformat(item["retain_until"]) <= datetime.now(UTC)
    await observe(app.client, machine_id, state="retained", revision=2)
    assert (await listed(app.client, machine_id))["desired_state"] == "deleted"


async def test_owner_stopped_empty_machine_is_left_alone(controller_app):
    app = controller_app
    machine_id, _ = await _empty_machine(
        app, state="stopped", desired_state="stopped", stop_reason="owner"
    )
    item = await listed(app.client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("stopped", 1)


async def test_errored_machine_that_never_hosted_an_agent_is_released(controller_app):
    app = controller_app
    app.config.hosted_idle_stop_minutes = 30
    machine_id, _ = await _empty_machine(
        app,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        updated_at=datetime.now(UTC) - timedelta(minutes=31),
    )
    before = datetime.now(UTC)
    item = await listed(app.client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "retained",
        2,
    )
    assert before <= datetime.fromisoformat(item["retain_until"]) <= datetime.now(UTC)
    await observe(app.client, machine_id, state="retained", revision=2)
    item = await listed(app.client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "retained",
        "deleted",
        3,
    )


async def test_errored_machine_that_enrolled_is_left_for_its_owner(controller_app):
    app = controller_app
    app.config.hosted_idle_stop_minutes = 30
    await enrolled(app, agents=0)
    await update_machine(
        app.factory,
        app.machine_id,
        state="error",
        error="The instance failed its status checks.",
        updated_at=datetime.now(UTC) - timedelta(minutes=31),
    )
    [item] = await list_machines(app.client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "running",
        1,
    )


async def test_recently_errored_empty_machine_is_left_alone(controller_app):
    app = controller_app
    app.config.hosted_idle_stop_minutes = 30
    machine_id, _ = await _empty_machine(
        app,
        state="error",
        error="The instance failed its status checks.",
        updated_at=datetime.now(UTC) - timedelta(minutes=10),
    )
    item = await listed(app.client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "running",
        1,
    )


async def _claim(factory, owner_id: str) -> HostedMachine:
    async with factory() as session:
        await lock_claims(session)
        machine = await HostedMachineStore().claim(
            session,
            owner_id=owner_id,
            capacity=2,
            now=datetime.now(UTC),
        )
        await session.commit()
        return machine


async def test_released_machine_is_revived_or_replaced_by_a_claim(controller_app):
    app = controller_app
    app.config.hosted_idle_stop_minutes = 30
    machine_id, owner_id = await _empty_machine(app)
    assert (await listed(app.client, machine_id))["desired_state"] == "retained"
    revived = await _claim(app.factory, owner_id)
    assert (revived.id, revived.desired_state, revived.retain_until) == (
        machine_id,
        "running",
        None,
    )
    await update_machine(
        app.factory, machine_id, state="deleted", desired_state="deleted"
    )
    replaced = await _claim(app.factory, owner_id)
    assert replaced.id != machine_id
    assert replaced.desired_state == "running"

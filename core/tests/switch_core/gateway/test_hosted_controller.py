import asyncio
import json
import logging
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, text

from switch_core.bridges.agent.api.hosted_cutover_routes import (
    router as hosted_cutover_router,
)
from switch_core.bridges.agent.api.hosted_machine_routes import (
    router as hosted_machine_router,
)
from switch_core.bridges.agent.api.hosted_routes import router as worker_router
from switch_core.bridges.agent.api.hosted_worker_routes import (
    router as hosted_worker_router,
)
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config as get_worker_config
from switch_core.bridges.agent.dependencies import get_protocol as get_worker_protocol
from switch_core.bridges.agent.dependencies import get_session as get_worker_session
from switch_core.bridges.agent.dependencies import (
    get_session_factory as get_worker_session_factory,
)
from switch_core.bridges.agent.protocol.agent_connections import (
    AgentConnection,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.agent_core import AgentExistsError
from switch_core.bridges.agent.protocol.hosted_workers import IdleReport, WorkerBinding
from switch_core.db.models import (
    Agent,
    ApiKey,
    GitHubIssuedToken,
    HostedLaunch,
    HostedMachine,
    HostedOperation,
    ProviderConnection,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineStore,
    lock_launch,
    lock_launches,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.auth import get_current_user, get_current_user_in_transaction
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import DELETING_RESUME_AFTER, router
from switch_core.gateway.hosted_launches import router as launch_router
from switch_core.gateway.hosted_relay import router as relay_router
from switch_core.gateway.known_agents import KNOWN_AGENTS
from switch_core.keys import Keyring
from switch_core.providers.github_installation import (
    GitHubInstallationCredentials,
    RepositoryCredential,
)
from switch_core.providers.github_revocations import queue_revocation, revoke_pending
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    PROFILE,
    make_owner,
    make_service,
)
from tests.switch_core.hosted_machine_helpers import seed_launch, seed_machine

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

TOKEN = "SYNTHETIC-CONTROLLER-CREDENTIAL-FOR-TESTS"
HEADERS = {"Authorization": "Bearer " + TOKEN}
FIXTURES = Path(__file__).parent.parent / "fixtures" / "hosted_machines"
MACHINE_ITEM_KEYS = {
    "machine_id",
    "slot_id",
    "generation",
    "state",
    "desired_state",
    "revision",
    "data_volume_id",
    "retain_until",
    "bundle_revision",
}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


async def register_hosted_agent(
    service, *, owner: str, request_id: str, name: str, spec: dict
) -> str:
    """Register a launch's agent identity the way launch creation does."""
    known = KNOWN_AGENTS["claude-code"]
    options = known.parse_options(
        {
            "channels_enabled": True,
            "repo_dir": "/data/worktrees/agent/workspace",
            "auto_session": spec["auto_session"],
        }
    )
    result = await service.register_agent(
        name=name,
        description=spec["description"],
        display_name=spec["display_name"],
        icon_url=spec["icon_url"],
        connector_type=known.connector_type,
        integration_profile=known.build_profile(options),
        tools=known.tools,
        models=known.models,
        metadata={
            "known_agent_type": "claude-code",
            "known_agent_options": options.model_dump(),
            "hosted_launch_id": request_id,
        },
        owner_id=owner,
    )
    return result.agent_id


SPEC = {
    "description": "Cloud helper",
    "display_name": None,
    "icon_url": None,
    "instructions": "Help with the repository.",
    "auto_session": True,
    "auto_approve": False,
    "addressing_policy": None,
    "definition_attributes": {},
    "installation_id": 123,
    "repository_id": 456,
}


@pytest.fixture
async def controller_app(session_factory, monkeypatch, tmp_path):
    """A queued machine with one queued launch whose agent is registered."""
    owner = await make_owner(session_factory)
    request_id = str(uuid4())
    async with session_factory() as session:
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner, role="member")
        )
        session.add(
            ProviderConnection(
                user_id=owner,
                provider="github",
                kind="oauth",
                encrypted_credential=TEST_KEYRING.encrypt(
                    json.dumps(
                        {
                            "access_token": "SYNTHETIC-GITHUB",
                            "expires_at": (
                                datetime.now(UTC) + timedelta(hours=1)
                            ).timestamp(),
                        }
                    ),
                ),
                verified_at=datetime.now(UTC),
            )
        )
        await ProviderConnectionStore().save(
            session,
            owner,
            "setup-token",
            TEST_KEYRING.encrypt("SYNTHETIC-CLAUDE"),
            datetime.now(UTC),
        )
        await session.commit()
    service = make_service(session_factory)
    service.connections = AgentConnectionRegistry()
    service.event_buffer = SimpleNamespace(boot=1, remove=Mock())
    service.config.hosted_idle_stop_minutes = 0
    service.config.hosted_disk_retention_days = 7
    agent_id = await register_hosted_agent(
        service, owner=owner, request_id=request_id, name="cloud-helper", spec=SPEC
    )
    async with session_factory() as session:
        machine = await seed_machine(
            session,
            owner_id=owner,
            slot_id="slot-a",
            state="queued",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        await seed_launch(
            session,
            machine=machine,
            request_id=request_id,
            name="cloud-helper",
            state="queued",
            desired_state="running",
            revision=1,
            agent_id=agent_id,
            spec=SPEC,
        )
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.repository = "example/project"
        await session.commit()
    settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=TOKEN,
        machine_slots=["slot-a", "slot-b"],
        github_private_key_path="/tmp/synthetic-signing-key.pem",
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", AsyncMock())
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.state.github_connections = SimpleNamespace(client_id="synthetic-app")
    app.include_router(router)
    app.include_router(worker_router)
    app.include_router(hosted_machine_router)
    app.include_router(hosted_worker_router, prefix="/agents")
    app.include_router(hosted_cutover_router, prefix="/agents")
    app.include_router(launch_router)
    app.include_router(relay_router)
    settings_path = tmp_path / "controller.json"
    settings_path.write_text(
        json.dumps({**settings.model_dump(mode="json"), "token": TOKEN})
    )
    service.config.hosted_controller_config_path = str(settings_path)
    service.config.hosted_github_config_path = "/tmp/synthetic-github.json"

    async def worker_session():
        async with session_factory() as session:
            yield session

    async def current_user():
        async with session_factory() as session:
            return await session.get(User, owner)

    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_current_user_in_transaction] = current_user
    app.dependency_overrides[get_session] = worker_session

    async def worker_agent():
        async with session_factory() as session:
            return await session.get(Agent, agent_id)

    app.dependency_overrides[get_agent_from_scope] = worker_agent
    app.dependency_overrides[get_worker_config] = lambda: service.config
    app.dependency_overrides[get_worker_session] = worker_session
    app.dependency_overrides[get_worker_session_factory] = lambda: session_factory
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: service.config
    app.dependency_overrides[get_protocol] = lambda: service
    app.dependency_overrides[get_worker_protocol] = lambda: service
    issue = AsyncMock(
        return_value=RepositoryCredential(
            "SYNTHETIC-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubConnections",
        lambda _: app.state.github_connections,
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=AsyncMock()),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, request_id, agent_id, service, session_factory, settings


async def machine_of(factory, request_id: str) -> HostedMachine:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        machine = await session.get(
            HostedMachine, (require_tenant_id(), launch.machine_id)
        )
        assert machine is not None
        return machine


async def update_machine(factory, machine_id: str, **values) -> None:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()


async def update_launch(factory, request_id: str, **values) -> None:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        for key, value in values.items():
            setattr(launch, key, value)
        await session.commit()


def attach_worker(
    service,
    agent_id: str,
    request_id: str,
    *,
    revision: int = 1,
    boot_id: str = "boot-a",
    connection_id: str | None = None,
) -> AgentConnection:
    conn = service.connections.open(
        agent_id=agent_id,
        connection_id=connection_id or str(uuid4()),
        scope="all",
        delivery_filter="all",
        spawn_capable=True,
        cursor=0,
        declaration=ClientDeclaration(speaks=7, accepts=1),
        expected_generation=None,
    )
    service.connections.bind_worker(
        conn, WorkerBinding(request_id, revision, boot_id, "instance-a"), {}
    )
    return conn


def fence(conn: AgentConnection) -> dict:
    return {"connection_id": conn.id, "generation": conn.stream_generation}


def report_idle(
    service, conn: AgentConnection, *, busy: bool = False, seq: int = 1
) -> None:
    assert conn.worker is not None
    service.connections.record_idle_report(
        conn,
        IdleReport(
            report_seq=seq,
            relays_through=0,
            busy=busy,
            reasons=[],
            sessions={},
            launch_revision=conn.worker.launch_revision,
            generation=conn.stream_generation,
            received_monotonic=time.monotonic(),
            received_at=datetime.now(UTC),
        ),
    )


async def list_machines(client) -> list[dict]:
    response = await client.get("/hosted-controller/machines", headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()["machines"]


async def observe(client, machine_id: str, **body) -> dict:
    response = await client.post(
        f"/hosted-controller/machines/{machine_id}/observation",
        headers=HEADERS,
        json=body,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_controller_requires_its_own_credential(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    for method, path, body in (
        ("GET", "/hosted-controller/machines", None),
        ("POST", f"/hosted-controller/machines/{machine.id}/prepare", {}),
        (
            "POST",
            f"/hosted-controller/machines/{machine.id}/observation",
            {"state": "running", "revision": 1},
        ),
    ):
        for token in (None, "Bearer wrong"):
            response = await client.request(
                method,
                path,
                headers={} if token is None else {"Authorization": token},
                json=body,
            )
            assert response.status_code == 401
    assert (await machine_of(factory, request_id)).state == "queued"


async def test_old_per_launch_controller_routes_are_gone(controller_app):
    client, request_id, *_ = controller_app
    assert (await client.get("/hosted-controller", headers=HEADERS)).status_code in {
        404,
        405,
    }
    for suffix in ("prepare", "observation"):
        response = await client.post(
            f"/hosted-controller/{request_id}/{suffix}", headers=HEADERS, json={}
        )
        assert response.status_code in {404, 405}


async def test_machines_lists_every_live_machine_with_the_contract_keys(
    controller_app,
):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    async with factory() as session:
        gone = await seed_machine(
            session,
            owner_id=machine.owner_id,
            slot_id="slot-b",
            state="deleted",
            desired_state="deleted",
            stop_reason=None,
            revision=3,
            generation=1,
        )
        await session.commit()
    listed = await list_machines(client)
    assert [item["machine_id"] for item in listed] == [machine.id]
    assert gone.id not in {item["machine_id"] for item in listed}
    assert set(listed[0]) == MACHINE_ITEM_KEYS
    assert listed[0] == {
        "machine_id": machine.id,
        "slot_id": "slot-a",
        "generation": 1,
        "state": "queued",
        "desired_state": "running",
        "revision": 1,
        "data_volume_id": None,
        "retain_until": None,
        "bundle_revision": None,
    }


async def test_queued_machine_times_out_with_an_actionable_error(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(
        factory, machine.id, updated_at=datetime.now(UTC) - timedelta(minutes=11)
    )
    [item] = await list_machines(client)
    assert item["state"] == "error"
    saved = await machine_of(factory, request_id)
    assert saved.error_code == "machine_connect_timeout"
    assert "10 minutes" in saved.error
    assert "Retry" in saved.error


async def test_recent_queued_machine_is_left_alone(controller_app):
    client, request_id, *_ = controller_app
    [item] = await list_machines(client)
    assert item["state"] == "queued"


async def test_running_machine_that_never_connects_times_out(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        running_observed_at=datetime.now(UTC) - timedelta(minutes=11),
    )
    [item] = await list_machines(client)
    assert item["state"] == "error"
    saved = await machine_of(factory, request_id)
    assert saved.error_code == "machine_connect_timeout"
    assert "10 minutes" in saved.error


async def test_connect_timeout_counts_from_the_running_observation(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        updated_at=datetime.now(UTC) - timedelta(minutes=30),
        running_observed_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    [item] = await list_machines(client)
    assert item["state"] == "provisioning"


async def test_provisioning_machine_never_observed_running_times_out(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    before = datetime.now(UTC)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        updated_at=before - timedelta(minutes=11),
    )
    [item] = await list_machines(client)
    assert item["state"] == "error"
    saved = await machine_of(factory, request_id)
    assert saved.error_code == "machine_connect_timeout"
    assert (
        saved.error
        == "The cloud machine did not start within 10 minutes. Retry it in Switch Console, or contact your administrator if it still cannot start."
    )
    assert saved.updated_at >= before


async def test_recent_provisioning_machine_is_left_alone(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        updated_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    [item] = await list_machines(client)
    assert item["state"] == "provisioning"


async def _stopping_launch(controller_app, *, machine_state: str, minutes: int) -> None:
    _, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, state=machine_state)
    await update_launch(
        factory,
        request_id,
        state="stopping",
        desired_state="stopped",
        updated_at=datetime.now(UTC) - timedelta(minutes=minutes),
    )


async def test_launch_that_never_stops_on_a_ready_machine_times_out(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    before = datetime.now(UTC)
    await _stopping_launch(controller_app, machine_state="ready", minutes=11)
    await list_machines(client)
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
    assert launch.state == "error"
    assert launch.error_code == "agent_stop_timeout"
    assert (
        launch.error
        == "The agent did not stop within 10 minutes. Retry it in Switch Console."
    )
    assert launch.updated_at >= before
    retried = await client.post(
        f"/hosted-launches/{request_id}/lifecycle",
        json={"action": "retry", "revision": launch.revision},
    )
    assert retried.status_code == 200, retried.text


@pytest.mark.parametrize(
    ("machine_state", "minutes"),
    [("stopping", 11), ("provisioning", 11), ("ready", 5)],
    ids=["machine-stopping", "machine-provisioning", "recent"],
)
async def test_stopping_launch_is_left_alone_unless_it_should_have_stopped(
    controller_app, machine_state, minutes
):
    client, request_id, _, _, factory, _ = controller_app
    await _stopping_launch(controller_app, machine_state=machine_state, minutes=minutes)
    await list_machines(client)
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
    assert launch.state == "stopping"
    assert launch.error_code is None


async def test_retention_sweep_deletes_an_expired_retained_machine(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    expired = datetime.now(UTC) - timedelta(seconds=1)
    await update_machine(
        factory,
        machine.id,
        state="retained",
        desired_state="retained",
        retain_until=expired,
        revision=3,
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "deleted"
    assert item["revision"] == 4
    assert item["retain_until"] == expired.isoformat()


async def test_retention_sweep_keeps_a_machine_inside_its_window(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    until = datetime.now(UTC) + timedelta(days=3)
    await update_machine(
        factory,
        machine.id,
        state="retained",
        desired_state="retained",
        retain_until=until,
        revision=3,
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "retained"
    assert item["revision"] == 3
    assert item["retain_until"] == until.isoformat()


async def test_machines_sweep_expires_unconfirmed_and_superseded_operations(
    controller_app,
):
    client, request_id, _, _, factory, _ = controller_app
    await update_launch(factory, request_id, revision=2)
    now = datetime.now(UTC)
    operations = {
        "expired_claim": (2, "claimed", now - timedelta(minutes=6)),
        "fresh_claim": (2, "claimed", now),
        "current_queued": (2, "queued", now),
        "old_queued": (1, "queued", now),
        "old_claim": (1, "claimed", now),
    }
    ids = {name: str(uuid4()) for name in operations}
    async with factory() as session:
        for name, (revision, state, updated_at) in operations.items():
            session.add(
                HostedOperation(
                    id=ids[name],
                    launch_id=request_id,
                    launch_revision=revision,
                    session_id=str(uuid4()),
                    action="start",
                    state=state,
                    updated_at=updated_at,
                )
            )
        await session.commit()
    await list_machines(client)
    async with factory() as session:
        states = {
            name: (
                await session.get(HostedOperation, (require_tenant_id(), ids[name]))
            ).state
            for name in operations
        }
    assert states == {
        "expired_claim": "unknown",
        "fresh_claim": "claimed",
        "current_queued": "queued",
        "old_queued": "failed",
        "old_claim": "unknown",
    }


async def test_prepare_is_idempotent_per_revision_and_rotates_on_a_new_one(
    controller_app,
):
    client, request_id, _, _, factory, settings = controller_app
    machine = await machine_of(factory, request_id)
    path = f"/hosted-controller/machines/{machine.id}/prepare"
    first = await client.post(path, headers=HEADERS, json={})
    again = await client.post(path, headers=HEADERS, json={})
    assert first.status_code == again.status_code == 200, first.text
    assert first.headers["cache-control"] == "no-store"
    assert first.json() == again.json()
    body = first.json()
    assert set(body) == {
        "machine_id",
        "slot_id",
        "generation",
        "revision",
        "bundle_revision",
        "machine_capability",
        "api_endpoint",
    }
    assert body["machine_id"] == machine.id
    assert body["slot_id"] == "slot-a"
    assert body["generation"] == 1
    assert body["revision"] == body["bundle_revision"] == 1
    assert body["api_endpoint"] == settings.agent_api_endpoint
    saved = await machine_of(factory, request_id)
    assert saved.state == "provisioning"
    assert HostedMachineStore.capability_matches(saved, body["machine_capability"])
    [item] = await list_machines(client)
    assert item["bundle_revision"] == 1
    assert body["machine_capability"] not in json.dumps(item)

    await update_machine(factory, machine.id, revision=2)
    rotated = (await client.post(path, headers=HEADERS, json={})).json()
    assert rotated["revision"] == rotated["bundle_revision"] == 2
    assert rotated["machine_capability"] != body["machine_capability"]
    saved = await machine_of(factory, request_id)
    assert not HostedMachineStore.capability_matches(saved, body["machine_capability"])
    assert HostedMachineStore.capability_matches(saved, rotated["machine_capability"])


async def test_prepare_does_not_touch_launches_or_agents(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    started = list(service.client_lifecycle.started)
    response = await client.post(
        f"/hosted-controller/machines/{machine.id}/prepare", headers=HEADERS, json={}
    )
    assert response.status_code == 200, response.text
    assert service.client_lifecycle.started == started
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch.state == "queued"
        assert launch.worker_capability_hash is None
        assert await session.scalar(select(GitHubIssuedToken)) is None


async def test_prepare_refuses_unknown_and_deleted_machines(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    missing = await client.post(
        f"/hosted-controller/machines/{uuid4()}/prepare", headers=HEADERS, json={}
    )
    assert missing.status_code == 404
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, desired_state="deleted")
    deleted = await client.post(
        f"/hosted-controller/machines/{machine.id}/prepare", headers=HEADERS, json={}
    )
    assert deleted.status_code == 409
    assert deleted.json() == {"detail": "machine is deleted"}
    assert (await machine_of(factory, request_id)).machine_capability_hash is None


async def test_prepare_for_a_departed_owner_errors_the_machine(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    async with factory() as session:
        await session.delete(
            await session.get(TenantMember, (require_tenant_id(), machine.owner_id))
        )
        await session.commit()
    response = await client.post(
        f"/hosted-controller/machines/{machine.id}/prepare", headers=HEADERS, json={}
    )
    assert response.status_code == 409
    assert "machine_capability" not in response.text
    saved = await machine_of(factory, request_id)
    assert saved.state == "error"
    assert "workspace member" in saved.error
    assert saved.machine_capability_hash is None


async def test_controller_observation_fixture_is_accepted(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    body = fixture("controller_observation.json")
    await update_machine(
        factory, machine.id, state="provisioning", revision=body["revision"]
    )
    response = await client.post(
        f"/hosted-controller/machines/{machine.id}/observation",
        headers=HEADERS,
        json=body,
    )
    assert response.status_code == 200, response.text
    item = response.json()
    assert set(item) == MACHINE_ITEM_KEYS
    assert item["state"] == "provisioning"
    assert item["data_volume_id"] == body["data_volume_id"]
    saved = await machine_of(factory, request_id)
    assert saved.instance_id == body["instance_id"]
    assert saved.instance_type == body["instance_type"]
    assert saved.running_observed_at is not None


async def test_observation_rejects_unknown_fields_and_codes(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    path = f"/hosted-controller/machines/{machine.id}/observation"
    for body in (
        {"state": "running", "revision": 1, "surprise": True},
        {"state": "error", "revision": 1, "error_code": "worker_needs_attention"},
        {"state": "sleeping", "revision": 1},
        {"state": "running", "revision": 0},
    ):
        assert (await client.post(path, headers=HEADERS, json=body)).status_code == 422
    missing = await client.post(
        f"/hosted-controller/machines/{uuid4()}/observation",
        headers=HEADERS,
        json={"state": "running", "revision": 1},
    )
    assert missing.status_code == 404


async def test_stale_observation_is_ignored_unless_it_carries_an_error(
    controller_app,
):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(
        factory,
        machine.id,
        state="stopping",
        desired_state="stopped",
        stop_reason="owner",
        revision=2,
    )
    ignored = await observe(
        client, machine.id, state="running", revision=1, data_volume_id="vol-stale"
    )
    assert ignored["state"] == "stopping"
    assert ignored["desired_state"] == "stopped"
    assert ignored["data_volume_id"] is None
    ahead = await observe(client, machine.id, state="stopped", revision=3)
    assert ahead["state"] == "stopping"
    recorded = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance could not be stopped.",
        error_code="machine_needs_attention",
    )
    assert recorded["state"] == "error"
    saved = await machine_of(factory, request_id)
    assert saved.error == "The instance could not be stopped."
    assert saved.error_code == "machine_needs_attention"


@pytest.mark.parametrize("state", ["queued", "provisioning"])
async def test_stale_error_does_not_overwrite_a_newer_retry(controller_app, state):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, state=state, revision=2)
    item = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
    )
    assert item["state"] == state
    saved = await machine_of(factory, request_id)
    assert saved.state == state
    assert saved.error is None
    assert saved.error_code is None


async def test_stale_error_is_recorded_on_a_ready_machine(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, state="ready", revision=2)
    item = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
    )
    assert item["state"] == "error"
    assert (
        await machine_of(factory, request_id)
    ).error == "The instance failed its status checks."


async def test_running_observation_waits_for_a_heartbeat(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, state="provisioning")
    first = await observe(client, machine.id, state="running", revision=1)
    assert first["state"] == "provisioning"
    observed = (await machine_of(factory, request_id)).running_observed_at
    assert observed is not None
    again = await observe(client, machine.id, state="running", revision=1)
    assert again["state"] == "provisioning"
    assert (await machine_of(factory, request_id)).running_observed_at == observed
    await update_machine(factory, machine.id, state="ready")
    assert (await observe(client, machine.id, state="running", revision=1))[
        "state"
    ] == "ready"
    assert (await observe(client, machine.id, state="provisioning", revision=1))[
        "state"
    ] == "ready"


@pytest.mark.parametrize(
    "state", ["stopping", "stopped", "deleting", "deleted", "retained"]
)
async def test_lifecycle_observations_are_copied(controller_app, state):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, state="ready", error_code="disk_full")
    item = await observe(client, machine.id, state=state, revision=1)
    assert item["state"] == state
    assert (await machine_of(factory, request_id)).error_code is None


async def test_error_observation_is_kept_until_retry(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, state="provisioning")
    errored = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
    )
    assert errored["state"] == "error"
    for state in ("running", "provisioning", "stopped"):
        assert (await observe(client, machine.id, state=state, revision=1))[
            "state"
        ] == "error"
    saved = await machine_of(factory, request_id)
    assert saved.error == "The instance failed its status checks."
    assert saved.error_code == "machine_needs_attention"
    defaulted = await observe(client, machine.id, state="error", revision=1)
    assert defaulted["state"] == "error"
    saved = await machine_of(factory, request_id)
    assert "Retry" in saved.error
    assert saved.error_code is None


@pytest.mark.parametrize("state", ["retained", "deleting", "deleted"])
async def test_retiring_an_errored_machine_replaces_its_error(controller_app, state):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_launch(factory, request_id, state="deleted", desired_state="deleted")
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=datetime.now(UTC) + timedelta(days=7),
        revision=2,
    )
    item = await observe(client, machine.id, state=state, revision=2)
    assert item["state"] == state
    saved = await machine_of(factory, request_id)
    assert saved.error is None
    assert saved.error_code is None


async def test_errored_machine_retained_after_its_last_agent_expires(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_launch(factory, request_id, state="deleted", desired_state="deleted")
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=datetime.now(UTC) - timedelta(seconds=1),
        revision=2,
    )
    await observe(client, machine.id, state="retained", revision=2)
    [item] = await list_machines(client)
    assert item["state"] == "retained"
    assert item["desired_state"] == "deleted"
    assert item["revision"] == 3


async def test_retention_sweep_deletes_an_expired_errored_machine(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_launch(factory, request_id, state="deleted", desired_state="deleted")
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=datetime.now(UTC) - timedelta(seconds=1),
        revision=2,
    )
    [item] = await list_machines(client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "deleted",
        3,
    )
    item = await observe(client, machine.id, state="deleting", revision=3)
    assert item["state"] == "deleting"
    saved = await machine_of(factory, request_id)
    assert (saved.error, saved.error_code) == (None, None)


async def test_retention_sweep_keeps_an_errored_machine_inside_its_window(
    controller_app,
):
    client, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    await update_launch(factory, request_id, state="deleted", desired_state="deleted")
    until = datetime.now(UTC) + timedelta(days=3)
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=until,
        revision=2,
    )
    [item] = await list_machines(client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "retained",
        2,
    )
    assert item["retain_until"] == until.isoformat()


async def test_deleted_observation_with_live_launches_logs_an_invariant_failure(
    controller_app, caplog
):
    client, request_id, agent_id, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    with caplog.at_level(logging.ERROR, logger="switch_core.gateway.hosted_controller"):
        item = await observe(client, machine.id, state="deleted", revision=1)
    assert item["state"] == "deleted"
    assert request_id in caplog.text
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch.state == "queued"
        assert await session.get(Agent, agent_id) is not None
    assert await list_machines(client) == []


async def _idle_ready(
    controller_app, *, minutes: int, report: bool = True, busy: bool = False
) -> AgentConnection:
    """A ready machine whose one launch and the machine itself went quiet 31 minutes ago."""
    _, request_id, agent_id, service, factory, _ = controller_app
    service.config.hosted_idle_stop_minutes = minutes
    machine = await machine_of(factory, request_id)
    long_ago = datetime.now(UTC) - timedelta(minutes=31)
    await update_machine(factory, machine.id, state="ready", active_at=long_ago)
    await update_launch(factory, request_id, state="ready", active_at=long_ago)
    conn = attach_worker(service, agent_id, request_id)
    if report:
        report_idle(service, conn, busy=busy)
    return conn


async def test_idle_machine_sleeps_when_every_agent_and_the_machine_are_idle(
    controller_app,
):
    client, request_id, *_ = controller_app
    await _idle_ready(controller_app, minutes=30)
    [item] = await list_machines(client)
    assert item["desired_state"] == "stopped"
    assert item["revision"] == 2
    saved = await machine_of(controller_app[4], request_id)
    assert saved.stop_reason == "idle"
    assert saved.running_observed_at is None
    async with controller_app[4]() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch.state == "ready"
        assert launch.desired_state == "running"
        assert launch.revision == 1


async def test_auto_session_does_not_exempt_an_agent_from_idle_stop(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await update_launch(factory, request_id, spec={**SPEC, "auto_session": False})
    await _idle_ready(controller_app, minutes=30)
    [item] = await list_machines(client)
    assert item["desired_state"] == "stopped"


async def test_recent_machine_activity_keeps_it_awake(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await _idle_ready(controller_app, minutes=30)
    machine = await machine_of(factory, request_id)
    await update_machine(
        factory, machine.id, active_at=datetime.now(UTC) - timedelta(minutes=5)
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"


async def test_recent_agent_activity_keeps_it_awake(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await _idle_ready(controller_app, minutes=30)
    await update_launch(
        factory, request_id, active_at=datetime.now(UTC) - timedelta(minutes=5)
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"


async def test_a_report_older_than_the_last_activity_is_not_evidence(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await _idle_ready(controller_app, minutes=30)
    await update_launch(
        factory, request_id, active_at=datetime.now(UTC) - timedelta(seconds=1)
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"


async def test_missing_idle_report_counts_as_busy(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    before = datetime.now(UTC)
    await _idle_ready(controller_app, minutes=30, report=False)
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch.active_at >= before


async def test_busy_agent_renews_its_activity_and_keeps_the_machine_awake(
    controller_app,
):
    client, request_id, _, _, factory, _ = controller_app
    before = datetime.now(UTC)
    await _idle_ready(controller_app, minutes=30, busy=True)
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch.active_at >= before


async def _second_launch(controller_app, **values) -> str:
    _, request_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, request_id)
    second = str(uuid4())
    async with factory() as session:
        await seed_launch(
            session,
            machine=machine,
            request_id=second,
            name="cloud-second",
            state=values.pop("state", "ready"),
            desired_state=values.pop("desired_state", "running"),
            revision=1,
            agent_id=values.pop("agent_id", None),
            spec=SPEC,
        )
        await session.commit()
    await update_launch(factory, second, **values)
    return second


async def test_one_busy_agent_keeps_the_whole_machine_awake(controller_app):
    client, *_ = controller_app
    await _idle_ready(controller_app, minutes=30)
    await _second_launch(
        controller_app, active_at=datetime.now(UTC) - timedelta(minutes=31)
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"


@pytest.mark.parametrize(
    "values",
    [
        {"state": "error", "error_code": "agent_crashed"},
        {"state": "stopped", "desired_state": "stopped"},
    ],
    ids=["crashed", "stopped"],
)
async def test_crashed_and_stopped_agents_do_not_keep_the_machine_awake(
    controller_app, values
):
    client, *_ = controller_app
    await _idle_ready(controller_app, minutes=30)
    await _second_launch(controller_app, **values)
    [item] = await list_machines(client)
    assert item["desired_state"] == "stopped"


async def test_machine_with_no_counted_agents_sleeps(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    await _idle_ready(controller_app, minutes=30, report=False)
    await update_launch(factory, request_id, state="stopped", desired_state="stopped")
    [item] = await list_machines(client)
    assert item["desired_state"] == "stopped"


async def _empty_machine(controller_app, **values) -> tuple[str, str]:
    """Another owner's machine that never hosted an agent, quiet for 31 minutes."""
    factory = controller_app[4]
    async with factory() as session:
        owner = User(
            name="empty", email="empty@example.com", role="user", password_hash="x"
        )
        session.add(owner)
        await session.flush()
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            slot_id="slot-b",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        machine.active_at = datetime.now(UTC) - timedelta(minutes=31)
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()
        return machine.id, owner.id


async def _listed(client, machine_id: str) -> dict:
    return {item["machine_id"]: item for item in await list_machines(client)}[
        machine_id
    ]


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
    client, _, _, service, _, _ = controller_app
    service.config.hosted_idle_stop_minutes = minutes
    machine_id, _ = await _empty_machine(controller_app, **values)
    before = datetime.now(UTC)
    item = await _listed(client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("retained", 2)
    assert before <= datetime.fromisoformat(item["retain_until"]) <= datetime.now(UTC)
    await observe(client, machine_id, state="retained", revision=2)
    assert (await _listed(client, machine_id))["desired_state"] == "deleted"


async def test_owner_stopped_empty_machine_is_left_alone(controller_app):
    client, *_ = controller_app
    machine_id, _ = await _empty_machine(
        controller_app, state="stopped", desired_state="stopped", stop_reason="owner"
    )
    item = await _listed(client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("stopped", 1)


async def test_errored_machine_that_never_hosted_an_agent_is_released(controller_app):
    client, _, _, service, _, _ = controller_app
    service.config.hosted_idle_stop_minutes = 30
    machine_id, _ = await _empty_machine(
        controller_app,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        updated_at=datetime.now(UTC) - timedelta(minutes=31),
    )
    before = datetime.now(UTC)
    item = await _listed(client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "retained",
        2,
    )
    assert before <= datetime.fromisoformat(item["retain_until"]) <= datetime.now(UTC)
    await observe(client, machine_id, state="retained", revision=2)
    item = await _listed(client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "retained",
        "deleted",
        3,
    )


async def test_errored_machine_that_hosted_an_agent_is_left_for_its_owner(
    controller_app,
):
    client, request_id, _, service, factory, _ = controller_app
    service.config.hosted_idle_stop_minutes = 30
    machine = await machine_of(factory, request_id)
    await update_launch(factory, request_id, state="deleted", desired_state="deleted")
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        updated_at=datetime.now(UTC) - timedelta(minutes=31),
    )
    [item] = await list_machines(client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "running",
        1,
    )


async def test_recently_errored_empty_machine_is_left_alone(controller_app):
    client, _, _, service, _, _ = controller_app
    service.config.hosted_idle_stop_minutes = 30
    machine_id, _ = await _empty_machine(
        controller_app,
        state="error",
        error="The instance failed its status checks.",
        updated_at=datetime.now(UTC) - timedelta(minutes=10),
    )
    item = await _listed(client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "running",
        1,
    )


async def test_idle_machine_whose_agents_were_removed_keeps_its_disk(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await _idle_ready(controller_app, minutes=30, report=False)
    await update_launch(factory, request_id, state="deleted", desired_state="deleted")
    before = datetime.now(UTC)
    [item] = await list_machines(client)
    assert item["desired_state"] == "retained"
    retain_until = datetime.fromisoformat(item["retain_until"])
    assert before + timedelta(days=7) <= retain_until
    assert retain_until <= datetime.now(UTC) + timedelta(days=7)


async def _claim(factory, owner_id: str) -> HostedMachine:
    async with factory() as session:
        await lock_launches(session)
        machine = await HostedMachineStore().claim(
            session,
            owner_id=owner_id,
            slots=["slot-a", "slot-b"],
            capacity=2,
            now=datetime.now(UTC),
        )
        await session.commit()
        return machine


async def test_released_machine_is_revived_or_replaced_by_a_claim(controller_app):
    client, _, _, service, factory, _ = controller_app
    service.config.hosted_idle_stop_minutes = 30
    machine_id, owner_id = await _empty_machine(controller_app)
    assert (await _listed(client, machine_id))["desired_state"] == "retained"
    revived = await _claim(factory, owner_id)
    assert (revived.id, revived.desired_state, revived.retain_until) == (
        machine_id,
        "running",
        None,
    )
    await update_machine(factory, machine_id, state="deleted", desired_state="deleted")
    replaced = await _claim(factory, owner_id)
    assert replaced.id != machine_id
    assert (replaced.slot_id, replaced.desired_state) == ("slot-b", "running")


async def test_idle_stop_is_off_when_the_setting_is_zero(controller_app):
    client, *_ = controller_app
    await _idle_ready(controller_app, minutes=0)
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"
    assert item["revision"] == 1


async def test_only_a_ready_running_machine_is_put_to_sleep(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await _idle_ready(controller_app, minutes=30)
    machine = await machine_of(factory, request_id)
    await update_machine(factory, machine.id, state="provisioning")
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"


async def test_worker_renewal_is_bound_to_its_owner_and_selected_repository(
    controller_app,
):
    client, request_id, agent_id, _, factory, _ = controller_app
    renewed = await client.post("/hosted/github-credential")
    assert renewed.status_code == 200, renewed.text
    assert renewed.json()["repository"] == "example/project"
    assert renewed.headers["cache-control"] == "no-store"
    await update_launch(factory, request_id, agent_id=str(uuid4()))
    denied = await client.post("/hosted/github-credential")
    assert denied.status_code == 403
    assert "SYNTHETIC" not in denied.text


async def test_worker_claim_is_durable_and_stale_claim_is_not_replayed(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    conn = attach_worker(service, agent_id, request_id)
    operation_id = await _queued_operation(factory, request_id)
    claim_path = f"/hosted/operations/{operation_id}/claim"
    claimed_by = f"1:{conn.id}:{conn.stream_generation}"
    claim = await client.post(claim_path, json=fence(conn))
    assert claim.status_code == 200, claim.text
    assert claim.json()["id"] == operation_id
    assert claim.json()["state"] == "claimed"
    other_boot = attach_worker(
        service, agent_id, request_id, connection_id=conn.id, boot_id="boot-b"
    )
    second = await client.post(claim_path, json=fence(other_boot))
    assert second.status_code == 409
    conn = attach_worker(service, agent_id, request_id, connection_id=conn.id)
    async with factory() as session:
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        assert row.claimed_by == claimed_by
        assert row.claimed_boot_id == "boot-a"
        row.updated_at = datetime.now(UTC) - timedelta(minutes=6)
        await session.commit()
    async with factory() as session:
        await HostedLaunchStore().fail_stale_operations(session, request_id, 1)
        await session.commit()
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        assert row.state == "unknown"
    assert (
        await client.post(
            f"/hosted/operations/{operation_id}/result",
            json={**fence(conn), "state": "applied", "error": None},
        )
    ).status_code == 409


async def _queued_operation(factory, request_id: str, revision: int = 1) -> str:
    operation_id = str(uuid4())
    async with factory() as session:
        session.add(
            HostedOperation(
                id=operation_id,
                launch_id=request_id,
                launch_revision=revision,
                session_id=str(uuid4()),
                action="start",
            )
        )
        await session.commit()
    return operation_id


async def test_operation_claim_is_refused_to_a_non_worker(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    operation_id = await _queued_operation(factory, request_id)
    plain = service.connections.open(
        agent_id=agent_id,
        connection_id=str(uuid4()),
        scope="all",
        delivery_filter="all",
        spawn_capable=True,
        cursor=0,
        declaration=ClientDeclaration(speaks=7, accepts=1),
        expected_generation=None,
    )
    refused = await client.post(
        f"/hosted/operations/{operation_id}/claim", json=fence(plain)
    )
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "hosted_worker_only"
    worker = attach_worker(service, agent_id, request_id)
    stale = {**fence(worker), "generation": worker.stream_generation + 1}
    refused = await client.post(f"/hosted/operations/{operation_id}/claim", json=stale)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "generation_changed"


async def test_a_lost_claim_reply_is_offered_again_and_claimed_once(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    operation_id = await _queued_operation(factory, request_id)
    conn = attach_worker(service, agent_id, request_id)
    claim_path = f"/hosted/operations/{operation_id}/claim"
    assert (await client.post(claim_path, json=fence(conn))).status_code == 200

    idle = {
        "report_seq": 1,
        "relays_through": 0,
        "busy": False,
        "reasons": [],
        "sessions": {"total": 0, "live": 0, "parked": 0, "failed": 0},
    }
    report = await client.post(
        f"/agents/{agent_id}/connection/idle", json={**fence(conn), **idle}
    )
    assert report.status_code == 200, report.text
    assert report.json()["queued_operations"] == [operation_id]

    reattached = attach_worker(service, agent_id, request_id, connection_id=conn.id)
    again = await client.post(claim_path, json=fence(reattached))
    assert again.status_code == 200, again.text
    assert again.json()["state"] == "claimed"
    result = await client.post(
        f"/hosted/operations/{operation_id}/result",
        json={**fence(reattached), "state": "applied", "error": None},
    )
    assert result.status_code == 200
    report = await client.post(
        f"/agents/{agent_id}/connection/idle",
        json={**fence(reattached), **idle, "report_seq": 2},
    )
    assert report.json()["queued_operations"] == []
    assert (await client.post(claim_path, json=fence(reattached))).status_code == 409


async def test_lost_result_is_reposted_from_a_later_generation(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    operation_id = await _queued_operation(factory, request_id)
    conn = attach_worker(service, agent_id, request_id)
    claimed = await client.post(
        f"/hosted/operations/{operation_id}/claim", json=fence(conn)
    )
    assert claimed.status_code == 200
    reattached = attach_worker(service, agent_id, request_id, connection_id=conn.id)
    result_path = f"/hosted/operations/{operation_id}/result"
    body = {**fence(reattached), "state": "applied", "error": None}
    first = await client.post(result_path, json=body)
    assert first.status_code == 200, first.text
    assert first.json()["state"] == "applied"
    again = await client.post(result_path, json=body)
    assert again.status_code == 200
    other_boot = attach_worker(
        service, agent_id, request_id, connection_id=conn.id, boot_id="boot-b"
    )
    refused = await client.post(
        result_path, json={**fence(other_boot), "state": "applied", "error": None}
    )
    assert refused.status_code == 409


async def test_provider_refresh_and_revocation_are_owner_bound(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    response = await client.post("/hosted/provider-credential")
    assert response.status_code == 200
    assert response.json()["status"] == "connected"
    assert response.headers["cache-control"] == "no-store"
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        await ProviderConnectionStore().delete(session, launch.owner_id)
        await session.commit()
    assert (await client.post("/hosted/provider-credential")).json() == {
        "status": "revoked"
    }
    await update_launch(factory, request_id, desired_state="deleted")
    assert (await client.post("/hosted/provider-credential")).status_code == 403
    assert (await client.post("/hosted/github-credential")).status_code == 403


async def test_provider_status_waits_then_rejects_replaced_revision(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    old = (await client.post("/hosted/provider-credential")).json()
    async with factory() as writer:
        launch = await writer.get(HostedLaunch, (require_tenant_id(), request_id))
        await ProviderConnectionStore().lock_user(writer, launch.owner_id)
        connection = await writer.get(
            ProviderConnection, (require_tenant_id(), launch.owner_id, "claude")
        )
        replacement = connection.verified_at + timedelta(seconds=1)
        connection.verified_at = replacement
        connection.verification_status = "configured"
        request = asyncio.create_task(
            client.post(
                "/hosted/provider-status",
                json={
                    "authenticated": True,
                    "revision": old["revision"],
                },
            )
        )
        try:
            await asyncio.sleep(0.05)
            assert not request.done()
        finally:
            await writer.commit()
        response = await asyncio.wait_for(request, timeout=5)
        assert response.status_code == 409
    async with factory() as db:
        saved = await db.get(
            ProviderConnection, (require_tenant_id(), launch.owner_id, "claude")
        )
        assert saved.verified_at == replacement
        assert saved.verification_status == "configured"


@pytest.mark.parametrize("desired", ["stopped", "deleted"])
async def test_provider_status_does_not_overwrite_stop_during_lock_wait(
    controller_app, desired
):
    client, request_id, _, _, factory, _ = controller_app
    old = (await client.post("/hosted/provider-credential")).json()
    async with factory() as writer:
        launch = await writer.get(HostedLaunch, (require_tenant_id(), request_id))
        await ProviderConnectionStore().lock_user(writer, launch.owner_id)
        request = asyncio.create_task(
            client.post(
                "/hosted/provider-status",
                json={"authenticated": False, "revision": old["revision"]},
            )
        )
        try:
            await asyncio.sleep(0.05)
            assert not request.done()
            launch.desired_state = desired
            launch.state = "stopping"
        finally:
            await writer.commit()
        response = await asyncio.wait_for(request, timeout=5)
        assert response.status_code == 409
    async with factory() as db:
        saved = await db.get(HostedLaunch, (require_tenant_id(), request_id))
        assert saved.desired_state == desired
        assert saved.state == "stopping"


@pytest.mark.parametrize("change", ["stop", "relink", "disconnect", "revoke_failure"])
async def test_worker_token_is_revoked_when_authorization_changes_during_issue(
    controller_app, monkeypatch, change
):
    client, request_id, _, _, factory, _ = controller_app
    revoke = AsyncMock(
        side_effect=RuntimeError("Synthetic revocation failure")
        if change == "revoke_failure"
        else None
    )

    async def issue(*args):
        async with factory() as session:
            await asyncio.wait_for(lock_launch(session, request_id), 1)
            launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
            if change in ("stop", "revoke_failure"):
                launch.desired_state = "stopped"
                launch.revision += 1
            else:
                row = await session.get(
                    ProviderConnection, (require_tenant_id(), launch.owner_id, "github")
                )
                if change == "disconnect":
                    await session.delete(row)
                else:
                    row.verified_at = datetime.now(UTC) + timedelta(seconds=1)
            await session.commit()
        return RepositoryCredential(
            "SYNTHETIC-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )

    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=revoke),
    )
    response = await client.post("/hosted/github-credential")
    assert response.status_code == 409
    revoke.assert_awaited_once_with("SYNTHETIC-REPOSITORY")
    if change == "revoke_failure":
        async with factory() as session:
            queued = await session.scalar(
                select(GitHubIssuedToken).where(
                    GitHubIssuedToken.revoke_requested.is_(True)
                )
            )
            assert queued is not None
    assert "SYNTHETIC-REPOSITORY" not in response.text


async def test_local_registration_cannot_take_a_reserved_cloud_name(controller_app):
    _, request_id, agent_id, service, factory, _ = controller_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        owner_id = launch.owner_id
    with pytest.raises(AgentExistsError):
        await service.register_agent(
            name="cloud-helper",
            description="Local helper",
            connector_type="test",
            integration_profile=PROFILE,
            owner_id=owner_id,
        )
    async with factory() as session:
        agent = await session.scalar(select(Agent).where(Agent.name == "cloud-helper"))
        assert agent.id == agent_id


@pytest.mark.parametrize("state", ["queued", "claimed"])
async def test_operations_from_an_earlier_worker_are_not_claimed_or_completed(
    controller_app, state
):
    client, request_id, agent_id, service, factory, _ = controller_app
    conn = attach_worker(service, agent_id, request_id, revision=2)
    operation_id = str(uuid4())
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.revision = 2
        session.add(
            HostedOperation(
                id=operation_id,
                launch_id=request_id,
                launch_revision=1,
                session_id=str(uuid4()),
                action="start",
                state=state,
            )
        )
        await session.commit()
    claim = await client.post(
        f"/hosted/operations/{operation_id}/claim", json=fence(conn)
    )
    assert claim.status_code == 409
    response = await client.post(
        f"/hosted/operations/{operation_id}/result",
        json={**fence(conn), "state": "applied", "error": None},
    )
    assert response.status_code == 409
    async with factory() as session:
        await HostedLaunchStore().fail_stale_operations(session, request_id, 2)
        await session.commit()
    async with factory() as session:
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        assert row.state == ("unknown" if state == "claimed" else "failed")
        assert "worker changed" in row.error.lower()


async def _issue_repository_token(client) -> None:
    response = await client.post("/hosted/github-credential")
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("cause", ["stop", "owner_loss", "disconnect", "expired"])
async def test_repository_tokens_are_revoked_after_access_commit(
    controller_app, monkeypatch, cause
):
    client, request_id, _, service, factory, _ = controller_app
    await _issue_repository_token(client)
    async with factory() as session:
        record = await session.scalar(select(GitHubIssuedToken))
        assert "SYNTHETIC" not in record.encrypted_token
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        owner = launch.owner_id
        if cause == "stop":
            launch.desired_state = "stopped"
            launch.revision += 1
        elif cause == "owner_loss":
            await session.delete(
                await session.get(TenantMember, (require_tenant_id(), owner))
            )
        elif cause == "disconnect":
            await session.delete(
                await session.get(
                    ProviderConnection, (require_tenant_id(), owner, "github")
                )
            )
        else:
            record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    async def revoked(token):
        assert token == "SYNTHETIC-REPOSITORY"
        async with factory() as session:
            stored = await session.scalar(select(GitHubIssuedToken))
            assert stored.revoke_requested

    revoke = AsyncMock(side_effect=revoked)
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", revoke)
    async with factory() as session:
        assert await revoke_pending(session, service.config, ()) is False
        assert await revoke_pending(session, service.config, ()) is False
        assert await session.scalar(select(GitHubIssuedToken)) is None
    assert revoke.await_count == (0 if cause == "expired" else 1)


async def test_machines_listing_drains_pending_revocations(controller_app, monkeypatch):
    client, request_id, _, _, factory, _ = controller_app
    await _issue_repository_token(client)
    await update_launch(factory, request_id, desired_state="stopped", revision=2)
    revoke = AsyncMock()
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", revoke)
    await list_machines(client)
    revoke.assert_awaited_once_with("SYNTHETIC-REPOSITORY")
    async with factory() as session:
        assert await session.scalar(select(GitHubIssuedToken)) is None


async def test_failed_repository_revocation_remains_queued(controller_app, monkeypatch):
    client, request_id, _, service, factory, _ = controller_app
    await _issue_repository_token(client)
    async with factory() as session:
        await queue_revocation(session, (GitHubIssuedToken.launch_id == request_id,))
        await session.commit()
    revoke = AsyncMock(side_effect=RuntimeError("Synthetic failure"))
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", revoke)
    async with factory() as session:
        assert await revoke_pending(session, service.config, ()) is True
        record = await session.scalar(select(GitHubIssuedToken))
        assert record.revoke_requested
        await session.commit()
        revoke.side_effect = None
        assert await revoke_pending(session, service.config, ()) is False


async def test_error_retry_issues_a_fresh_repository_token(controller_app, monkeypatch):
    client, request_id, _, service, factory, _ = controller_app
    await _issue_repository_token(client)
    await update_launch(factory, request_id, state="error")
    async with factory() as session:
        assert await revoke_pending(session, service.config, ()) is False
        assert await session.scalar(select(GitHubIssuedToken)) is None
    await update_launch(factory, request_id, state="queued", revision=2)
    issue = AsyncMock(
        return_value=RepositoryCredential(
            "SYNTHETIC-FRESH-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=AsyncMock()),
    )
    result = await client.post("/hosted/github-credential")
    assert result.status_code == 200, result.text
    assert result.json()["token"] == "SYNTHETIC-FRESH-REPOSITORY"
    async with factory() as session:
        record = await session.scalar(select(GitHubIssuedToken))
        assert not record.revoke_requested
        assert record.launch_revision == 2


async def test_concurrent_revocation_drains_claim_once(controller_app, monkeypatch):
    client, request_id, _, service, factory, _ = controller_app
    await _issue_repository_token(client)
    async with factory() as session:
        await queue_revocation(session, ())
        await session.commit()
    entered, release = asyncio.Event(), asyncio.Event()

    async def revoke(token):
        entered.set()
        await release.wait()

    mocked = AsyncMock(side_effect=revoke)
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", mocked)

    async def drain():
        async with factory() as session:
            return await revoke_pending(session, service.config, ())

    first = asyncio.create_task(drain())
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert await drain() is True
        async with factory() as session:
            row = await session.scalar(select(GitHubIssuedToken))
            assert row.attempts == 1
            assert row.claim_until > datetime.now(UTC) + timedelta(seconds=60)
        mocked.assert_awaited_once()
    finally:
        release.set()
    assert await first is False
    async with factory() as session:
        assert await session.scalar(select(GitHubIssuedToken)) is None


async def test_revocation_lock_timeout_preserves_the_committed_sweep(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await _issue_repository_token(client)
    machine = await machine_of(factory, request_id)
    await update_machine(
        factory, machine.id, updated_at=datetime.now(UTC) - timedelta(minutes=11)
    )
    async with factory() as locked:
        await locked.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"github-revocation:{require_tenant_id()}"},
        )
        await queue_revocation(locked, ())
        listed = await list_machines(client)
        assert listed[0]["state"] == "error"
        await locked.rollback()
    assert (await machine_of(factory, request_id)).state == "error"


async def test_failed_revocations_do_not_starve_newer_tokens(
    controller_app, monkeypatch
):
    client, request_id, _, service, factory, _ = controller_app
    await _issue_repository_token(client)
    async with factory() as session:
        first = await session.scalar(select(GitHubIssuedToken))
        for number in range(8):
            session.add(
                GitHubIssuedToken(
                    id=str(uuid4()),
                    owner_id=first.owner_id,
                    launch_id=request_id,
                    launch_revision=1,
                    encrypted_token=TEST_KEYRING.encrypt(f"SYNTHETIC-TOKEN-{number}"),
                    expires_at=first.expires_at + timedelta(seconds=1),
                    revoke_requested=True,
                    attempts=0,
                )
            )
        first.revoke_requested = True
        await session.commit()
    seen = []

    async def fail(token):
        seen.append(token)
        raise RuntimeError("Synthetic outage")

    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", fail)
    async with factory() as session:
        assert await revoke_pending(session, service.config, ()) is True
        assert len(set(seen)) == 8
        assert await revoke_pending(session, service.config, ()) is True
    assert len(set(seen)) == 9


async def test_revocation_warning_is_scoped_to_action_owner(
    controller_app, monkeypatch
):
    client, request_id, _, service, factory, _ = controller_app
    await _issue_repository_token(client)
    async with factory() as session:
        first = await session.scalar(select(GitHubIssuedToken))
        owner = first.owner_id
        other_user = User(
            name="other",
            email="other-revocation@example.invalid",
            role="user",
            password_hash="x",
        )
        session.add(other_user)
        await session.flush()
        other = other_user.id
        other_launch = HostedLaunch(
            id=str(uuid4()), owner_id=other, name="other-revocation-worker", spec={}
        )
        session.add(other_launch)
        await session.flush()
        session.add(
            GitHubIssuedToken(
                id=str(uuid4()),
                owner_id=other,
                launch_id=other_launch.id,
                launch_revision=1,
                encrypted_token=TEST_KEYRING.encrypt("SYNTHETIC-OTHER-TOKEN"),
                expires_at=first.expires_at,
                revoke_requested=True,
                attempts=0,
            )
        )
        await session.commit()
    revoke = AsyncMock(side_effect=RuntimeError("Synthetic outage"))
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", revoke)
    async with factory() as session:
        assert (
            await revoke_pending(
                session, service.config, (GitHubIssuedToken.owner_id == owner,)
            )
            is False
        )
        revoke.assert_not_awaited()
        assert (
            await revoke_pending(
                session, service.config, (GitHubIssuedToken.owner_id == other,)
            )
            is True
        )


async def _interrupted_removal(controller_app, updated_at: datetime) -> None:
    """Leave the launch as a removal interrupted between its two commits."""
    _, request_id, agent_id, service, factory, _ = controller_app
    service.client_lifecycle.stop = AsyncMock()
    service.client_lifecycle.delete_record = AsyncMock(side_effect=ClientStore().delete)
    service.config.hosted_disk_retention_days = 7
    async with factory() as session:
        agent = await session.get(Agent, agent_id)
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.desired_state = "deleted"
        launch.state = "deleting"
        launch.revision = 2
        launch.deletion_cleanup = {
            "client_id": agent.client_id,
            "key_id": agent.api_key_id,
        }
        launch.updated_at = updated_at
        await session.commit()


async def test_sweep_finishes_an_interrupted_removal(controller_app):
    client, request_id, agent_id, _, factory, _ = controller_app
    async with factory() as session:
        key_id = (await session.get(Agent, agent_id)).api_key_id
    await _interrupted_removal(
        controller_app, datetime.now(UTC) - DELETING_RESUME_AFTER - timedelta(seconds=1)
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "retained"
    async with factory() as session:
        assert await session.get(Agent, agent_id) is None
        assert await session.get(ApiKey, key_id) is None
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert (launch.state, launch.name, launch.deletion_cleanup) == (
            "deleted",
            "removed:" + request_id,
            None,
        )


async def test_sweep_leaves_a_recent_removal_alone(controller_app):
    client, request_id, agent_id, _, factory, _ = controller_app
    await _interrupted_removal(controller_app, datetime.now(UTC))
    [item] = await list_machines(client)
    assert item["desired_state"] == "running"
    async with factory() as session:
        assert await session.get(Agent, agent_id) is not None
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch.state == "deleting"

"""A hosted agent's worker: attaching with its capability, and the up-calls only it may make."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException, WebSocketDisconnect
from sqlalchemy import event as orm_event
from sqlalchemy import select

from switch_core.bridges.agent.api import handlers
from switch_core.bridges.agent.api.handlers import (
    _open_connection,
    connection_placements,
    connection_socket,
    poll_events,
)
from switch_core.bridges.agent.api.hosted_cutover_routes import (
    router as hosted_cutover_router,
)
from switch_core.bridges.agent.api.hosted_routes import router as hosted_routes_router
from switch_core.bridges.agent.api.hosted_worker_routes import (
    router as hosted_worker_router,
)
from switch_core.bridges.agent.api.schemas import ConnectionPlacementsRequest
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config as get_worker_config
from switch_core.bridges.agent.dependencies import get_protocol as get_worker_protocol
from switch_core.bridges.agent.dependencies import get_session as get_worker_session
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    TAKEN_OVER,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.hosted_workers import ConsoleView
from switch_core.bridges.agent.protocol.stream import KEEPALIVE
from switch_core.db.models import (
    Agent,
    Client,
    HostedLaunch,
    HostedMachine,
    Message,
    ProviderConnection,
    Room,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import hosted_relay
from switch_core.gateway.auth import (
    create_jwt,
    get_current_user,
    get_current_user_in_transaction,
)
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.hosted_launches import register_identity
from switch_core.gateway.hosted_launches import router as launch_router
from switch_core.gateway.hosted_machines import router as machine_router
from switch_core.gateway.hosted_relay import router as relay_router
from switch_core.keys import Keyring
from switch_core.providers.github_installation import (
    GitHubInstallationCredentials,
    RepositoryCredential,
)
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
)
from tests.switch_core.hosted_machine_helpers import seed_launch, seed_machine

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

TOKEN = "SYNTHETIC-CONTROLLER-CREDENTIAL-FOR-TESTS"
HEADERS = {"Authorization": "Bearer " + TOKEN}
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
    "session_limit": 8,
}


@pytest.fixture
async def worker_app(session_factory, monkeypatch, tmp_path):
    """A running machine with one launch whose identity Core registered.

    Yields `(client, request_id, agent_id, service, factory, prepared)`, where
    `prepared` holds the worker capability for the launch's revision and the
    machine id.
    """
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
        machine = await seed_machine(
            session,
            owner_id=owner,
            slot_id="slot-a",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        machine_id = machine.id
        await seed_launch(
            session,
            machine=machine,
            request_id=request_id,
            name="cloud-helper",
            state="queued",
            desired_state="running",
            revision=1,
            agent_id=None,
            spec=SPEC,
        )
        await session.commit()
    service = make_service(session_factory)
    service.connections = AgentConnectionRegistry()
    service.event_buffer = EventBuffer(sequence_base=1 << 32)
    service.approval_outcomes = None
    service.config.hosted_sessions_per_agent = 8
    service.config.hosted_idle_stop_minutes = 0
    service.config.hosted_disk_retention_days = 7
    service.client_lifecycle.stop = AsyncMock()
    service.client_lifecycle.delete_record = AsyncMock(side_effect=ClientStore().delete)
    async with session_factory() as session:
        launch = await register_identity(session, service, request_id)
        agent_id = launch.agent_id
        assert agent_id is not None and launch.state == "queued"
        launch = await session.get(
            HostedLaunch, (require_tenant_id(), request_id), populate_existing=True
        )
        capability = HostedLaunchStore().issue_worker_capability(launch, TEST_KEYRING)
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
    app.include_router(hosted_routes_router)
    app.include_router(hosted_worker_router, prefix="/agents")
    app.include_router(hosted_cutover_router, prefix="/agents")
    app.include_router(launch_router)
    app.include_router(relay_router)
    app.include_router(machine_router)
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

    async def worker_agent():
        async with session_factory() as session:
            return await session.get(Agent, agent_id)

    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_current_user_in_transaction] = current_user
    app.dependency_overrides[get_session] = worker_session
    app.dependency_overrides[get_agent_from_scope] = worker_agent
    app.dependency_overrides[get_worker_config] = lambda: service.config
    app.dependency_overrides[get_worker_session] = worker_session
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
    prepared = {
        "worker_capability": capability,
        "revision": 1,
        "machine_id": machine_id,
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, request_id, agent_id, service, session_factory, prepared


async def _agent(factory, agent_id: str) -> Agent:
    async with factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        return agent


async def _open(
    service,
    agent: Agent,
    *,
    capability: str | None,
    connection_id: str | None = None,
    boot_id: str = "boot-a",
    speaks: int = PROTOCOL_VERSION,
    state_version: int | None = 1,
    expected_generation: int | None = None,
) -> Any:
    """Open the worker's connection as the socket does, and hand back its frames."""
    _conn, frames = await _open_connection(
        agent=agent,
        protocol=service,
        config=service.config,
        connection_id=connection_id or str(uuid4()),
        scope="all",
        event_filter="all",
        start_from="head",
        spawn_capable=True,
        declaration=ClientDeclaration(speaks=speaks),
        rooms=None,
        expected_generation=expected_generation,
        worker_capability=capability,
        host_boot_id=boot_id,
        host_instance_id="instance-a",
        worker_state_version=state_version,
    )
    return frames


async def _refusal(coro) -> tuple[int, str]:
    with pytest.raises(HTTPException) as caught:
        await coro
    detail = caught.value.detail
    return caught.value.status_code, detail["code"] if isinstance(detail, dict) else ""


async def _first_frames(frames, count: int) -> list[tuple[str, dict]]:
    received = []
    while len(received) < count:
        frame = await asyncio.wait_for(anext(frames), timeout=2)
        if frame is KEEPALIVE:
            continue
        received.append((frame.event, frame.data))
    return received


async def _bump(factory, request_id: str) -> None:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.revision += 1
        await session.commit()


async def issue_capability(factory, request_id: str) -> str:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        capability = HostedLaunchStore().issue_worker_capability(launch, TEST_KEYRING)
        await session.commit()
        return capability


async def set_machine(factory, machine_id: str, **values: Any) -> None:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()


async def _machine(factory, machine_id: str) -> HostedMachine:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        return machine


async def test_registered_identity_works_in_the_launch_worktree(worker_app):
    _, request_id, agent_id, _, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    options = agent.metadata_["known_agent_options"]
    assert options["repo_dir"] == f"/data/worktrees/{agent_id}/workspace"
    assert agent.metadata_["hosted_launch_id"] == request_id
    machine = await _machine(factory, prepared["machine_id"])
    assert machine.agents_version >= 1


async def test_capability_is_idempotent_by_revision(worker_app):
    _, request_id, agent_id, service, factory, prepared = worker_app
    assert await issue_capability(factory, request_id) == prepared["worker_capability"]
    await _bump(factory, request_id)
    third = await issue_capability(factory, request_id)
    assert third != prepared["worker_capability"]
    agent = await _agent(factory, agent_id)
    assert await _refusal(
        _open(service, agent, capability=prepared["worker_capability"])
    ) == (403, "worker_capability_obsolete")
    await _open(service, agent, capability=third)
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert prepared["worker_capability"] not in (
            launch.worker_capability_encrypted or ""
        )


async def test_worker_attach_requires_current_capability(worker_app):
    _, request_id, agent_id, service, factory, prepared = worker_app
    capability = prepared["worker_capability"]
    agent = await _agent(factory, agent_id)
    assert await _refusal(_open(service, agent, capability=None)) == (
        403,
        "worker_capability_required",
    )
    assert await _refusal(_open(service, agent, capability="not-it")) == (
        403,
        "worker_capability_obsolete",
    )
    assert await _refusal(_open(service, agent, capability=capability, speaks=6)) == (
        426,
        "upgrade_required",
    )
    for state_version in (None, 0):
        assert await _refusal(
            _open(service, agent, capability=capability, state_version=state_version)
        ) == (426, "upgrade_required")
    assert service.connections.for_agent(agent_id) == []

    response = await _open(service, agent, capability=capability)
    (conn,) = service.connections.for_agent(agent_id)
    assert conn.worker is not None and conn.worker.launch_revision == 1
    frames = await _first_frames(response, 2)
    assert frames[0][0] == "connection_state"
    assert frames[1][0] == "worker_attached"
    assert frames[1][1]["launch_revision"] == 1
    assert frames[1][1]["cancelled"] == []

    await _bump(factory, request_id)
    service.connections.supersede(agent_id, 2)
    assert service.connections.get(conn.id) is None
    assert not service.connections.ring_worker(agent_id, "operation", {"id": "x"})
    assert await _refusal(
        _open(service, agent, capability=capability, connection_id=conn.id)
    ) == (403, "worker_capability_obsolete")


async def test_local_console_cannot_take_over_hosted_stream(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    worker_id = str(uuid4())
    await _open(
        service,
        agent,
        capability=prepared["worker_capability"],
        connection_id=worker_id,
    )
    worker = service.connections.get(worker_id)
    generation = worker.stream_generation

    assert (await _refusal(_open(service, agent, capability=None)))[0] == 403
    assert (
        await _refusal(_open(service, agent, capability=None, connection_id=worker_id))
    )[0] == 403
    local_id = str(uuid4())
    placements = ConnectionPlacementsRequest(
        connection_id=local_id, generation=0, placements={}
    )
    assert await _refusal(
        connection_placements(agent_id, placements, agent, service)
    ) == (403, "hosted_worker_only")
    assert await _refusal(_poll(service, agent)) == (403, "hosted_worker_only")
    assert worker.stream_generation == generation
    assert service.connections.get(worker_id) is worker


async def _poll(service, agent: Agent) -> Any:
    return await poll_events(
        agent.id, agent, service, timeout=0, accept="application/json"
    )


async def test_second_worker_refused_while_first_alive(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    capability = prepared["worker_capability"]
    first = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=first)
    assert await _refusal(
        _open(service, agent, capability=capability, boot_id="boot-b")
    ) == (
        409,
        "worker_already_attached",
    )
    assert [conn.id for conn in service.connections.for_agent(agent_id)] == [first]


async def test_same_boot_takeover_evicts_old(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    capability = prepared["worker_capability"]
    first = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=first)
    old = service.connections.get(first)
    second = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=second)
    assert service.connections.get(first) is None
    assert old.closure is not None and old.closure.code == TAKEN_OVER.code
    assert service.connections.attached_worker(agent_id).id == second


async def test_same_connection_reattach_keeps_the_generation_fence(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    capability = prepared["worker_capability"]
    conn_id = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=conn_id)
    held = service.connections.get(conn_id).stream_generation
    await _open(
        service,
        agent,
        capability=capability,
        connection_id=conn_id,
        expected_generation=held,
    )
    conn = service.connections.get(conn_id)
    assert conn.stream_generation != held and conn.worker is not None
    status, code = await _refusal(
        _open(
            service,
            agent,
            capability=capability,
            connection_id=conn_id,
            expected_generation=held,
        )
    )
    assert status == 409


async def test_idle_report_answers_catch_up(worker_app):
    client, request_id, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    await _open(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    conn = service.connections.get(conn_id)
    body = {
        "connection_id": conn_id,
        "generation": conn.stream_generation,
        "report_seq": 1,
        "relays_through": 0,
        "busy": False,
        "reasons": [],
        "sessions": {"total": 0, "live": 0, "parked": 0, "failed": 0},
    }
    response = await client.post(f"/agents/{agent_id}/connection/idle", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["queued_operations"] == []
    assert response.json()["credential_revision"] is not None
    assert service.connections.fresh_idle_report(agent_id, request_id, 1) is not None
    stale = await client.post(
        f"/agents/{agent_id}/connection/idle",
        json={**body, "generation": conn.stream_generation + 1},
    )
    assert stale.status_code == 409


async def test_relay_reply_is_fenced(worker_app):
    client, request_id, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    await _open(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    conn = service.connections.get(conn_id)
    relay = service.connections.relays.register(
        tenant_id=require_tenant_id(),
        agent_id=agent_id,
        binding=conn.worker,
        relay_seq=None,
        core_boot=1,
        connection_id=conn_id,
        generation=conn.stream_generation,
        timeout_ms=5000,
    )
    fence = {"connection_id": conn_id, "generation": conn.stream_generation}
    path = f"/agents/{agent_id}/connection/relay/{relay.id}"
    unknown = await client.post(
        f"/agents/{agent_id}/connection/relay/{uuid4()}",
        json={**fence, "ok": True, "value": 1},
    )
    assert unknown.status_code == 404
    stale = await client.post(
        path, json={**fence, "generation": conn.stream_generation + 1, "ok": True}
    )
    assert stale.status_code == 409
    too_large = await client.post(
        path,
        content=json.dumps({**fence, "ok": True, "value": "x" * (2 * 1024 * 1024)}),
        headers={"content-type": "application/json"},
    )
    assert too_large.status_code == 413
    answered = await client.post(path, json={**fence, "ok": True, "value": {"a": 1}})
    assert answered.status_code == 200, answered.text
    assert (await relay.future) == {"ok": True, "value": {"a": 1}}
    again = await client.post(path, json={**fence, "ok": True, "value": 2})
    assert again.status_code == 409


async def test_room_notice_requires_the_worker(worker_app):
    client, _, agent_id, service, factory, prepared = worker_app
    response = await client.post(
        f"/agents/{agent_id}/room-notices",
        json={
            "connection_id": str(uuid4()),
            "generation": 0,
            "room_id": "!room:example.com",
            "message_id": "$event",
            "thread_id": None,
            "reason": "startup",
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "generation_changed"


async def _ready_worker(worker_app) -> Any:
    _, request_id, agent_id, service, factory, prepared = worker_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "ready"
        await session.commit()
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    await _open(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    conn = service.connections.get(conn_id)
    conn.worker_frames.drain()
    return conn


async def _answer_relays(client, conn, value: Any, seen: list[dict]) -> None:
    while True:
        for event, data in conn.worker_frames.drain():
            if event != "relay":
                continue
            seen.append(data)
            await client.post(
                f"/agents/{conn.agent_id}/connection/relay/{data['id']}",
                json={
                    "connection_id": conn.id,
                    "generation": conn.stream_generation,
                    "ok": True,
                    "value": value,
                },
            )
        await asyncio.sleep(0.01)


async def _launch(factory, request_id: str) -> HostedLaunch:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch is not None
        return launch


async def test_read_only_relay_does_not_renew_activity(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    before = await _launch(factory, request_id)
    seen: list[dict] = []
    answering = asyncio.create_task(_answer_relays(client, conn, {"health": 1}, seen))
    try:
        response = await client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"health": True}, "timeout_ms": 5000},
        )
    finally:
        answering.cancel()
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["value"] == {"health": 1}
    assert response.json()["worker"]["generation"] == conn.stream_generation
    assert seen[0]["relay_seq"] is None
    after = await _launch(factory, request_id)
    assert after.relay_seq == before.relay_seq
    assert after.active_at == before.active_at


async def test_mutating_relay_takes_a_sequence(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    seen: list[dict] = []
    answering = asyncio.create_task(_answer_relays(client, conn, {"accepted": 1}, seen))
    try:
        response = await client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
        )
    finally:
        answering.cancel()
    assert response.status_code == 200, response.text
    assert seen[0]["relay_seq"] == 1
    assert seen[0]["deadline_ms"] > 0
    assert (await _launch(factory, request_id)).relay_seq == 1


async def test_relay_queue_refusal_takes_no_sequence(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    slots = [conn.worker_frames.reserve(1) for _ in range(64)]
    response = await client.post(
        f"/hosted-launches/{request_id}/relay",
        json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "worker_busy"
    assert (await _launch(factory, request_id)).relay_seq == 0
    for slot in slots:
        slot.release()


async def test_gateway_cancel_after_commit_still_enqueues(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    request = asyncio.create_task(
        client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
        )
    )
    for _ in range(200):
        if (await _launch(factory, request_id)).relay_seq == 1:
            break
        await asyncio.sleep(0.01)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    await asyncio.sleep(0.05)
    frames = [data for event, data in conn.worker_frames.drain() if event == "relay"]
    assert [frame["relay_seq"] for frame in frames] == [1]


async def test_relay_refusals(worker_app):
    client, request_id, agent_id, service, factory, _ = worker_app
    path = f"/hosted-launches/{request_id}/relay"
    missing = await client.post(
        f"/hosted-launches/{uuid4()}/relay",
        json={"message": {"health": True}, "timeout_ms": 1000},
    )
    assert missing.status_code == 404
    starting = await client.post(
        path, json={"message": {"health": True}, "timeout_ms": 1000}
    )
    assert starting.status_code == 409
    assert starting.json()["error"]["code"] == "worker_waking"
    await _ready_worker(worker_app)
    for message in ({"ensure": {}}, {"room": {}}, {"approvals": {}}):
        refused = await client.post(path, json={"message": message, "timeout_ms": 1000})
        assert refused.status_code == 400
        assert refused.json()["error"]["code"] == "refused_message"
    too_large = await client.post(
        path,
        content=json.dumps({"message": {"health": "x" * (2 * 1024 * 1024)}}),
        headers={"content-type": "application/json"},
    )
    assert too_large.status_code == 413


async def _relay_code(client, request_id: str, message: dict) -> tuple[int, dict]:
    response = await client.post(
        f"/hosted-launches/{request_id}/relay",
        json={"message": message, "timeout_ms": 1000},
    )
    return response.status_code, response.json()


READ_ONLY = {"health": True}


async def test_relay_error_codes_in_order(worker_app):
    client, request_id, _, service, factory, prepared = worker_app
    machine_id = prepared["machine_id"]
    await _ready_worker(worker_app)
    mutating = {"forget": str(uuid4())}

    await set_machine(
        factory, machine_id, desired_state="stopped", stop_reason="owner", revision=2
    )
    await set_launch_values(
        factory, request_id, state="error", error_code="agent_crashed"
    )
    for message in (READ_ONLY, mutating):
        status, body = await _relay_code(client, request_id, message)
        assert (status, body["error"]["code"]) == (409, "machine_stopped")
        assert "wake_available" not in body
    await set_launch_values(factory, request_id, state="ready", error_code=None)

    await set_machine(factory, machine_id, stop_reason="idle", state="stopped")
    status, body = await _relay_code(client, request_id, READ_ONLY)
    assert (status, body["error"]["code"]) == (409, "worker_sleeping")
    assert body["wake_available"] is True
    assert body["worker"]["sleeping"] is True
    assert body["worker"]["request_id"] == request_id
    assert (await _machine(factory, machine_id)).desired_state == "stopped"

    status, body = await _relay_code(client, request_id, mutating)
    assert (status, body["error"]["code"]) == (409, "worker_waking")
    assert body["worker"]["sleeping"] is False
    woken = await _machine(factory, machine_id)
    assert (woken.desired_state, woken.stop_reason, woken.revision) == (
        "running",
        None,
        3,
    )
    assert (await _launch(factory, request_id)).relay_seq == 0
    status, body = await _relay_code(client, request_id, READ_ONLY)
    assert body["error"]["code"] == "worker_waking"

    await set_machine(factory, machine_id, state="ready")
    await set_launch_values(
        factory, request_id, desired_state="stopped", state="stopped"
    )
    status, body = await _relay_code(client, request_id, mutating)
    assert (status, body["error"]["code"]) == (409, "agent_stopped")

    await set_launch_values(
        factory,
        request_id,
        desired_state="running",
        state="error",
        error_code="agent_crashed",
    )
    status, body = await _relay_code(client, request_id, READ_ONLY)
    assert (status, body["error"]["code"]) == (409, "agent_crashed")

    await set_launch_values(factory, request_id, state="ready", error_code=None)
    service.connections = AgentConnectionRegistry()
    status, body = await _relay_code(client, request_id, READ_ONLY)
    assert (status, body["error"]["code"]) == (409, "worker_not_attached")
    assert set(body["worker"]) >= {"machine_id", "process_state", "oom_kills"}


async def test_relay_to_an_errored_machine_is_machine_error(worker_app):
    client, request_id, _, _, factory, prepared = worker_app
    machine_id = prepared["machine_id"]
    await set_machine(factory, machine_id, state="error")
    assert (await _launch(factory, request_id)).state == "queued"
    for message in (READ_ONLY, {"forget": str(uuid4())}):
        status, body = await _relay_code(client, request_id, message)
        assert (status, body["error"]["code"]) == (409, "machine_error")
        assert "wake_available" not in body
    assert (await _launch(factory, request_id)).relay_seq == 0


async def test_relay_to_a_machine_needing_an_administrator_says_so(worker_app):
    client, request_id, _, _, factory, prepared = worker_app
    await set_machine(
        factory,
        prepared["machine_id"],
        state="error",
        error_code="machine_needs_attention",
    )
    status, body = await _relay_code(client, request_id, READ_ONLY)
    assert (status, body["error"]) == (
        409,
        {
            "code": "machine_error",
            "message": "The cloud machine needs attention. Contact your server administrator.",
        },
    )


async def test_relay_to_an_errored_owner_stopped_machine_is_machine_error(worker_app):
    client, request_id, _, _, factory, prepared = worker_app
    await _ready_worker(worker_app)
    await set_machine(
        factory,
        prepared["machine_id"],
        desired_state="stopped",
        stop_reason="owner",
        state="error",
        error_code="machine_needs_attention",
        revision=2,
    )
    for message in (READ_ONLY, {"forget": str(uuid4())}):
        status, body = await _relay_code(client, request_id, message)
        assert (status, body["error"]) == (
            409,
            {
                "code": "machine_error",
                "message": "The cloud machine needs attention. Contact your server administrator.",
            },
        )


async def test_relay_to_an_errored_sleeping_machine_does_not_wake_it(worker_app):
    client, request_id, _, _, factory, prepared = worker_app
    machine_id = prepared["machine_id"]
    await _ready_worker(worker_app)
    await set_machine(
        factory,
        machine_id,
        desired_state="stopped",
        stop_reason="idle",
        state="error",
        revision=2,
    )
    for message in (READ_ONLY, {"forget": str(uuid4())}):
        status, body = await _relay_code(client, request_id, message)
        assert (status, body["error"]["code"]) == (409, "machine_error")
        assert "wake_available" not in body
    machine = await _machine(factory, machine_id)
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "stopped",
        "idle",
        2,
    )


async def test_idle_sleep_wakes_only_for_a_running_agent(worker_app):
    client, request_id, _, _, factory, prepared = worker_app
    machine_id = prepared["machine_id"]
    await set_machine(
        factory,
        machine_id,
        desired_state="stopped",
        stop_reason="idle",
        state="stopped",
        revision=2,
    )
    await set_launch_values(
        factory, request_id, desired_state="stopped", state="stopped"
    )
    status, body = await _relay_code(client, request_id, {"forget": str(uuid4())})
    assert (status, body["error"]["code"]) == (409, "agent_stopped")
    assert (await _machine(factory, machine_id)).desired_state == "stopped"


async def test_mutating_relay_renews_the_machine(worker_app):
    client, request_id, _, _, factory, prepared = worker_app
    conn = await _ready_worker(worker_app)
    before = await _machine(factory, prepared["machine_id"])
    seen: list[dict] = []
    answering = asyncio.create_task(_answer_relays(client, conn, {"accepted": 1}, seen))
    try:
        response = await client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
        )
    finally:
        answering.cancel()
    assert response.status_code == 200, response.text
    after = await _machine(factory, prepared["machine_id"])
    assert after.active_at > before.active_at


async def set_launch_values(factory, request_id: str, **values: Any) -> None:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch is not None
        for key, value in values.items():
            setattr(launch, key, value)
        await session.commit()


async def test_relay_timeout_cancels_on_the_worker(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    response = await client.post(
        f"/hosted-launches/{request_id}/relay",
        json={"message": {"health": True}, "timeout_ms": 50},
    )
    assert response.status_code == 504
    events = [event for event, _ in conn.worker_frames.drain()]
    assert events == ["relay", "relay_cancel"]


async def test_auto_start_off_notice_is_posted_once(worker_app):
    client, _, agent_id, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    async with factory() as session:
        room = Room(
            transport_room_id=f"!{uuid4().hex[:8]}:example.com",
            name="r",
            description="",
        )
        session.add(room)
        await session.flush()
        room_id = room.id
        session.add(
            Message(
                seq=1,
                room_id=room_id,
                transport_event_id="$addressed",
                sender_id="@someone:example.com",
                event_type="m.room.message",
                msgtype="m.text",
                body="hello",
                content={"body": "hello"},
            )
        )
        sender = await session.scalar(
            select(Client.transport_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .where(Agent.id == agent_id)
        )
        await session.commit()
    sent: list[tuple[str, str]] = []

    async def send_message(agent, room, body, *, thread_id, extra_content):
        sent.append((room, body))
        async with factory() as session:
            session.add(
                Message(
                    seq=2 + len(sent),
                    room_id=room,
                    transport_event_id=f"$notice{len(sent)}",
                    sender_id=sender,
                    event_type="m.room.message",
                    msgtype="m.notice",
                    body=body,
                    content={"body": body, **extra_content},
                )
            )
            await session.commit()

    service.send_message = send_message
    notice = {
        "connection_id": conn.id,
        "generation": conn.stream_generation,
        "room_id": room_id,
        "message_id": "$addressed",
        "thread_id": None,
        "reason": "auto_start_off",
    }
    first = await client.post(f"/agents/{agent_id}/room-notices", json=notice)
    second = await client.post(f"/agents/{agent_id}/room-notices", json=notice)
    assert first.status_code == 200, first.text
    assert first.json()["posted"] is True
    assert second.json()["posted"] is False
    assert len(sent) == 1
    assert "not set to start one automatically" in sent[0][1]


@pytest.mark.parametrize("order", ["reply_then_teardown", "teardown_then_reply"])
@pytest.mark.parametrize("stage", ["dispatching", "awaiting_reply"])
async def test_gateway_cancel_with_teardown_and_immediate_reply(
    worker_app, caplog, order, stage
):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    app = client._transport.app
    request_sessions: list[str] = []

    async def tracked_session():
        async with factory() as session:
            request_sessions.append("open")
            try:
                yield session
            finally:
                request_sessions.append("closed")

    app.dependency_overrides[get_session] = tracked_session
    loop = asyncio.get_running_loop()
    loop_errors: list[dict[str, Any]] = []
    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
    try:
        request = asyncio.create_task(
            client.post(
                f"/hosted-launches/{request_id}/relay",
                json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
            )
        )
        frames: list[dict[str, Any]] = []
        deadline = loop.time() + 5
        while not frames and loop.time() < deadline:
            frames += [d for e, d in conn.worker_frames.drain() if e == "relay"]
            await asyncio.sleep(0.001)
        assert len(frames) == 1
        if stage == "awaiting_reply":
            for _ in range(20):
                await asyncio.sleep(0)
        reply = client.post(
            f"/agents/{conn.agent_id}/connection/relay/{frames[0]['id']}",
            json={
                "connection_id": conn.id,
                "generation": conn.stream_generation,
                "ok": True,
                "value": {"accepted": 1},
            },
        )
        if order == "reply_then_teardown":
            replying = asyncio.create_task(reply)
            request.cancel()
        else:
            request.cancel()
            replying = asyncio.create_task(reply)
        outcome, replied = await asyncio.gather(
            request, replying, return_exceptions=True
        )
        await asyncio.gather(*hosted_relay._dispatches)
    finally:
        loop.set_exception_handler(None)
    assert isinstance(outcome, asyncio.CancelledError)
    assert replied.status_code == 200, replied.text
    assert replied.json() == {"ok": True}
    assert frames[0]["relay_seq"] == 1
    assert conn.worker_frames.drain() == []
    assert (await _launch(factory, request_id)).relay_seq == 1
    assert request_sessions == ["open", "closed"]
    relays = service.connections.relays
    assert relays.get(frames[0]["id"]).future.done()
    assert not relays.mutating_pending(conn.agent_id, conn.worker.launch_id)
    assert loop_errors == []
    logged = caplog.text.lower()
    assert "session closed" not in logged
    assert "connection in use" not in logged
    assert "another operation is in progress" not in logged


async def test_relay_stream_shows_a_full_worker_queue(worker_app):
    _, request_id, agent_id, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    session_id = str(uuid4())
    slots = [conn.worker_frames.reserve(1) for _ in range(64)]
    stream = hosted_relay.relay_events(
        service,
        require_tenant_id(),
        agent_id,
        request_id,
        ConsoleView(frozenset({session_id})),
    )
    try:
        assert (await anext(stream)).startswith(b"event: worker\n")
        refused = (await anext(stream)).decode()
        assert refused.startswith("event: error\n")
        assert json.loads(refused.split("data: ", 1)[1]) == {
            "sessionId": session_id,
            "code": "worker_busy",
            "message": "The worker's frame queue is full. Retry shortly.",
        }
        for slot in slots:
            slot.release()
        retried = asyncio.create_task(anext(stream))
        for _ in range(300):
            frames = [d for e, d in conn.worker_frames.drain() if e == "relay"]
            if frames:
                break
            await asyncio.sleep(0.01)
        assert [frame["message"] for frame in frames] == [{"subscribe": session_id}]
        retried.cancel()
        with pytest.raises(asyncio.CancelledError):
            await retried
    finally:
        await stream.aclose()


WORKER_ATTACHED_FIELDS = {
    "launch_revision",
    "limits",
    "idle",
    "credential_revision",
    "queued_operations",
    "relay_fence",
    "cancelled",
}
RELAY_FIELDS = {"id", "deadline_ms", "relay_seq", "message"}


async def test_worker_attaches_answers_a_relay_and_reports_idle_over_the_wire(
    worker_app,
):
    client, request_id, agent_id, service, factory, prepared = worker_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "ready"
        await session.commit()
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    stream = await _open(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    (state, _), (attached_event, attached) = await _first_frames(stream, 2)
    assert (state, attached_event) == ("connection_state", "worker_attached")
    assert set(attached) == WORKER_ATTACHED_FIELDS
    generation = service.connections.get(conn_id).stream_generation

    sent_at_ms = int(time.time() * 1000)
    relaying = asyncio.create_task(
        client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"health": True}, "timeout_ms": 5000},
        )
    )
    ((relay_event, relay),) = await _first_frames(stream, 1)
    assert relay_event == "relay"
    assert set(relay) == RELAY_FIELDS
    assert relay["relay_seq"] is None
    assert relay["message"] == {"health": True}
    assert sent_at_ms + 4000 <= relay["deadline_ms"] <= int(time.time() * 1000) + 5000
    fence = {"connection_id": conn_id, "generation": generation}
    reply = await client.post(
        f"/agents/{agent_id}/connection/relay/{relay['id']}",
        json={**fence, "ok": True, "value": {"health": 1}},
    )
    assert reply.status_code == 200, reply.text
    relayed = await relaying
    assert relayed.status_code == 200, relayed.text
    assert relayed.json()["value"] == {"health": 1}

    idle = await client.post(
        f"/agents/{agent_id}/connection/idle",
        json={
            **fence,
            "report_seq": 1,
            "relays_through": attached["relay_fence"],
            "busy": False,
            "reasons": [],
            "sessions": {"total": 0, "live": 0, "parked": 0, "failed": 0},
        },
    )
    assert idle.status_code == 200, idle.text
    assert set(idle.json()) >= {"queued_operations", "credential_revision"}
    assert idle.json()["credential_revision"] == attached["credential_revision"]
    assert service.connections.fresh_idle_report(agent_id, request_id, 1) is not None


async def test_relay_with_real_auth_opens_two_transactions(worker_app):
    """Tenant resolution, then the user and the launch on one transaction."""
    client, request_id, _, service, factory, _ = worker_app
    await _ready_worker(worker_app)
    app = client._transport.app
    del app.dependency_overrides[get_current_user]
    del app.dependency_overrides[get_current_user_in_transaction]
    app.dependency_overrides[get_user_store] = UserStore
    service.config.gateway_tenant_choice_enabled = False
    owner = (await _launch(factory, request_id)).owner_id
    client.cookies.set(
        "switch_auth", create_jwt(owner, "owner@test", "user", TEST_KEYRING, None)
    )
    begins: list[object] = []
    engine = factory.kw["bind"].sync_engine
    listener = begins.append
    orm_event.listen(engine, "begin", listener)
    try:
        response = await client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"health": True}, "timeout_ms": 50},
        )
    finally:
        orm_event.remove(engine, "begin", listener)
    assert response.status_code == 504, response.text
    assert len(begins) == 2
    stranger = await client.post(
        f"/hosted-launches/{uuid4()}/relay",
        json={"message": {"health": True}, "timeout_ms": 50},
    )
    assert stranger.status_code == 404
    client.cookies.clear()
    assert (
        await client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"health": True}, "timeout_ms": 50},
        )
    ).status_code == 401


class _Socket:
    """The handler's side of a WebSocket, in this test's event loop.

    Records what is sent and how it closes, and hands the handler whatever the
    test queues as the client's messages; `None` is the client going away.
    """

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.close_code: int | None = None
        self._incoming: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._changed = asyncio.Event()

    async def accept(self) -> None:
        return None

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)
        self._changed.set()

    async def receive_json(self) -> dict[str, Any]:
        message = await self._incoming.get()
        if message is None:
            raise WebSocketDisconnect(1000)
        return message

    async def close(self, code: int = 1000) -> None:
        if self.close_code is None:
            self.close_code = code
        self._changed.set()

    def leave(self) -> None:
        self._incoming.put_nowait(None)

    async def frames(self, count: int) -> list[tuple[str, dict[str, Any]]]:
        """The next `count` frames sent, pings skipped."""

        def received() -> list[tuple[str, dict[str, Any]]]:
            return [(m["event"], m["data"]) for m in self.sent if m["event"] != "ping"]

        async def wait() -> None:
            while len(received()) < count:
                self._changed.clear()
                await self._changed.wait()

        await asyncio.wait_for(wait(), timeout=2)
        return received()[:count]


async def _open_socket(
    service,
    agent: Agent,
    *,
    capability: str | None,
    connection_id: str | None = None,
    speaks: int = PROTOCOL_VERSION,
    state_version: int | None = 1,
) -> tuple[_Socket, asyncio.Task[None]]:
    socket = _Socket()
    task = asyncio.create_task(
        connection_socket(
            websocket=socket,  # type: ignore[arg-type]
            agent_id=agent.id,
            agent=agent,
            protocol=service,
            config=service.config,
            connection_id=connection_id or str(uuid4()),
            scope="all",
            spawn_capable=True,
            protocol_version=speaks,
            worker_capability=capability,
            host_boot_id="boot-a",
            host_instance_id="instance-a",
            worker_state_version=state_version,
        )
    )
    return socket, task


@pytest.mark.parametrize(
    ("change", "refused"),
    [
        ({"capability": None}, (403, "worker_capability_required")),
        ({"capability": "not-it"}, (403, "worker_capability_obsolete")),
        ({"speaks": 6}, (426, "upgrade_required")),
        ({"state_version": None}, (426, "upgrade_required")),
    ],
)
async def test_the_socket_refuses_a_worker_open_as_the_stream_does(
    worker_app, change: dict[str, Any], refused: tuple[int, str]
):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    opening = {"capability": prepared["worker_capability"], **change}
    assert await _refusal(_open(service, agent, **opening)) == refused

    socket, task = await _open_socket(service, agent, **opening)
    await asyncio.wait_for(task, timeout=2)

    status, code = refused
    ((event, data),) = await socket.frames(1)
    assert event == "refused"
    assert data["status"] == status
    assert data["detail"]["code"] == code
    assert socket.close_code == 4000 + status
    assert service.connections.for_agent(agent_id) == []


async def test_a_worker_over_the_socket_is_sent_its_frames(worker_app, monkeypatch):
    # Pings every 50 ms, so the socket notices its client leave promptly.
    monkeypatch.setattr(handlers, "HEARTBEAT_INTERVAL_SECONDS", 0.05)
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    socket, task = await _open_socket(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    try:
        (state, _), (attached, data) = await socket.frames(2)
        assert (state, attached) == ("connection_state", "worker_attached")
        assert set(data) == WORKER_ATTACHED_FIELDS
        conn = service.connections.get(conn_id)
        assert conn.worker is not None and conn.stream_attached

        assert service.connections.ring_worker(agent_id, "wake", {"entries": []})
        assert (await socket.frames(3))[2] == ("wake", {"entries": []})
    finally:
        socket.leave()
        await asyncio.wait_for(task, timeout=2)

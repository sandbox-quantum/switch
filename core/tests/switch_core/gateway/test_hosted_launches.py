import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, text

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentExistsError
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.connections.broker import Principal, ServiceError
from switch_core.db.models import (
    Agent,
    HostedLaunch,
    HostedMachine,
    HostedOperation,
    ServiceGrant,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_machine_store import MACHINE_NEEDS_ATTENTION
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import (
    update_addressing_policy,
    update_agent_display_name,
    update_agent_icon,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_protocol, get_session
from switch_core.gateway.hosted_launches import router
from switch_core.gateway.schemas import (
    UpdateAddressingPolicyRequest,
    UpdateAgentDisplayNameRequest,
    UpdateAgentIconRequest,
)
from switch_core.keys import Keyring
from switch_core.providers.claude_verifier import ClaudeVerificationError
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_service,
    register,
)
from tests.switch_core.connections.github_seed import (  # noqa: F401
    connect_github,
    github_broker,
    github_vendor,
)
from tests.switch_core.hosted_machine_helpers import seed_machine

SERVICE_STORE = ServiceConnectionStore()
TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

ICON = "https://cdn.example.com/9.x/bottts/png?seed=helper"

SUMMARY_KEYS = {
    "request_id",
    "name",
    "provider",
    "state",
    "agent_id",
    "error",
    "error_code",
    "desired_state",
    "revision",
    "sleeping",
    "machine_id",
    "process_state",
    "process_restarts",
    "oom_kills",
}


@pytest.fixture
async def launch_app(session_factory, monkeypatch, github_vendor):  # noqa: F811
    async with session_factory() as session:
        owner = User(
            id="cloud-owner",
            name="Owner",
            email="cloud@example.com",
            role="user",
            password_hash="unused",
        )
        session.add(owner)
        await session.flush()
        await ProviderConnectionStore().save(
            session,
            owner.id,
            "setup-token",
            TEST_KEYRING.encrypt("SYNTHETIC-CREDENTIAL"),
            datetime.now(UTC),
        )
        await connect_github(session, owner.id, TEST_KEYRING)
        await session.commit()
    app = FastAPI()
    app.include_router(router)
    app.state.service_broker = github_broker(
        session_factory, TEST_KEYRING, github_vendor
    )
    verifier = AsyncMock()
    app.state.claude_verifier = verifier
    app.state.github_connections = object()
    app.state.hosted_controller_settings = SimpleNamespace(
        tenant_id=require_tenant_id(),
        machine_slots=["slot-a", "slot-b"],
    )
    config = SimpleNamespace(
        hosted_launch_capacity=1,
        hosted_agents_per_owner=3,
        hosted_sessions_per_agent=2,
        hosted_disk_retention_days=7,
        keyring=TEST_KEYRING,
    )
    protocol = make_service(session_factory)
    protocol.connections = AgentConnectionRegistry()
    protocol.event_buffer = EventBuffer(sequence_base=1 << 32)
    protocol.client_lifecycle.stop = AsyncMock()
    protocol.client_lifecycle.delete_record = AsyncMock(
        side_effect=ClientStore().delete
    )
    identity = {"user": owner}

    async def sessions():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_current_user] = lambda: identity["user"]
    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_protocol] = lambda: protocol
    access = AsyncMock(
        return_value={
            "installations": [
                {
                    "id": 123,
                    "repositories": [
                        {
                            "id": 456,
                            "name": "Example/Project",
                            "permissions": {"push": True},
                        }
                    ],
                }
            ]
        }
    )
    monkeypatch.setattr("switch_core.gateway.hosted_launches.connection_status", access)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield SimpleNamespace(
            client=client,
            verifier=verifier,
            access=access,
            config=config,
            identity=identity,
            factory=session_factory,
            protocol=protocol,
        )


def body(name: str = "helper"):
    return {
        "request_id": str(uuid4()),
        "name": name,
        "description": "Repository helper",
        "display_name": None,
        "icon_url": None,
        "instructions": "",
        "definition": f"---\nname: {name}\ndescription: Repository helper\n---\nRepository helper\n",
        "installation_id": 123,
        "repository_id": 456,
        "definition_attributes": {"model": "sonnet"},
        "auto_session": True,
        "auto_approve": False,
        "addressing_policy": None,
    }


async def _launch(factory, request_id: str) -> HostedLaunch:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch is not None
        return launch


async def _machine(factory, machine_id: str) -> HostedMachine:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        return machine


async def _update(factory, model, key: str, **values) -> None:
    async with factory() as session:
        row = await session.get(model, (require_tenant_id(), key))
        assert row is not None
        for name, value in values.items():
            setattr(row, name, value)
        await session.commit()


async def _lifecycle(app, request_id: str, action: str, revision: int):
    return await app.client.post(
        f"/hosted-launches/{request_id}/lifecycle",
        json={"action": action, "revision": revision},
    )


async def test_request_is_durable_idempotent_and_never_returns_credentials(launch_app):
    app = launch_app
    request = body()
    result = await app.client.post("/hosted-launches", json=request)
    assert result.status_code == 202
    assert result.json()["state"] == "queued"
    assert "SYNTHETIC" not in result.text
    app.verifier.verify.assert_awaited_once_with("setup-token", "SYNTHETIC-CREDENTIAL")
    second = await app.client.post("/hosted-launches", json=request)
    assert second.json() == result.json()
    assert app.verifier.verify.await_count == 1
    assert app.access.await_count == 1
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(HostedLaunch)) == 1
        assert await session.scalar(select(func.count()).select_from(Agent)) == 1
    app.identity["user"] = SimpleNamespace(id="someone-else")
    assert (
        await app.client.get("/hosted-launches/" + request["request_id"])
    ).status_code == 404


async def test_create_claims_a_machine_and_registers_the_identity(launch_app):
    app = launch_app
    created = await app.client.post("/hosted-launches", json=body())
    assert created.status_code == 202, created.text
    summary = created.json()
    assert set(summary) == SUMMARY_KEYS
    assert summary["sleeping"] is False
    assert summary["process_restarts"] == 0 and summary["oom_kills"] == 0
    agent_id = summary["agent_id"]
    assert agent_id is not None
    launch = await _launch(app.factory, summary["request_id"])
    assert launch.repository == "Example/Project"
    assert launch.machine_id == summary["machine_id"]
    async with app.factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None and agent.name == "helper"
        assert agent.metadata_["hosted_launch_id"] == launch.id
        assert (
            agent.metadata_["known_agent_options"]["repo_dir"]
            == f"/data/worktrees/{agent_id}/example/project"
        )
    machine = await _machine(app.factory, summary["machine_id"])
    assert (machine.slot_id, machine.state, machine.desired_state) == (
        "slot-a",
        "queued",
        "running",
    )
    versions = machine.agents_version
    assert versions >= 1

    other = await app.client.post("/hosted-launches", json=body("reviewer"))
    assert other.status_code == 202, other.text
    assert other.json()["machine_id"] == machine.id
    assert (await _machine(app.factory, machine.id)).agents_version > versions


async def test_create_refuses_without_a_machine(session_factory, launch_app):
    app = launch_app
    async with app.factory() as session:
        session.add(
            User(
                id="other-owner",
                name="Other",
                email="other@example.com",
                role="user",
                password_hash="unused",
            )
        )
        await session.flush()
        await seed_machine(
            session,
            owner_id="other-owner",
            slot_id="slot-a",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        await session.commit()
    full = await app.client.post("/hosted-launches", json=body())
    assert full.status_code == 409
    assert full.json()["detail"] == "no machine slot available"

    app.config.hosted_launch_capacity = 2
    created = await app.client.post("/hosted-launches", json=body())
    assert created.status_code == 202, created.text
    await _update(
        app.factory, HostedMachine, created.json()["machine_id"], state="error"
    )
    broken = await app.client.post("/hosted-launches", json=body("reviewer"))
    assert broken.status_code == 409
    assert broken.json()["detail"] == MACHINE_NEEDS_ATTENTION


async def test_identity_failure_is_an_error_that_retry_registers(
    launch_app, monkeypatch
):
    app = launch_app
    register_agent = app.protocol.register_agent
    monkeypatch.setattr(
        app.protocol,
        "register_agent",
        AsyncMock(side_effect=RuntimeError("synthetic registration failure")),
        raising=False,
    )
    created = await app.client.post("/hosted-launches", json=body())
    assert created.status_code == 202, created.text
    failed = created.json()
    assert (failed["state"], failed["error_code"], failed["agent_id"]) == (
        "error",
        "identity_failed",
        None,
    )
    assert failed["error"]
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Agent)) == 0

    monkeypatch.setattr(app.protocol, "register_agent", register_agent, raising=False)
    retried = await _lifecycle(app, failed["request_id"], "retry", failed["revision"])
    assert retried.status_code == 200, retried.text
    assert retried.json()["state"] == "queued"
    assert retried.json()["error_code"] is None
    assert retried.json()["agent_id"] is not None
    async with app.factory() as session:
        assert await session.get(Agent, retried.json()["agent_id"]) is not None


async def test_identity_failure_deletes_the_partial_agent_under_the_launch_lock(
    launch_app, monkeypatch
):
    app = launch_app
    register_agent = app.protocol.register_agent
    delete_agent = app.protocol.delete_agent
    partial: list[str] = []
    lock_free: list[bool] = []

    async def register_then_fail(**kwargs):
        await register_agent(**kwargs)
        partial.append(kwargs["reserved_agent_id"])
        raise RuntimeError("synthetic registration failure")

    async def probe_then_delete(*, agent_id):
        async with app.factory() as other:
            lock_free.append(
                await other.scalar(
                    text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {
                        "key": f"hosted-launch:{require_tenant_id()}:{request['request_id']}"
                    },
                )
            )
            await other.rollback()
        await delete_agent(agent_id=agent_id)

    monkeypatch.setattr(
        app.protocol, "register_agent", register_then_fail, raising=False
    )
    monkeypatch.setattr(app.protocol, "delete_agent", probe_then_delete, raising=False)
    request = body()
    created = await app.client.post("/hosted-launches", json=request)
    assert created.status_code == 202, created.text
    assert lock_free == [False]
    failed = created.json()
    assert (failed["state"], failed["error_code"], failed["agent_id"]) == (
        "error",
        "identity_failed",
        None,
    )
    async with app.factory() as session:
        assert await session.get(Agent, partial[0]) is None


async def test_a_taken_name_is_refused(launch_app, monkeypatch):
    app = launch_app
    await register(app.protocol, "helper", "cloud-owner")
    refused = await app.client.post("/hosted-launches", json=body())
    assert refused.status_code == 409
    assert refused.json()["detail"] == "An agent already uses this name."

    monkeypatch.setattr(
        app.protocol,
        "register_agent",
        AsyncMock(side_effect=AgentExistsError("taken meanwhile")),
        raising=False,
    )
    request = body("reviewer")
    raced = await app.client.post("/hosted-launches", json=request)
    assert raced.status_code == 422
    launch = await _launch(app.factory, request["request_id"])
    assert (launch.state, launch.error_code, launch.agent_id) == (
        "error",
        "identity_failed",
        None,
    )


async def test_disabled_server_refuses_before_verifying_credentials(launch_app):
    app = launch_app
    app.config.hosted_launch_capacity = 0
    assert (await app.client.post("/hosted-launches", json=body())).status_code == 503
    app.verifier.verify.assert_not_called()


async def test_expired_claude_or_missing_repository_never_queues(launch_app):
    app = launch_app
    app.verifier.verify.side_effect = ClaudeVerificationError(
        "Credential no longer works."
    )
    assert (await app.client.post("/hosted-launches", json=body())).status_code == 422
    app.access.assert_not_called()
    app.verifier.verify.side_effect = None
    app.access.return_value = {"installations": []}
    assert (await app.client.post("/hosted-launches", json=body())).status_code == 422
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(HostedLaunch)) == 0


async def test_changed_request_and_unexpected_credentials_are_rejected(launch_app):
    app = launch_app
    request = body()
    assert (await app.client.post("/hosted-launches", json=request)).status_code == 202
    assert (
        await app.client.post("/hosted-launches", json=request | {"name": "different"})
    ).status_code == 409
    assert (
        await app.client.post(
            "/hosted-launches", json=body() | {"credential": "SYNTHETIC"}
        )
    ).status_code == 422


@pytest.mark.parametrize("change", [{"instructions": "x" * 32768}])
async def test_rejects_unlaunchable_configuration_before_verifying_credentials(
    launch_app, change
):
    app = launch_app
    response = await app.client.post("/hosted-launches", json=body() | change)
    assert response.status_code == 422
    app.verifier.verify.assert_not_awaited()
    app.access.assert_not_awaited()


async def test_manual_cloud_agents_are_supported(launch_app):
    app = launch_app
    assert (
        await app.client.post("/hosted-launches", json=body() | {"auto_session": False})
    ).status_code == 202


async def test_lifecycle_owner_and_revision_guards(launch_app):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    request_id = created["request_id"]
    owner = app.identity["user"]
    app.identity["user"] = SimpleNamespace(id="someone-else")
    assert (await _lifecycle(app, request_id, "stop", 1)).status_code == 404
    app.identity["user"] = owner
    stopped = await _lifecycle(app, request_id, "stop", 1)
    assert stopped.json()["desired_state"] == "stopped"
    assert stopped.json()["state"] == "stopping"
    assert stopped.json()["revision"] == 2
    assert (await _lifecycle(app, request_id, "start", 1)).status_code == 409
    assert (await _lifecycle(app, request_id, "restart", 2)).status_code == 409
    assert (await _lifecycle(app, request_id, "retry", 2)).status_code == 409
    started = await _lifecycle(app, request_id, "start", 2)
    assert (started.json()["desired_state"], started.json()["state"]) == (
        "running",
        "queued",
    )
    await _update(app.factory, HostedLaunch, request_id, state="ready")
    restarted = await _lifecycle(app, request_id, "restart", 3)
    assert restarted.status_code == 200, restarted.text
    assert (restarted.json()["state"], restarted.json()["revision"]) == ("queued", 4)


async def test_start_wakes_a_stopped_machine(launch_app):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    machine_id = created["machine_id"]
    await _update(
        app.factory,
        HostedMachine,
        machine_id,
        desired_state="stopped",
        stop_reason="idle",
        state="stopped",
        revision=2,
    )
    url = f"/hosted-launches/{created['request_id']}"
    assert (await app.client.get(url)).json()["sleeping"] is True
    listed = (await app.client.get("/hosted-launches")).json()
    assert [launch["sleeping"] for launch in listed] == [True]
    stopped = await _lifecycle(app, created["request_id"], "stop", 1)
    assert (stopped.json()["state"], stopped.json()["sleeping"]) == ("stopped", True)
    await _update(app.factory, HostedMachine, machine_id, stop_reason="owner")
    started = await _lifecycle(app, created["request_id"], "start", 2)
    assert started.json()["desired_state"] == "running"
    assert started.json()["sleeping"] is False
    machine = await _machine(app.factory, machine_id)
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "running",
        None,
        3,
    )


async def test_retry_resets_the_process_counters(launch_app):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    request_id = created["request_id"]
    await _update(
        app.factory,
        HostedLaunch,
        request_id,
        state="error",
        error="The agent keeps crashing.",
        error_code="agent_crashed",
        process_restarts=5,
        process_oom_kills=2,
    )
    failed = (await app.client.get(f"/hosted-launches/{request_id}")).json()
    assert (failed["process_restarts"], failed["oom_kills"]) == (5, 2)
    retried = await _lifecycle(app, request_id, "retry", 1)
    assert retried.status_code == 200, retried.text
    summary = retried.json()
    assert (summary["state"], summary["error"], summary["error_code"]) == (
        "queued",
        None,
        None,
    )
    assert (summary["process_restarts"], summary["oom_kills"]) == (0, 0)
    assert summary["agent_id"] == created["agent_id"]


async def test_remove_in_any_state_retains_the_machine_only_when_empty(launch_app):
    app = launch_app
    app.config.hosted_agents_per_owner = 3
    first = (await app.client.post("/hosted-launches", json=body())).json()
    second = (await app.client.post("/hosted-launches", json=body("reviewer"))).json()
    machine_id = first["machine_id"]

    removed = await _lifecycle(app, first["request_id"], "remove", 1)
    assert removed.status_code == 200, removed.text
    assert (removed.json()["state"], removed.json()["name"]) == (
        "deleted",
        "removed:" + first["request_id"],
    )
    assert (await _machine(app.factory, machine_id)).desired_state == "running"
    async with app.factory() as session:
        assert await session.get(Agent, first["agent_id"]) is None
    assert (await _lifecycle(app, first["request_id"], "start", 2)).status_code == 409

    await _update(
        app.factory,
        HostedLaunch,
        second["request_id"],
        state="error",
        error_code="agent_failed",
    )
    last = await _lifecycle(app, second["request_id"], "remove", 1)
    assert last.status_code == 200, last.text
    machine = await _machine(app.factory, machine_id)
    assert machine.desired_state == "retained"
    retention = machine.retain_until - datetime.now(UTC)
    assert timedelta(days=7) - timedelta(minutes=1) < retention <= timedelta(days=7)
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Agent)) == 0
    reclaimed = await app.client.post("/hosted-launches", json=body("helper"))
    assert reclaimed.status_code == 202, reclaimed.text
    assert reclaimed.json()["machine_id"] == machine_id
    assert (await _machine(app.factory, machine_id)).desired_state == "running"


async def test_session_operation_status_is_owner_scoped(launch_app):
    app = launch_app
    request = body()
    await app.client.post("/hosted-launches", json=request)
    operation_id = str(uuid4())
    async with app.factory() as session:
        session.add(
            HostedOperation(
                id=operation_id,
                launch_id=request["request_id"],
                launch_revision=1,
                session_id=str(uuid4()),
                action="start",
            )
        )
        await session.commit()
    url = f"/hosted-launches/{request['request_id']}/sessions/{operation_id}"
    found = await app.client.get(url)
    assert found.status_code == 200
    assert found.json()["state"] == "queued"
    app.identity["user"] = SimpleNamespace(id="someone-else")
    assert (await app.client.get(url)).status_code == 404


async def test_stop_on_a_sleeping_machine_prevents_mention_wake(launch_app):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    await _update(
        app.factory,
        HostedMachine,
        created["machine_id"],
        desired_state="stopped",
        stop_reason="idle",
        state="stopped",
        revision=2,
    )
    stopped = await _lifecycle(app, created["request_id"], "stop", 1)
    assert stopped.status_code == 200
    assert stopped.json()["state"] == "stopped"
    async with app.factory() as session:
        launch, machine = await HostedLaunchStore().note_addressed(
            session, created["request_id"]
        )
        await session.commit()
    assert launch.desired_state == "stopped"
    assert launch.revision == 2
    assert (machine.desired_state, machine.revision) == ("stopped", 2)


async def test_read_only_repository_cannot_create_cloud_agent(launch_app):
    app = launch_app
    app.access.return_value["installations"][0]["repositories"][0]["permissions"] = {
        "pull": True
    }
    result = await app.client.post("/hosted-launches", json=body())
    assert result.status_code == 422
    assert "needs write access" in result.json()["detail"]


async def _interrupted_registration(app, monkeypatch, request: dict) -> str:
    """A launch whose agent id was recorded but whose agent was never registered."""
    register_agent = app.protocol.register_agent
    monkeypatch.setattr(
        app.protocol,
        "register_agent",
        AsyncMock(side_effect=RuntimeError("synthetic registration failure")),
        raising=False,
    )
    created = await app.client.post("/hosted-launches", json=request)
    assert created.status_code == 202, created.text
    monkeypatch.setattr(app.protocol, "register_agent", register_agent, raising=False)
    reserved = str(uuid4())
    await _update(
        app.factory,
        HostedLaunch,
        request["request_id"],
        state="queued",
        error=None,
        error_code=None,
        agent_id=reserved,
    )
    return reserved


async def test_create_retry_registers_an_interrupted_identity(launch_app, monkeypatch):
    app = launch_app
    request = body()
    reserved = await _interrupted_registration(app, monkeypatch, request)
    retried = await app.client.post("/hosted-launches", json=request)
    assert retried.status_code == 202, retried.text
    assert retried.json()["agent_id"] == reserved
    async with app.factory() as session:
        agent = await session.get(Agent, reserved)
        assert agent is not None
        assert agent.metadata_["hosted_launch_id"] == request["request_id"]
    again = await app.client.post("/hosted-launches", json=request)
    assert again.json()["agent_id"] == reserved
    async with app.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Agent)) == 1


@pytest.mark.parametrize(
    ("state", "action"), [("error", "retry"), ("stopped", "start")]
)
async def test_lifecycle_registers_an_interrupted_identity(
    launch_app, monkeypatch, state, action
):
    app = launch_app
    request = body()
    reserved = await _interrupted_registration(app, monkeypatch, request)
    await _update(
        app.factory,
        HostedLaunch,
        request["request_id"],
        state=state,
        desired_state="running" if state == "error" else "stopped",
    )
    launch = await _launch(app.factory, request["request_id"])
    result = await _lifecycle(app, request["request_id"], action, launch.revision)
    assert result.status_code == 200, result.text
    assert result.json()["agent_id"] == reserved
    async with app.factory() as session:
        assert await session.get(Agent, reserved) is not None


async def _ready_launch(app) -> dict:
    created = (await app.client.post("/hosted-launches", json=body())).json()
    await _update(app.factory, HostedLaunch, created["request_id"], state="ready")
    await _update(
        app.factory, HostedMachine, created["machine_id"], state="ready", revision=2
    )
    return created


async def _session_operation(app, request_id: str, operation_id: str | None = None):
    return await app.client.post(
        f"/hosted-launches/{request_id}/sessions",
        json={
            "id": operation_id or str(uuid4()),
            "session_id": str(uuid4()),
            "action": "start",
        },
    )


async def _operation_count(factory) -> int:
    async with factory() as session:
        return await session.scalar(select(func.count()).select_from(HostedOperation))


@pytest.mark.parametrize(
    ("machine", "code", "message"),
    [
        (
            {"state": "error"},
            "machine_error",
            "The cloud machine needs attention. Retry it in Switch Console.",
        ),
        (
            {"state": "error", "error_code": "machine_needs_attention"},
            "machine_error",
            "The cloud machine needs attention. Contact your server administrator.",
        ),
        (
            {"state": "stopped", "desired_state": "stopped", "stop_reason": "owner"},
            "machine_stopped",
            "The owner stopped the cloud machine. Start it in Switch Console.",
        ),
        (
            {"state": "provisioning"},
            "worker_waking",
            "The cloud machine is starting. Try again in a moment.",
        ),
    ],
)
async def test_session_operation_refuses_a_machine_that_is_not_ready(
    launch_app, machine, code, message
):
    app = launch_app
    created = await _ready_launch(app)
    await _update(app.factory, HostedMachine, created["machine_id"], **machine)
    refused = await _session_operation(app, created["request_id"])
    assert refused.status_code == 409
    assert refused.json() == {"detail": message, "code": code}
    assert await _operation_count(app.factory) == 0
    assert (await _machine(app.factory, created["machine_id"])).revision == 2


async def test_session_operation_wakes_a_sleeping_machine(launch_app):
    app = launch_app
    created = await _ready_launch(app)
    await _update(
        app.factory,
        HostedMachine,
        created["machine_id"],
        state="stopped",
        desired_state="stopped",
        stop_reason="idle",
    )
    before = await _launch(app.factory, created["request_id"])
    waking = await _session_operation(app, created["request_id"])
    assert waking.status_code == 409
    assert waking.json()["code"] == "worker_waking"
    machine = await _machine(app.factory, created["machine_id"])
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "running",
        None,
        3,
    )
    assert (
        await _launch(app.factory, created["request_id"])
    ).active_at > before.active_at
    assert await _operation_count(app.factory) == 0


async def test_session_operation_is_queued_on_a_ready_machine_and_replayed(
    launch_app,
):
    app = launch_app
    created = await _ready_launch(app)
    operation_id = str(uuid4())
    body_ = {"id": operation_id, "session_id": str(uuid4()), "action": "start"}
    url = f"/hosted-launches/{created['request_id']}/sessions"
    queued = await app.client.post(url, json=body_)
    assert queued.status_code == 202, queued.text
    await _update(
        app.factory,
        HostedMachine,
        created["machine_id"],
        state="stopped",
        desired_state="stopped",
        stop_reason="owner",
    )
    replayed = await app.client.post(url, json=body_)
    assert replayed.status_code == 202
    assert replayed.json()["id"] == operation_id


async def _restartable(app, action: str, stop_reason: str) -> dict:
    """A launch that `action` accepts, on a machine stopped for `stop_reason`."""
    created = (await app.client.post("/hosted-launches", json=body())).json()
    launch_state = {"start": "stopped", "restart": "ready", "retry": "error"}[action]
    await _update(app.factory, HostedLaunch, created["request_id"], state=launch_state)
    await _update(
        app.factory,
        HostedMachine,
        created["machine_id"],
        state="stopped",
        desired_state="stopped",
        stop_reason=stop_reason,
        revision=2,
    )
    return created


@pytest.mark.parametrize("action", ["restart", "retry"])
async def test_restart_and_retry_do_not_start_an_owner_stopped_machine(
    launch_app, action
):
    app = launch_app
    created = await _restartable(app, action, "owner")
    refused = await _lifecycle(app, created["request_id"], action, 1)
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": "The owner stopped the cloud machine. Start it in Switch Console.",
        "code": "machine_stopped",
    }
    machine = await _machine(app.factory, created["machine_id"])
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "stopped",
        "owner",
        2,
    )
    assert (await _launch(app.factory, created["request_id"])).revision == 1


@pytest.mark.parametrize("action", ["start", "restart", "retry"])
@pytest.mark.parametrize(
    "error_code,message",
    [
        (
            None,
            "The cloud machine needs attention. Retry it in Switch Console.",
        ),
        (
            "machine_needs_attention",
            "The cloud machine needs attention. Contact your server administrator.",
        ),
    ],
)
async def test_restart_and_retry_refuse_an_errored_machine_even_if_owner_stopped(
    launch_app, action, error_code, message
):
    app = launch_app
    created = await _restartable(app, action, "owner")
    machine_updates = {"state": "error", "revision": 3}
    if error_code is not None:
        machine_updates["error_code"] = error_code
    await _update(app.factory, HostedMachine, created["machine_id"], **machine_updates)
    refused = await _lifecycle(app, created["request_id"], action, 1)
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": message,
        "code": "machine_error",
    }
    machine = await _machine(app.factory, created["machine_id"])
    assert machine.state == "error"
    assert (await _launch(app.factory, created["request_id"])).revision == 1


@pytest.mark.parametrize("action", ["restart", "retry"])
async def test_restart_and_retry_wake_an_idle_sleeping_machine(launch_app, action):
    app = launch_app
    created = await _restartable(app, action, "idle")
    result = await _lifecycle(app, created["request_id"], action, 1)
    assert result.status_code == 200, result.text
    assert result.json()["state"] == "queued"
    machine = await _machine(app.factory, created["machine_id"])
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "running",
        None,
        3,
    )


def _configuration(
    definition: str = "---\nname: helper\nmodel: opus\n---\nBe brief.\n",
):
    return {
        "instructions": "Be brief.",
        "definition": definition,
        "definition_attributes": {"model": "opus"},
    }


async def test_owner_updates_the_configuration_the_next_start_runs(launch_app):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    url = f"/hosted-launches/{created['request_id']}/configuration"
    assert (await app.client.get(url)).json() == {
        "description": "Repository helper",
        "instructions": "",
        "definition_attributes": {"model": "sonnet"},
    }
    updated = await app.client.put(url, json=_configuration())
    assert updated.status_code == 200, updated.text
    assert updated.json() == {
        "description": "Repository helper",
        "instructions": "Be brief.",
        "definition_attributes": {"model": "opus"},
    }
    assert (await app.client.get(url)).json() == updated.json()
    launch = await _launch(app.factory, created["request_id"])
    assert launch.revision == 1
    assert launch.spec["definition"] == _configuration()["definition"].strip()
    assert launch.spec["session_limit"] == 2
    assert launch.spec["name"] == "helper"
    await _lifecycle(app, created["request_id"], "stop", 1)
    started = await _lifecycle(app, created["request_id"], "start", 2)
    assert started.json()["revision"] == 3
    launch = await _launch(app.factory, created["request_id"])
    assert launch.spec["instructions"] == "Be brief."
    assert launch.spec["definition_attributes"] == {"model": "opus"}


async def test_configuration_is_owner_scoped(launch_app):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    url = f"/hosted-launches/{created['request_id']}/configuration"
    app.identity["user"] = SimpleNamespace(id="someone-else")
    assert (await app.client.get(url)).status_code == 404
    assert (await app.client.put(url, json=_configuration())).status_code == 404
    launch = await _launch(app.factory, created["request_id"])
    assert launch.spec["instructions"] == ""


async def test_configuration_of_a_removed_launch_is_refused(launch_app):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    await _lifecycle(app, created["request_id"], "remove", 1)
    response = await app.client.put(
        f"/hosted-launches/{created['request_id']}/configuration",
        json=_configuration(),
    )
    assert response.status_code == 409


@pytest.mark.parametrize(
    "change",
    [
        {"definition": ""},
        {"instructions": "x" * 32769},
        {"instructions": "x" * 20000, "definition": "y" * 20000},
        {"definition_attributes": "opus"},
        {"model": "opus"},
    ],
)
async def test_invalid_configuration_is_refused(launch_app, change):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    response = await app.client.put(
        f"/hosted-launches/{created['request_id']}/configuration",
        json=_configuration() | change,
    )
    assert response.status_code == 422
    launch = await _launch(app.factory, created["request_id"])
    assert launch.spec["definition_attributes"] == {"model": "sonnet"}


async def test_identity_edits_keep_the_launch_spec_that_registers_it_again(
    launch_app,
):
    app = launch_app
    created = (await app.client.post("/hosted-launches", json=body())).json()
    agent_id = created["agent_id"]
    owner = app.identity["user"]
    policy = {"rules": [{"users": [], "agents": [], "owner": True}]}
    async with app.factory() as session:
        await update_agent_display_name(
            agent_id,
            UpdateAgentDisplayNameRequest(display_name="Helper"),
            session,
            AgentStore(),
            owner,
            False,
        )
        await update_agent_icon(
            agent_id,
            UpdateAgentIconRequest(icon_url=ICON),
            session,
            AgentStore(),
            owner,
            False,
        )
        await update_addressing_policy(
            agent_id,
            UpdateAddressingPolicyRequest.model_validate({"policy": policy}),
            session,
            AgentStore(),
            RoomStore(),
            UserStore(),
            SimpleNamespace(
                agent_session_store=AgentSessionStore(),
                room_role_store=RoomRoleStore(),
                connections=AgentConnectionRegistry(),
            ),
            owner,
            False,
        )
        agent = await session.get(Agent, agent_id, populate_existing=True)
        assert agent is not None
        stored_policy = agent.addressing_policy
    launch = await _launch(app.factory, created["request_id"])
    assert launch.spec["display_name"] == "Helper"
    assert launch.spec["icon_url"] == ICON
    assert launch.spec["addressing_policy"] == stored_policy
    assert launch.spec["definition_attributes"] == {"model": "sonnet"}


async def test_a_launch_grants_its_agent_the_repository(launch_app, github_vendor):  # noqa: F811
    app = launch_app
    created = await app.client.post("/hosted-launches", json=body())
    assert created.status_code == 202, created.text
    agent_id = created.json()["agent_id"]
    async with app.factory() as session:
        grant = await session.scalar(
            select(ServiceGrant).where(ServiceGrant.agent_id == agent_id)
        )
    assert grant is not None
    assert (grant.service, grant.access, grant.owner_id) == (
        "github",
        "write",
        "cloud-owner",
    )
    assert grant.resources == {"installation_id": 123, "repository_ids": [456]}
    assert github_vendor.checked == [
        ("SYNTHETIC-GITHUB", {"installation_id": 123, "repository_ids": [456]})
    ]


async def test_a_launch_change_revokes_its_agents_github_tokens(
    launch_app,
    github_vendor,  # noqa: F811
):
    app = launch_app
    created = await app.client.post("/hosted-launches", json=body())
    summary = created.json()
    async with app.factory() as session:
        session.add(
            TenantMember(
                tenant_id=require_tenant_id(), user_id="cloud-owner", role="member"
            )
        )
        await session.commit()
        issued = await github_broker(app.factory, TEST_KEYRING, github_vendor).issue(
            session, summary["agent_id"], Principal.agent_key(), "github"
        )

    stopped = await _lifecycle(app, summary["request_id"], "stop", summary["revision"])

    assert stopped.status_code == 200, stopped.text
    assert github_vendor.revoked == [issued.token]


async def test_a_stop_does_not_wait_on_a_refresh_and_takes_back_its_token(
    launch_app,
    github_vendor,  # noqa: F811
):
    app = launch_app
    created = await app.client.post("/hosted-launches", json=body())
    summary = created.json()
    async with app.factory() as session:
        session.add(
            TenantMember(
                tenant_id=require_tenant_id(), user_id="cloud-owner", role="member"
            )
        )
        await SERVICE_STORE.replace_secret(
            session,
            "cloud-owner",
            "github",
            revision=1,
            encrypted_secret=TEST_KEYRING.encrypt(
                json.dumps(
                    {
                        "access_token": "SYNTHETIC-GITHUB",
                        "expires_at": time.time() + 30,
                        "refresh_token": "SYNTHETIC-REFRESH",
                        "refresh_expires_at": time.time() + 7200,
                    }
                )
            ),
        )
        await session.commit()
    refreshing, release = asyncio.Event(), asyncio.Event()
    refresh = github_vendor.refresh

    async def slow_refresh(secret):
        refreshing.set()
        await release.wait()
        return await refresh(secret)

    github_vendor.refresh = slow_refresh  # type: ignore[method-assign]
    broker = github_broker(app.factory, TEST_KEYRING, github_vendor)

    async def fetch():
        async with app.factory() as session:
            return await broker.issue(
                session, summary["agent_id"], Principal.agent_key(), "github"
            )

    issuing = asyncio.create_task(fetch())
    await asyncio.wait_for(refreshing.wait(), 5)
    try:
        stopped = await asyncio.wait_for(
            _lifecycle(app, summary["request_id"], "stop", summary["revision"]), 5
        )
        assert stopped.status_code == 200, stopped.text
    finally:
        release.set()
    with pytest.raises(ServiceError) as caught:
        await issuing
    assert caught.value.code == "internal" and caught.value.retryable
    assert github_vendor.revoked == [github_vendor.issued[0][1]]

"""The shared hosted-machine wire fixtures are what Core really sends and accepts.

One launch is driven through the real routes: create, prepare, the controller's
observation, the supervisor's agent list and heartbeat, the controller's
machine list and the idle-stop sweep. Each response is compared with its
fixture; each request fixture is posted as it stands.
"""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from switch_core.bridges.agent.api.hosted_machine_routes import (
    router as hosted_machine_router,
)
from switch_core.bridges.agent.dependencies import get_config as get_worker_config
from switch_core.bridges.agent.dependencies import get_protocol as get_worker_protocol
from switch_core.bridges.agent.dependencies import (
    get_session_factory as get_worker_session_factory,
)
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.crypto import encrypt_token
from switch_core.db.models import (
    Agent,
    ApiKey,
    HostedLaunch,
    HostedMachine,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import router as controller_router
from switch_core.gateway.hosted_launches import router as launch_router
from switch_core.gateway.hosted_machines import router as machine_router
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
)
from tests.switch_core.hosted_wire_fixtures import (
    AGENT_ID,
    API_ENDPOINT,
    API_TOKEN,
    LAUNCH_ID,
    MACHINE_CAPABILITY,
    MACHINE_ID,
    TIMESTAMP,
    WORKER_CAPABILITY,
    assert_wire_fixture,
    read_fixture,
    request_fixture,
)

TOKEN = "SYNTHETIC-CONTROLLER-CREDENTIAL-FOR-TESTS"
CONTROLLER = {"Authorization": "Bearer " + TOKEN}
IDLE_STOP_MINUTES = 30

LAUNCH_REQUEST = {
    "request_id": LAUNCH_ID,
    "name": "reviewer",
    "description": "Reviews pull requests",
    "display_name": None,
    "icon_url": None,
    "instructions": "Review each pull request you are asked about and post your findings in the room.",
    "provider": "claude",
    "definition": "---\nname: reviewer\ndescription: Reviews pull requests\n---\nYou review pull requests for correctness and clarity.\n",
    "installation_id": 123,
    "repository_id": 456,
    "definition_attributes": {"model": "sonnet"},
    "auto_session": True,
    "auto_approve": False,
    "addressing_policy": None,
}

RESPONSES: dict[str, dict[tuple[str, ...], Any]] = {
    "prepare_response.json": {("machine_capability",): MACHINE_CAPABILITY},
    "agents_response.json": {
        ("agents", "*", "worker_capability"): WORKER_CAPABILITY,
        ("agents", "*", "switch_credentials", "env", "SWITCH_API_TOKEN"): API_TOKEN,
    },
    "agents_response_unavailable.json": {},
    "heartbeat_response.json": {},
    "launch_summary.json": {},
    "machines_response.json": {},
    "machine_summary_sleeping.json": {("heartbeat_at",): TIMESTAMP},
}


@pytest.fixture
async def wire(session_factory, monkeypatch, tmp_path):
    owner = await make_owner(session_factory)
    async with session_factory() as session:
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner, role="member")
        )
        await ProviderConnectionStore().save(
            session,
            owner,
            "setup-token",
            encrypt_token("SYNTHETIC-CLAUDE", "test-secret"),
            datetime.now(UTC),
        )
        await session.commit()
    settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=TOKEN,
        machine_slots=["slot-a", "slot-b"],
        github_private_key_path="/tmp/synthetic-signing-key.pem",
        agent_api_endpoint=API_ENDPOINT,
    )
    settings_path = tmp_path / "controller.json"
    settings_path.write_text(
        json.dumps({**settings.model_dump(mode="json"), "token": TOKEN})
    )
    service = make_service(session_factory)
    service.connections = AgentConnectionRegistry()
    service.event_buffer = EventBuffer(sequence_base=1 << 32)
    service.config.hosted_launch_capacity = 4
    service.config.hosted_agents_per_owner = 3
    service.config.hosted_sessions_per_agent = 8
    service.config.hosted_disk_retention_days = 7
    service.config.hosted_idle_stop_minutes = IDLE_STOP_MINUTES
    service.config.hosted_controller_config_path = str(settings_path)
    monkeypatch.setattr(
        "switch_core.gateway.hosted_launches.connection_status",
        AsyncMock(
            return_value={
                "installations": [
                    {
                        "id": 123,
                        "repositories": [
                            {
                                "id": 456,
                                "name": "example-org/example-repo",
                                "permissions": {"push": True},
                            }
                        ],
                    }
                ]
            }
        ),
    )
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.state.claude_verifier = AsyncMock()
    app.state.github_connections = object()
    app.include_router(controller_router)
    app.include_router(hosted_machine_router)
    app.include_router(launch_router)
    app.include_router(machine_router)

    async def sessions():
        async with session_factory() as session:
            yield session

    async def current_user():
        async with session_factory() as session:
            return await session.get(User, owner)

    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: service.config
    app.dependency_overrides[get_protocol] = lambda: service
    app.dependency_overrides[get_worker_config] = lambda: service.config
    app.dependency_overrides[get_worker_session_factory] = lambda: session_factory
    app.dependency_overrides[get_worker_protocol] = lambda: service
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.test"
    ) as client:
        yield SimpleNamespace(client=client, factory=session_factory)


async def _row(factory, model, key: str):
    async with factory() as session:
        row = await session.get(model, (require_tenant_id(), key))
        assert row is not None
        return row


def _ok(response: httpx.Response, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json()


async def wire_flow(wire) -> tuple[dict[str, Any], dict[str, str]]:
    """Drive one launch through the real routes, returning each response by fixture name."""
    client, factory = wire.client, wire.factory
    bodies: dict[str, Any] = {}
    created = _ok(await client.post("/hosted-launches", json=LAUNCH_REQUEST), 202)
    machine_id, agent_id = created["machine_id"], created["agent_id"]
    placeholders = {MACHINE_ID: machine_id, AGENT_ID: agent_id}

    bodies["prepare_response.json"] = prepared = _ok(
        await client.post(
            f"/hosted-controller/machines/{machine_id}/prepare",
            headers=CONTROLLER,
            json={},
        )
    )

    observed = _ok(
        await client.post(
            f"/hosted-controller/machines/{machine_id}/observation",
            headers=CONTROLLER,
            json=request_fixture("controller_observation.json", placeholders),
        )
    )
    assert observed["state"] == "provisioning"
    assert (await _row(factory, HostedMachine, machine_id)).running_observed_at

    heartbeat = request_fixture("heartbeat_request.json", placeholders)
    supervisor = {
        "Authorization": "Bearer " + prepared["machine_capability"],
        "X-Switch-Host-Boot-Id": heartbeat["boot_id"],
        "X-Switch-Host-Instance-Id": heartbeat["instance_id"],
    }
    bodies["agents_response.json"] = _ok(
        await client.get(f"/hosted/machines/{machine_id}/agents", headers=supervisor)
    )

    bodies["heartbeat_response.json"] = _ok(
        await client.post(
            f"/hosted/machines/{machine_id}/heartbeat",
            headers=supervisor,
            json=heartbeat,
        )
    )
    machine = await _row(factory, HostedMachine, machine_id)
    assert machine.state == "ready"
    assert machine.heartbeat == heartbeat
    [report] = heartbeat["agents"]
    launch = await _row(factory, HostedLaunch, LAUNCH_ID)
    assert (
        launch.process_state,
        launch.process_restarts,
        launch.process_oom_kills,
        launch.process_exit,
    ) == (
        report["process_state"],
        report["restarts"],
        report["oom_kills"],
        report["exit"],
    )
    assert (launch.state, launch.error_code) == ("error", "agent_crashed")

    bodies["launch_summary.json"] = _ok(
        await client.get(f"/hosted-launches/{LAUNCH_ID}")
    )
    bodies["machines_response.json"] = _ok(
        await client.get("/hosted-controller/machines", headers=CONTROLLER)
    )

    async with factory() as session:
        row = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        row.active_at = datetime.now(UTC) - timedelta(minutes=IDLE_STOP_MINUTES + 1)
        await session.commit()
    [swept] = (
        _ok(await client.get("/hosted-controller/machines", headers=CONTROLLER))
    )["machines"]
    assert swept["desired_state"] == "stopped"
    _ok(
        await client.post(
            f"/hosted-controller/machines/{machine_id}/observation",
            headers=CONTROLLER,
            json={"state": "stopped", "revision": swept["revision"]},
        )
    )
    bodies["machine_summary_sleeping.json"] = _ok(
        await client.get(f"/hosted-machines/{machine_id}")
    )

    async with factory() as session:
        agent = await session.get(Agent, agent_id)
        key = await session.get(ApiKey, agent.api_key_id)
        key.encrypted_key = ""
        await session.commit()
    bodies["agents_response_unavailable.json"] = _ok(
        await client.get(f"/hosted/machines/{machine_id}/agents", headers=supervisor)
    )
    return bodies, placeholders


@pytest.mark.parametrize("name", sorted(RESPONSES))
async def test_response_fixture_is_real_core_output(wire, name):
    bodies, placeholders = await wire_flow(wire)
    assert_wire_fixture(
        name, bodies[name], placeholders=placeholders, volatile=RESPONSES[name]
    )


def test_request_fixtures_carry_exactly_the_contract_fields():
    assert set(read_fixture("controller_observation.json")) == {
        "state",
        "revision",
        "error",
        "error_code",
        "data_volume_id",
        "instance_id",
        "instance_type",
    }
    heartbeat = read_fixture("heartbeat_request.json")
    assert set(heartbeat) == {
        "boot_id",
        "instance_id",
        "supervisor_version",
        "runtime_fingerprint",
        "disk",
        "memory",
        "agents",
    }
    assert set(heartbeat["disk"]) == {
        "path",
        "total_bytes",
        "used_bytes",
        "available_bytes",
    }
    assert set(heartbeat["memory"]) == {"total_bytes", "available_bytes"}
    [agent] = heartbeat["agents"]
    assert set(agent) == {
        "launch_id",
        "agent_id",
        "revision",
        "process_state",
        "restarts",
        "oom_kills",
        "exit",
        "since",
    }
    assert set(agent["exit"]) == {"code", "signal", "result"}


def test_fixtures_name_the_same_machine_launch_and_agent():
    agents = read_fixture("agents_response.json")
    [listed] = agents["agents"]
    [reported] = read_fixture("heartbeat_request.json")["agents"]
    launch = read_fixture("launch_summary.json")
    assert (reported["launch_id"], reported["agent_id"], reported["revision"]) == (
        listed["launch_id"],
        listed["agent_id"],
        listed["revision"],
    )
    assert (launch["request_id"], launch["agent_id"]) == (LAUNCH_ID, AGENT_ID)
    assert (listed["launch_id"], listed["agent_id"]) == (LAUNCH_ID, AGENT_ID)
    assert {
        agents["machine_id"],
        launch["machine_id"],
        read_fixture("prepare_response.json")["machine_id"],
        read_fixture("machine_summary_sleeping.json")["machine_id"],
        *(
            item["machine_id"]
            for item in read_fixture("machines_response.json")["machines"]
        ),
    } == {MACHINE_ID}
    assert read_fixture("machine_summary_sleeping.json")["agents"] == [LAUNCH_ID]

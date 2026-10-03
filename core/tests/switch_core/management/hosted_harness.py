"""A management harness with cloud machines: the routes a cloud machine's
supervisor, its agents controller and its agents' workers call.

Built on `harness.build_harness`: the agent bridge app additionally mounts
the hosted routers the server mounts (machine, worker, cutover and
`/hosted/...`), with a config that names a cloud machines settings file, so
a machine's supervisor can enroll its controller and the controller can act
for its cloud agents through the real bearer middleware.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import dependencies as bridge_deps
from switch_core.bridges.agent.api.hosted_cutover_routes import (
    router as hosted_cutover_router,
)
from switch_core.bridges.agent.api.hosted_machine_routes import (
    router as hosted_machine_router,
)
from switch_core.bridges.agent.api.hosted_routes import router as hosted_router
from switch_core.bridges.agent.api.hosted_worker_routes import (
    router as hosted_worker_router,
)
from switch_core.crypto import encrypt_token
from switch_core.db.models import (
    TENANT_ZERO_ID,
    HostedLaunch,
    HostedMachine,
    ProviderConnection,
    User,
)
from switch_core.db.stores.hosted_machine_store import HostedMachineStore
from switch_core.gateway.known_agents import KNOWN_AGENTS
from tests.switch_core.hosted_machine_helpers import seed_launch, seed_machine
from tests.switch_core.management.harness import (
    JWT_SECRET,
    Harness,
    add_member,
    bearer,
    build_harness,
    platform,
)

CONTROLLER_TOKEN = "SYNTHETIC-HOSTED-CONTROLLER-TOKEN-FOR-TESTS-0123"  # gitleaks:allow
BOOT_ID = "00000000-0000-4000-8000-00000000b001"
INSTANCE_ID = "i-0123456789abcdef0"

SPEC: dict[str, Any] = {
    "name": "cloud-helper",
    "description": "Cloud helper",
    "display_name": None,
    "icon_url": None,
    "instructions": "Help with the repository.",
    "provider": "claude",
    "definition": "---\nname: cloud-helper\n---\nHelp.",
    "auto_session": True,
    "auto_approve": False,
    "addressing_policy": None,
    "definition_attributes": {"model": "sonnet"},
    "installation_id": 123,
    "repository_id": 456,
    "session_limit": 8,
}


def host_headers() -> dict[str, str]:
    return {"X-Switch-Host-Boot-Id": BOOT_ID, "X-Switch-Host-Instance-Id": INSTANCE_ID}


def hosted_config(settings_path: Path) -> SimpleNamespace:
    return SimpleNamespace(
        jwt_secret_key=JWT_SECRET,
        hosted_controller_config_path=str(settings_path),
        hosted_github_config_path=None,
        hosted_sessions_per_agent=8,
        hosted_idle_stop_minutes=30,
        hosted_disk_retention_days=7,
    )


@dataclass
class CloudMachine:
    machine_id: str
    capability: str
    owner: User


@dataclass
class CloudAgent:
    launch_id: str
    agent_id: str


def build_hosted_harness(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> Harness:
    settings_path = tmp_path / "controller.json"
    settings_path.write_text(
        json.dumps(
            {
                "tenant_id": TENANT_ZERO_ID,
                "token": CONTROLLER_TOKEN,
                "machine_slots": ["slot-a", "slot-b"],
                "github_private_key_path": "/tmp/synthetic-signing-key.pem",
                "agent_api_endpoint": "https://switch.example.com/api/agent",
            }
        )
    )
    harness = build_harness(
        session_factory, hosted_controller_config_path=str(settings_path)
    )
    config = hosted_config(settings_path)
    harness.protocol.config = config  # type: ignore[assignment]
    app = harness.app
    app.include_router(hosted_worker_router, prefix="/agents")
    app.include_router(hosted_cutover_router, prefix="/agents")
    app.include_router(hosted_router)
    app.include_router(hosted_machine_router)
    app.dependency_overrides[bridge_deps.get_config] = lambda: config
    return harness


async def add_cloud_machine(
    harness: Harness, *, owner: User | None = None, slot_id: str = "slot-a"
) -> CloudMachine:
    """A ready machine with an issued capability, and its owner's Claude login."""
    if owner is None:
        owner = await add_member(harness.session_factory, f"owner-{uuid4().hex[:6]}")
    async with harness.session_factory() as session:
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            slot_id=slot_id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        capability = HostedMachineStore().issue_capability(machine, JWT_SECRET)
        session.add(
            ProviderConnection(
                user_id=owner.id,
                provider="claude",
                kind="setup-token",
                encrypted_credential=encrypt_token("SYNTHETIC-CLAUDE", JWT_SECRET),
                verified_at=datetime.now(UTC),
            )
        )
        await session.commit()
        return CloudMachine(machine_id=machine.id, capability=capability, owner=owner)


async def add_cloud_agent(
    harness: Harness,
    machine: CloudMachine,
    *,
    name: str = "cloud-helper",
    state: str = "queued",
    desired_state: str = "running",
    spec: dict[str, Any] | None = None,
) -> CloudAgent:
    """A launch on `machine` with its agent registered, as launch creation leaves it."""
    launch_id = str(uuid4())
    body = {**SPEC, "name": name, **(spec or {})}
    known = KNOWN_AGENTS["claude-code"]
    options = known.parse_options(
        {
            "channels_enabled": True,
            "repo_dir": "/data/worktrees/agent/workspace",
            "auto_session": body["auto_session"],
        }
    )
    registered = await harness.protocol.register_agent(
        name=name,
        description=body["description"],
        display_name=None,
        icon_url=None,
        connector_type=known.connector_type,
        integration_profile=known.build_profile(options),
        tools=known.tools,
        models=known.models,
        metadata={
            "known_agent_type": "claude-code",
            "known_agent_options": options.model_dump(),
            "hosted_launch_id": launch_id,
        },
        owner_id=machine.owner.id,
    )
    async with harness.session_factory() as session:
        row = await session.get(HostedMachine, (TENANT_ZERO_ID, machine.machine_id))
        assert row is not None
        await seed_launch(
            session,
            machine=row,
            request_id=launch_id,
            name=name,
            state=state,
            desired_state=desired_state,
            revision=1,
            agent_id=registered.agent_id,
            spec=body,
        )
        launch = await session.get(HostedLaunch, (TENANT_ZERO_ID, launch_id))
        assert launch is not None
        launch.repository = "example/project"
        await session.commit()
    return CloudAgent(launch_id=launch_id, agent_id=registered.agent_id)


async def enroll_machine(
    client: httpx.AsyncClient,
    machine: CloudMachine,
    *,
    capability: str | None = None,
    headers: dict[str, str] | None = None,
    kind: str = "ec2",
) -> httpx.Response:
    return await client.post(
        "/v1/management/controllers/enroll",
        json={
            "proof": {
                "kind": "machine_secret",
                "machine_id": machine.machine_id,
                "capability": capability or machine.capability,
            },
            "controller": {
                "kind": kind,
                "name": "cloud-machine",
                "platform": platform(),
                "version": "2.1.0",
            },
        },
        headers=host_headers() if headers is None else headers,
    )


async def enrolled_token(
    client: httpx.AsyncClient, machine: CloudMachine
) -> tuple[str, str]:
    """Enroll the machine's controller; its id and an access token."""
    enrolled = await enroll_machine(client, machine)
    assert enrolled.status_code == 201, enrolled.text
    body = enrolled.json()
    token = await client.post(
        f"/v1/management/controllers/{body['controller_id']}/token",
        json={"credential": body["credential"]},
    )
    assert token.status_code == 200, token.text
    return body["controller_id"], token.json()["access_token"]


async def update_launch(harness: Harness, launch_id: str, **values: Any) -> None:
    async with harness.session_factory() as session:
        launch = await session.get(HostedLaunch, (TENANT_ZERO_ID, launch_id))
        assert launch is not None
        for key, value in values.items():
            setattr(launch, key, value)
        await session.commit()


async def launch_row(harness: Harness, launch_id: str) -> HostedLaunch:
    async with harness.session_factory() as session:
        launch = await session.get(HostedLaunch, (TENANT_ZERO_ID, launch_id))
        assert launch is not None
        return launch


async def assignment(
    client: httpx.AsyncClient, controller_id: str, token: str
) -> dict[str, Any]:
    response = await client.get(
        f"/v1/management/controllers/{controller_id}/assignment",
        headers=bearer(token),
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def fixture_heartbeat() -> dict[str, Any]:
    """The supervisor's recorded heartbeat body."""
    path = (
        Path(__file__).resolve().parents[1]
        / "fixtures"
        / "hosted_machines"
        / "heartbeat_request.json"
    )
    return dict(json.loads(path.read_text()))

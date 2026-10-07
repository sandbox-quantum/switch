"""A management app wired the way `main` wires it, against the test database.

The agent bridge side is a bare FastAPI app behind the real
`BearerAuthMiddleware` with the real `ManagementAuthenticator`; the gateway
side is mounted at `/gateway` with the real `get_current_user`. Only what
those need from the rest of the server is stubbed: the agent bridge's session
and protocol, and the gateway's config. The protocol is a real
`AgentCore` with its collaborators faked out, so registration writes
real rows, and with a real connection registry and event buffer, so the
controller stream and the act-as routes run against Core's own state. The
agent routes are mounted too, for a controller to act on.

Requests go through `httpx.AsyncClient` over `ASGITransport`, for the reason
`gateway/test_tenant_resolution.py` gives.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import dependencies as bridge_deps
from switch_core.bridges.agent.api.activity_routes import router as activity_router
from switch_core.bridges.agent.api.handlers import router as api_router
from switch_core.bridges.agent.api.operations import router as operations_router
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware, ControllerPrincipal
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnectionError,
)
from switch_core.bridges.agent.protocol.controller_stream import IDLE
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    Room,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.keys import Keyring
from switch_core.management import controller_routes
from switch_core.management.errors import ManagementError
from switch_core.management.wiring import Management, build_management

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

TOKEN_SECRET = "unit-test-controller-token-secret-0123456789"  # gitleaks:allow
STATUS_INTERVAL = 60
SERVER_URL = "https://switch-api.example.test"

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "agent_controllers"


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


# Where the status fixture's controller says it makes agents' workspaces.
WORKSPACES_DIR: str = fixture("status_request.json")["machine"]["workspaces_dir"]


@dataclass
class Clock:
    """A clock a test moves by hand."""

    now: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now = self.now + timedelta(**delta)


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def stop(self, client_id: str) -> None:
        return None

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        return None

    async def create_client(self, *, client_type: str, display_name: str) -> Client:
        async with self._session_factory() as session:
            client = Client(
                transport_user_id=f"@{display_name}:test",
                display_name=display_name,
                type=client_type,
            )
            session.add(client)
            await session.commit()
            return client

    def start_client(self, client: Client) -> None:
        return None


class _NoBridges:
    def bridges_for_tenant(self, tenant_id: str) -> list[object]:
        return []


def protocol_service(
    session_factory: async_sessionmaker[AsyncSession], cache: ApiKeyCache
) -> AgentCore:
    svc = object.__new__(AgentCore)
    svc.session_factory = session_factory  # type: ignore[assignment]
    svc.agent_store = AgentStore()
    svc.api_key_store = ApiKeyStore()
    svc.api_key_cache = cache
    svc.client_lifecycle = _FakeClientLifecycle(session_factory)  # type: ignore[assignment]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[assignment]
    svc.config = SimpleNamespace(keyring=TEST_KEYRING)  # type: ignore[assignment]
    svc.telemetry = None
    svc.event_buffer = EventBuffer(sequence_base=0)
    svc.connections = AgentConnectionRegistry()
    svc.approval_outcomes = None  # type: ignore[assignment]
    svc.room_store = RoomStore()
    svc.agent_session_store = AgentSessionStore()
    svc.user_store = UserStore()
    svc.room_role_store = RoomRoleStore()
    return svc


@dataclass
class Harness:
    app: FastAPI
    management: Management
    protocol: AgentCore
    cache: ApiKeyCache
    controller_auth_cache: ControllerAuthCache
    clock: Clock
    session_factory: async_sessionmaker[AsyncSession]

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )

    def middleware(self) -> BearerAuthMiddleware:
        async def _app(scope: Any, receive: Any, send: Any) -> None:
            return None

        return BearerAuthMiddleware(
            _app,
            agent_store=AgentStore(),
            api_key_store=ApiKeyStore(),
            api_key_cache=self.cache,
            session_factory=self.session_factory,
            controller_auth=self.management.authenticator,
        )


def build_harness(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    controller_auth_ttl_seconds: float = 5,
    server_url: str | None = SERVER_URL,
) -> Harness:
    """The controller-token cache is on, as it is by default in production,
    so every management test runs through it."""
    clock = Clock()
    cache = ApiKeyCache(ttl_seconds=5, max_entries=64)
    controller_auth_cache = ControllerAuthCache(
        ttl_seconds=controller_auth_ttl_seconds, max_entries=64
    )
    protocol = protocol_service(session_factory, cache)
    management = build_management(
        token_secret=TOKEN_SECRET,
        status_interval_seconds=STATUS_INTERVAL,
        server_url=server_url,
        session_factory=session_factory,
        presence=protocol.connections.controllers,
        auth_cache=controller_auth_cache,
        clock=clock,
    )

    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    agent_app = FastAPI()
    gateway_app = FastAPI()
    management.install(
        agent_bridge_app=agent_app, gateway_app=gateway_app, protocol=protocol
    )

    agent_app.include_router(activity_router)
    agent_app.include_router(api_router, prefix="/agents")
    agent_app.include_router(operations_router)
    agent_app.dependency_overrides[bridge_deps.get_session] = _session
    agent_app.dependency_overrides[bridge_deps.get_session_factory] = lambda: (
        session_factory
    )
    agent_app.dependency_overrides[bridge_deps.get_protocol] = lambda: protocol

    gateway_app.dependency_overrides[gw_deps.get_session] = _session
    gateway_app.dependency_overrides[gw_deps.get_session_factory] = lambda: (
        session_factory
    )
    gateway_app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    gateway_app.dependency_overrides[gw_deps.get_protocol] = lambda: protocol
    gateway_app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING, gateway_tenant_choice_enabled=False
    )
    agent_app.mount("/gateway", gateway_app)
    agent_app.add_middleware(
        BearerAuthMiddleware,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=cache,
        session_factory=session_factory,
        controller_auth=management.authenticator,
    )
    return Harness(
        app=agent_app,
        management=management,
        protocol=protocol,
        cache=cache,
        controller_auth_cache=controller_auth_cache,
        clock=clock,
        session_factory=session_factory,
    )


async def add_member(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    tenant_id: str = TENANT_ZERO_ID,
) -> User:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role="member"))
        await session.commit()
        return user


def cookies_for(user: User, tenant_id: str = TENANT_ZERO_ID) -> dict[str, str]:
    return {
        "switch_auth": create_jwt(
            user.id, user.email, user.role, TEST_KEYRING, tenant_id
        )
    }


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def platform() -> dict[str, str]:
    return {"os": "linux", "arch": "x64", "os_version": "6.1.0"}


def status_report(
    seq: int,
    *,
    providers: list[dict[str, Any]] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The status fixture, with its sequence and optionally its lists replaced."""
    report = fixture("status_request.json")
    report["seq"] = seq
    if providers is not None:
        report["providers"] = providers
    if agents is not None:
        report["agents"] = agents
    return report


def provider(name: str, *, installed: bool = True, auth: str = "ok") -> dict[str, Any]:
    return {
        "provider": name,
        "installed": installed,
        "version": "1.0.0" if installed else None,
        "auth": auth,
        "auth_source": "local" if installed else None,
        "checked_at": "2026-01-01T00:00:00Z",
    }


@dataclass
class EnrolledController:
    controller_id: str
    credential: str
    access_token: str
    owner: User

    @property
    def headers(self) -> dict[str, str]:
        return bearer(self.access_token)


async def enroll_console(
    harness: Harness, client: httpx.AsyncClient, owner: User, name: str = "laptop"
) -> EnrolledController:
    """Enroll a console controller for `owner` and exchange its credential."""
    response = await client.post(
        "/gateway/management/controllers",
        json={
            "name": name,
            "kind": "console",
            "platform": platform(),
            "version": "0.1.0",
        },
        cookies=cookies_for(owner),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    token = await client.post(
        f"/v1/management/controllers/{body['controller_id']}/token",
        json={"credential": body["credential"]},
    )
    assert token.status_code == 200, token.text
    return EnrolledController(
        controller_id=body["controller_id"],
        credential=body["credential"],
        access_token=token.json()["access_token"],
        owner=owner,
    )


async def report_status(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    seq: int,
    *,
    providers: list[dict[str, Any]] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> httpx.Response:
    return await client.put(
        f"/v1/management/controllers/{controller.controller_id}/status",
        json=status_report(seq, providers=providers, agents=agents),
        headers=controller.headers,
    )


def definition(provider_name: str = "claude", **overrides: Any) -> dict[str, Any]:
    return {
        "provider": provider_name,
        "model": None,
        "instructions": "",
        "auto_approve": False,
        "directory": None,
        "isolation": "shared",
        **overrides,
    }


async def create_managed_agent(
    client: httpx.AsyncClient,
    owner: User,
    *,
    name: str,
    controller_id: str | None,
    desired_state: str = "running",
    definition_body: dict[str, Any] | None = None,
) -> httpx.Response:
    return await client.post(
        "/gateway/management/agents",
        json={
            "name": name,
            "description": f"{name} description",
            "controller_id": controller_id,
            "desired_state": desired_state,
            "definition": definition_body or definition(),
        },
        cookies=cookies_for(owner),
    )


async def place_agent(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    *,
    name: str,
) -> str:
    """Create a managed agent on `controller`, which must accept placements."""
    await report_status(client, controller, 1, providers=[provider("claude")])
    created = await create_managed_agent(
        client,
        controller.owner,
        name=name,
        controller_id=controller.controller_id,
        definition_body=definition(),
    )
    assert created.status_code == 201, created.text
    return str(created.json()["agent_id"])


async def add_room(
    session_factory: async_sessionmaker[AsyncSession],
    *agent_ids: str,
    name: str = "room",
) -> str:
    """A room with these agents as members."""
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test.local",
            name=name,
            description=f"{name} description",
        )
        session.add(room)
        await session.flush()
        for agent_id in agent_ids:
            await session.execute(
                insert(room_agents).values(room_id=room.id, agent_id=agent_id)
            )
        await session.commit()
        return room.id


def parse_frame(frame: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    return frame["event"], frame["data"]


async def take(
    stream: AsyncIterator[dict[str, Any]], count: int, timeout: float = 3.0
) -> list[tuple[str, dict[str, Any]]]:
    """The next `count` frames off a stream, idle ticks skipped."""
    frames: list[tuple[str, dict[str, Any]]] = []

    async def pump() -> None:
        while len(frames) < count:
            raw = await anext(stream)
            if raw is IDLE:
                continue
            frames.append(parse_frame(raw))

    await asyncio.wait_for(pump(), timeout=timeout)
    return frames


@dataclass
class Answer:
    """What the socket would have said, shaped like an HTTP response: a beat
    or an attach either succeeds or is refused with the contract's envelope."""

    status_code: int
    body: dict[str, Any]

    @property
    def text(self) -> str:
        return json.dumps(self.body)

    def json(self) -> dict[str, Any]:
        return self.body


def _principal(controller: EnrolledController) -> ControllerPrincipal:
    return ControllerPrincipal(
        controller_id=controller.controller_id,
        owner_id=controller.owner.id,
        tenant_id=TENANT_ZERO_ID,
    )


async def open_connection(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    cursors: dict[str, int | str] | None = None,
) -> dict[str, Any]:
    response = await client.post(
        f"/v1/controllers/{controller.controller_id}/connection",
        json={"cursors": cursors or {}},
        headers=controller.headers,
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


async def open_stream(
    harness: Harness,
    controller: EnrolledController,
    opened: dict[str, Any],
) -> AsyncIterator[dict[str, Any]]:
    """The frames the controller's socket would send, from the route's own
    stream: the socket adds only pings around them."""
    return await controller_routes.attach_stream(
        principal=_principal(controller),
        management=harness.management.service,
        protocol=harness.protocol,
        session_factory=harness.session_factory,
        connection_id=opened["connection_id"],
        generation=opened["generation"],
    )


async def attach(
    harness: Harness,
    controller: EnrolledController,
    connection_id: str,
    generation: int,
) -> Answer:
    """An attach, answered as the socket's `refused` frame would be."""
    try:
        stream = await open_stream(
            harness,
            controller,
            {"connection_id": connection_id, "generation": generation},
        )
    except ManagementError as error:
        return Answer(error.status_code, error.body())
    await stream.aclose()  # type: ignore[attr-defined]
    return Answer(200, {})


def beat(
    harness: Harness,
    controller: EnrolledController,
    *,
    connection_id: str,
    generation: int,
    cursors: dict[str, int],
) -> Answer:
    """A pong, answered as the socket would: the agents on success, the
    refusal its `evicted` frame would name otherwise."""
    try:
        agents = controller_routes.record_beat(
            principal=_principal(controller),
            protocol=harness.protocol,
            connection_id=connection_id,
            generation=generation,
            cursors=cursors,
        )
    except ControllerConnectionError as exc:
        error = controller_routes._connection_refusal(exc)
        return Answer(error.status_code, error.body())
    return Answer(200, {"agents": agents})

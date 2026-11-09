"""The real gateway app on Postgres, the people who ask it, and what they ask
about.

Everything that decides who may do what is real: the routes, their
dependencies, authentication by session cookie, the stores, the resource,
room and chat services, agent management and the service broker. What the
app would hand on to a messaging platform, a running client, a vendor or a
machine is a stand-in that raises `Reached` when a route gets that far. A
route can only get that far by passing its checks, so the matrix reads that
answer, 418, as "let through", without these stand-ins having to do the work.
A route that refuses after one of them was asked has acted before checking,
and the matrix says so.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.resource.service import ResourceService
from switch_core.config import SwitchConfig
from switch_core.connections.app_credentials import ConnectorApps
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.settings import DecisionAvailability
from switch_core.feature_flags import KNOWN_FEATURE_FLAGS
from switch_core.gateway.app import create_gateway_app
from switch_core.gateway.auth import create_jwt
from switch_core.management.dependencies import init_management_dependencies
from switch_core.management.wiring import (
    Management,
    build_management,
    mount_gateway_routes,
)
from switch_core.organization_directory import LocalDirectory
from switch_core.outbound import OutboundPolicy
from switch_core.process_lease import ProcessLease
from switch_core.providers.github import GitHubConnections, GitHubReach
from switch_core.signals import SignalBus
from switch_core.tenant_context import tenant_scope
from switch_core.user_changes import LocalUserChanges, SignalUserChanges
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.github_seed import github_broker
from tests.switch_core.gateway.conftest import (
    _chat_service,
    _FakeActivityListener,
    _FakeLifecycle,
    _FakeListener,
)
from tests.switch_core.gateway.test_messaging_install_routes import _Service
from tests.switch_core.management.harness import (
    SERVER_URL,
    STATUS_INTERVAL,
    TOKEN_SECRET,
    Clock,
)

REPO_ROOT = Path(__file__).resolve().parents[5]

# The workspace every case is asked in, inside an organization of its own.
TENANT = "role-matrix"
ORGANIZATION = "role-matrix-org"


def _surface() -> ModuleType:
    """`scripts/e2e_surface.py`, which writes the committed route snapshot:
    its configuration (every feature flag on) and its route walker, so the
    matrix enumerates routes exactly as the snapshot does."""
    path = REPO_ROOT / "scripts" / "e2e_surface.py"
    spec = importlib.util.spec_from_file_location("e2e_surface", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SURFACE = _surface()


class Reached(Exception):
    """A route passed its checks and asked a collaborator the matrix stands
    in for."""


def reached_response(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=418, content={"reached": str(exc)})


class Fake:
    """A collaborator the matrix does not run. `answers` are what it says to
    the reads a route makes before deciding; anything else it is asked is a
    route acting on what it allowed."""

    def __init__(self, name: str, **answers: Any) -> None:
        self._name = name
        self._answers = answers

    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("__"):
            raise AttributeError(attr)
        if attr in self._answers:
            return self._answers[attr]

        def reached(*args: Any, **kwargs: Any) -> Any:
            raise Reached(f"{self._name}.{attr}")

        return reached


def stand_in(cls: type, name: str, **answers: Any) -> Any:
    """A stand-in that passes for a `cls` where a route checks for one: it
    holds `answers`, and anything else a route reaches for on it is `Reached`.
    Its methods are `cls`'s own, so one that reaches for anything not given
    is `Reached` too."""

    def missing(self: Any, attr: str) -> Any:
        if attr.startswith("__"):
            raise AttributeError(attr)
        raise Reached(f"{name}.{attr}")

    standing_in = type(f"StandIn{cls.__name__}", (cls,), {"__getattr__": missing})
    instance: Any = object.__new__(standing_in)
    for attr, value in answers.items():
        object.__setattr__(instance, attr, value)
    return instance


class _Partly:
    """`real` for what it has, and `Reached` for what it hasn't."""

    def __init__(self, real: Any, name: str) -> None:
        self._real = real
        self._fake = Fake(name)

    def __getattr__(self, attr: str) -> Any:
        try:
            return getattr(self._real, attr)
        except AttributeError:
            return getattr(self._fake, attr)


class _Core(AgentCore):
    """The protocol service with the stores the gateway reads through it, and
    nothing it would hand on to a running client or bridge: asking it for that
    is `Reached`."""

    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("__"):
            raise AttributeError(attr)
        raise Reached(f"protocol.{attr}")


def _protocol(
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    clients: _FakeLifecycle,
) -> AgentCore:
    core = object.__new__(_Core)
    core.session_factory = session_factory  # type: ignore[assignment]
    core.agent_store = AgentStore()
    core.api_key_store = ApiKeyStore()
    core.api_key_cache = ApiKeyCache(ttl_seconds=5, max_entries=64)
    core.config = config
    core.telemetry = None
    core.connections = AgentConnectionRegistry()
    core.room_store = RoomStore()
    core.agent_session_store = AgentSessionStore()
    core.user_store = UserStore()
    core.room_role_store = RoomRoleStore()
    core.bridge_store = CollaborationBridgeStore()
    core.external_user_store = ExternalUserStore()
    core.room_group_store = RoomGroupStore()
    core.client_lifecycle = _Partly(clients, "client_lifecycle")  # type: ignore[assignment]
    return core


class _Bridges:
    """The collaboration lifecycle with nothing running: what the gateway reads
    of it to describe a bridge, and `Reached` for anything it would do."""

    def __init__(self) -> None:
        self._fake = Fake("collab_lifecycle")

    def get_adapter(self, bridge_id: str) -> None:
        return None

    def supports_channel_creation(self, bridge_type: str) -> bool:
        return True

    def supports_directory_search(self, bridge_type: str) -> bool:
        return True

    def receives_webhooks(self, bridge_type: str) -> bool:
        return False

    def webhook_url(self, bridge_id: str, bridge_type: str) -> str | None:
        return None

    def __getattr__(self, attr: str) -> Any:
        return getattr(self._fake, attr)


def _install(install_id: str, platform: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=install_id,
        tenant_id=TENANT,
        platform=platform,
        external_workspace_id=f"ws-{install_id}",
        status="active",
        scopes="",
        bridge_id=None,
        installed_at="2026-09-28T00:00:00Z",
        ended_at=None,
    )


def installs() -> Any:
    """The messaging-app installer with a Slack install (`s1`, OAuth) and a
    Telegram chat (`t1`, by claim), and Telegram not yet connected here: the
    routes decide who may do what with them, and this only answers."""
    return _Service(installs=[_install("s1", "slack"), _install("t1", "telegram")])


def _never_listens() -> Any:
    raise AssertionError("the matrix's signal bus is never started")


def _management(
    session_factory: async_sessionmaker[AsyncSession],
    protocol: AgentCore,
    settings: SwitchConfig,
) -> Management:
    """Agent management as `Management.install` sets it up for the gateway,
    without what `install` does beyond that: switching the agent operations on
    is process-wide, and no route here needs it."""
    process_id = str(uuid.uuid4())
    signal_bus = SignalBus(session_factory, _never_listens, process_id=process_id)
    return build_management(
        token_secret=TOKEN_SECRET,
        status_interval_seconds=STATUS_INTERVAL,
        server_url=SERVER_URL,
        third_party_avatars=True,
        controller_release=None,
        session_factory=session_factory,
        presence=protocol.connections.controllers,
        auth_cache=ControllerAuthCache(ttl_seconds=5, max_entries=64),
        clock=Clock(),
        signal_bus=signal_bus,
        lease=ProcessLease(
            process_id=process_id,
            session_factory=session_factory,
            processes=SwitchCoreProcessStore(),
            key_ids=[key.id for key in settings.keyring.keys],
        ),
        user_changes=SignalUserChanges(local=LocalUserChanges(), bus=signal_bus),
    )


def config() -> SwitchConfig:
    return SURFACE._config(frozenset(KNOWN_FEATURE_FLAGS))  # type: ignore[no-any-return]


def build_gateway(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    """The gateway as `main.py` builds it; `client` mounts it at `/gateway`,
    as `main.py` does."""
    settings = config()
    lifecycle = _FakeLifecycle()
    protocol = _protocol(session_factory, settings, lifecycle)
    chat_service, room_service = _chat_service(
        session_factory,
        lifecycle=lifecycle,
        listener=_FakeListener(),
        activity=_FakeActivityListener(),
        connections=protocol.connections,
    )
    resource_service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )
    protocol.room_service = room_service  # type: ignore[assignment]
    protocol.resource_service = resource_service  # type: ignore[assignment]
    gateway = create_gateway_app(
        agent_store=AgentStore(),
        room_store=RoomStore(),
        room_group_store=RoomGroupStore(),
        room_service=room_service,
        bridge_store=CollaborationBridgeStore(),
        client_lifecycle=Fake("client_lifecycle"),  # type: ignore[arg-type]
        collab_lifecycle=_Bridges(),  # type: ignore[arg-type]
        event_buffer=Fake("event_buffer"),  # type: ignore[arg-type]
        session_factory=session_factory,
        user_store=UserStore(),
        external_user_store=ExternalUserStore(),
        api_key_store=ApiKeyStore(),
        invitation_store=InvitationStore(),
        join_domain_store=JoinDomainStore(),
        organization_store=OrganizationStore(),
        organization_directory=LocalDirectory(),
        template_store=TemplateStore(),
        usage_store=UsageStore(),
        budget_store=BudgetStore(),
        resource_service=resource_service,
        protocol=protocol,
        install_service=installs(),
        invite_mailer=None,
        user_changes=LocalUserChanges(),
        chat_service=chat_service,
        connector_apps=stand_in(
            ConnectorApps, "connector_apps", github_app=lambda: None
        ),
        config=settings,
    )
    management = _management(session_factory, protocol, settings)
    init_management_dependencies(
        service=management.service,
        authenticator=management.authenticator,
        session_factory=session_factory,
    )
    mount_gateway_routes(gateway)
    gateway.state.service_broker = github_broker(
        session_factory, settings.keyring, FakeVendor()
    )
    gateway.state.organization_apps = stand_in(
        OrganizationApps,
        "organization_apps",
        _store=OrganizationAppCredentialStore(settings.keyring),
    )
    gateway.state.controller_revoker = management.service
    # Auto-route's decision client, asking nothing: the decision settings
    # routes read and save the workspace's row, and Test meets a service that
    # is down.
    gateway.state.decision_client = DynamicDecisionClient(
        session_factory=session_factory,
        availability=DecisionAvailability.from_config(settings),
        keyring=settings.keyring,
        client=httpx.AsyncClient(transport=httpx.MockTransport(_decision_down)),
        guarded_client=httpx.AsyncClient(transport=httpx.MockTransport(_decision_down)),
        outbound_policy=OutboundPolicy.parse(""),
        timeout_seconds=1.0,
        telemetry=None,
        cache_seconds=0,
    )
    gateway.state.github_connections = _github()
    # The clients the room and chat services think are running: `World` adds
    # each agent it makes, as a running client would announce itself.
    gateway.state.matrix_lifecycle = lifecycle
    gateway.add_exception_handler(Reached, reached_response)
    return gateway


def _decision_down(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(503)


def _github() -> GitHubConnections:
    """The server's GitHub App, answering for GitHub rather than asking it."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as file:
        json.dump(
            {
                "client_id": "example-client",
                "client_secret": "SYNTHETIC-PLACEHOLDER",
                "slug": "example-app",
                "origin": "https://switch.example.com",
            },
            file,
        )
    github = GitHubConnections.from_file(file.name)
    Path(file.name).unlink()
    github.exchange = Fake("github").exchange  # type: ignore[method-assign]
    github.revoke = AsyncMock()  # type: ignore[method-assign]
    github.request = Fake("github").request  # type: ignore[method-assign]
    github.repositories = AsyncMock(  # type: ignore[method-assign]
        return_value=GitHubReach(installations=[], sso_hidden=[])
    )
    return github


class Persona(StrEnum):
    """Who asks. The ticket's three roles, the deployment operator, and the
    member who owns the thing being asked about."""

    ORG_ADMIN = "org-admin"
    WORKSPACE_ADMIN = "workspace-admin"
    MEMBER = "member"
    OPERATOR = "operator"
    OWNER = "owner"


def domain_of(persona: Persona) -> str:
    """Each persona's e-mail domain is their own, so a workspace can be opened
    to it without the next one finding it already open."""
    return f"{persona.value}.example.invalid"


def email_of(persona: Persona) -> str:
    return f"{persona.value}@{domain_of(persona)}"


@dataclass(frozen=True)
class People:
    ids: dict[Persona, str]

    def headers(self, persona: Persona) -> dict[str, str]:
        """A signed-in session in the workspace, as the browser sends it."""
        user_id = self.ids[persona]
        token = create_jwt(
            user_id,
            email_of(persona),
            "user",
            config().keyring,
            TENANT,
            session_version=0,
            auth_time=datetime.now(UTC),
        )
        return {"cookie": f"switch_auth={token}"}


async def seed_people(session_factory: async_sessionmaker[AsyncSession]) -> People:
    """The workspace, its organization, and one person for each `Persona`.

    The organization admin holds no membership in the workspace: standing
    there through the organization alone is the case that differs from a
    workspace admin. The operator holds none either.
    """
    ids: dict[Persona, str] = {}
    with tenant_scope(TENANT):
        async with session_factory() as session:
            session.add(Organization(id=ORGANIZATION, slug=ORGANIZATION, name="Acme"))
            await session.flush()
            session.add(
                Tenant(
                    id=TENANT, slug=TENANT, name=TENANT, organization_id=ORGANIZATION
                )
            )
            await session.flush()
            for persona in Persona:
                user = User(
                    id=f"{persona.value}-{uuid.uuid4().hex[:6]}",
                    name=persona.value,
                    email=email_of(persona),
                    role="admin" if persona is Persona.OPERATOR else "user",
                )
                session.add(user)
                ids[persona] = user.id
            await session.flush()
            for persona, tenant_role in (
                (Persona.WORKSPACE_ADMIN, "admin"),
                (Persona.MEMBER, "member"),
                (Persona.OWNER, "member"),
            ):
                session.add(
                    TenantMember(
                        tenant_id=TENANT, user_id=ids[persona], role=tenant_role
                    )
                )
            for persona, organization_role in (
                (Persona.ORG_ADMIN, "org_admin"),
                (Persona.WORKSPACE_ADMIN, "member"),
                (Persona.MEMBER, "member"),
                (Persona.OWNER, "member"),
            ):
                session.add(
                    OrganizationMember(
                        organization_id=ORGANIZATION,
                        user_id=ids[persona],
                        role=organization_role,
                    )
                )
            await session.commit()
    return People(ids)


def client(gateway: FastAPI) -> httpx.AsyncClient:
    """A client of `gateway` at `/gateway`. A route that fails answers 500
    rather than raising into the test, so the matrix can say which route."""
    root = FastAPI()
    root.mount("/gateway", gateway)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=root, raise_app_exceptions=False),
        base_url="http://switch.test",
    )


def _scope(
    kind: str, method: str, path: str, headers: dict[str, str]
) -> dict[str, Any]:
    return {
        "type": kind,
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http" if kind == "http" else "ws",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [
            (name.lower().encode(), value.encode()) for name, value in headers.items()
        ],
        "server": ("switch.test", 80),
        "client": ("127.0.0.1", 1),
        "subprotocols": [],
    }


async def _first_answer(
    gateway: FastAPI,
    scope: dict[str, Any],
    opening: dict[str, Any],
    kinds: set[str],
    hang_up_after: set[str],
) -> dict[str, Any]:
    """The first message of `kinds` the app sends for `scope`, hanging up once
    it has sent one of `hang_up_after`: how a stream or a socket is asked who
    may open it, without waiting for all it would go on to send."""
    root = FastAPI()
    root.mount("/gateway", gateway)
    loop = asyncio.get_running_loop()
    answered: asyncio.Future[dict[str, Any]] = loop.create_future()
    done_opening: asyncio.Future[None] = loop.create_future()
    opened = False

    async def receive() -> dict[str, Any]:
        nonlocal opened
        if not opened:
            opened = True
            return opening
        await done_opening
        return {
            "type": "http.disconnect"
            if scope["type"] == "http"
            else "websocket.disconnect"
        }

    async def send(message: Any) -> None:
        if message["type"] in kinds and not answered.done():
            answered.set_result(message)
        if message["type"] in hang_up_after and not done_opening.done():
            done_opening.set_result(None)

    task = asyncio.create_task(root(scope, receive, send))
    try:
        return await asyncio.wait_for(asyncio.shield(answered), timeout=10)
    finally:
        # Hung up: let the app see it and finish, as it would a client leaving.
        try:
            await asyncio.wait_for(task, timeout=10)
        except TimeoutError:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def stream_status(gateway: FastAPI, path: str, headers: dict[str, str]) -> int:
    """The status an event stream opens with."""
    answer = await _first_answer(
        gateway,
        _scope("http", "GET", path, headers),
        {"type": "http.request", "body": b"", "more_body": False},
        {"http.response.start"},
        # Once it has sent something, it is waiting for what is next.
        {"http.response.body"},
    )
    return int(answer["status"])


async def socket_status(gateway: FastAPI, path: str, headers: dict[str, str]) -> int:
    """101 when the socket is accepted, else the status its handshake is
    refused with."""
    answer = await _first_answer(
        gateway,
        _scope("websocket", "GET", path, headers),
        {"type": "websocket.connect"},
        {"websocket.accept", "websocket.http.response.start", "websocket.close"},
        {"websocket.send", "websocket.http.response.body", "websocket.close"},
    )
    if answer["type"] == "websocket.accept":
        return 101
    return int(answer.get("status", 403))

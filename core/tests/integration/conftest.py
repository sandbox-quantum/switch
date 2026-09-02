"""Integration-test infrastructure: real Postgres + Tuwunel (Matrix) via testcontainers.

Unlike the unit suite (which fakes the nio client), these fixtures boot a real
Matrix homeserver and wire up the subset of `switch_core.main:run()` the feature
under test needs, in-process. This lets a test drive the genuine path
RoomService → Matrix invite/join → AgentClient sync loop → EventBuffer.

The two containers mirror the `postgres` / `tuwunel` services in
`deploy/local/docker-compose.yml` (see constants below — keep in sync). They get
ephemeral host ports, so the suite coexists with a running `just up` dev stack.

Isolation model: the containers, the Postgres database, its schema, and the Matrix
admin are **session-scoped** (built once). Between tests the per-test `harness`
fixture resets Postgres rows with TRUNCATE and rebuilds the in-memory services, so
tests don't pay a per-test CREATE DATABASE. The Matrix homeserver is *not* reset —
its users/rooms persist across the session — so tests must use unique agent names.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

import asyncpg
import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from testcontainers.core.container import DockerContainer
from testcontainers.postgres import PostgresContainer

# Importing models registers every table on Base.metadata for create_all.
import switch_core.db.models  # noqa: F401
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    RegistrationResult,
    TaskProtocolConfig,
)
from switch_core.bridges.agent.request_tracker import RequestTracker
from switch_core.bridges.resource.service import ResourceService
from switch_core.bridges.resource.tracker import ResourceRequestTracker
from switch_core.clients.agent_client import AgentClient
from switch_core.clients.client_base import ClientBase
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.base import Base
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.task_store import TaskStore
from switch_core.db.stores.user_store import UserStore
from switch_core.matrix_admin import (
    MatrixAdmin,
    ensure_admin_exists,
    wait_for_homeserver,
)
from switch_core.room_service import RoomService

# ── Mirrors deploy/local/docker-compose.yml — keep in sync ──────────────────────
POSTGRES_IMAGE = "postgres:16-alpine"
TUWUNEL_IMAGE = "jevolk/tuwunel:v1.7.1"
TUWUNEL_ENV = {
    "TUWUNEL_SERVER_NAME": "localhost",
    "TUWUNEL_DATABASE_PATH": "/var/lib/tuwunel",
    "TUWUNEL_ADDRESS": "0.0.0.0",
    "TUWUNEL_PORT": "8008",
    "TUWUNEL_ALLOW_FEDERATION": "false",
    "TUWUNEL_ALLOW_REGISTRATION": "false",
    "TUWUNEL_MAX_REQUEST_SIZE": "20000000",
}

# ── Throwaway test constants (not secrets — local ephemeral infra) ──────────────
SERVER_NAME = "localhost"
SHARED_SECRET = "dev-secret"
ADMIN_USER = "admin"
ADMIN_PASSWORD = "admin"
JWT_SECRET = "dev-jwt-secret-test"
REGISTRATION_TOKEN = "dev-test-token"
GATEWAY_ADMIN_EMAIL = "admin@switch.local"
GATEWAY_ADMIN_PASSWORD = "admin"


class _NoBridges:
    """Stand-in for CollaborationBridgeLifecycleService when no bridge is configured.

    Room creation only calls `.get(bridge_id)` when a bridge_id is set (ours is
    None), and agent registration calls `.all_bridges()` for bridge-identity
    creation. Both paths are exercised here as no-ops — the feature under test
    involves no collaboration bridge.
    """

    def get(self, _bridge_id: str) -> None:
        return None

    def all_bridges(self) -> list:
        return []


@dataclass
class StackInfo:
    pg: PostgresContainer
    matrix_url: str


@dataclass
class SessionEnv:
    """Session-scoped pieces shared by every test: the engine/schema, the Matrix
    admin, and the (stateless) stores. The per-test `harness` fixture builds the
    in-memory services on top of these."""

    config: SwitchConfig
    engine: AsyncEngine
    session_factory: object
    matrix_admin: MatrixAdmin
    agent_store: AgentStore
    agent_session_store: AgentSessionStore
    room_store: RoomStore
    client_store: ClientStore
    task_store: TaskStore
    bridge_store: CollaborationBridgeStore
    external_user_store: ExternalUserStore
    api_key_store: ApiKeyStore
    reference_store: ReferenceStore
    reference_type_store: ReferenceTypeStore
    document_store: DocumentStore
    package_store: PackageStore
    room_link_store: RoomLinkStore
    room_role_store: RoomRoleStore
    user_store: UserStore


def _wait_matrix_ready(matrix_url: str, timeout_s: float = 60.0) -> None:
    """Block until the homeserver answers the client-versions probe."""
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                f"{matrix_url}/_matrix/client/versions", timeout=5
            ):
                return
        except (urllib.error.URLError, ConnectionError, OSError) as err:
            last_err = err
            time.sleep(0.5)
    raise RuntimeError(f"Tuwunel not ready at {matrix_url}: {last_err}")


def _ensure_docker_host() -> None:
    """Point docker-py at the active docker context when DOCKER_HOST is unset.

    testcontainers' docker-py defaults to /var/run/docker.sock, which doesn't
    exist under OrbStack/colima (and some Docker Desktop setups). Resolve the
    daemon endpoint from `docker context inspect` so the suite runs regardless
    of provider, without per-machine env setup.
    """
    if os.environ.get("DOCKER_HOST") or os.path.exists("/var/run/docker.sock"):
        return
    docker = shutil.which("docker")
    if docker is None:
        return
    try:
        out = subprocess.run(
            [docker, "context", "inspect"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        host = json.loads(out.stdout)[0]["Endpoints"]["docker"]["Host"]
    except (subprocess.SubprocessError, ValueError, KeyError, IndexError):
        return
    if host:
        os.environ["DOCKER_HOST"] = host


@pytest.fixture(scope="session")
def switch_stack() -> Iterator[StackInfo]:
    _ensure_docker_host()
    tuwunel = DockerContainer(TUWUNEL_IMAGE).with_exposed_ports(8008)
    for key, value in TUWUNEL_ENV.items():
        tuwunel = tuwunel.with_env(key, value)
    tuwunel = tuwunel.with_env("TUWUNEL_REGISTRATION_SHARED_SECRET", SHARED_SECRET)

    with PostgresContainer(POSTGRES_IMAGE) as pg, tuwunel:
        host = tuwunel.get_container_host_ip()
        port = tuwunel.get_exposed_port(8008)
        matrix_url = f"http://{host}:{port}"
        _wait_matrix_ready(matrix_url)
        yield StackInfo(pg=pg, matrix_url=matrix_url)


def _build_config(stack: StackInfo, db_name: str) -> SwitchConfig:
    pg = stack.pg
    return SwitchConfig(
        db_host=pg.get_container_host_ip(),
        db_port=str(pg.get_exposed_port(5432)),
        db_user=pg.username,
        db_password=pg.password,
        db_name=db_name,
        matrix_server=stack.matrix_url,
        matrix_server_name=SERVER_NAME,
        matrix_admin_user=ADMIN_USER,
        matrix_admin_password=ADMIN_PASSWORD,
        matrix_registration_shared_secret=SHARED_SECRET,
        agent_registration_token=REGISTRATION_TOKEN,
        jwt_secret_key=JWT_SECRET,
        gateway_admin_email=GATEWAY_ADMIN_EMAIL,
        gateway_admin_password=GATEWAY_ADMIN_PASSWORD,
        frontend_base_url=None,
    )


_PROFILE = IntegrationProfile(
    connection_model="session_passive",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=[],
    task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
)


class Harness:
    """In-process switch-core wiring for integration tests.

    Holds the real services and exposes the few operations a test needs:
    register agents, start their Matrix sync clients, and reach the RoomService
    / EventBuffer.
    """

    def __init__(
        self,
        *,
        protocol: ProtocolService,
        room_service: RoomService,
        client_lifecycle: ClientLifecycleService,
        room_store: RoomStore,
        event_buffer: EventBuffer,
        owner_id: str,
        session_factory: object,
    ) -> None:
        self.protocol = protocol
        self.room_service = room_service
        self.client_lifecycle = client_lifecycle
        self.room_store = room_store
        self.event_buffer = event_buffer
        self.owner_id = owner_id
        self.session_factory = session_factory
        self._registered: list[str] = []

    async def register_agent(self, name: str) -> RegistrationResult:
        result = await self.protocol.register_agent(
            name=name,
            description=f"integration test agent {name}",
            connector_type="test",
            integration_profile=_PROFILE,
            owner_id=self.owner_id,
            overwrite=True,
            # Harness agents address each other; the owner-only default would
            # block every agent-to-agent message. Tests that exercise scoped
            # addressing set a policy explicitly.
            owner_only=False,
        )
        self._registered.append(result.agent_id)
        return result

    async def start_clients(self, timeout: float = 20.0) -> None:
        """Start every registered agent's Matrix client and await readiness.

        `start_all` launches each client's sync loop as a background task; the
        client only loads its Agent (so `get_by_agent_id` resolves) once that
        task has run. Poll until each is present and ready before returning.
        """
        await self.client_lifecycle.start_all()
        for agent_id in self._registered:
            client = await self._await_client(agent_id, timeout)
            await client.wait_ready()

    async def _await_client(self, agent_id: str, timeout: float) -> AgentClient:
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            client = self.client_lifecycle.get_by_agent_id(agent_id)
            if client is not None:
                return client  # type: ignore[return-value]
            await asyncio.sleep(0.1)
        raise AssertionError(f"No running client for agent {agent_id} after {timeout}s")

    def client_for(self, agent_id: str) -> AgentClient:
        client = self.client_lifecycle.get_by_agent_id(agent_id)
        if client is None:
            raise AssertionError(f"No running client for agent {agent_id}")
        return client  # type: ignore[return-value]

    async def matrix_room_id(self, room_id: str) -> str:
        async with self.session_factory() as session:  # type: ignore[operator]
            room = await self.room_store.get(session, room_id)
        assert room is not None
        return room.matrix_room_id


async def _admin_dsn(stack: StackInfo) -> str:
    pg = stack.pg
    return (
        f"postgresql://{pg.username}:{pg.password}"
        f"@{pg.get_container_host_ip()}:{pg.get_exposed_port(5432)}/{pg.dbname}"
    )


async def _truncate_all(engine: AsyncEngine) -> None:
    """Reset row state between tests by truncating every mapped table at once.

    `RESTART IDENTITY CASCADE` zeroes sequences and follows FK references, so a
    single statement clears the whole graph regardless of table order.
    """
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    if not tables:
        return
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE"))


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def session_env(switch_stack: StackInfo) -> AsyncIterator[SessionEnv]:
    # One database for the whole session; tests reset it with TRUNCATE rather than
    # CREATE/DROP DATABASE. DROP at teardown uses FORCE to evict any still-open
    # sync connections.
    db_name = f"test_{uuid.uuid4().hex[:12]}"
    admin_dsn = await _admin_dsn(switch_stack)
    admin_conn = await asyncpg.connect(admin_dsn)
    await admin_conn.execute(f'CREATE DATABASE "{db_name}"')
    await admin_conn.close()

    config = _build_config(switch_stack, db_name)
    engine = create_engine_from_config(config)
    session_factory = create_session_factory(engine)

    # Schema is built directly from the SQLAlchemy models (not Alembic). This is
    # fast and always matches the current models, but means the integration suite
    # does NOT exercise the migration chain — model↔migration drift is caught
    # separately by `just migrate`, not here.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    await wait_for_homeserver(config.matrix_server)
    await ensure_admin_exists(
        server_url=config.matrix_server,
        username=config.matrix_admin_user,
        password=config.matrix_admin_password,
        shared_secret=config.matrix_registration_shared_secret,
    )
    matrix_admin = await MatrixAdmin.create(
        server_url=config.matrix_server,
        admin_user=config.matrix_admin_user,
        admin_password=config.matrix_admin_password,
        shared_secret=config.matrix_registration_shared_secret,
    )

    env = SessionEnv(
        config=config,
        engine=engine,
        session_factory=session_factory,
        matrix_admin=matrix_admin,
        agent_store=AgentStore(),
        agent_session_store=AgentSessionStore(),
        room_store=RoomStore(),
        client_store=ClientStore(),
        task_store=TaskStore(),
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        api_key_store=ApiKeyStore(),
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        room_role_store=RoomRoleStore(),
        user_store=UserStore(),
    )
    try:
        yield env
    finally:
        await matrix_admin.close()
        await engine.dispose()
        admin_conn = await asyncpg.connect(admin_dsn)
        try:
            await admin_conn.execute(
                f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'
            )
        finally:
            await admin_conn.close()


@pytest_asyncio.fixture(loop_scope="session")
async def harness(session_env: SessionEnv) -> AsyncIterator[Harness]:
    # Reset Postgres state from the previous test (Tuwunel is session-scoped and
    # is not reset — tests use unique agent names to avoid Matrix collisions).
    await _truncate_all(session_env.engine)

    config = session_env.config
    session_factory = session_env.session_factory

    # Owner user for agent registration (api keys are owned by a user); recreated
    # each test because the users table was just truncated.
    owner = User(name="Admin", email=GATEWAY_ADMIN_EMAIL, role="admin")
    async with session_factory() as session:  # type: ignore[operator]
        await session_env.user_store.create(session, owner)
        await session.commit()
    owner_id = owner.id

    # Per-test in-memory wiring: a fresh EventBuffer / client registry so queued
    # events and client registrations never leak across tests.
    event_buffer = EventBuffer()
    connections = ConnectionRegistry()
    request_tracker = RequestTracker()
    resource_request_tracker = ResourceRequestTracker()
    collab_lifecycle = _NoBridges()

    resource_service = ResourceService(
        reference_store=session_env.reference_store,
        reference_type_store=session_env.reference_type_store,
        document_store=session_env.document_store,
        package_store=session_env.package_store,
        room_link_store=session_env.room_link_store,
        session_factory=session_factory,
    )

    client_factory = ClientFactory(
        client_store=session_env.client_store,
        session_factory=session_factory,
        config=config,
    )
    client_factory.register(
        "agent",
        AgentClient,
        event_buffer=event_buffer,
        agent_store=session_env.agent_store,
        room_store=session_env.room_store,
        bridge_store=session_env.bridge_store,
        document_store=session_env.document_store,
        reference_store=session_env.reference_store,
        agent_session_store=session_env.agent_session_store,
        room_role_store=session_env.room_role_store,
        external_user_store=session_env.external_user_store,
        request_tracker=request_tracker,
        resource_request_tracker=resource_request_tracker,
        connections=connections,
        frontend_base_url=config.frontend_base_url,
    )
    client_factory.register("user", ClientBase)
    client_factory.register("bridge", ClientBase)

    client_lifecycle = ClientLifecycleService(
        matrix_admin=session_env.matrix_admin,
        client_store=session_env.client_store,
        client_factory=client_factory,
        session_factory=session_factory,
        config=config,
    )

    room_service = RoomService(
        matrix_admin=session_env.matrix_admin,
        room_store=session_env.room_store,
        agent_store=session_env.agent_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,  # type: ignore[arg-type]
        collab_bridge_store=session_env.bridge_store,
        resource_service=resource_service,
        session_factory=session_factory,
    )

    protocol = ProtocolService(
        agent_store=session_env.agent_store,
        agent_session_store=session_env.agent_session_store,
        room_store=session_env.room_store,
        room_service=room_service,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,  # type: ignore[arg-type]
        event_buffer=event_buffer,
        task_store=session_env.task_store,
        request_tracker=request_tracker,
        resource_request_tracker=resource_request_tracker,
        resource_service=resource_service,
        api_key_store=session_env.api_key_store,
        api_key_cache=ApiKeyCache(
            ttl_seconds=config.agent_auth_cache_ttl_seconds,
            max_entries=config.agent_auth_cache_max_entries,
        ),
        external_user_store=session_env.external_user_store,
        bridge_store=session_env.bridge_store,
        session_factory=session_factory,
        config=config,
        connections=connections,
    )

    h = Harness(
        protocol=protocol,
        room_service=room_service,
        client_lifecycle=client_lifecycle,
        room_store=session_env.room_store,
        event_buffer=event_buffer,
        owner_id=owner_id,
        session_factory=session_factory,
    )
    try:
        yield h
    finally:
        # Stop the agents' sync loops before the next test truncates, so none is
        # mid-query against a table being cleared.
        await client_lifecycle.stop_all()

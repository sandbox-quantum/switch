from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import signal
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from fastapi.responses import JSONResponse

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_TTL_SECONDS,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.request_tracker import RequestTracker
from switch_core.bridges.agent.server_connectors.agui.connector import (
    AgUiConnectionConfig,
    AgUiConnector,
)
from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)
from switch_core.bridges.agent.server_connectors.opencode.connector import (
    OpenCodeConnectionConfig,
    OpenCodeConnector,
)
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.bridges.resource.tracker import ResourceRequestTracker
from switch_core.clients.admin_client import AdminClient
from switch_core.clients.agent_client import AgentClient
from switch_core.clients.client_base import ClientBase
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.clients.resource_manager_client import ResourceManagerClient
from switch_core.config import SwitchConfig
from switch_core.crypto import encrypt_token
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import ApiKey, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.stores.task_store import TaskStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.app import create_gateway_app
from switch_core.gateway.auth import hash_password
from switch_core.matrix_admin import (
    MatrixAdmin,
    ensure_admin_exists,
    wait_for_homeserver,
)
from switch_core.room_service import RoomService
from switch_core.version import switch_core_version

logger = logging.getLogger(__name__)

# How often to reset runtime states whose session heartbeat has lapsed. A few
# seconds keeps a stuck "working"/"awaiting-input" surface from lingering long
# after a session crashes, while staying well above the per-pass DB cost.
_RUNTIME_STATE_SWEEP_INTERVAL = 5.0

# How often to close connections whose heartbeat has lapsed. Kept well under
# the heartbeat TTL so a dead connection's room slot and role lease are freed
# promptly rather than at the next unrelated request.
_CONNECTION_SWEEP_INTERVAL = 2.0


async def _runtime_state_sweep_loop(protocol: ProtocolService) -> None:
    while True:
        await asyncio.sleep(_RUNTIME_STATE_SWEEP_INTERVAL)
        try:
            await protocol.sweep_runtime_states()
        except Exception:
            logger.exception("Runtime-state sweep failed")


async def _connection_sweep_loop(protocol: ProtocolService) -> None:
    """Expire connections whose client has stopped beating.

    Skips a round after the event loop has been blocked. A stall stops us
    *processing* heartbeats, so every connection looks lapsed at once through no
    fault of its client — and expiring them all drops their room slots and role
    leases, then every client reconnects together, which is a worse stall. The
    clients were never given the chance to beat, so the honest reading is "we
    were not listening", not "they went away".
    """
    while True:
        started = time.monotonic()
        await asyncio.sleep(_CONNECTION_SWEEP_INTERVAL)
        overslept = (time.monotonic() - started) - _CONNECTION_SWEEP_INTERVAL
        if overslept > HEARTBEAT_TTL_SECONDS / 2:
            logger.warning(
                "Connection sweep skipped: the event loop was blocked for %.1fs, "
                "so heartbeats could not be processed and every connection would "
                "look lapsed. Something is blocking the loop — that is the bug, "
                "not the connections.",
                overslept,
            )
            continue
        try:
            for conn in protocol.connections.sweep():
                logger.info(
                    "Connection %s for agent %s expired (heartbeat lapsed, "
                    "%d beats received)",
                    conn.id,
                    conn.agent_id,
                    conn.beats,
                )
        except Exception:
            logger.exception("Connection sweep failed")


logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("nio.rooms").setLevel(logging.ERROR)
logging.getLogger("nio.client.base_client").setLevel(logging.WARNING)


class _QuietPollFilter(logging.Filter):
    _SUPPRESSED = [
        "/events?timeout=",
        "/room-history?",
        "/agents/",
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(p in msg for p in self._SUPPRESSED)


logging.getLogger("uvicorn.access").addFilter(_QuietPollFilter())


async def run() -> None:
    config = SwitchConfig()
    # ── Database ─────────────────────────────────────────────────────────────
    engine = create_engine_from_config(config)
    session_factory = create_session_factory(engine)

    # ── Matrix homeserver admin ──────────────────────────────────────────────
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

    # ── Stores ───────────────────────────────────────────────────────────────
    agent_store = AgentStore()
    agent_session_store = AgentSessionStore()
    room_store = RoomStore()
    client_store = ClientStore()
    task_store = TaskStore()
    bridge_store = CollaborationBridgeStore()
    external_user_store = ExternalUserStore()
    bridge_message_map_store = BridgeMessageMapStore()
    user_store = UserStore()
    api_key_store = ApiKeyStore()
    reference_store = ReferenceStore()
    document_store = DocumentStore()
    package_store = PackageStore()
    room_link_store = RoomLinkStore()
    room_group_store = RoomGroupStore()
    room_role_store = RoomRoleStore()

    # ── Seed admin user + registration key ──────────────────────────────────
    await _seed_admin_user(session_factory, user_store, config)
    await _seed_admin_registration_key(
        session_factory, user_store, api_key_store, config
    )

    # ── Event queue + request trackers ───────────────────────────────────────
    event_buffer = EventBuffer()
    request_tracker = RequestTracker()
    resource_request_tracker = ResourceRequestTracker()
    connector_store = ServerConnectorStore()

    # ── Resource service ─────────────────────────────────────────────────────
    resource_service = ResourceService(
        reference_store=reference_store,
        document_store=document_store,
        package_store=package_store,
        room_link_store=room_link_store,
        session_factory=session_factory,
    )

    # One connection registry for the process. Created here rather than inside
    # the agent bridge because the Matrix agent clients are wired first and read
    # presence from it — an agent is reachable if it has a live connection OR a
    # fresh heartbeat row (CHOO-1857 stage B).
    connections = ConnectionRegistry()

    # ── Client factory ───────────────────────────────────────────────────────
    client_factory = ClientFactory(
        client_store=client_store,
        session_factory=session_factory,
        config=config,
    )
    client_factory.register(
        "agent",
        AgentClient,
        event_buffer=event_buffer,
        agent_store=agent_store,
        room_store=room_store,
        bridge_store=bridge_store,
        document_store=document_store,
        reference_store=reference_store,
        agent_session_store=agent_session_store,
        room_role_store=room_role_store,
        external_user_store=external_user_store,
        request_tracker=request_tracker,
        resource_request_tracker=resource_request_tracker,
        connections=connections,
        frontend_base_url=config.frontend_base_url,
    )
    client_factory.register(
        "resource_manager",
        ResourceManagerClient,
        agent_store=agent_store,
        room_store=room_store,
        resource_service=resource_service,
        request_tracker=request_tracker,
    )
    client_factory.register("user", ClientBase)
    client_factory.register("bridge", ClientBase)

    # ── Client lifecycle ─────────────────────────────────────────────────────
    client_lifecycle = ClientLifecycleService(
        matrix_admin=matrix_admin,
        client_store=client_store,
        client_factory=client_factory,
        session_factory=session_factory,
        config=config,
    )

    # ── Collaboration bridge lifecycle ───────────────────────────────────────
    collab_lifecycle = CollaborationBridgeLifecycleService(
        bridge_store=bridge_store,
        external_user_store=external_user_store,
        bridge_message_map_store=bridge_message_map_store,
        room_store=room_store,
        agent_store=agent_store,
        client_store=client_store,
        client_lifecycle=client_lifecycle,
        room_service=None,  # type: ignore[arg-type]  # set after RoomService creation
        matrix_admin=matrix_admin,
        session_factory=session_factory,
        config=config,
    )

    # ── Room service ─────────────────────────────────────────────────────────
    room_service = RoomService(
        matrix_admin=matrix_admin,
        room_store=room_store,
        agent_store=agent_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        collab_bridge_store=bridge_store,
        resource_service=resource_service,
        session_factory=session_factory,
    )
    collab_lifecycle._room_service = room_service

    # Registered after RoomService is built: the admin client owns the
    # `!invite-agent` command, which reuses RoomService to add agents to the
    # room (and any bridged channel).
    client_factory.register(
        "admin",
        AdminClient,
        agent_store=agent_store,
        room_store=room_store,
        room_role_store=room_role_store,
        document_store=document_store,
        reference_store=reference_store,
        agent_session_store=agent_session_store,
        room_service=room_service,
        connections=connections,
        frontend_base_url=config.frontend_base_url,
    )

    # ── FastAPI apps ─────────────────────────────────────────────────────────
    agent_bridge_app, protocol = create_agent_bridge_app(
        agent_store=agent_store,
        agent_session_store=agent_session_store,
        room_store=room_store,
        room_service=room_service,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        event_buffer=event_buffer,
        task_store=task_store,
        request_tracker=request_tracker,
        resource_request_tracker=resource_request_tracker,
        resource_service=resource_service,
        api_key_store=api_key_store,
        external_user_store=external_user_store,
        bridge_store=bridge_store,
        session_factory=session_factory,
        config=config,
        connections=connections,
    )
    # ── Server-side connector lifecycle ─────────────────────────────────────
    connector_lifecycle = ServerSideConnectorLifecycleService(
        connector_store=connector_store,
        api_key_store=api_key_store,
        protocol=protocol,
        session_factory=session_factory,
        encryption_secret=config.jwt_secret_key,
    )
    connector_lifecycle.register_connector_type(
        "opencode", OpenCodeConnector, OpenCodeConnectionConfig
    )
    connector_lifecycle.register_connector_type(
        "agui", AgUiConnector, AgUiConnectionConfig
    )

    # ── Gateway app ───────────────────────────────────────────────────────────
    gateway_app = create_gateway_app(
        agent_store=agent_store,
        room_store=room_store,
        room_group_store=room_group_store,
        room_service=room_service,
        bridge_store=bridge_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        connector_lifecycle=connector_lifecycle,
        connector_store=connector_store,
        event_buffer=event_buffer,
        session_factory=session_factory,
        user_store=user_store,
        external_user_store=external_user_store,
        api_key_store=api_key_store,
        resource_service=resource_service,
        protocol=protocol,
        config=config,
    )

    # Register collaboration bridge adapter types
    collab_lifecycle.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )
    collab_lifecycle.register_adapter("slack", SlackAdapter, SlackConnectionConfig)
    collab_lifecycle.register_adapter("teams", TeamsAdapter, TeamsConnectionConfig)
    collab_lifecycle.register_adapter(
        "discord", DiscordAdapter, DiscordConnectionConfig
    )
    collab_lifecycle.register_adapter(
        "telegram", TelegramAdapter, TelegramConnectionConfig
    )

    # Health check mounted on the agent bridge app
    @agent_bridge_app.get("/health")
    async def health_check() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    agent_bridge_app.mount("/gateway", gateway_app)

    # ── Ensure system clients exist ─────────────────────────────────────────
    await client_lifecycle.ensure_system_client("resource_manager")
    await client_lifecycle.ensure_system_client("admin")

    # ── Lifespan: start server-side connectors once HTTP is serving ────────
    original_lifespan = agent_bridge_app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app: object) -> AsyncIterator[None]:
        async with original_lifespan(app):  # type: ignore[arg-type]
            asyncio.create_task(connector_lifecycle.start_all())
            sweep_task = asyncio.create_task(_runtime_state_sweep_loop(protocol))
            connection_sweep_task = asyncio.create_task(
                _connection_sweep_loop(protocol)
            )
            try:
                yield
            finally:
                sweep_task.cancel()
                connection_sweep_task.cancel()

    agent_bridge_app.router.lifespan_context = lifespan  # type: ignore[assignment]

    # ── Start runtime ────────────────────────────────────────────────────────
    await client_lifecycle.start_all()
    await collab_lifecycle.start_all()

    # Backfill system clients (e.g. the admin client) into rooms created before
    # they existed; the just-started clients auto-accept the invites.
    await room_service.reconcile_system_clients()

    logger.info(
        "Switch is running on http://%s:%d", config.server_host, config.server_port
    )

    server_config = uvicorn.Config(
        agent_bridge_app,
        host=config.server_host,
        port=config.server_port,
        log_level="info",
        log_config=None,
    )
    server = uvicorn.Server(server_config)

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(
            sig,
            lambda: asyncio.create_task(
                _shutdown(
                    server,
                    client_lifecycle,
                    collab_lifecycle,
                    connector_lifecycle,
                    matrix_admin,
                )
            ),
        )

    await server.serve()


async def _seed_admin_user(
    session_factory: object,
    user_store: UserStore,
    config: SwitchConfig,
) -> None:
    async with session_factory() as session:  # type: ignore[operator]
        existing = await user_store.get_by_email(session, config.gateway_admin_email)
        if existing is not None:
            logger.info("Admin user already exists: %s", config.gateway_admin_email)
            return

        admin = User(
            name="Admin",
            email=config.gateway_admin_email,
            role="admin",
            password_hash=hash_password(config.gateway_admin_password),
        )
        await user_store.create(session, admin)
        await session.commit()
        logger.info("Seeded admin user: %s", config.gateway_admin_email)


async def _seed_admin_registration_key(
    session_factory: object,
    user_store: UserStore,
    api_key_store: ApiKeyStore,
    config: SwitchConfig,
) -> None:
    async with session_factory() as session:  # type: ignore[operator]
        admin = await user_store.get_by_email(session, config.gateway_admin_email)
        if admin is None:
            logger.error(
                "Cannot seed registration key: admin user %s not found",
                config.gateway_admin_email,
            )
            return

        token_hash = hashlib.sha256(
            config.agent_registration_token.encode()
        ).hexdigest()
        existing = await api_key_store.get_by_hash(session, token_hash)
        if existing is not None:
            logger.info("Admin registration key already seeded")
            return

        key = ApiKey(
            user_id=admin.id,
            key_hash=token_hash,
            encrypted_key=encrypt_token(
                config.agent_registration_token, config.jwt_secret_key
            ),
            label="Default (from AGENT_REGISTRATION_TOKEN)",
            type="registration",
        )
        await api_key_store.create(session, key)
        await session.commit()
        logger.info("Seeded admin registration key from AGENT_REGISTRATION_TOKEN")


async def _shutdown(
    server: uvicorn.Server,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    connector_lifecycle: ServerSideConnectorLifecycleService,
    matrix_admin: MatrixAdmin,
) -> None:
    logger.info("Shutting down...")
    server.should_exit = True
    await connector_lifecycle.stop_all()
    await collab_lifecycle.stop_all()
    await client_lifecycle.stop_all()
    await matrix_admin.close()

    await asyncio.sleep(1)
    logger.info("Forcing exit")
    os._exit(0)


def main() -> None:
    alembic_ini = Path(__file__).resolve().parent.parent / "alembic.ini"
    alembic_cfg = AlembicConfig(str(alembic_ini))
    alembic_command.upgrade(alembic_cfg, "head")

    log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
    switch_log_level = os.environ.get("SWITCH_LOG_LEVEL", "INFO").upper()
    logging.getLogger().setLevel(log_level)
    logging.getLogger("switch_core").setLevel(switch_log_level)

    running_version = switch_core_version()
    logger.info("Starting switch-core %s", running_version or "(version unknown)")

    logger.info("Database migrations applied")

    asyncio.run(run())


if __name__ == "__main__":
    main()

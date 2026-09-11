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
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_TTL_SECONDS,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_LABEL,
    BOOTSTRAP_KEY_TYPE,
    BOOTSTRAP_LAST_SEEDED_HASH_META_KEY,
    BOOTSTRAP_REVOKED_HASHES_META_KEY,
    LEGACY_BOOTSTRAP_KEY_LABEL,
    RETIRED_KEY_TYPE,
    ensure_bootstrap_owner,
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
from switch_core.clients.admin_client import AdminClient
from switch_core.clients.agent_client import AgentClient
from switch_core.clients.client_base import ClientBase
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.crypto import encrypt_token
from switch_core.db.boot_lock import boot_lock
from switch_core.db.engine import (
    create_engine_from_config,
    create_session_factory,
    create_unpooled_engine,
)
from switch_core.db.models import TENANT_ZERO_ID, ApiKey, User
from switch_core.db.runtime_role import (
    RuntimeRoleError,
    grant_runtime_role,
    verify_restricted_role,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.db.stores.task_store import TaskStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.gateway.app import create_gateway_app
from switch_core.gateway.auth import hash_password
from switch_core.logging_config import configure_logging
from switch_core.messages.notify import MessageListener
from switch_core.provisioning import Provisioning
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomService
from switch_core.tenant_context import no_tenant
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
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
    # `no_tenant` for the reason every other long-lived task does it: a task
    # keeps the context of whoever created it, and nothing in here may depend
    # on that. Boot binds nothing today, so this changes no behaviour — it
    # removes the dependency on boot continuing not to.
    with no_tenant():
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


async def _prepare_database(config: SwitchConfig) -> None:
    """Re-issue the runtime role's grants, on the owner's connection.

    Runs after `alembic upgrade head` and before anything opens the runtime
    engine, so a table the migration has just added is granted before the role
    that needs it connects. Skipped where no owner is configured: that is a
    deployment whose migrations and grants are somebody else's job, and
    inventing an owner connection for it would be worse than doing nothing.
    """
    owner_url = config.owner_database_url
    if owner_url is None:
        return
    owner_engine = create_async_engine(
        owner_url, poolclass=NullPool, connect_args=config.db_connect_args
    )
    try:
        async with owner_engine.begin() as connection:
            await grant_runtime_role(connection, config.db_user)
    finally:
        await owner_engine.dispose()
    logger.info(
        "Granted the runtime role %s access to the schema owned by %s",
        config.db_user,
        config.db_owner_user,
    )


async def _check_tenant_isolation(config: SwitchConfig, engine: AsyncEngine) -> None:
    """Refuse to serve on a connection the policies do not apply to.

    Before anything else touches the database, because the first thing that
    does is the admin seeding, and a deployment that is not isolating tenants
    should not get as far as writing a row.
    """
    try:
        await verify_restricted_role(engine)
    except RuntimeRoleError as exc:
        if config.db_require_restricted_role:
            raise
        logger.error(
            "Tenant isolation is NOT in force on this deployment: %s "
            "Continuing only because DB_REQUIRE_RESTRICTED_ROLE is false. "
            "Every row-level-security policy in this schema is inert, and any "
            "second tenant onboarded here can read the first's data.",
            exc,
        )


async def run(config: SwitchConfig) -> None:
    # ── Database ─────────────────────────────────────────────────────────────
    # The migration and the runtime role's grant re-issue already ran, under
    # Switch's boot-time advisory lock, before this coroutine was ever started
    # — see `main._migrate_and_grant`, which `main()` awaits first. Both use
    # the schema owner's connection where one is configured, and neither
    # belongs on the pooled application engine built below.
    engine = create_engine_from_config(config)
    await _check_tenant_isolation(config, engine)
    session_factory = create_session_factory(engine)
    # Its connection is held rather than borrowed, so it builds its own outside
    # the pool. Nothing subscribes yet; it starts with the server so that the
    # subscription exists before the first consumer needs it.
    message_listener = MessageListener(lambda: create_unpooled_engine(config))

    # Invitations for the Postgres transport, which has no durable one of its
    # own. Built unconditionally: it is a dict until something registers.
    invites = InviteBus()
    ephemeral = EphemeralBus()

    # ── Stores ───────────────────────────────────────────────────────────────
    agent_store = AgentStore()
    agent_session_store = AgentSessionStore()
    room_store = RoomStore()
    client_store = ClientStore()
    task_store = TaskStore()
    bridge_store = CollaborationBridgeStore()
    external_user_store = ExternalUserStore()
    bridge_message_map_store = BridgeMessageMapStore()
    session_request_post_store = SessionRequestPostStore()
    user_store = UserStore()
    api_key_store = ApiKeyStore()
    tenant_store = TenantStore()
    reference_store = ReferenceStore()
    reference_type_store = ReferenceTypeStore()
    document_store = DocumentStore()
    package_store = PackageStore()
    room_link_store = RoomLinkStore()
    room_group_store = RoomGroupStore()
    room_role_store = RoomRoleStore()
    message_store = MessageStore()
    media_store = MediaStore()

    # ── Seed admin user + agent-registration bootstrap key ──────────────────
    # A second acquisition of the boot lock, distinct from the one around the
    # migration in `main._migrate_and_grant`: nothing between the two needs
    # another replica kept out, so there is nothing to gain from holding one
    # lock across the whole of boot instead of two narrower ones. This one
    # cannot be a transaction-scoped `pg_advisory_xact_lock` the way a single
    # migration transaction could be, though — the seeding below reads its own
    # state and writes it back across several separate sessions (see
    # `_seed_agent_registration_bootstrap_key`'s docstring), so only a
    # session-level lock, held for the whole span, actually serialises it.
    async with boot_lock(config):
        await _seed_admin_user(session_factory, user_store, config)
        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, agent_store, config
        )

    # ── Event queue + request trackers ───────────────────────────────────────
    event_buffer = EventBuffer()
    connector_store = ServerConnectorStore()

    # ── Resource service ─────────────────────────────────────────────────────
    resource_service = ResourceService(
        reference_store=reference_store,
        reference_type_store=reference_type_store,
        document_store=document_store,
        package_store=package_store,
        room_link_store=room_link_store,
        session_factory=session_factory,
    )
    # Once per tenant, not once for the deployment: `reference_types` is
    # scoped, so "every stored type a built-in shadows" is a question asked of
    # one tenant at a time. Which tenants there are is the one read that
    # cannot be scoped to any of them, so it goes through the exemption
    # (`db/tenant_lookup.py`) rather than through a session.
    #
    # No `row.tenant_id == tenant_id` filter here, unlike the fan-outs in
    # `ClientLifecycleService`: `ReferenceTypeStore.list_all` names `tenant_id
    # = require_tenant_id()` in its own query rather than leaning on the
    # policy for it (it is the one store that has to, per `db/tenant_lookup.py`
    # and `reference_type_store.py` — `reference_types` has no `id` column of
    # its own to filter by otherwise). That WHERE clause narrows correctly on
    # an owner connection too, so each pass through this loop already sees
    # only the tenant it just bound; a row-by-row filter on top of it would
    # compare a value against one it can never disagree with.
    tenant_ids = await all_tenant_ids(session_factory)
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            await resource_service.log_builtin_shadowing(session)

    # ── Provisioning ─────────────────────────────────────────────────────────
    matrix_admin: Provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=room_store,
        client_store=client_store,
        message_store=message_store,
        invites=invites,
    )

    # One connection registry for the process. Created here rather than inside
    # the agent bridge because the room clients are wired first and read
    # presence from it — an agent is reachable if it has a live connection OR a
    # fresh heartbeat row (CHOO-1857 stage B).
    connections = ConnectionRegistry()

    # ── Client factory ───────────────────────────────────────────────────────
    client_factory = ClientFactory(
        client_store=client_store,
        session_factory=session_factory,
        config=config,
        room_store=room_store,
        message_store=message_store,
        media_store=media_store,
        listener=message_listener,
        invites=invites,
        ephemeral=ephemeral,
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
        connections=connections,
        frontend_base_url=config.frontend_base_url,
    )
    client_factory.register("user", ClientBase)
    client_factory.register("bridge", ClientBase)

    # ── Client lifecycle ─────────────────────────────────────────────────────
    client_lifecycle = ClientLifecycleService(
        matrix_admin=matrix_admin,
        client_store=client_store,
        tenant_store=tenant_store,
        client_factory=client_factory,
        session_factory=session_factory,
        config=config,
    )

    # ── Collaboration bridge lifecycle ───────────────────────────────────────
    collab_lifecycle = CollaborationBridgeLifecycleService(
        bridge_store=bridge_store,
        external_user_store=external_user_store,
        bridge_message_map_store=bridge_message_map_store,
        session_request_post_store=session_request_post_store,
        room_store=room_store,
        agent_store=agent_store,
        client_store=client_store,
        client_lifecycle=client_lifecycle,
        room_service=None,  # type: ignore[arg-type]  # set after RoomService creation
        matrix_admin=matrix_admin,
        session_factory=session_factory,
        config=config,
        client_factory=client_factory,
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
            await message_listener.start()
            try:
                yield
            finally:
                sweep_task.cancel()
                connection_sweep_task.cancel()
                await message_listener.stop()

    agent_bridge_app.router.lifespan_context = lifespan  # type: ignore[assignment]

    # ── Start runtime ────────────────────────────────────────────────────────
    await client_lifecycle.start_all()
    await collab_lifecycle.start_all()

    # Backfill room membership: system clients (e.g. the admin client) added
    # after a room was created, and any agent whose invite did not land. The
    # just-started clients accept the invites on their first sync.
    await room_service.reconcile_room_clients()

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
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> None:
    # Tenant zero by name, not by fallback. The admin `User` row is global
    # (db/models.py) and the lookup below spans every tenant either way, but
    # `UserStore.create` also writes a `tenant_members` row, and which tenant
    # the deployment's own admin joins is a decision this line makes rather
    # than one a default makes for it. It is the same decision, and the same
    # reasoning, as `gateway/oidc_routes.py` binding tenant zero around a
    # just-in-time provisioned account: exactly one tenant exists, and signing
    # up into a tenant of one's own is a later phase, whose change is here.
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        existing = await user_store.get_by_email(session, config.gateway_admin_email)
        if existing is not None:
            # Existing, but not necessarily whole. An account with no
            # `tenant_members` row cannot sign in at all — `gateway/auth.py`
            # refuses to guess a tenant and answers 403 — and until this ran,
            # the only thing in the product that ever wrote a missing
            # membership was an OIDC login, so a password account in that
            # state was locked out with no way back in short of SQL. The
            # migration backfilled every account that existed when it ran;
            # this covers the ones that did not, and any whose membership is
            # lost later.
            if await user_store.ensure_membership(session, existing):
                await session.commit()
                logger.warning(
                    "Admin user %s had no tenant membership and could not have "
                    "signed in; joined it to tenant %s.",
                    config.gateway_admin_email,
                    TENANT_ZERO_ID,
                )
            else:
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


async def _seed_agent_registration_bootstrap_key(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    api_key_store: ApiKeyStore,
    agent_store: AgentStore,
    config: SwitchConfig,
) -> None:
    """Seed the deployment-wide agent-registration bootstrap key.

    Unlike a personal registration key (minted by, and owned by, a single
    gateway user), this key is handed out to bring up the first agents
    against a fresh deployment before anyone has logged in. Agents it
    registers are attributed to a dedicated, non-admin account (see
    ``registration_bootstrap.py``), not to the admin user this key's ApiKey
    row is filed under — the row lives on the admin so it is listed and
    revocable from the admin's own API Keys page, but holding the token
    itself confers no admin authority.

    Existence and rotation are resolved by the key's own hash and type
    globally, never by which user the configured admin email currently
    resolves to: an admin row is looked up here only to own a freshly
    created key, and can be swapped out (``GATEWAY_ADMIN_EMAIL`` changed to a
    different account) without this re-inserting a duplicate of a key that
    already exists under the old one, which would collide on the unique
    ``key_hash`` and fail the whole boot.
    """
    # This was one unscoped session, and it is the one place in the tree where
    # "unscoped session" and "scoped write" met — the design doc named it as
    # the path the runtime role would have to come back for. It has, and this
    # is what it became: three phases, each scoped to the tenant it is
    # actually acting in, and the only cross-tenant question left ("which
    # tenants are there") answered by the exemption in `db/tenant_lookup.py`.
    tenant_ids = await all_tenant_ids(session_factory)

    # ── The two accounts, in tenant zero ────────────────────────────────────
    # `users` is global, so the lookups need no tenant; `ensure_bootstrap_owner`
    # writes a `tenant_members` row, which does. It named tenant zero before
    # and still does — the deployment's own accounts belong to the tenant the
    # migration created — but it now does so on a session that was bound
    # *before* its transaction opened, which is what makes the write land at
    # all: a `tenant_scope` entered inside an already-begun transaction changes
    # nothing, because the `set_config` rides `after_begin`.
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        admin = await user_store.get_by_email(session, config.gateway_admin_email)
        if admin is None:
            raise RuntimeError(
                "Cannot seed agent-registration bootstrap key: admin user "
                f"{config.gateway_admin_email} not found"
            )
        admin_id = admin.id
        bootstrap_owner = await ensure_bootstrap_owner(session, user_store)
        bootstrap_owner_id = bootstrap_owner.id
        owner_metadata = dict(bootstrap_owner.metadata_ or {})
        await session.commit()

    # ── The admin-owned-agent warning, over every tenant ────────────────────
    # It has to see every tenant's agents or it under-reports exactly the case
    # it exists to flag, and it now does so one tenant at a time. The names
    # are collected rather than the rows: nothing here needs an `Agent` past
    # the session that read it.
    admin_owned_agents: list[str] = []
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            # Filtered on the row's own tenant as well as the owner: on an
            # owner connection no policy narrows the read, and every tenant's
            # agents would be counted once per tenant. See
            # `db/tenant_lookup.py`.
            admin_owned_agents.extend(
                agent.name
                for agent in await agent_store.get_all(session)
                if agent.owner_id == admin_id and agent.tenant_id == tenant_id
            )
    if admin_owned_agents:
        logger.warning(
            "%d agent(s) are owned by the admin user (%s) and carry "
            "admin-equivalent authority over every room and resource in "
            "this deployment, not just their own: %s. If any were "
            "registered through AGENT_REGISTRATION_TOKEN, reassign or "
            "re-register them under a non-admin owner.",
            len(admin_owned_agents),
            config.gateway_admin_email,
            ", ".join(admin_owned_agents),
        )

    # ── The key itself, in the one tenant that holds it ─────────────────────
    key_tenant_id = await _bootstrap_key_tenant(
        session_factory, api_key_store, tenant_ids
    )
    # Retiring a stale legacy key is deployment-wide even though adopting one
    # is not. The block below works in a single tenant, which is right for the
    # key — it is one per deployment — and wrong for the sweep beside it: a
    # legacy admin-owned registration row in some *other* tenant still
    # authenticates and still registers agents with admin authority, which is
    # the case that sweep exists to stop. It reads every tenant, one at a
    # time, and hands back what it revoked so the owner's record below covers
    # those hashes too.
    retired_elsewhere = await _retire_legacy_keys_outside(
        session_factory, api_key_store, tenant_ids, key_tenant_id
    )
    async with tenant_session(session_factory, key_tenant_id) as session:
        token_hash = hashlib.sha256(
            config.agent_registration_token.encode()
        ).hexdigest()
        encrypted_key = encrypt_token(
            config.agent_registration_token, config.jwt_secret_key
        )

        # Filtered on this tenant as well as on the type, for the same reason
        # every other fan-out in this change is: `get_by_type` carries no
        # tenant filter of its own, so on an owner connection it answers with
        # every tenant's keys and this block would adopt or retire one that
        # belongs to somebody else. See `db/tenant_lookup.py`.
        bootstrap_keys = [
            row
            for row in await api_key_store.get_by_type(session, BOOTSTRAP_KEY_TYPE)
            if row.tenant_id == key_tenant_id
        ]
        if len(bootstrap_keys) > 1:
            raise RuntimeError(
                f"Found {len(bootstrap_keys)} agent-registration bootstrap "
                "keys; expected at most one. This needs a direct database fix."
            )
        bootstrap_key = bootstrap_keys[0] if bootstrap_keys else None

        last_seeded_hash = owner_metadata.get(BOOTSTRAP_LAST_SEEDED_HASH_META_KEY)
        raw_revoked_hashes = owner_metadata.get(BOOTSTRAP_REVOKED_HASHES_META_KEY)
        if raw_revoked_hashes is not None and not isinstance(raw_revoked_hashes, list):
            raise RuntimeError(
                f"{BOOTSTRAP_REVOKED_HASHES_META_KEY} on the agent-registration "
                "bootstrap owner is not a list; refusing to guess which "
                "hashes are revoked. This needs a direct database fix."
            )
        revoked_hashes: list[str] = list(raw_revoked_hashes or [])
        meta_dirty = False
        for retired in retired_elsewhere:
            if retired not in revoked_hashes:
                revoked_hashes.append(retired)
                meta_dirty = True

        if (
            bootstrap_key is None
            and last_seeded_hash is not None
            and last_seeded_hash not in revoked_hashes
        ):
            # A key was active as of the last seed call and is gone now: it
            # was deleted (revoked) since then. Remember its value forever,
            # not just until the next rotation — see the constant's docstring.
            revoked_hashes.append(last_seeded_hash)
            meta_dirty = True
            logger.warning(
                "Agent-registration bootstrap key was deleted since the "
                "last restart; its value is now permanently refused, even "
                "if AGENT_REGISTRATION_TOKEN is later set back to it."
            )

        if bootstrap_key is None:
            # Every row carrying the legacy label, not just one matching the
            # current token: an admin who rotated AGENT_REGISTRATION_TOKEN at
            # or before this upgrade leaves the old row's hash stale, so a
            # hash-only lookup for the current token would miss it — and a
            # `type: "registration"` row at that label is otherwise
            # indistinguishable from a live credential that still
            # authenticates as the admin. Scoped to "no bootstrap key yet":
            # once one exists, any startup that still finds a legacy-labeled
            # row here already retired it on an earlier pass.
            legacy_rows = [
                row
                for row in await api_key_store.get_by_label(
                    session, LEGACY_BOOTSTRAP_KEY_LABEL
                )
                if row.type == "registration" and row.tenant_id == key_tenant_id
            ]
            matching_legacy = next(
                (row for row in legacy_rows if row.key_hash == token_hash), None
            )
            if matching_legacy is not None:
                matching_legacy.type = BOOTSTRAP_KEY_TYPE
                matching_legacy.label = BOOTSTRAP_KEY_LABEL
                matching_legacy.encrypted_key = encrypted_key
                bootstrap_key = matching_legacy
                logger.info(
                    "Migrated the legacy admin-owned registration key to a "
                    "scoped agent-registration bootstrap key"
                )
            for stale in legacy_rows:
                if stale is matching_legacy:
                    continue
                # Retired, not deleted: every consumer already refuses
                # RETIRED_KEY_TYPE (it is not in REGISTRATION_KEY_TYPES), so
                # this stops it authenticating exactly as deletion would —
                # but the row stays on the API Keys page (filtered on type,
                # not existence) with a label that says why, so an operator
                # can tell a stale bootstrap key apart from a personal key
                # that coincidentally shared the label, and delete it
                # themselves once they have. Its hash is also permanently
                # revoked: restoring an old .env or values file must not
                # bring it back to life via the rotation path below.
                stale.type = RETIRED_KEY_TYPE
                stale.label = f"{stale.label} (retired: stale, no longer authenticates)"
                if stale.key_hash not in revoked_hashes:
                    revoked_hashes.append(stale.key_hash)
                    meta_dirty = True
                logger.warning(
                    "Retired a stale admin-owned registration key (id %s, "
                    "label %r): its value no longer matches "
                    "AGENT_REGISTRATION_TOKEN, so it predates a token "
                    "rotation and would otherwise keep registering agents "
                    "with admin authority indefinitely. It is now visible "
                    "on the API Keys page for a human to review and delete.",
                    stale.id,
                    LEGACY_BOOTSTRAP_KEY_LABEL,
                )

        if bootstrap_key is not None:
            if bootstrap_key.key_hash != token_hash:
                if token_hash in revoked_hashes:
                    logger.warning(
                        "AGENT_REGISTRATION_TOKEN matches a previously "
                        "revoked agent-registration bootstrap key; refusing "
                        "to rotate onto it. Set a new, never-used value to "
                        "change the active key."
                    )
                else:
                    bootstrap_key.key_hash = token_hash
                    bootstrap_key.encrypted_key = encrypted_key
                    logger.info(
                        "Rotated the agent-registration bootstrap key from "
                        "AGENT_REGISTRATION_TOKEN"
                    )
        elif token_hash in revoked_hashes:
            logger.warning(
                "Agent-registration bootstrap key was revoked; not "
                "reseeding it from AGENT_REGISTRATION_TOKEN. Set a new, "
                "never-used value to re-enable deployment-wide bootstrap "
                "registration, or mint per-user registration keys from the "
                "gateway's API Keys page instead."
            )
        else:
            # No explicit `tenant_id`: the session is bound to the tenant this
            # key belongs to, so the column default writes it, the same way
            # every other scoped insert in the tree does. Naming a constant
            # here was the shape that only worked while nothing enforced it.
            bootstrap_key = ApiKey(
                user_id=admin_id,
                key_hash=token_hash,
                encrypted_key=encrypted_key,
                label=BOOTSTRAP_KEY_LABEL,
                type=BOOTSTRAP_KEY_TYPE,
            )
            await api_key_store.create(session, bootstrap_key)
            logger.info(
                "Seeded the agent-registration bootstrap key from "
                "AGENT_REGISTRATION_TOKEN"
            )

        new_last_seeded_hash = bootstrap_key.key_hash if bootstrap_key else None
        if new_last_seeded_hash != last_seeded_hash:
            meta_dirty = True

        if meta_dirty:
            # `users` carries no tenant, so the owner row is writable from
            # this session whichever tenant holds the key. Re-read rather than
            # carried over from the block above: the object there belonged to
            # a session that has since closed, and mutating a detached row
            # persists nothing.
            owner = await user_store.get(session, bootstrap_owner_id)
            if owner is None:
                raise RuntimeError(
                    "The agent-registration bootstrap owner vanished between "
                    "being seeded and being updated; this needs a direct "
                    "database fix."
                )
            meta = dict(owner.metadata_ or {})
            meta[BOOTSTRAP_LAST_SEEDED_HASH_META_KEY] = new_last_seeded_hash
            meta[BOOTSTRAP_REVOKED_HASHES_META_KEY] = revoked_hashes
            owner.metadata_ = meta

        await session.commit()


async def _retire_legacy_keys_outside(
    session_factory: async_sessionmaker[AsyncSession],
    api_key_store: ApiKeyStore,
    tenant_ids: list[str],
    key_tenant_id: str,
) -> list[str]:
    """Retire every legacy admin-owned registration key outside `key_tenant_id`.

    The seeding proper works in one tenant, because the bootstrap key is one
    per deployment. This sweep cannot: a `type: "registration"` row carrying
    the legacy label is indistinguishable from a live credential that
    authenticates as the admin, and one sitting in another tenant goes on
    doing so. Adoption stays where the key is; retirement goes everywhere,
    because "no longer authenticates" is not a per-tenant claim.

    Retired rather than deleted, for the reason the seeding gives at length:
    every consumer already refuses `RETIRED_KEY_TYPE`, so this stops it
    authenticating exactly as deletion would, while the row stays on the API
    Keys page with a label saying why. The hashes come back so the bootstrap
    owner's `revoked_hashes` covers them and restoring an old .env cannot
    bring one back through the rotation path.
    """
    retired: list[str] = []
    for tenant_id in tenant_ids:
        if tenant_id == key_tenant_id:
            continue
        async with tenant_session(session_factory, tenant_id) as session:
            stale_rows = [
                row
                for row in await api_key_store.get_by_label(
                    session, LEGACY_BOOTSTRAP_KEY_LABEL
                )
                if row.type == "registration" and row.tenant_id == tenant_id
            ]
            for stale in stale_rows:
                stale.type = RETIRED_KEY_TYPE
                stale.label = f"{stale.label} (retired: stale, no longer authenticates)"
                retired.append(stale.key_hash)
                logger.warning(
                    "Retired a stale admin-owned registration key (id %s) in "
                    "tenant %s: the deployment's agent-registration bootstrap "
                    "key lives in tenant %s, so this one authenticates nothing "
                    "the operator intends and would otherwise keep registering "
                    "agents with admin authority indefinitely. It is now "
                    "visible on the API Keys page for a human to review.",
                    stale.id,
                    tenant_id,
                    key_tenant_id,
                )
            if stale_rows:
                await session.commit()
    return retired


async def _bootstrap_key_tenant(
    session_factory: async_sessionmaker[AsyncSession],
    api_key_store: ApiKeyStore,
    tenant_ids: list[str],
) -> str:
    """Which tenant holds the deployment's agent-registration bootstrap key.

    The key is one per deployment and `api_keys` is scoped, so "one per
    deployment" is a claim about a set of per-tenant tables rather than about
    one table. This asks each tenant in turn and refuses if two answer — the
    same "expected at most one" rule the seeding already enforced within a
    tenant, now enforced across them, which is where a second one could
    actually appear.

    Tenant zero when nobody holds one, because that is where a fresh
    deployment's key is created. A legacy admin-owned registration row counts
    as holding it: the seeding is about to adopt or retire that row, and it has
    to do so in the tenant the row is actually in.
    """
    holders: list[str] = []
    legacy_holders: list[str] = []
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            # Both reads are filtered on the row's own tenant as well: on an
            # owner connection neither store method narrows by tenant, so
            # every tenant would look like a holder as soon as one was. See
            # `db/tenant_lookup.py`.
            if any(
                row.tenant_id == tenant_id
                for row in await api_key_store.get_by_type(session, BOOTSTRAP_KEY_TYPE)
            ):
                holders.append(tenant_id)
            elif any(
                row.type == "registration" and row.tenant_id == tenant_id
                for row in await api_key_store.get_by_label(
                    session, LEGACY_BOOTSTRAP_KEY_LABEL
                )
            ):
                legacy_holders.append(tenant_id)
    if len(holders) > 1:
        raise RuntimeError(
            f"Tenants {sorted(holders)} each hold an agent-registration "
            "bootstrap key; the key is one per deployment and expected in at "
            "most one. This needs a direct database fix."
        )
    if holders:
        return holders[0]
    if legacy_holders:
        return legacy_holders[0]
    return TENANT_ZERO_ID


async def _shutdown(
    server: uvicorn.Server,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    connector_lifecycle: ServerSideConnectorLifecycleService,
    matrix_admin: Provisioning,
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


async def _migrate_and_grant(config: SwitchConfig) -> None:
    """Apply pending migrations and reissue the runtime role's grants.

    Migrations still run at boot, on the same schedule as before — what
    changed is the connection they run on, and the lock now held around both
    this and the grant re-issue. `migrations/env.py` points Alembic at
    DB_OWNER_USER where one is configured, because DDL is exactly what the
    runtime role is not allowed to issue. Where none is, this is unchanged
    from before and runs as DB_USER, which is right for a developer pointing
    at a scratch database and fails loudly and immediately for a deployment
    that has moved to a restricted role without saying who its owner is.

    Held under `db/boot_lock.boot_lock` because a rolling deploy, or a crash
    racing a restart, starts more than one replica of this process at once,
    and neither step here tolerates two replicas doing it at the same time:
    two concurrent `alembic upgrade head` runs contend on the same catalogue
    locks Postgres itself takes for DDL — the usual result is a deadlock or a
    "duplicate object" error, not one side quietly winning — and
    `_prepare_database`'s grant re-issue right after it touches
    `pg_default_acl`, which two concurrent `ALTER DEFAULT PRIVILEGES`
    statements contend on the same way. One acquisition covers both rather
    than two: a table a migration just added is usable only once the grant
    after it has run, so nothing is served by letting a second replica in
    between them, and holding the lock across both is simpler than justifying
    why it would be safe to drop in the gap.

    `alembic_command.upgrade` is synchronous, and `migrations/env.py` calls
    `asyncio.run` internally to drive its own async engine when it isn't
    offline — which raises if called from a thread that already has a running
    event loop. This coroutine has one, so the upgrade runs via
    `asyncio.to_thread`, on a worker thread that starts with no event loop of
    its own, which is exactly what that inner `asyncio.run` needs.
    """
    alembic_ini = Path(__file__).resolve().parent.parent / "alembic.ini"
    alembic_cfg = AlembicConfig(str(alembic_ini))
    async with boot_lock(config):
        await asyncio.to_thread(alembic_command.upgrade, alembic_cfg, "head")
        await _prepare_database(config)
    logger.info(
        "Database migrations applied as %s",
        config.db_owner_user or config.db_user,
    )


def main() -> None:
    config = SwitchConfig()
    running_version = switch_core_version()
    configure_logging(config, running_version)

    logger.info("Starting switch-core %s", running_version or "(version unknown)")

    asyncio.run(_migrate_and_grant(config))

    asyncio.run(run(config))


if __name__ == "__main__":
    main()

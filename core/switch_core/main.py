from __future__ import annotations

import asyncio
import gc
import hashlib
import logging
import os
import signal
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Iterator
from contextlib import asynccontextmanager, contextmanager
from datetime import timedelta
from pathlib import Path

import httpx
import telegram
import uvicorn
from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.agent_connections import (
    HEARTBEAT_TTL_SECONDS,
    AgentConnectionRegistry,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.agent_event_listener import AgentEventListener
from switch_core.bridges.agent.protocol.connection_rows import SharedConnections
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.bridges.agent.protocol.event_buffer import (
    EventBuffer,
    session_slots_for,
)
from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_LABEL,
    BOOTSTRAP_KEY_TYPE,
    BOOTSTRAP_LAST_SEEDED_HASH_META_KEY,
    BOOTSTRAP_REVOKED_HASHES_META_KEY,
    LEGACY_BOOTSTRAP_KEY_LABEL,
    RETIRED_KEY_TYPE,
    ensure_bootstrap_owner,
)
from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.bridge_signals import BridgeSignals
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection
from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient
from switch_core.bridges.collaboration.discord.install import DiscordAppInstaller
from switch_core.bridges.collaboration.install import (
    MessagingInstallerRegistry,
    events_path,
    public_url,
)
from switch_core.bridges.collaboration.install_routes import (
    create_messaging_install_router,
)
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.platforms import register_platforms
from switch_core.bridges.collaboration.slack.install import SlackAppInstaller
from switch_core.bridges.collaboration.teams.app_package import (
    build_distributed_app_package,
)
from switch_core.bridges.collaboration.teams.install import TeamsAppInstaller
from switch_core.bridges.collaboration.teams.shared_app import TeamsSharedApp
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
)
from switch_core.bridges.collaboration.telegram.app_client import (
    TelegramAppClient,
    bot_resource,
)
from switch_core.bridges.collaboration.telegram.install import TelegramAppInstaller
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.chats.service import ChatService
from switch_core.chats.signals import ChatSignals
from switch_core.clients.actor import Actor, AgentActor, HumanActor, SystemActor
from switch_core.clients.agent_admin import AgentAdministration, AgentDeletionRequests
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.clients.client_signals import ClientSignals
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.config import SwitchConfig, deprecated_env_names
from switch_core.connections.app_credentials import ConnectorApps
from switch_core.connections.app_signals import ConnectorAppSignals
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.github_move import move_github_connections
from switch_core.connections.loader import CATALOG
from switch_core.connections.maintenance import (
    maintenance_loop as service_token_maintenance_loop,
)
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.connections.registry import ClientRegistration, build_adapters
from switch_core.db import encrypted_json
from switch_core.db.boot_lock import boot_lock
from switch_core.db.connection_budget import check_connection_budget
from switch_core.db.engine import (
    create_engine_from_config,
    create_session_factory,
    create_unpooled_engine,
)
from switch_core.db.key_rotation import (
    reencrypt_stored_secrets,
    require_front_key_readable,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    ApiKey,
    User,
    agent_event_boot_sequence,
)
from switch_core.db.runtime_role import (
    RuntimeRoleError,
    grant_runtime_role,
    verify_restricted_role,
)
from switch_core.db.schema_version import (
    require_schema_at_head,
    schema_ahead_through_expand_only,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.service_app_credential_store import ServiceAppCredentialStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.delivery.conversation import ConversationRules, ConversationSettings
from switch_core.delivery.recipient import RecipientServices
from switch_core.delivery.router import GROUP_SWEEP_SECONDS, MessageRouter
from switch_core.feature_flags import AGENT_MANAGEMENT, SWITCH_BUDDY
from switch_core.gateway.app import create_gateway_app
from switch_core.gateway.auth import hash_password
from switch_core.gateway.invite_mail import SmtpInviteMailer
from switch_core.gateway.ui import GatewayUi
from switch_core.logging_config import configure_logging
from switch_core.management.template_updates import TemplateUpdates
from switch_core.management.wiring import Management, create_management
from switch_core.messages.notify import MessageListener
from switch_core.observability.bootstrap import (
    Observability,
    RuntimeProbes,
    start_observability,
)
from switch_core.observability.pool import (
    WaitTimedQueuePool,
    install_hold_timer,
    install_pool_watermark,
    pool_stats,
)
from switch_core.observability.query import instrument_queries
from switch_core.outbound import guarded_async_client
from switch_core.ownership import Ownership
from switch_core.process_identity import new_process_id
from switch_core.process_lease import ProcessLease
from switch_core.provisioning import Provisioning
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_changes import COALESCE_SECONDS, RoomChanges
from switch_core.room_service import RoomService
from switch_core.session_activity.listener import AgentSessionActivityListener
from switch_core.session_activity.maintenance import (
    own_maintenance as own_session_activity_maintenance,
)
from switch_core.session_activity.outcomes import ApprovalOutcomes
from switch_core.session_activity.service import AgentSessionActivityService
from switch_core.signals import SignalBus
from switch_core.telemetry.messages import MessageTelemetry
from switch_core.telemetry.reporter import SnapshotReporter
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.setup import build_telemetry
from switch_core.tenant_context import no_tenant
from switch_core.transport.cursors import CursorWriter
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.membership_signals import MembershipSignals
from switch_core.transport.room_cache import RoomCacheLimits, RoomDeliveryCache
from switch_core.trust.setup import build_trust_client
from switch_core.user_changes import LocalUserChanges, SignalUserChanges
from switch_core.version import switch_core_version

logger = logging.getLogger(__name__)

# How often to reset runtime states whose session heartbeat has lapsed. A few
# seconds keeps a stuck "working"/"awaiting-input" surface from lingering long
# after a session crashes, while staying well above the per-pass DB cost.
_RUNTIME_STATE_SWEEP_INTERVAL = 5.0
# How often the retention loop deletes expired agent events. The retention
# window is measured in hours, so running once a minute is precise enough.
_AGENT_EVENT_RETENTION_INTERVAL = 60.0

# How often to close connections whose heartbeat has lapsed. Kept well under
# the heartbeat TTL so a dead connection's room slot and role lease are freed
# promptly rather than at the next unrelated request.
_CONNECTION_SWEEP_INTERVAL = 2.0

# The window the lifespan's teardown runs in before the process is killed
# regardless. Anything with a deadline of its own must fit inside it — see
# `observability.logs.SHUTDOWN_FLUSH_SECONDS`.
_FORCED_EXIT_GRACE_SECONDS = 3.0


class _Server(uvicorn.Server):
    """uvicorn's server without uvicorn's own signal handling.

    `run` stops the process on SIGTERM and SIGINT itself (`_shutdown`): it
    hands the owned work over and drains before it tells uvicorn to stop.
    uvicorn's handlers would stop serving at once, skipping that, and re-raise
    the signal once serving ended, starting a second shutdown. asyncio
    delivers a signal to both, so uvicorn's are not installed at all.
    """

    @contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


class _ShutdownOnSignal:
    """The process's stop-signal handler: the first signal starts the one
    shutdown, and `finish` waits for it, which ends in `os._exit`. A second
    signal while it runs exits at once, as a second Ctrl-C is meant to."""

    def __init__(self, start: Callable[[], Coroutine[None, None, None]]) -> None:
        self._start = start
        self._task: asyncio.Task[None] | None = None

    def __call__(self) -> None:
        if self._task is not None:
            logger.warning(
                "A second stop signal arrived while shutting down; exiting now "
                "without finishing the shutdown."
            )
            os._exit(1)
        self._task = asyncio.get_running_loop().create_task(self._start())

    async def finish(self) -> None:
        """Wait for the shutdown a signal started; return at once if none did."""
        if self._task is not None:
            await self._task


# With several replicas, how long a process keeps serving after it is told to
# stop and has taken itself out of readiness: long enough for the Service to
# stop sending it new requests, so they go to another replica rather than
# being refused. A single replica has nowhere to send them, and stops at once
# as it always has. Inside the chart's 45-second grace period
# (`switchCore.terminationGracePeriodSeconds`) with the bridge stops and
# `_FORCED_EXIT_GRACE_SECONDS` after it.
_DRAIN_SECONDS = 5.0


async def _agent_event_retention_loop(
    session_factory: async_sessionmaker[AsyncSession], buffer: EventBuffer
) -> None:
    """Once a minute, delete agent events and position tickets older than the
    retention window, one tenant at a time."""
    with no_tenant():
        while True:
            await asyncio.sleep(_AGENT_EVENT_RETENTION_INTERVAL)
            try:
                for tenant_id in await all_tenant_ids(session_factory):
                    await buffer.expire(tenant_id)
            except Exception:
                logger.exception("Agent event retention pass failed")


async def _attachment_group_sweep_loop(
    session_factory: async_sessionmaker[AsyncSession], router: MessageRouter
) -> None:
    """Decide the multi-file posts whose files stopped arriving, in every
    tenant. The process that wrote a post's first file sets a timer for it;
    this is what decides a post whose writer is gone, and every process runs
    it, since a post is claimed by whoever gets to it first."""
    with no_tenant():
        while True:
            await asyncio.sleep(GROUP_SWEEP_SECONDS)
            try:
                tenants = await all_tenant_ids(session_factory)
            except Exception:
                logger.exception("Attachment group sweep failed")
                continue
            # One tenant at a time, each on its own: a tenant whose sweep
            # fails leaves the tenants after it to be swept all the same.
            for tenant_id in tenants:
                try:
                    await router.flush_due_groups(tenant_id)
                except Exception:
                    logger.exception(
                        "Attachment group sweep failed for tenant %s", tenant_id
                    )


async def _recheck_agent_rooms(
    session_factory: async_sessionmaker[AsyncSession], router: MessageRouter
) -> None:
    """Check the room claims and managed agents this process holds against
    the agents' memberships, in every tenant, for a membership signal that
    never arrived (`MessageRouter.recheck_agent_rooms`)."""
    with no_tenant():
        for tenant_id in await all_tenant_ids(session_factory):
            await router.recheck_agent_rooms(tenant_id)


async def _runtime_state_sweep_loop(protocol: AgentCore) -> None:
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


async def _connection_sweep_loop(protocol: AgentCore) -> None:
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
                "AgentConnection sweep skipped: the event loop was blocked for %.1fs, "
                "so heartbeats could not be processed and every connection would "
                "look lapsed. Something is blocking the loop — that is the bug, "
                "not the connections.",
                overslept,
            )
            continue
        try:
            for conn in protocol.connections.sweep():
                logger.info(
                    "AgentConnection %s for agent %s expired (heartbeat lapsed, "
                    "%d beats received)",
                    conn.id,
                    conn.agent_id,
                    conn.beats,
                )
            for controller_conn in protocol.connections.controllers.sweep():
                logger.info(
                    "Controller connection %s for controller %s expired (beat "
                    "lapsed, %d beats received)",
                    controller_conn.id,
                    controller_conn.controller_id,
                    controller_conn.beats,
                )
        except Exception:
            logger.exception("AgentConnection sweep failed")


# Under `_FORCED_EXIT_GRACE_SECONDS`, and first in the teardown: what it
# writes is what lets every other process see this one's connections go
# offline, and take over the work it owned, now rather than when its lease
# lapses.
_RELEASE_SECONDS = 1.0

# How long a process shutting down gives the work it owns to stop and be
# handed over, before the rest of its release. Each consumer finishes the row
# in hand within a grace of its own (`transport/postgres.py`), so this is a
# backstop for a stop that hangs on a platform: the lease then lapses on its
# own and the work is taken over after it. Inside the chart's 45-second grace
# period (`switchCore.terminationGracePeriodSeconds`) with the drain and the
# rest of the shutdown after it.
_HAND_OVER_SECONDS = 10.0


async def _release_process(
    ownership: Ownership,
    connections: SharedConnections,
    management: Management | None,
    lease: ProcessLease,
) -> None:
    """Hand the work this process owns to the others, record the agent
    connections and controller sockets that went, then mark this process's
    lease stopped and tell the others, which take the work over on hearing
    it. In that order: the lease must not read as stopped while
    owned work still runs here, or another process would start it beside
    this one. Once the owned work has stopped, the lease is marked stopped
    even when the recording fails, so the connections this process held read
    offline either way. Never raises: if it all fails, the lease lapses on
    its own.

    Run from the signal handler and again from the lifespan's teardown, in
    either order: once one call has given up on the owned work, the other
    leaves the lease to lapse as well (`Ownership.stop` raises)."""
    try:
        async with asyncio.timeout(_HAND_OVER_SECONDS):
            await ownership.stop()
    except Exception:
        logger.warning(
            "Stopping this process's owned work at shutdown failed or took "
            "longer than %.0fs; the other processes take it over once its "
            "lease lapses.",
            _HAND_OVER_SECONDS,
            exc_info=True,
        )
        return
    try:
        async with asyncio.timeout(_RELEASE_SECONDS):
            try:
                await connections.flush()
                if management is not None:
                    await management.flush()
            finally:
                await lease.stop()
                ownership.gone()
    except TimeoutError:
        logger.warning(
            "Gave up releasing switch-core process %s after %.1fs; its "
            "connections read offline once its lease lapses.",
            lease.process_id,
            _RELEASE_SECONDS,
        )
    except Exception:
        logger.warning(
            "Releasing switch-core process %s at shutdown failed; its "
            "connections read offline once its lease lapses.",
            lease.process_id,
            exc_info=True,
        )


# The innermost of three nested budgets: under
# `observability.logs.SHUTDOWN_FLUSH_SECONDS`, itself under
# `_FORCED_EXIT_GRACE_SECONDS`. This and the log flush already fill that
# window, so neither can grow. The per-message worker gets at most
# `_MESSAGE_TELEMETRY_DRAIN_SECONDS` and the sink the rest, so a slow worker
# can never cost the sink its final flush, which carries every kind of event,
# and whatever the worker does not use is the sink's.
_TELEMETRY_DRAIN_SECONDS = 1.0
_MESSAGE_TELEMETRY_DRAIN_SECONDS = 0.4


async def _drain_telemetry(
    telemetry: TelemetryService,
    message_telemetry: MessageTelemetry,
    http_client: httpx.AsyncClient | None,
) -> None:
    """Let in-flight product events finish, then close their client.

    Never raises and never overruns: a relay that stopped answering must not
    hold the process past the point where it is killed.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _TELEMETRY_DRAIN_SECONDS
    # First, because what it still holds is emitted through the sink.
    await _close_by(
        message_telemetry.aclose(),
        loop.time() + _MESSAGE_TELEMETRY_DRAIN_SECONDS,
        "queued message events",
    )
    await _close_by(telemetry.aclose(), deadline, "buffered telemetry events")
    if http_client is not None:
        try:
            await http_client.aclose()
        except Exception:
            logger.warning("Telemetry HTTP client did not close.", exc_info=True)


async def _close_by(
    closing: Coroutine[object, object, None], deadline: float, what: str
) -> None:
    """Await one telemetry shutdown step until `deadline`, on the loop's clock.
    Never raises. The step logs how much it lost itself."""
    try:
        async with asyncio.timeout_at(deadline):
            await closing
    except TimeoutError:
        logger.warning("Gave up waiting for %s at shutdown.", what)
    except Exception:
        logger.warning(
            "Reporting %s at shutdown failed; continuing.", what, exc_info=True
        )


async def _snapshot_loop(reporter: SnapshotReporter) -> None:
    # `no_tenant` for the reason every other long-lived task does it: the
    # snapshot binds each tenant in turn as it counts, and must not inherit
    # whichever one happened to be bound when the task was created.
    with no_tenant():
        await reporter.run_forever()


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


_INSUFFICIENT_PRIVILEGE = "42501"


async def _check_tenant_isolation(config: SwitchConfig, engine: AsyncEngine) -> bool:
    """Refuse to serve on a connection the policies do not apply to.

    Before anything else touches the database, because the first thing that
    does is the admin seeding, and a deployment that is not isolating tenants
    should not get as far as writing a row.

    Returns whether isolation is in force. False only with
    DB_REQUIRE_RESTRICTED_ROLE off, and then the server keeps to the one
    workspace it has: no further tenant may be created while it runs.
    """
    try:
        await verify_restricted_role(engine)
    except RuntimeRoleError as exc:
        if config.db_require_restricted_role:
            raise
        try:
            tenant_count = len(await all_tenant_ids(create_session_factory(engine)))
        except DBAPIError as count_error:
            if getattr(count_error.orig, "sqlstate", None) != _INSUFFICIENT_PRIVILEGE:
                raise
            # The role cannot run the lookups because boot had no owner
            # connection to grant them with. Nothing can resolve a tenant on
            # such a connection, let alone serve a second one, so the count is
            # not needed to keep tenants apart; the role check's own error
            # already names what is missing.
            logger.error(
                "Tenant isolation is NOT in force on this deployment, and the "
                "number of workspaces could not be checked: %s Continuing only "
                "because DB_REQUIRE_RESTRICTED_ROLE is false.",
                exc,
            )
            return False
        if tenant_count > 1:
            raise RuntimeRoleError(
                f"{exc} DB_REQUIRE_RESTRICTED_ROLE=false is only allowed on a "
                f"single-tenant deployment, and this one has {tenant_count} "
                "workspaces."
            ) from exc
        logger.error(
            "Tenant isolation is NOT in force on this deployment: %s "
            "Continuing only because DB_REQUIRE_RESTRICTED_ROLE is false. "
            "Every row-level-security policy in this schema is inert, and any "
            "second tenant onboarded here can read the first's data, so none "
            "can be created while it runs.",
            exc,
        )
        return False
    return True


async def run(config: SwitchConfig, process_id: str) -> None:
    # ── Database ─────────────────────────────────────────────────────────────
    # The migration and the runtime role's grant re-issue already ran, under
    # Switch's boot-time advisory lock, before this coroutine was ever started
    # — see `main._migrate_and_grant`, which `main()` awaits first. Both use
    # the schema owner's connection where one is configured, and neither
    # belongs on the pooled application engine built below.
    encrypted_json.configure(config.keyring)
    engine = create_engine_from_config(config, poolclass=WaitTimedQueuePool)
    tenants_isolated = await _check_tenant_isolation(config, engine)
    await check_connection_budget(config, engine)
    session_factory = create_session_factory(engine)
    # Wired here rather than inside the engine factory, so the database layer
    # keeps knowing nothing about observability. Unconditional: the listeners
    # record into whatever registry is installed, which is the null one until
    # `start_observability` runs and stays null when export is off — measured
    # at 0.3 µs per statement against a 130 µs statement, so a server that
    # reports nothing pays nothing worth counting, and turning export on does
    # not change how queries execute.
    instrument_queries(engine)
    pool_watermark = install_pool_watermark(engine)
    install_hold_timer(engine)

    # Its connection is held rather than borrowed, so it builds its own outside
    # the pool. Nothing subscribes yet; it starts with the server so that the
    # subscription exists before the first consumer needs it.
    #
    # Deliberately NOT instrumented for query timing: `MessageListener` takes
    # the raw asyncpg connection off this engine and issues `LISTEN` and its
    # heartbeat through the driver, so SQLAlchemy's cursor events never fire
    # and the listeners would record nothing at all. That this connection is
    # alive is answered by the `message_listener` readiness check instead.
    message_listener = MessageListener(lambda: create_unpooled_engine(config))
    # The same arrangement for session activity and approval requests: their
    # tables announce each change with the row attached, and this pushes it on.
    session_activity_listener = AgentSessionActivityListener(
        lambda: create_unpooled_engine(config)
    )
    # Signals between switch-core processes (see `signals.py`): the same
    # arrangement again, carrying "who should look" rather than a room's rows.
    signal_bus = SignalBus(
        session_factory,
        lambda: create_unpooled_engine(config),
        process_id=process_id,
    )
    # This process's row in `switch_core_processes`, claimed before anything
    # can record a connection against it and held until the process drains.
    # What another process reads to know this one is alive.
    process_lease = ProcessLease(
        process_id=process_id,
        session_factory=session_factory,
        processes=SwitchCoreProcessStore(),
        key_ids=[key.id for key in config.keyring.keys],
    )
    await process_lease.renew()
    logger.info("Claimed switch-core process lease %s", process_id)
    # Renewed from here on, not from when the process starts serving: the
    # owned work started during boot stops once the lease is not sure
    # (`ProcessLease.surely_held`), and a boot can take longer than that.
    lease_task = asyncio.create_task(process_lease.run())
    # Which of the work that must run once this process runs (`ownership.py`),
    # held under that lease. With one process, all of it.
    ownership = Ownership(
        lease=process_lease,
        session_factory=session_factory,
        bus=signal_bus,
        store=OwnershipLeaseStore(),
        processes=SwitchCoreProcessStore(),
    )
    own_session_activity_maintenance(ownership, session_factory)
    # Every owned consumer's progress, written in batches
    # (`transport/cursors.py`).
    cursor_writer = CursorWriter(
        session_factory=session_factory,
        cursors=DeliveryCursorStore(),
        leases=OwnershipLeaseStore(),
        process_id=process_id,
    )

    # Invitations for the Postgres transport, which has no durable one of its
    # own. Built unconditionally: it is a dict until something registers.
    # Membership changes made in other processes reach the clients here over
    # the signal bus (`transport/membership_signals.py`).
    invites = InviteBus()
    ephemeral = EphemeralBus()

    # ── Stores ───────────────────────────────────────────────────────────────
    agent_store = AgentStore()
    agent_session_store = AgentSessionStore()
    room_store = RoomStore()
    client_store = ClientStore()
    bridge_store = CollaborationBridgeStore()
    external_user_store = ExternalUserStore()
    bridge_message_map_store = BridgeMessageMapStore()
    user_store = UserStore()
    api_key_store = ApiKeyStore()
    invitation_store = InvitationStore()
    join_domain_store = JoinDomainStore()
    organization_store = OrganizationStore()
    tenant_store = TenantStore()
    reference_store = ReferenceStore()
    reference_type_store = ReferenceTypeStore()
    document_store = DocumentStore()
    package_store = PackageStore()
    room_link_store = RoomLinkStore()
    room_group_store = RoomGroupStore()
    room_role_store = RoomRoleStore()
    message_store = MessageStore()
    usage_store = UsageStore()
    budget_store = BudgetStore()
    media_store = MediaStore()
    template_store = TemplateStore()

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
        await _seed_admin_and_bootstrap_key(
            session_factory, user_store, api_key_store, agent_store, config, process_id
        )
        async with engine.begin() as connection:
            event_boot = await connection.scalar(agent_event_boot_sequence.next_value())

    # ── Event queue + request trackers ───────────────────────────────────────
    event_buffer = EventBuffer(
        session_factory,
        sequence_base=event_boot << 32,
        rooms=message_listener,
        retention_seconds=config.agent_event_retention_seconds,
        session_slots=session_slots_for(config.db_pool_size, config.db_max_overflow),
    )
    # Listens for the `NOTIFY` that each insert into `agent_events` sends, and
    # wakes this process's streams for that agent, whichever process wrote it.
    agent_event_listener = AgentEventListener(
        lambda: create_unpooled_engine(config), event_buffer
    )

    # ── Product telemetry ────────────────────────────────────────────────────
    # Before the services that report through it, switched on or not.
    telemetry, installed_at, telemetry_http = await build_telemetry(
        config, session_factory, switch_core_version()
    )
    message_telemetry = MessageTelemetry(
        telemetry=telemetry, session_factory=session_factory
    )

    # ── Switch Trust guardrails ──────────────────────────────────────────────
    trust_client, trust_http = build_trust_client(session_factory, config)

    # ── Resource service ─────────────────────────────────────────────────────
    resource_service = ResourceService(
        reference_store=reference_store,
        reference_type_store=reference_type_store,
        document_store=document_store,
        package_store=package_store,
        room_link_store=room_link_store,
        session_factory=session_factory,
        telemetry=telemetry,
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
    # Under the boot lock, so two processes starting together do not rewrite
    # the same secrets at once, and after `_seed_admin_and_bootstrap_key` has
    # checked that every process still running can read the key they are
    # rewritten under.
    async with boot_lock(config):
        await reencrypt_stored_secrets(session_factory, config.keyring, tenant_ids)
        # After rotation, which has opened every stored GitHub secret or
        # stopped the boot: the move reads them, once per tenant.
        await move_github_connections(session_factory, config.keyring, tenant_ids)

    # One connection registry for the process. Created here rather than inside
    # the agent bridge because the router is wired first and reads presence
    # from it: an agent is reachable if it has a live connection OR a fresh
    # heartbeat row (CHOO-1857 stage B).
    connections = AgentConnectionRegistry()
    # The agent connections this process holds, recorded for the others under
    # this process's lease, and a copy of theirs kept in `connections`
    # (`connection_rows.py`), so the router's presence questions are answered
    # for every process.
    shared_connections = SharedConnections(
        registry=connections,
        session_factory=session_factory,
        store=AgentConnectionStore(),
        bus=signal_bus,
        lease=process_lease,
    )

    # ── Message router ───────────────────────────────────────────────────────
    # Every row written to a room goes through it, which decides in the same
    # transaction which agents the row is for (`delivery/router.py`).
    router = MessageRouter(
        services=RecipientServices(
            session_factory=session_factory,
            event_buffer=event_buffer,
            agent_store=agent_store,
            room_store=room_store,
            document_store=document_store,
            reference_store=reference_store,
            package_store=package_store,
            agent_session_store=agent_session_store,
            room_role_store=room_role_store,
            external_user_store=external_user_store,
            connections=connections,
            frontend_base_url=config.dashboard_base_url,
            message_telemetry=message_telemetry,
        ),
        message_store=message_store,
        client_store=client_store,
        budget_store=budget_store,
        conversation=ConversationRules(
            settings=ConversationSettings.from_config(config),
            message_store=message_store,
            room_store=room_store,
            agent_store=agent_store,
            room_role_store=room_role_store,
        ),
    )

    MembershipSignals(invites=invites, bus=signal_bus, router=router)
    signal_bus.on_resync(lambda: _recheck_agent_rooms(session_factory, router))
    signal_bus.on_recheck(lambda: _recheck_agent_rooms(session_factory, router))

    # ── Provisioning ─────────────────────────────────────────────────────────
    postgres_provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=room_store,
        client_store=client_store,
        router=router,
        invites=invites,
    )
    provisioning: Provisioning = postgres_provisioning

    # One shared read per room for every client in this process.
    room_cache = RoomDeliveryCache(
        session_factory=session_factory,
        message_store=message_store,
        limits=RoomCacheLimits(
            max_bytes=config.room_delivery_cache_max_bytes,
            max_rooms=config.room_delivery_cache_max_rooms,
            max_rows_per_room=config.room_delivery_cache_max_rows_per_room,
            max_age_seconds=config.room_delivery_cache_max_age_seconds,
        ),
    )

    # ── Client factory ───────────────────────────────────────────────────────
    client_factory = ClientFactory(
        client_store=client_store,
        session_factory=session_factory,
        config=config,
        room_store=room_store,
        message_store=message_store,
        usage_store=usage_store,
        media_store=media_store,
        listener=message_listener,
        invites=invites,
        ephemeral=ephemeral,
        room_cache=room_cache,
        message_observer=message_telemetry,
        router=router,
    )
    # Members that only write: an agent, whose rows are decided as they are
    # written (the router), a person on another platform, and a bridge's own
    # identity (its reader, the WorkspaceConsumer, is built by the bridge).
    client_factory.register("agent", AgentActor)
    client_factory.register("user", HumanActor)
    client_factory.register("bridge", Actor)

    # ── Client lifecycle ─────────────────────────────────────────────────────
    client_lifecycle = ClientLifecycleService(
        provisioning=provisioning,
        client_store=client_store,
        tenant_store=tenant_store,
        client_factory=client_factory,
        session_factory=session_factory,
        config=config,
        tenants_isolated=tenants_isolated,
        ownership=ownership,
        cursor_writer=cursor_writer,
    )
    # Clients registered or deleted in another process are started or stopped
    # here too (`clients/client_signals.py`).
    ClientSignals(lifecycle=client_lifecycle, bus=signal_bus)

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
        provisioning=provisioning,
        session_factory=session_factory,
        config=config,
        client_factory=client_factory,
        session_activity_listener=session_activity_listener,
        session_activity_service=AgentSessionActivityService(session_factory),
        connections=connections,
        ownership=ownership,
        cursor_writer=cursor_writer,
        telemetry=telemetry,
        trust_client=trust_client,
    )
    # Bridges registered, edited or removed in another process are applied to
    # this process's copies too (`bridges/collaboration/bridge_signals.py`),
    # and agents registered or deleted elsewhere reach their identities here.
    BridgeSignals(lifecycle=collab_lifecycle, bus=signal_bus)
    client_lifecycle.add_agents_changed_listener(collab_lifecycle.agents_changed)

    # ── Room service ─────────────────────────────────────────────────────────
    room_service = RoomService(
        provisioning=provisioning,
        room_store=room_store,
        agent_store=agent_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        collab_bridge_store=bridge_store,
        resource_service=resource_service,
        session_factory=session_factory,
        telemetry=telemetry,
        room_cache=room_cache,
    )
    collab_lifecycle._room_service = room_service

    # The rename and delete commands reach AgentCore through this, bound once
    # AgentCore exists below.
    agent_admin = AgentAdministration()
    deletion_requests = AgentDeletionRequests()

    # Registered after RoomService is built: the command consumer owns the
    # `!invite-agent` command, which reuses RoomService to add agents to the
    # room (and any bridged channel).
    client_factory.register(
        "admin",
        SystemActor,
        CommandConsumer,
        agent_store=agent_store,
        room_store=room_store,
        room_role_store=room_role_store,
        external_user_store=external_user_store,
        document_store=document_store,
        reference_store=reference_store,
        agent_session_store=agent_session_store,
        room_service=room_service,
        user_store=user_store,
        agent_admin=agent_admin,
        deletion_requests=deletion_requests,
        connections=connections,
        frontend_base_url=config.dashboard_base_url,
        follow_the_conversation_enabled=config.follow_the_conversation_enabled,
    )

    # ── Agent management (off unless the agent_management flag is on) ─────────
    # Built before the agent bridge app because its authenticator is the bearer
    # middleware's controller branch; its routes are installed once both apps
    # exist, below.
    # Change notices for signed-in users' Consoles (`gateway/changes.py`): the
    # sockets this process holds, reached from every process over the bus.
    user_changes = LocalUserChanges()
    user_change_publisher = SignalUserChanges(local=user_changes, bus=signal_bus)
    room_changes = RoomChanges(
        session_factory=session_factory,
        publisher=user_change_publisher,
        window_seconds=COALESCE_SECONDS,
    )
    room_service.on_room_changed(room_changes.room_changed)
    postgres_provisioning.on_membership_changed(room_changes.room_changed)
    management = create_management(
        config,
        session_factory,
        connections.controllers,
        signal_bus,
        process_lease,
        user_change_publisher,
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
        resource_service=resource_service,
        api_key_store=api_key_store,
        external_user_store=external_user_store,
        bridge_store=bridge_store,
        session_factory=session_factory,
        config=config,
        approval_outcomes=ApprovalOutcomes(
            session_activity_listener, AgentSessionActivityService(session_factory)
        ),
        controller_auth=management.authenticator if management is not None else None,
        connections=connections,
        telemetry=telemetry,
        trust_client=trust_client,
        gateway_ui=(
            GatewayUi.load(config.gateway_ui_dir)
            if config.gateway_ui_dir is not None
            else None
        ),
    )
    agent_admin.bind(protocol)
    protocol.deletion_requests = deletion_requests
    # Every close reports, whichever of the five paths did it — and only for a
    # connection the handler saw start.
    connections.set_close_listener(protocol.sessions.on_close)

    # ── Messaging app installs ──────────────────────────────────────────────
    # Registration is the feature flag. An installer exists for a platform when
    # this deployment holds that platform's app credentials, and the whole
    # install surface refuses when none does — a deployment that registered no
    # app cannot half-offer the button. Config validation has already required
    # the three Slack values all together and a public origin with them.
    installers = MessagingInstallerRegistry()
    if config.slack_app_client_id:
        assert config.slack_app_client_secret is not None
        assert config.slack_app_signing_secret is not None
        installers.register(
            SlackAppInstaller(
                client_id=config.slack_app_client_id,
                client_secret=config.slack_app_client_secret,
                signing_secret=config.slack_app_signing_secret,
            )
        )
    if config.discord_app_client_id:
        assert config.discord_app_client_secret is not None
        assert config.discord_app_application_id is not None
        installers.register(
            DiscordAppInstaller(
                client_id=config.discord_app_client_id,
                client_secret=config.discord_app_client_secret,
                application_id=config.discord_app_application_id,
            )
        )

    teams_app = _distributed_teams_app(config, installers, collab_lifecycle)

    async def _attach_shared_telegram_bridges(client: TelegramAppClient) -> None:
        # The bridges that started before the bot was up; each one starting
        # after is attached as it starts, by `_attach_to_telegram_if_live`.
        for adapter in collab_lifecycle.iter_adapters():
            if isinstance(adapter, TelegramAdapter):
                adapter.attach_shared_connection(client)

    telegram_app: TelegramAppClient | None = None
    if config.telegram_app_bot_token:
        assert config.telegram_app_webhook_secret is not None
        assert config.messaging_public_url is not None
        telegram_app = TelegramAppClient(
            bot=telegram.Bot(config.telegram_app_bot_token),
            webhook_url=public_url(
                config.messaging_public_url, events_path("telegram")
            ),
            webhook_secret=config.telegram_app_webhook_secret,
            on_connected=_attach_shared_telegram_bridges,
        )
        collab_lifecycle.reserve_resource(
            bot_resource(telegram_app.bot_id), "Telegram app bot"
        )
        shared_bot = telegram_app

        def _attach_to_telegram_if_live(adapter: PlatformAdapter) -> None:
            # Not before the bot is up, for the reason the Discord client
            # gives: the bridge would start against a bot it cannot use, and
            # the attach on connect would then be a no-op.
            if shared_bot.is_live and isinstance(adapter, TelegramAdapter):
                adapter.attach_shared_connection(shared_bot)

        collab_lifecycle.add_bridge_starting_listener(_attach_to_telegram_if_live)
        installers.register(
            TelegramAppInstaller(
                client=telegram_app,
                webhook_secret=config.telegram_app_webhook_secret,
            )
        )

    install_service: MessagingInstallService | None = None
    if installers.platforms():
        assert config.messaging_public_url is not None
        install_service = MessagingInstallService(
            session_factory=session_factory,
            store=MessagingInstallStore(),
            receipts=MessagingEventReceiptStore(),
            installers=installers,
            lifecycle=collab_lifecycle,
            users=user_store,
            rooms=room_service,
            public_origin=config.messaging_public_url,
            keyring=config.keyring,
        )

    chat_service = ChatService(
        session_factory=session_factory,
        room_service=room_service,
        provisioning=provisioning,
        listener=message_listener,
        activity_listener=session_activity_listener,
        room_store=room_store,
        agent_store=agent_store,
        user_store=user_store,
        message_store=message_store,
        router=router,
        media_store=media_store,
        usage_store=usage_store,
        id_server_name=config.id_server_name,
        media_max_bytes=config.agent_media_max_bytes,
        agent_chats_enabled=config.agent_chats_enabled,
        group_chats_enabled=config.group_chats_enabled,
        connections=connections,
    )
    # Changes to people's chats made in another process wake the Console
    # streams held here too (`chats/signals.py`).
    ChatSignals(service=chat_service, bus=signal_bus)
    room_service.on_room_agents_changed(chat_service.sync_room)
    protocol.set_room_agents_listener(room_service.room_agents_changed)
    protocol.set_agent_profile_listener(chat_service.agent_changed)
    chat_service.on_agent_room_changed(room_changes.rooms_changed)
    room_service.on_room_changed(chat_service.room_changed)

    # ── Connector app credentials ─────────────────────────────────────────────
    # Each connector's app, from configuration or a row the operator saved,
    # before anything that serves a sign-in reads them.
    service_http = guarded_async_client(config.outbound_policy, timeout=20)
    service_registration = ClientRegistration(
        session_factory=session_factory,
        keyring=config.keyring,
        public_url=config.gateway_public_url,
        server_name=config.id_server_name,
    )
    connector_apps = ConnectorApps(
        catalog=CATALOG,
        config=config,
        environ=os.environ,
        session_factory=session_factory,
        store=ServiceAppCredentialStore(config.keyring),
        http=service_http,
        registration=service_registration,
    )
    await connector_apps.load()

    # ── Gateway app ───────────────────────────────────────────────────────────
    gateway_app = create_gateway_app(
        agent_store=agent_store,
        room_store=room_store,
        room_group_store=room_group_store,
        room_service=room_service,
        bridge_store=bridge_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        event_buffer=event_buffer,
        session_factory=session_factory,
        user_store=user_store,
        external_user_store=external_user_store,
        api_key_store=api_key_store,
        invitation_store=invitation_store,
        join_domain_store=join_domain_store,
        organization_store=organization_store,
        template_store=template_store,
        usage_store=usage_store,
        budget_store=budget_store,
        resource_service=resource_service,
        protocol=protocol,
        install_service=install_service,
        invite_mailer=(
            SmtpInviteMailer.from_config(config)
            if config.invite_email_enabled
            else None
        ),
        user_changes=user_changes,
        chat_service=chat_service,
        connector_apps=connector_apps,
        config=config,
    )

    register_platforms(collab_lifecycle)

    # Liveness, and cheap on purpose: the gateway Deployment and the setup Job
    # wait on it at boot, so anything it checked would become a boot-ordering
    # dependency for them. Readiness is /health/ready below.
    @agent_bridge_app.get("/health")
    async def health_check() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    # Set by the lifespan; before that the honest answer is "no".
    observability: Observability | None = None
    # Set as shutdown begins, so the Service stops routing here first.
    draining = asyncio.Event()

    @agent_bridge_app.get("/health/ready")
    async def readiness_check() -> JSONResponse:
        if draining.is_set():
            return JSONResponse(
                {"status": "not ready", "checks": {"draining": {"healthy": False}}},
                status_code=503,
            )
        if observability is None:
            return JSONResponse(
                {"status": "not ready", "checks": {"startup": {"healthy": False}}},
                status_code=503,
            )
        report = observability.monitor.current()
        return JSONResponse(
            report.as_response(), status_code=200 if report.ready else 503
        )

    # Mounted on the agent-bridge app, not inside /gateway: this is the leg a
    # platform and a customer's browser reach, and /gateway is neither routed
    # here from outside nor reachable without a cookie they do not have.
    if install_service is not None:
        agent_bridge_app.include_router(
            create_messaging_install_router(install_service),
            tags=["messaging-installs"],
        )
    agent_bridge_app.include_router(
        create_bridge_webhook_router(
            BridgeWebhookService(
                lifecycle=collab_lifecycle,
                session_factory=session_factory,
                receipts=MessagingEventReceiptStore(),
            )
        ),
        tags=["bridge-webhooks"],
    )

    if management is not None:
        management.install(
            agent_bridge_app=agent_bridge_app,
            gateway_app=gateway_app,
            protocol=protocol,
        )
        # What deleting an account needs of it: revoking the person's machines.
        gateway_app.state.controller_revoker = management.service
        # Before the bridge serves: until Core knows which agents a controller
        # runs, their own keys would be let in and their presence misread.
        await management.load_bindings()
        # And which controllers the other processes hold, so their agents do
        # not read offline here until the signal bus has connected.
        await management.load_connections()

    # Before the bridge serves, so the first presence question already knows
    # the agents connected to the other processes.
    await shared_connections.start()

    agent_bridge_app.mount("/gateway", gateway_app)

    # ── Ensure system clients exist ─────────────────────────────────────────
    # Under the boot lock: it checks, then creates, and two processes starting
    # on a fresh install would otherwise both create tenant zero's admin.
    async with boot_lock(config):
        await client_lifecycle.ensure_system_client("admin")

    probes = RuntimeProbes(
        listener_connected=message_listener.connected.is_set,
        session_activity_listener_connected=session_activity_listener.connected.is_set,
        agent_event_listener_connected=agent_event_listener.connected.is_set,
        signal_bus_connected=signal_bus.connected.is_set,
        bridges_running=collab_lifecycle.running_count,
        bridges_running_by_platform=collab_lifecycle.running_by_platform,
        bridges_configured=collab_lifecycle.expected_count,
        consumers_running=client_lifecycle.running_count,
        agents_connected=connections.live_agents_by_transport,
        pool_stats=lambda: pool_stats(engine, pool_watermark),
        room_cache_stats=room_cache.stats,
    )

    # ── Lifespan ──────────────────────────────────────────────────────────────
    original_lifespan = agent_bridge_app.router.lifespan_context

    # A service is issued only where this server is set up for it, as its
    # catalog entry's adapter says (`connections/registry.py`). Without any,
    # the broker's upkeep still revokes and prunes whatever records exist.
    # With `organization_connector_apps` on, a workspace whose organization
    # saved its own app goes through that one (`connections/organization_apps.py`).
    organization_apps = (
        OrganizationApps(
            apps=connector_apps,
            store=OrganizationAppCredentialStore(config.keyring),
        )
        if config.organization_connector_apps_enabled
        else None
    )
    service_broker = ServiceBroker(
        session_factory=session_factory,
        keyring=config.keyring,
        catalog=CATALOG,
        adapters=build_adapters(
            CATALOG,
            github_app=connector_apps.github_app(),
            oauth_clients=connector_apps.oauth_clients(),
            http=service_http,
            registration=service_registration,
        ),
        organization_apps=organization_apps,
        disabled=config.disabled_services,
        store=ServiceConnectionStore(),
        token_retention=timedelta(days=config.service_token_retention_days),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=config.service_connections_enabled,
        public_url=config.gateway_public_url,
    )
    agent_bridge_app.state.service_broker = service_broker
    gateway_app.state.service_broker = service_broker
    gateway_app.state.organization_apps = organization_apps
    # A connector app the operator saves or removes, put to work in every process.
    ConnectorAppSignals(
        apps=connector_apps,
        organization_apps=organization_apps,
        broker=service_broker,
        state=gateway_app.state,
        bus=signal_bus,
    )
    if config.service_connections_enabled:
        protocol.service_broker = service_broker
    protocol.install_service = install_service

    snapshot_reporter = SnapshotReporter(
        telemetry=telemetry,
        session_factory=session_factory,
        interval_hours=config.telemetry_snapshot_interval_hours,
        installed_at=installed_at,
        live_session_count=connections.live_connection_count,
    )

    @asynccontextmanager
    async def lifespan(app: object) -> AsyncIterator[None]:
        nonlocal observability
        async with original_lifespan(app):  # type: ignore[arg-type]
            observability = start_observability(
                config=config,
                version=switch_core_version(),
                session_factory=session_factory,
                probes=probes,
                process_id=process_id,
                db_server_engine=lambda: create_unpooled_engine(config),
            )
            sweep_task = asyncio.create_task(_runtime_state_sweep_loop(protocol))
            retention_task = asyncio.create_task(
                _agent_event_retention_loop(session_factory, event_buffer)
            )
            attachment_group_task = asyncio.create_task(
                _attachment_group_sweep_loop(session_factory, router)
            )
            connection_sweep_task = asyncio.create_task(
                _connection_sweep_loop(protocol)
            )
            service_token_task = asyncio.create_task(
                service_token_maintenance_loop(session_factory, service_broker)
            )
            shared_connections_task = asyncio.create_task(shared_connections.run())
            cursor_writer_task = asyncio.create_task(cursor_writer.run())
            management_task = (
                asyncio.create_task(management.run())
                if management is not None
                else None
            )
            # Once per start, in the background: a new release may bring a
            # new revision of an official template, and the agents an older
            # one created are brought up to it (`template_updates`).
            template_updates_task = (
                asyncio.create_task(
                    TemplateUpdates(
                        engine=engine,
                        session_factory=session_factory,
                        management=management.service,
                        protocol=protocol,
                        agent_management=config.feature_flags[AGENT_MANAGEMENT],
                        switch_buddy=config.feature_flags[SWITCH_BUDDY],
                    ).run(tenant_ids)
                )
                if management is not None
                else None
            )
            # Only when telemetry is on: the chart tells a customer that off
            # means nothing is collected, and the fan-out is not free.
            snapshot_task = (
                asyncio.create_task(_snapshot_loop(snapshot_reporter))
                if telemetry.enabled
                else None
            )
            await message_listener.start()
            await session_activity_listener.start()
            await agent_event_listener.start()
            await signal_bus.start()
            try:
                yield
            finally:
                sweep_task.cancel()
                retention_task.cancel()
                attachment_group_task.cancel()
                router.close()
                connection_sweep_task.cancel()
                service_token_task.cancel()
                if snapshot_task is not None:
                    snapshot_task.cancel()
                shared_connections_task.cancel()
                if management_task is not None:
                    management_task.cancel()
                if template_updates_task is not None:
                    template_updates_task.cancel()
                ownership_task.cancel()
                # The lease goes on being renewed while the owned work is
                # handed over, which can take a few seconds: it must not lapse
                # under work still running here. A renewal after the release
                # does nothing.
                await _release_process(
                    ownership, shared_connections, management, process_lease
                )
                lease_task.cancel()
                cursor_writer_task.cancel()
                await message_listener.stop()
                await session_activity_listener.stop()
                await agent_event_listener.stop()
                await signal_bus.stop()
                # Before the operational flush, and bounded: the whole
                # teardown runs inside `_FORCED_EXIT_GRACE_SECONDS` and a
                # product event is the least valuable thing in it.
                await protocol.sessions.aclose()
                await _drain_telemetry(telemetry, message_telemetry, telemetry_http)
                await trust_http.aclose()
                await observability.aclose()
                # So a probe during teardown gets a 503 rather than the last
                # cached answer, which may still say ready.
                observability = None

    agent_bridge_app.router.lifespan_context = lifespan  # type: ignore[assignment]

    # Before the runtime starts: what follows is the clients, bridges and work
    # this process owns, which ownership hands to another replica as replicas
    # come and go, so it must stay collectable.
    _freeze_boot_objects()

    # ── Start runtime ────────────────────────────────────────────────────────
    await client_lifecycle.start_all()
    # Before the bridges start, so none on a shared app runs without the
    # install that entitles it.
    if install_service is not None:
        collab_lifecycle.add_bridge_start_guard(
            install_service.refuse_uninstalled_bridge
        )
    await collab_lifecycle.start_all()

    # The one shared Discord Gateway connection, opened in the one process that
    # holds it (`ownership.py`) and logged in for the API alone in every other.
    # Wanted after the bridges so it can attach to the inert ones the moment it
    # connects — a shared-delivery bridge opens no socket of its own, and
    # attaching re-runs the agent-identity provisioning that could not run at
    # start. Brought up in the background: a configured-but-unreachable Discord
    # app must never block or fail a boot that serves every other platform, so
    # its initial connect retries with backoff and Discord installs stay inert
    # until it succeeds.
    discord_gateway: DiscordGatewayClient | None = None
    if config.discord_app_bot_token:
        # install_service is present whenever an installer is registered, and the
        # Discord bot token being set means the Discord installer is — so this is
        # not None here. Asserted rather than branched to say that out loud.
        assert install_service is not None

        async def _attach_shared_discord_bridges(
            connection: DiscordConnection,
        ) -> None:
            # Runs once the connection is up, as the socket or for the API
            # alone: hand it to every already-running Discord bridge. Narrowed to Discord's adapter and not only to the
            # capability, because Telegram's shared bridges have it too and
            # must be handed Telegram's bot, not this socket.
            for adapter in collab_lifecycle.iter_adapters():
                if isinstance(adapter, DiscordAdapter):
                    adapter.attach_shared_connection(connection)

        discord_gateway = DiscordGatewayClient(
            bot_token=config.discord_app_bot_token,
            message_content=config.discord_app_message_content,
            members=config.discord_app_members,
            install_service=install_service,
            on_connected=_attach_shared_discord_bridges,
        )
        collab_lifecycle.add_bridge_starting_listener(discord_gateway.attach_if_live)
        discord_gateway.own(ownership)

    # The shared Telegram bot: `getMe`, then `setWebhook`. In the background
    # for the reason the Discord connection is — an unreachable Telegram must
    # not hold up a boot serving everything else.
    telegram_app_task: asyncio.Task[None] | None = None
    if telegram_app is not None:

        async def _run_telegram_app(client: TelegramAppClient) -> None:
            await client.start_with_retry()
            await client.watch_delivery()

        telegram_app_task = asyncio.create_task(
            _run_telegram_app(telegram_app), name="telegram-app"
        )

    # Start the work this process owns, before it serves: with one process,
    # all of it. Then the quiet copies of the bridges another process holds.
    await ownership.start()
    # Running from here, so the rest of the boot is covered: a lease that
    # stops being sure stops the work it holds there and then.
    ownership_task = asyncio.create_task(ownership.run())
    await collab_lifecycle.start_quiet_copies()
    if discord_gateway is not None:
        discord_gateway.start_quietly()

    # Backfill room membership: system clients (e.g. the admin client) added
    # after a room was created, and any agent whose invite did not land. The
    # just-started clients accept the invites on their first sync. Under the
    # boot lock, so two processes starting together do not both invite the
    # same missing client.
    async with boot_lock(config):
        await room_service.reconcile_room_clients()

    logger.info(
        "Switch is running on http://%s:%d", config.server_host, config.server_port
    )

    telemetry.emit("deployment_started", tenant_count=len(tenant_ids))
    # The funnel's first step, and only for a deployment with an install date.
    await telemetry.emit_milestone("deployment_installed")

    server_config = uvicorn.Config(
        agent_bridge_app,
        host=config.server_host,
        port=config.server_port,
        log_level="info",
        log_config=None,
    )
    server = _Server(server_config)

    loop = asyncio.get_event_loop()

    _begin_shutdown = _ShutdownOnSignal(
        lambda: _shutdown(
            server,
            draining.set,
            lambda: _release_process(
                ownership, shared_connections, management, process_lease
            ),
            _DRAIN_SECONDS if config.core_replicas > 1 else 0.0,
            connections.controllers,
            client_lifecycle,
            collab_lifecycle,
            provisioning,
            discord_gateway,
            teams_app,
            telegram_app,
            telegram_app_task,
        )
    )

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _begin_shutdown)
        except NotImplementedError:
            # Windows' event loops take no signal handlers. Ctrl-C still
            # arrives as SIGINT through the signal module, outside the loop,
            # so it is handed back to the loop; SIGTERM is never delivered
            # there, a stop being a process kill instead.
            signal.signal(
                sig,
                lambda _signum, _frame: loop.call_soon_threadsafe(_begin_shutdown),
            )

    await server.serve()
    # uvicorn returns once its own part is done, while `_shutdown` is still
    # stopping the rest; returning here would end the loop under it.
    await _begin_shutdown.finish()


def _freeze_boot_objects() -> None:
    """Take everything boot created out of the garbage collector's way.

    A full collection walks every tracked object while holding the interpreter
    lock, and most of the heap is what boot built and keeps for the life of the
    process: modules, the ORM's mappers, the app's routes. Walking that once a
    minute is what stalls the event loop for hundreds of milliseconds.
    `gc.freeze` moves it to a permanent generation the collector skips, so
    full collections only walk what was allocated since.

    Called before the runtime starts, not once it is serving. A frozen object
    is still freed when its last reference goes, but one caught in a reference
    cycle never is, and the clients and bridges a process runs are full of
    cycles (tasks, callbacks, sessions). With several replicas, ownership moves
    that work between processes whenever one joins or leaves, so freezing it
    would keep every client and bridge this process started at boot alive
    after it hands them over.
    """
    gc.collect()
    gc.freeze()
    logger.info(
        "Froze %d objects created during boot out of garbage collection.",
        gc.get_freeze_count(),
    )


async def _seed_admin_and_bootstrap_key(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    api_key_store: ApiKeyStore,
    agent_store: AgentStore,
    config: SwitchConfig,
    process_id: str,
) -> None:
    """Seed the admin user and the agent-registration bootstrap key, after
    checking that every live process can read this one's front key.

    The check comes first because the bootstrap key is the first thing a boot
    encrypts: it is written under the front key when it is created or
    AGENT_REGISTRATION_TOKEN changes, and a process refused only after that
    would already have stored a value the others cannot decrypt.
    """
    await require_front_key_readable(session_factory, config.keyring, process_id)
    await _seed_admin_user(session_factory, user_store, config)
    await _seed_agent_registration_bootstrap_key(
        session_factory, user_store, api_key_store, agent_store, config
    )


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
        encrypted_key = config.keyring.encrypt(config.agent_registration_token)

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


def _distributed_teams_app(
    config: SwitchConfig,
    installers: MessagingInstallerRegistry,
    collab_lifecycle: CollaborationBridgeLifecycleService,
) -> TeamsSharedApp | None:
    """The one distributed Teams app, when this deployment is configured with it.

    Its installer is registered, and every bridge on the app is handed it as
    the bridge starts, before it runs — so this must happen before any bridge
    does. Unlike Discord's Gateway client there is nothing to connect. Config
    validation has already required every `TEAMS_APP_*` value together.
    """
    if not config.teams_app_client_id:
        return None
    assert config.messaging_public_url is not None
    assert config.teams_app_privacy_url is not None
    assert config.teams_app_terms_url is not None
    teams_app = TeamsSharedApp.from_config(config)
    installers.register(
        TeamsAppInstaller(
            app=teams_app,
            package=build_distributed_app_package(
                app_id=config.teams_app_client_id,
                app_name=config.teams_app_name,
                messaging_public_url=config.messaging_public_url,
                privacy_url=config.teams_app_privacy_url,
                terms_url=config.teams_app_terms_url,
            ),
        )
    )
    collab_lifecycle.add_bridge_starting_listener(teams_app.attach_if_teams)
    return teams_app


async def _shutdown(
    server: uvicorn.Server,
    begin_draining: Callable[[], None],
    release: Callable[[], Awaitable[None]],
    drain_seconds: float,
    controllers: ControllerPresence,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    provisioning: Provisioning,
    discord_gateway: DiscordGatewayClient | None,
    teams_app: TeamsSharedApp | None,
    # Defaulted so a caller with no Telegram app, as the shutdown-order tests
    # are, need not name it; `run` always passes both.
    telegram_app: TelegramAppClient | None = None,
    telegram_app_task: asyncio.Task[None] | None = None,
) -> None:
    logger.info("Shutting down...")
    begin_draining()
    # Before uvicorn closes the sockets, so the controllers' are recorded as
    # closed by the server.
    controllers.begin_shutdown()
    # Serve through the drain still owning the work and the lease, so the
    # agents and controllers connected here read online everywhere while the
    # Service moves new requests to the other replicas.
    if drain_seconds:
        await asyncio.sleep(drain_seconds)
    # Before the sockets close, and not left to the lifespan's teardown:
    # uvicorn runs that only once every connection has closed, and a stream
    # still open when the process is killed would mean it never runs. Every
    # other process reads this one's machines offline from here, and has taken
    # over the consumers and bridges it owned, so the sockets close straight
    # after and their clients reconnect to a process that holds them.
    await release()
    server.should_exit = True
    await collab_lifecycle.stop_all()
    # The API log-in of a process that did not hold the socket; the socket
    # itself was closed with the rest of the owned work in `release`. `stop`
    # cancels a connect or log-in still retrying before it closes, so a retry
    # in flight cannot re-open what it just closed.
    if discord_gateway is not None:
        await discord_gateway.stop()
    # After the bridges, which borrow its HTTP client until they stop.
    if teams_app is not None:
        await teams_app.aclose()

    if telegram_app_task is not None:
        telegram_app_task.cancel()
        try:
            await telegram_app_task
        except asyncio.CancelledError:
            pass
    if telegram_app is not None:
        await telegram_app.stop()
    await client_lifecycle.stop_all()
    await provisioning.close()

    # `should_exit` starts uvicorn's shutdown, which runs the lifespan's
    # teardown; this sleep is all the time that teardown gets.
    await asyncio.sleep(_FORCED_EXIT_GRACE_SECONDS)
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
    alembic_cfg = _alembic_config()
    async with boot_lock(config):
        if await _schema_ahead(config, alembic_cfg):
            # A newer release has migrated, and this one is still rolling out
            # or being rolled back. Alembic has no file for the database's
            # head and would refuse; the newer release already granted what
            # its tables need, and this release reads none of them.
            logger.warning(
                "The database is ahead of switch-core %s by expand-only "
                "revisions only; nothing to migrate.",
                switch_core_version() or "(version unknown)",
            )
            return
        await asyncio.to_thread(alembic_command.upgrade, alembic_cfg, "head")
        await _prepare_database(config)
    logger.info(
        "Database migrations applied as %s",
        config.db_owner_user or config.db_user,
    )


async def _schema_ahead(config: SwitchConfig, alembic_cfg: AlembicConfig) -> bool:
    """Whether the database is ahead of this build by expand-only revisions,
    read on the connection the migration would run on."""
    engine = create_async_engine(
        config.owner_database_url or config.database_url,
        poolclass=NullPool,
        connect_args=config.db_connect_args,
    )
    try:
        return await schema_ahead_through_expand_only(engine, alembic_cfg)
    finally:
        await engine.dispose()


async def _check_schema_at_head(config: SwitchConfig) -> None:
    """Stand in for `_migrate_and_grant` on a server that does not migrate."""
    if config.db_owner_password is not None:
        logger.warning(
            "DB_OWNER_PASSWORD is set on a server with DB_MIGRATE_ON_BOOT=false, "
            "which never uses it. Remove it from this process's environment."
        )
    engine = create_async_engine(
        config.database_url, poolclass=NullPool, connect_args=config.db_connect_args
    )
    try:
        await require_schema_at_head(engine, _alembic_config())
    finally:
        await engine.dispose()
    logger.info("Database schema is servable; migrations were applied before boot")


def _alembic_config() -> AlembicConfig:
    return AlembicConfig(str(Path(__file__).resolve().parent.parent / "alembic.ini"))


def migrate() -> None:
    """Entry point for migrating a deployment without starting a server.

    Exists so a deploy can bring the schema up in a job of its own, ahead of
    the pods that will serve on it, and still run *this* code rather than a
    bare `alembic upgrade head`. The difference is everything `_migrate_and_grant`
    adds around the upgrade: the boot lock, so the job and a replica that
    starts while it is running cannot both be applying DDL, and the grant
    re-issue, without which a table the migration just created is invisible to
    the runtime role. A job that skipped either would leave the deployment in a
    state the server then has to repair at boot, one replica at a time.

    Boot runs the same function, and must keep doing so: nothing guarantees a
    deployment has a migration job, and a developer running the server against
    a fresh database has none. Running it twice is not wasted work — the second
    pass finds no pending revisions and re-issues grants that are already
    correct.
    """
    config = SwitchConfig()
    running_version = switch_core_version()
    configure_logging(config, running_version, new_process_id(config.pod_name))

    logger.info("Migrating switch-core %s", running_version or "(version unknown)")

    asyncio.run(_migrate_and_grant(config))


def main() -> None:
    config = SwitchConfig()
    running_version = switch_core_version()
    process_id = new_process_id(config.pod_name)
    configure_logging(config, running_version, process_id)

    logger.info(
        "Starting switch-core %s as process %s",
        running_version or "(version unknown)",
        process_id,
    )
    for warning in deprecated_env_names():
        logger.warning(warning)

    if config.db_migrate_on_boot:
        asyncio.run(_migrate_and_grant(config))
    else:
        asyncio.run(_check_schema_at_head(config))

    asyncio.run(run(config, process_id))


if __name__ == "__main__":
    main()

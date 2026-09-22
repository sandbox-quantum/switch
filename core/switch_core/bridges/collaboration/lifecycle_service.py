from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import TYPE_CHECKING
from uuid import uuid4

import aiohttp
import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.ingress import CallbackEndpoint, CallbackIngress
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.clients.bridge_client import BridgeClient, BridgeClientConfig
from switch_core.clients.client_factory import ClientFactory
from switch_core.config import SwitchConfig
from switch_core.db.models import CollaborationBridge
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.db.tenant_lookup import all_tenant_ids, tenant_of_collaboration_bridge
from switch_core.deeplinks import gateway_url_warning
from switch_core.provisioning import Provisioning
from switch_core.telemetry import TelemetryService, emit_safely
from switch_core.telemetry.ages import UNKNOWN_AGE, age_days, seconds_since
from switch_core.telemetry.deployment import (
    claim_milestone,
    milestone_claimed,
    seconds_since_install,
)
from switch_core.telemetry.snapshot import normalise_platform
from switch_core.tenant_context import current_tenant_id, no_tenant

if TYPE_CHECKING:
    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.room_service import RoomService

# Every platform SDK below is registered dynamically (`register_adapter`), so a
# deployment that only wires up some of the five is plausible even though
# every one is a hard dependency of switch-core today — hence guarded rather
# than assumed. A dependency that is genuinely missing degrades classification
# to `unknown` instead of taking the whole classifier down with an ImportError,
# which would turn a bridge failure into a second, worse one.
try:
    from slack_sdk.errors import SlackApiError
except ImportError:  # pragma: no cover - exercised only without slack-sdk installed
    SlackApiError = None  # type: ignore[assignment, misc]

try:
    from discord.errors import DiscordException
    from discord.errors import LoginFailure as DiscordLoginFailure
except ImportError:  # pragma: no cover
    DiscordException = None  # type: ignore[assignment, misc]
    DiscordLoginFailure = None  # type: ignore[assignment, misc]

try:
    from telegram.error import BadRequest as TelegramBadRequest
    from telegram.error import ChatMigrated as TelegramChatMigrated
    from telegram.error import Forbidden as TelegramForbidden
    from telegram.error import InvalidToken as TelegramInvalidToken
    from telegram.error import NetworkError as TelegramNetworkError
    from telegram.error import TelegramError
except ImportError:  # pragma: no cover
    TelegramBadRequest = None  # type: ignore[assignment, misc]
    TelegramChatMigrated = None  # type: ignore[assignment, misc]
    TelegramForbidden = None  # type: ignore[assignment, misc]
    TelegramInvalidToken = None  # type: ignore[assignment, misc]
    TelegramNetworkError = None  # type: ignore[assignment, misc]
    TelegramError = None  # type: ignore[assignment, misc]

try:
    from mattermostdriver.exceptions import (
        NoAccessTokenProvided as MattermostNoAccessTokenProvided,
    )
    from mattermostdriver.exceptions import (
        NotEnoughPermissions as MattermostNotEnoughPermissions,
    )

    # `mattermostdriver` raises its named exceptions only for the status codes
    # it maps; anything else (including a bare connection failure) surfaces as
    # the underlying `requests` exception, since that is the client it wraps.
    from requests.exceptions import ConnectionError as RequestsConnectionError
    from requests.exceptions import HTTPError as RequestsHTTPError
    from requests.exceptions import InvalidJSONError as RequestsInvalidJSON
    from requests.exceptions import Timeout as RequestsTimeout
except ImportError:  # pragma: no cover
    MattermostNoAccessTokenProvided = None  # type: ignore[assignment, misc]
    MattermostNotEnoughPermissions = None  # type: ignore[assignment, misc]
    RequestsConnectionError = None  # type: ignore[assignment, misc]
    RequestsHTTPError = None  # type: ignore[assignment, misc]
    RequestsInvalidJSON = None  # type: ignore[assignment, misc]
    RequestsTimeout = None  # type: ignore[assignment, misc]

logger = logging.getLogger(__name__)


# Slack error codes that mean the credentials themselves are rejected, as
# opposed to Slack refusing a call for some other reason (rate limited, a
# scope not granted, an internal error). `SlackApiError` carries no separate
# type for this — the distinction lives entirely in `response["error"]`.
_SLACK_AUTH_ERROR_CODES = frozenset(
    {
        "invalid_auth",
        "not_authed",
        "account_inactive",
        "token_revoked",
        "token_expired",
    }
)

# Telegram's own hierarchy already encodes "the server understood the request
# and refused it" for these three. `BadRequest` is a subclass of
# `NetworkError`, so they are checked ahead of `_NETWORK_EXCEPTIONS` below —
# the same ordering `telegram/adapter.py`'s `_as_rich_failure` uses, and for
# the same reason: checking `NetworkError` first would report a definite
# refusal as an unreachable network.
_TELEGRAM_DEFINITE_REFUSALS = tuple(
    exc_type
    for exc_type in (TelegramBadRequest, TelegramForbidden, TelegramChatMigrated)
    if exc_type is not None
)

# Reaching the platform failed outright, across every transport an adapter
# uses: aiohttp (Slack's Socket Mode, Teams' inbound listener), httpx (Teams'
# token exchange and Graph calls) and requests (Mattermost, via
# `mattermostdriver`, which raises its own named exceptions only for the
# status codes it maps and lets a connection failure surface as the
# underlying `requests` exception unchanged).
#
# Each library's own base class for "the transport failed", not the individual
# leaves. A timeout is the case that makes this worth stating: `ConnectTimeout`
# is a `TimeoutException` rather than a `ConnectError` in httpx, and
# `ServerTimeoutError` is not a `ClientOSError` in aiohttp — so a list of
# leaves classifies a refusal as `network` and the timeout beside it as
# `unknown`, which are the two outcomes an operator most needs to tell apart.
_NETWORK_EXCEPTIONS = tuple(
    exc_type
    for exc_type in (
        TelegramNetworkError,
        aiohttp.ClientConnectionError,
        httpx.TransportError,
        RequestsConnectionError,
        RequestsTimeout,
        # The two builtins, for a failure that reaches here without a library's
        # name on it: `asyncio.wait_for` raises the first, and a raw socket
        # connect the second.
        TimeoutError,
        ConnectionError,
    )
    if exc_type is not None
)

_MATTERMOST_AUTH_ERRORS = tuple(
    exc_type
    for exc_type in (MattermostNoAccessTokenProvided, MattermostNotEnoughPermissions)
    if exc_type is not None
)


def _slack_failure_reason(exc: SlackApiError) -> str:
    """`auth_failed` for a rejected token, `platform_error` for everything else
    Slack refuses a call for (rate limits, a missing scope, an outage). Both
    arrive as the same `SlackApiError`, so the code inside the response — not
    the exception's type — is what tells them apart.

    Getting this right is the point of the whole rewrite: a revoked or rotated
    bot token is the most common bridge failure in the field, and reporting it
    as `platform_error` sends an operator to check Slack's status page instead
    of their own token.
    """
    # `.response` is not always a mapping. On the async client slack_sdk
    # raises `SlackApiError(message, res)` with the raw `aiohttp.ClientResponse`
    # whenever the body it was handed is not the JSON the content type claimed
    # — an empty 502, a proxy's error page. That object has no `.get`, and this
    # is evaluated inside the argument list of the `emit_safely` that reports
    # the failure, so an `AttributeError` here would replace the bridge's real
    # exception with a meaningless one *and* suppress the event.
    response = getattr(exc, "response", None)
    reader = getattr(response, "get", None)
    code = reader("error") if callable(reader) else None
    if code in _SLACK_AUTH_ERROR_CODES:
        return "auth_failed"
    return "platform_error"


def _failure_reason(exc: BaseException) -> str:
    """An enumerated reason for a bridge failure.

    Not the exception's message, which routinely carries a workspace name or a
    token fragment. Classified by type, and — where a library folds several
    outcomes into one exception class — by what the exception itself carries.
    Never by matching words in the class name: "SlackApiError" contains "api",
    which reads a revoked token as a platform fault.

    `KeyError` and `sqlalchemy.exc.DBAPIError` are deliberately left
    unclassified and fall through to `unknown`. A `KeyError` here is adapter
    code reading a platform payload whose shape changed — a bug in Switch, not
    a value the operator typed into their connection config. A `DBAPIError` is
    Switch's own database, not the messaging platform.
    """
    if isinstance(exc, BridgeCredentialError):
        return "auth_failed"

    if SlackApiError is not None and isinstance(exc, SlackApiError):
        return _slack_failure_reason(exc)

    if DiscordLoginFailure is not None and isinstance(exc, DiscordLoginFailure):
        return "auth_failed"

    if isinstance(exc, _MATTERMOST_AUTH_ERRORS):
        return "auth_failed"

    if TelegramInvalidToken is not None and isinstance(exc, TelegramInvalidToken):
        return "auth_failed"

    if isinstance(exc, _TELEGRAM_DEFINITE_REFUSALS):
        return "platform_error"

    if isinstance(exc, _NETWORK_EXCEPTIONS):
        return "network"

    # These four are each a platform's own SDK saying it was reached and it
    # refused — never Switch's homeserver or database, which speak neither
    # vendor's exception language, so the label stays accurate even though the
    # check is broad.
    if isinstance(exc, BridgeOperationError):
        return "platform_error"
    if DiscordException is not None and isinstance(exc, DiscordException):
        return "platform_error"
    if RequestsHTTPError is not None and isinstance(exc, RequestsHTTPError):
        return "platform_error"
    if TelegramError is not None and isinstance(exc, TelegramError):
        return "platform_error"

    # Ahead of the `ValueError` below, which it is one of: `requests` folds a
    # body it could not parse into `InvalidJSONError`, and a Mattermost server
    # answering with a proxy error page is the platform misbehaving, not a
    # connection config somebody typed wrong.
    if RequestsInvalidJSON is not None and isinstance(exc, RequestsInvalidJSON):
        return "platform_error"

    if isinstance(exc, ValueError):
        return "config_invalid"

    return "unknown"


def _bridge_client_localpart(bridge_type: str, display_name: str) -> str:
    """The Matrix localpart for a messaging app's own client.

    The random tail is what makes disconnecting and reconnecting work. The
    readable part is derived from the app's type and name, which an operator is
    free to reuse — and the homeserver has no API for removing an account, so
    the old one is still there when they do. Reusing the name meant either
    colliding with it, or adopting an account whose password Switch no longer
    holds: shared-secret registration reports an existing user as success
    without applying the new one, so the second reads as a working connection
    that can never log in.

    A fresh name each time costs an abandoned account on the homeserver, which
    is already the case and is logged on removal.
    """
    safe_name = re.sub(r"[^a-z0-9._=-]", "-", display_name.lower())[:16]
    return f"switch-bridge-{bridge_type}-{safe_name}-{uuid4().hex[:8]}"


class CollaborationBridgeLifecycleService:
    # See RoomService: a test may assemble this without `__init__`.
    _telemetry: TelemetryService | None = None
    _connect_failures: dict[str, int] = {}
    _bridge_facts: dict[str, tuple[str, object]] = {}
    _connected: set[str] = set()

    def __init__(
        self,
        *,
        bridge_store: CollaborationBridgeStore,
        external_user_store: ExternalUserStore,
        bridge_message_map_store: BridgeMessageMapStore,
        session_request_post_store: SessionRequestPostStore,
        room_store: RoomStore,
        agent_store: AgentStore,
        client_store: ClientStore,
        client_lifecycle: ClientLifecycleService,
        room_service: RoomService,
        matrix_admin: Provisioning,
        session_factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
        client_factory: ClientFactory,
        telemetry: TelemetryService | None = None,
    ) -> None:
        self._bridge_store = bridge_store
        self._external_user_store = external_user_store
        self._bridge_message_map_store = bridge_message_map_store
        self._session_request_post_store = session_request_post_store
        self._room_store = room_store
        self._agent_store = agent_store
        self._client_store = client_store
        self._client_lifecycle = client_lifecycle
        self._telemetry = telemetry
        self._room_service = room_service
        self._matrix_admin = matrix_admin
        self._session_factory = session_factory
        self._config = config
        self._client_factory = client_factory

        self._adapter_registry: dict[str, type[CollaborationAdapter]] = {}
        self._config_registry: dict[str, type[BridgeConnectionConfig]] = {}
        self._bridges: dict[str, BridgeCore] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        # How many times each bridge has failed to come up since this
        # process started. See `_note_connect_failure`.
        self._connect_failures: dict[str, int] = {}
        # bridge_id -> a monotonic reading taken when its connect attempt
        # began. Spans `start()` and the task it schedules, because those are
        # two halves of one attempt from the operator's side. See
        # `_connect_duration_ms`.
        self._connect_started: dict[str, float] = {}
        # Read off the row at start, so reporting never depends on what the
        # BridgeCore exposes.
        self._bridge_facts: dict[str, tuple[str, object]] = {}
        # Reached the platform, as opposed to merely started.
        self._connected: set[str] = set()
        # bridge_id -> the host resource it holds exclusively while running
        # (see CollaborationAdapter.exclusive_resource). Lets a second
        # claimant be refused by name instead of failing on the resource.
        self._held_resources: dict[str, str] = {}
        # Started and not deliberately stopped. A crash removes a bridge from
        # `_bridges` and leaves it here, which is what makes "configured but no
        # longer running" answerable.
        self._started: set[str] = set()
        # Every platform a bridge has been started for in this process, never
        # removed. `running_by_platform` reports zero for each, so a platform's
        # series survives its last bridge being stopped rather than ending —
        # see the note there on why an absent series is the worst answer.
        self._platforms_seen: set[str] = set()
        # The one listener every bridge that gets called back shares, and each
        # running bridge's place on it. Owned here rather than by an adapter
        # because the port is the process's, not a bridge's: two Mattermost
        # bridges are ordinary, and a listener each would be a port and an
        # ingress rule each. Constructed unconditionally and bound by nobody —
        # it binds when a bridge first asks to be served.
        self._callback_ingress = CallbackIngress(
            host=config.collaboration_callback_host,
            port=config.collaboration_callback_port,
            secret=config.jwt_secret_key,
        )
        self._callback_endpoints: dict[str, CallbackEndpoint] = {}
        # Serialises registration. The exclusivity check reads the stored
        # bridges and the winner is not written until several awaits later,
        # so two concurrent registrations would both see a free resource and
        # both take it — the very collision the check exists to refuse.
        #
        # A process-wide lock is sufficient *because* switch-core is a
        # singleton: the chart fails the render for replicaCount != 1, since
        # it holds live Matrix sessions in memory. If that ever changes, this
        # has to become a database constraint — the way the single-default
        # bridge invariant already is — because a lock in one process would
        # then be guarding nothing.
        self._register_lock = asyncio.Lock()

    def register_adapter(
        self,
        bridge_type: str,
        adapter_cls: type[CollaborationAdapter],
        config_cls: type[BridgeConnectionConfig],
    ) -> None:
        self._adapter_registry[bridge_type] = adapter_cls
        self._config_registry[bridge_type] = config_cls

    def get_registered_types(self) -> list[str]:
        return list(self._adapter_registry.keys())

    async def refresh_sdk_session(self, session_id: str) -> None:
        for bridge in self._bridges.values():
            await bridge.refresh_sdk_session(session_id)

    def get_adapter(self, bridge_id: str) -> CollaborationAdapter | None:
        """The live adapter for a running bridge, or None if it isn't running.

        Used to ask a platform for a channel deeplink without the caller having
        to know the platform specifics."""
        bridge = self._bridges.get(bridge_id)
        return bridge.adapter if bridge is not None else None

    def supports_channel_creation(self, bridge_type: str) -> bool:
        """Whether this platform can create a channel from Switch at all.

        Answered from the registered adapter *class*, so it holds for a bridge
        that is stopped and for a type nobody has registered a connection for
        yet — both moments where an operator needs the answer. An unknown type
        is reported as capable: the registration that follows rejects it by
        name, which is a better error than a capability claim about a platform
        Switch does not have."""
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return True
        return adapter_cls.supports_channel_creation

    def supports_directory_search(self, bridge_type: str) -> bool:
        """Whether this platform has a user directory Switch can search.

        Read from the adapter class for the same reason as
        `supports_channel_creation`: the answer decides whether to even offer
        someone the "which account is you" step while connecting, which is
        before any connection exists. An unknown type is reported as
        searchable — registration rejects it by name a moment later, which is a
        better error than a capability claim about a platform Switch does not
        have.
        """
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return True
        return adapter_cls.supports_directory_search

    def renders_custom_url_schemes(self, bridge_type: str) -> bool:
        """Whether this platform makes a `switchdash://` link clickable.

        Decides whether the "Open in Switch Console" deeplink is rewritten to
        the gateway's https redirect. The redirect exists for platforms that
        linkify only http(s) — a hop through the browser that lands in the same
        place, but a hop. A platform that renders the scheme should be handed
        the real link.

        Read from the adapter class for the same reason as
        `supports_channel_creation`. An unknown type is reported as rendering
        it, matching the base class default.
        """
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return True
        return adapter_cls.renders_custom_url_schemes

    def get_config_schema(self, bridge_type: str) -> dict[str, object]:
        config_cls = self._config_registry.get(bridge_type)
        if config_cls is None:
            raise ValueError(f"Unknown bridge type: {bridge_type}")
        return config_cls.model_json_schema()

    def validate_connection_config(
        self, bridge_type: str, connection_config: dict[str, object]
    ) -> None:
        """Raise unless `connection_config` is valid for this bridge type.

        Editing a connection has to be checked before it is stored: a config
        the adapter cannot parse would take the bridge down on its next start,
        long after the request that caused it."""
        config_cls = self._config_registry.get(bridge_type)
        if config_cls is None:
            raise ValueError(f"Unknown bridge type: {bridge_type}")
        config_cls.model_validate(connection_config)

    async def start_all(self) -> None:
        # Every tenant's active bridges, read one tenant at a time. Which
        # tenants there are comes from the exemption (`db/tenant_lookup.py`);
        # each tenant's bridges are then an ordinary scoped read.
        #
        # This was one unscoped read, and under the runtime role it returned
        # nothing — which is indistinguishable from a deployment with no
        # bridges configured. No bridge started, and the line below said
        # "Starting 0 collaboration bridges" with no error anywhere to say
        # otherwise. It stayed invisible until a bridge row existed, because
        # Postgres does not evaluate a policy for a scan that finds no rows.
        #
        # Nothing is bound around `start`: the bridge's tenant is read from its
        # own row inside `start`, and bound by each unit of work that needs it.
        # Binding here would only decide what the long-lived task snapshots,
        # which is exactly what must not matter — `start` is also reached from
        # an HTTP request, and a bridge cannot run under whichever tenant
        # happened to restart it.
        bridges: list[CollaborationBridge] = []
        for tenant_id in await all_tenant_ids(self._session_factory):
            async with tenant_session(self._session_factory, tenant_id) as session:
                # Filtered on the row's own tenant, not left to the policy: on an
                # owner connection no policy narrows this read, and the fan-out
                # would act on every tenant's rows once per tenant. See
                # `db/tenant_lookup.py`, "a fan-out ... filters what it reads back".
                bridges.extend(
                    bridge
                    for bridge in await self._bridge_store.get_active(session)
                    if bridge.tenant_id == tenant_id
                )

        logger.info("Starting %d collaboration bridges", len(bridges))
        for bridge in bridges:
            try:
                await self.start(bridge.id)
            except Exception:
                logger.exception("Failed to start bridge %s", bridge.id)

    async def _reject_resource_conflict(
        self,
        bridge_type: str,
        connection_config: dict[str, object],
        *,
        exclude_bridge_id: str | None = None,
    ) -> None:
        """Refuse a bridge that would contend for a resource another one holds.

        Checked against every stored bridge rather than the running set, so the
        answer does not depend on whether the incumbent happens to be up.
        """
        adapter_cls = self._adapter_registry.get(bridge_type)
        if adapter_cls is None:
            return
        wanted = adapter_cls.exclusive_resource(connection_config)
        if wanted is None:
            return

        # Captured before the loop below rebinds per tenant. This method is
        # only ever reached from an authenticated request, so what is bound
        # going in *is* the caller's tenant — the loop then replaces it, once
        # per tenant, for the scoped read of that tenant's bridges. A call
        # with nothing bound (no request behind it, if one ever exists) is
        # treated as belonging to no tenant at all rather than guessed at: it
        # can never match `other.tenant_id`, so it falls straight into the
        # cross-tenant branch below and gets the non-disclosing message. Fail
        # closed, not open.
        caller_tenant_id = current_tenant_id()

        # Deliberately across every tenant. Two tenants binding the same Slack
        # workspace, or the same Teams listen port, is precisely the collision
        # this exists to refuse — the resource is a property of the host and
        # the platform, not of a tenant — so narrowing to the caller's tenant
        # would make it miss the case it was written for.
        existing: list[CollaborationBridge] = []
        for tenant_id in await all_tenant_ids(self._session_factory):
            async with tenant_session(self._session_factory, tenant_id) as session:
                # Filtered on the row's own tenant, not left to the policy: on an
                # owner connection no policy narrows this read, and the fan-out
                # would act on every tenant's rows once per tenant. See
                # `db/tenant_lookup.py`, "a fan-out ... filters what it reads back".
                existing.extend(
                    bridge
                    for bridge in await self._bridge_store.get_all(session)
                    if bridge.tenant_id == tenant_id
                )
        for other in existing:
            # Guard the None case explicitly: an unflushed row has no id yet, and
            # `other.id == exclude_bridge_id` would then be None == None and skip
            # a bridge that genuinely holds the resource.
            if exclude_bridge_id is not None and other.id == exclude_bridge_id:
                continue
            if other.type != bridge_type:
                continue
            other_cls = self._adapter_registry.get(other.type)
            if other_cls is None:
                continue
            try:
                held = other_cls.exclusive_resource(other.connection_config or {})
            except Exception:
                # A stored config we can no longer parse should not block a new
                # bridge — it is its own problem, and it is already logged when
                # that bridge tries to start.
                logger.warning(
                    "Could not read the exclusive resource of bridge %s (%s)",
                    other.id,
                    other.type,
                    exc_info=True,
                )
                continue
            if held != wanted:
                continue
            if caller_tenant_id is not None and other.tenant_id == caller_tenant_id:
                # The incumbent is the caller's own bridge, so naming it tells
                # the caller nothing they cannot already see on their own
                # bridge list — and the name is what turns this from "refused"
                # into "refused, and here is the one to delete or move".
                raise ValueError(
                    f"'{other.display_name}' already uses {wanted} on this "
                    f"instance, and two {bridge_type} bridges cannot share it. "
                    "Delete that bridge first, or give this one a different "
                    "listen_port in its connection_config — noting the Helm "
                    "chart publishes only one Teams port, so a second one needs "
                    "its own Service port and route."
                )
            # The incumbent belongs to a different tenant (or the caller's
            # tenant could not be determined at all — see the fail-closed note
            # above). Refuse the same way, but without the incumbent's display
            # name or tenant: naming either would tell tenant A that tenant B
            # exists, is on this instance, and holds this specific workspace or
            # port, none of which A has any business learning from an error
            # message. `wanted` itself is not a new disclosure — it is an echo
            # of the connection_config the caller just submitted, not
            # information about the incumbent.
            #
            # "already claimed on this instance" is still a narrow leak: it
            # tells the caller *someone* holds this resource, which they would
            # not otherwise know. That is unavoidable if the collision is to be
            # refused at all rather than silently misconfigured, and it is a
            # great deal less than a bridge name and a tenant identity.
            logger.warning(
                "Refused to register a %s bridge for tenant %s: %s is already "
                "held by bridge %s in tenant %s",
                bridge_type,
                caller_tenant_id,
                wanted,
                other.id,
                other.tenant_id,
            )
            raise ValueError(
                f"{wanted} is already claimed by a {bridge_type} bridge on "
                "this instance and cannot be shared. This is a host- and "
                "platform-level limit, not specific to your workspace; an "
                "operator can see which bridge holds it."
            )

    async def register(
        self,
        *,
        bridge_type: str,
        display_name: str,
        connection_config: dict[str, object],
        channel_creation_enabled: bool,
    ) -> CollaborationBridge:
        async with self._register_lock:
            return await self._register_locked(
                bridge_type=bridge_type,
                display_name=display_name,
                connection_config=connection_config,
                channel_creation_enabled=channel_creation_enabled,
            )

    async def _register_locked(
        self,
        *,
        bridge_type: str,
        display_name: str,
        connection_config: dict[str, object],
        channel_creation_enabled: bool,
    ) -> CollaborationBridge:
        adapter_cls = self._adapter_registry.get(bridge_type)
        config_cls = self._config_registry.get(bridge_type)
        if adapter_cls is None or config_cls is None:
            raise ValueError(f"Unknown bridge type: {bridge_type}")

        if channel_creation_enabled and not adapter_cls.supports_channel_creation:
            raise ValueError(
                f"{bridge_type} cannot create channels from Switch, so this "
                "connection cannot be allowed to. Create the chat on the "
                "platform and add the bot to it; Switch adopts it as a room."
            )

        # Fill in what the adapter generates, validate the result, and persist
        # the validated form — not the raw request — so a value minted here is
        # stored once and never re-derived.
        connection_config = await adapter_cls.prepare_config(connection_config)
        validated = config_cls.model_validate(connection_config)
        connection_config = validated.model_dump(mode="json")

        await self._reject_resource_conflict(bridge_type, connection_config)

        # Before anything is written. The adapter runs in a background task
        # whose failures are logged and swallowed, so credentials that are wrong
        # would otherwise be stored, reported as success, and only surface later
        # as an unrelated-looking error. Failing here also avoids leaving an
        # orphan Matrix identity behind for a bridge that was never viable.
        await adapter_cls.verify_credentials(connection_config)

        bridge_client_record = await self._client_lifecycle.create_client(
            client_type="bridge",
            display_name=f"bridge-{bridge_type}-{display_name}",
            localpart=_bridge_client_localpart(bridge_type, display_name),
        )

        bridge = CollaborationBridge(
            type=bridge_type,
            display_name=display_name,
            connection_config=connection_config,  # type: ignore[arg-type]
            client_id=bridge_client_record.id,
            status="active",
            channel_creation_enabled=channel_creation_enabled,
        )
        async with self._session_factory() as session:
            await self._bridge_store.create(session, bridge)
            await session.commit()

        # Configured, which is not the same as connected — `bridge_connected`
        # says the platform answered. A deployment with many of these and few
        # of those is one whose setup is failing, and only the pair shows it.
        emit_safely(
            self._telemetry,
            "connector_configured",
            {"bridge_platform": normalise_platform(bridge_type)},
        )

        await self.start(bridge.id)

        logger.info(
            "Registered collaboration bridge %s (%s): %s",
            bridge.id,
            bridge_type,
            display_name,
        )
        return bridge

    async def start(self, bridge_id: str) -> None:
        """Start a bridge, reporting a failure even before one is ever run.

        Everything here runs before `_run_bridge` is scheduled, so nothing
        downstream reports a raise from this method. Unreported it would be an
        attempt counted in neither the numerator nor the denominator of the
        connect success rate — and the attempts that fail here are the ones
        that failed hardest. The `try` below reports and re-raises unchanged,
        so the caller (an HTTP handler, `start_all`, `restart`) is unaffected.

        Once `_run_bridge` is scheduled this method returns without waiting on
        it, so there is no window where both this method and that task's own
        handler could report the same attempt.
        """
        # `bridge_platform` is required on every `bridge_connected` event, but
        # a bridge whose row cannot even be read has no platform to name.
        # `unknown`, not `none`: every bridge here is on some platform, so
        # `none` would be a claim — and the one this catalogue reserves for a
        # room with no bridge at all.
        platform = "unknown"
        # Before the first statement that can fail, so a bridge that never gets
        # past reading its own row still reports how long that took.
        self._connect_started[bridge_id] = time.monotonic()
        try:
            # Two steps, because this is the point where the bridge's tenant
            # is not yet known: the exemption answers which tenant the id is
            # in (`db/tenant_lookup.py`), and the row itself is then read
            # scoped to it. Reached both from boot, with nothing bound, and
            # from an HTTP request, where what is bound is the caller's
            # tenant and not necessarily the bridge's — so this deliberately
            # does not inherit.
            tenant_id = await tenant_of_collaboration_bridge(
                self._session_factory, bridge_id
            )
            if tenant_id is None:
                raise ValueError(f"Bridge not found: {bridge_id}")
            async with tenant_session(self._session_factory, tenant_id) as session:
                bridge = await self._bridge_store.get(session, bridge_id)
            if bridge is None:
                raise ValueError(f"Bridge not found: {bridge_id}")
            platform = normalise_platform(bridge.type)

            adapter_cls = self._adapter_registry.get(bridge.type)
            config_cls = self._config_registry.get(bridge.type)
            if adapter_cls is None or config_cls is None:
                raise ValueError(f"Unknown bridge type: {bridge.type}")

            # Registration refuses a conflicting bridge, but rows predating
            # that check still exist, and start_all would otherwise walk into
            # the bind error one of them causes. Say which bridge holds it
            # instead.
            wanted = adapter_cls.exclusive_resource(bridge.connection_config or {})
            if wanted is not None:
                for other_id, held in self._held_resources.items():
                    if held == wanted and other_id != bridge_id:
                        raise ValueError(
                            f"Cannot start bridge {bridge_id} ({bridge.type}): "
                            f"{wanted} is already held by bridge {other_id}. "
                            "Only one of them can run; delete one, or give it "
                            "a different listen_port."
                        )

            typed_config = config_cls.model_validate(bridge.connection_config or {})
            adapter = adapter_cls(config=typed_config)  # type: ignore[call-arg]
            adapter.set_service_url_persister(
                lambda service_url: self._persist_service_url(
                    bridge_id, tenant_id, service_url
                )
            )
            adapter.set_channel_team_persister(
                lambda channel_id, team_id: self._persist_channel_team(
                    bridge_id, tenant_id, channel_id, team_id
                )
            )
            adapter.set_max_attachment_bytes(self._config.agent_media_max_bytes)

            callback_endpoint = self._callback_ingress.endpoint_for(
                bridge.type, bridge_id
            )
            adapter.set_callback_endpoint(callback_endpoint)
            self._callback_endpoints[bridge_id] = callback_endpoint

            gateway_warning = gateway_url_warning(
                self._config.gateway_public_url, adapter_cls.renders_custom_url_schemes
            )
            if gateway_warning:
                logger.warning(
                    "%s (bridge %s, %s)", gateway_warning, bridge_id, bridge.type
                )

            async with tenant_session(self._session_factory, tenant_id) as session:
                bridge_client_record = await self._client_store.get(
                    session, bridge.client_id
                )
            if bridge_client_record is None:
                raise ValueError(f"Bridge client not found: {bridge.client_id}")

            bridge_core = BridgeCore(
                bridge_id=bridge_id,
                bridge_tenant_id=tenant_id,
                bridge_type=bridge.type,
                bridge_display_name=bridge.display_name,
                adapter=adapter,
                room_store=self._room_store,
                external_user_store=self._external_user_store,
                bridge_message_map_store=self._bridge_message_map_store,
                session_request_post_store=self._session_request_post_store,
                agent_store=self._agent_store,
                client_store=self._client_store,
                room_service=self._room_service,
                client_lifecycle=self._client_lifecycle,
                matrix_admin=self._matrix_admin,
                session_factory=self._session_factory,
                matrix_server_name=self._config.matrix_server_name,
                bridge_client_matrix_user_id=bridge_client_record.matrix_user_id,
                max_attachment_bytes=self._config.agent_media_max_bytes,
                session_demo_enabled=self._config.session_demo_enabled,
                gateway_public_url=self._config.gateway_public_url,
            )

            bridge_client = BridgeClient(
                bridge_core=bridge_core,
                client_id=bridge_client_record.id,
                tenant_id=bridge_client_record.tenant_id,
                matrix_user_id=bridge_client_record.matrix_user_id,
                display_name=bridge_client_record.display_name,
                session_factory=self._session_factory,
                client_store=self._client_store,
                config=BridgeClientConfig(bridge_id=bridge_id),
                transport_factory=self._client_factory.transport_for,
            )

            # Stashed rather than passed: `_run_bridge`'s signature is what
            # the tenant-binding tests patch.
            self._bridge_facts[bridge_id] = (bridge.type, bridge.created_at)
            task = asyncio.create_task(
                self._run_bridge(bridge_id, tenant_id, bridge_core, bridge_client)
            )
            self._bridges[bridge_id] = bridge_core
            self._tasks[bridge_id] = task
            self._started.add(bridge_id)
            self._platforms_seen.add(normalise_platform(bridge.type))
            if wanted is not None:
                self._held_resources[bridge_id] = wanted

            logger.info("Started collaboration bridge %s (%s)", bridge_id, bridge.type)
        except Exception as exc:
            self._note_connect_failure(bridge_id)
            # Resolved before the call, never inside its argument list: an
            # expression there is evaluated before `emit_safely` is entered, so
            # anything it raised would escape the guard — replacing the
            # bridge's own exception with a meaningless one, and taking the
            # event this method exists to emit with it.
            reason = _failure_reason(exc)
            duration_ms = self._connect_duration_ms(bridge_id)
            emit_safely(
                self._telemetry,
                "bridge_connected",
                {
                    "bridge_platform": platform,
                    "outcome": "failure",
                    "failure_reason": reason,
                    "duration_ms": duration_ms,
                },
            )
            raise

    async def _persist_service_url(
        self, bridge_id: str, tenant_id: str, service_url: str
    ) -> None:
        """Persist an outbound serviceUrl an adapter learned from inbound traffic
        so outbound survives a restart (used by the Teams adapter).

        Called from inside the adapter's own task, which binds nothing, so the
        bridge's tenant is carried here explicitly rather than inherited."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            await self._bridge_store.set_service_url(session, bridge_id, service_url)
            await session.commit()

    async def _persist_channel_team(
        self, bridge_id: str, tenant_id: str, channel_id: str, team_id: str
    ) -> None:
        """Persist the team an adapter learned a channel belongs to, so channel
        capture survives a restart (used by the Teams adapter)."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            await self._bridge_store.set_channel_team(
                session, bridge_id, channel_id, team_id
            )
            await session.commit()

    async def _record_bridge_memberships(
        self, bridge_id: str, tenant_id: str, client_id: str
    ) -> None:
        """Make the bridge's rooms its recorded memberships before it starts.

        A bridge belongs in every room it carries, and that was expressed by
        inviting its client and letting the homeserver hold the membership —
        so nothing wrote it down. Once `client_rooms` became what a client
        reads its rooms from, a bridge that had never been re-invited was in
        none of them: it still received from the platform, because inbound
        posts into a room by id, and relayed nothing back out.

        Run at every start rather than repaired once, because the rooms a
        bridge carries change while it is stopped.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = await self._room_store.get_by_bridge(session, bridge_id)
            added = 0
            for room in rooms:
                members = await self._room_store.get_client_ids(session, room.id)
                if client_id in members:
                    continue
                await self._room_store.add_client(session, client_id, room.id)
                added += 1
            await session.commit()
        if added:
            logger.info(
                "Recorded bridge %s as a member of %d room(s) it carries",
                bridge_id,
                added,
            )

    async def _run_bridge(
        self,
        bridge_id: str,
        tenant_id: str,
        bridge_core: BridgeCore,
        bridge_client: BridgeClient,
    ) -> None:
        """The bridge's own long-lived task.

        `no_tenant` first, because an `asyncio.Task` snapshots the contextvars
        of whoever created it — and `start` is reached from an HTTP request as
        often as from boot, so without this the bridge would spend its whole
        life acting as the operator who happened to restart it. Nothing here
        is ambient afterwards: `_record_bridge_memberships` binds the bridge's
        tenant for its own writes, `BridgeCore.start` binds it around each
        piece of bridge-level loading it does, and `bridge_client.start()` —
        which runs until shutdown — binds nothing at all, leaving each
        delivery to bind the tenant of the room it is for.
        """
        platform, configured_at = self._bridge_facts.get(bridge_id, ("none", None))
        with no_tenant():
            connected = False
            try:
                await self._record_bridge_memberships(
                    bridge_id, tenant_id, bridge_client.client_id
                )
                await bridge_core.start()
                # The one point that means "connected": `start()` only
                # launched this task and `bridge_client.start()` never returns.
                connected = True
                self._connected.add(bridge_id)
                await self._report_connector_up(bridge_id, platform, configured_at)
                await bridge_client.start()
            except Exception as exc:
                logger.exception("Bridge %s crashed", bridge_id)
                self._bridges.pop(bridge_id, None)
                self._tasks.pop(bridge_id, None)
                self._held_resources.pop(bridge_id, None)
                # The adapter may already have asked to be served before the
                # failure, so a crash that leaves the endpoint registered
                # leaves presses being handled by a bridge that is not running.
                endpoint = self._callback_endpoints.pop(bridge_id, None)
                if endpoint is not None:
                    await endpoint.withdraw()
                # A failure before the adapter came up never connected at all.
                self._connected.discard(bridge_id)
                # Resolved here rather than inside the argument lists below,
                # for the reason `start` gives: an expression there runs
                # outside `emit_safely`'s guard, and this one is on the path of
                # a task nobody awaits, where anything it raised would surface
                # only as "Task exception was never retrieved" at collection.
                reason = _failure_reason(exc)
                if connected:
                    emit_safely(
                        self._telemetry,
                        "bridge_disconnected",
                        {
                            "bridge_platform": normalise_platform(platform),
                            "reason": reason,
                        },
                    )
                else:
                    self._note_connect_failure(bridge_id)
                    duration_ms = self._connect_duration_ms(bridge_id)
                    emit_safely(
                        self._telemetry,
                        "bridge_connected",
                        {
                            "bridge_platform": normalise_platform(platform),
                            "outcome": "failure",
                            "failure_reason": reason,
                            "duration_ms": duration_ms,
                        },
                    )

    def _note_connect_failure(self, bridge_id: str) -> None:
        """Remember that this bridge failed to come up.

        In memory, so a restart forgets and `failed_attempts_before_success`
        under-reports a connector whose struggles spanned one. Still the only
        signal separating "hard to set up" from "nobody tried it until March".
        """
        self._connect_failures[bridge_id] = self._connect_failures.get(bridge_id, 0) + 1

    def _connect_duration_ms(self, bridge_id: str) -> float:
        """How long this bridge's connect attempt took, in whole milliseconds.

        Spent on read: an attempt has exactly one outcome, and the next one
        starts its own clock in `start()`. Monotonic rather than the wall
        clock, so an NTP step mid-connect cannot produce a negative number or
        an hour that never passed.

        `-1` when no reading was taken, which should not happen — every path to
        an outcome goes through `start()` — but reporting `0` would assert the
        connect was instantaneous, which is the one thing it certainly was not.
        """
        started = self._connect_started.pop(bridge_id, None)
        if started is None:
            return UNKNOWN_AGE
        return round((time.monotonic() - started) * 1000)

    async def _report_connector_up(
        self, bridge_id: str, platform: str, configured_at: object
    ) -> None:
        """Report a bridge reaching the platform, and the effort it took.

        `bridge_connected` fires every time, so a flapping bridge shows up.
        `connector_added` fires only on the first ever connect.
        """
        emit_safely(
            self._telemetry,
            "bridge_connected",
            {
                "bridge_platform": normalise_platform(platform),
                "outcome": "success",
                "failure_reason": "none",
                "duration_ms": self._connect_duration_ms(bridge_id),
            },
        )

        # `enabled`, not just `is not None`: off is a real service with a
        # discarding sink, so testing for None alone spends the claim below on
        # a deployment reporting nothing.
        if self._telemetry is None or not self._telemetry.enabled:
            return
        # The first successful connect for this bridge, ever. Claimed against
        # the bridge id so restarting a working bridge does not re-report a
        # setup that happened months ago.
        if not await claim_milestone(
            self._session_factory, f"connector_added:{bridge_id}"
        ):
            # This bridge has reported, but the deployment-wide milestone may
            # not have. `emit_milestone` is itself once-ever.
            await self._telemetry.emit_milestone(
                "first_connector_added", bridge_platform=normalise_platform(platform)
            )
            return

        elapsed_since_install = seconds_since_install(self._telemetry.installed_at)
        emit_safely(
            self._telemetry,
            "connector_added",
            {
                "bridge_platform": normalise_platform(platform),
                # -1 where the deployment has no install clock, which is
                # distinguishable from "took no time" in a way that 0 is not.
                "seconds_since_install": (
                    elapsed_since_install if elapsed_since_install is not None else -1.0
                ),
                "seconds_since_configured": seconds_since(configured_at),
                "is_first_connector": not self._any_connector_before(bridge_id),
                "failed_attempts_before_success": self._connect_failures.pop(
                    bridge_id, 0
                ),
            },
        )
        await self._telemetry.emit_milestone(
            "first_connector_added", bridge_platform=normalise_platform(platform)
        )

    def _any_connector_before(self, bridge_id: str) -> bool:
        """Whether another bridge was already connected when this one came up."""
        return any(other != bridge_id for other in self._bridges)

    async def stop(self, bridge_id: str, *, reason: str = "shutdown") -> None:
        # Before the adapter goes, so a press in flight is answered as gone
        # rather than handled by a bridge that is halfway shut down.
        endpoint = self._callback_endpoints.pop(bridge_id, None)
        if endpoint is not None:
            await endpoint.withdraw()
        bridge_core = self._bridges.get(bridge_id)
        was_connected = bridge_id in self._connected
        self._connected.discard(bridge_id)
        if bridge_core:
            await bridge_core.stop()

        task = self._tasks.pop(bridge_id, None)
        if task and not task.done():
            task.cancel()

        self._bridges.pop(bridge_id, None)
        self._held_resources.pop(bridge_id, None)
        self._started.discard(bridge_id)
        # A bridge cancelled before it connected never reaches an outcome, and
        # `_run_bridge`'s handler does not catch `CancelledError`, so its
        # reading would otherwise sit here for the life of the process — and be
        # spent by the *next* attempt on the same id, which would then report a
        # duration measured from the one before it.
        self._connect_started.pop(bridge_id, None)
        logger.info("Stopped collaboration bridge %s", bridge_id)

        # `_bridges` membership is set before the connection is attempted, so
        # on its own it would report a bridge that never connected.
        if bridge_core is not None and was_connected:
            platform, _ = self._bridge_facts.get(bridge_id, ("none", None))
            emit_safely(
                self._telemetry,
                "bridge_disconnected",
                {
                    "bridge_platform": normalise_platform(platform),
                    "reason": reason,
                },
            )

    async def restart(self, bridge_id: str) -> None:
        """Stop and start a bridge so it picks up its stored config.

        An adapter is built from the config it was given at start, so an edit
        is inert until the bridge is rebuilt."""
        await self.stop(bridge_id, reason="restart")
        await self.start(bridge_id)
        logger.info("Restarted collaboration bridge %s", bridge_id)

    async def stop_all(self) -> None:
        logger.info("Stopping all %d collaboration bridges", len(self._bridges))
        for bridge_id in list(self._bridges):
            await self.stop(bridge_id)
        await self._callback_ingress.stop()

    async def remove(self, bridge_id: str) -> None:
        """Disconnect a messaging app and take its identities with it.

        Everything Switch created to talk to this platform goes: the bridge's
        own Matrix client, and the puppet client behind every person Switch saw
        on it. Leaving those behind is not a tidiness problem — the bridge
        client's Matrix name is derived from the app's type and display name,
        so an operator who disconnects an app and reconnects one named the same
        collided with the row left by the last one.

        Order matters: the clients are children of nothing but the bridge and
        external-user rows point at them, so those go first or the foreign keys
        refuse.
        """
        # The durable record, not `self._connected`: that is empty until a
        # connect succeeds *in this process*, so a connector that worked for
        # months and was down at removal would report "never connected".
        was_connected = await milestone_claimed(
            self._session_factory, f"connector_added:{bridge_id}"
        )
        await self.stop(bridge_id)
        async with self._session_factory() as session:
            bridge = await self._bridge_store.get(session, bridge_id)
            dependent_rooms = await self._room_store.get_by_bridge(session, bridge_id)
            room_count = len(dependent_rooms)
            if dependent_rooms:
                logger.warning(
                    "Detaching %d room(s) from collaboration bridge %s before removal; "
                    "they will become internal-only rooms: %s",
                    len(dependent_rooms),
                    bridge_id,
                    ", ".join(room.id for room in dependent_rooms),
                )
                for room in dependent_rooms:
                    await self._room_store.clear_bridge(session, room.id)
            puppets = await self._external_user_store.get_by_bridge(session, bridge_id)
            puppet_client_ids = [u.client_id for u in puppets if u.client_id]
            await self._external_user_store.delete_by_bridge(session, bridge_id)
            await self._bridge_store.delete(session, bridge_id)
            await session.commit()

        removed = list(puppet_client_ids)
        if bridge is not None:
            removed.append(bridge.client_id)
        for client_id in removed:
            await self._client_lifecycle.remove(client_id)

        # The Matrix accounts themselves outlive this: the homeserver offers no
        # deprovisioning call Switch can make. Said out loud because it is the
        # reason a reconnection cannot reuse the old name — see
        # `_bridge_client_localpart`.
        logger.info(
            "Removed collaboration bridge %s and %d client identities; their "
            "Matrix accounts remain on the homeserver, which has no API to "
            "remove them",
            bridge_id,
            len(removed),
        )

        if bridge is not None:
            emit_safely(
                self._telemetry,
                "connector_removed",
                {
                    "bridge_platform": normalise_platform(bridge.type),
                    "age_days": age_days(bridge.created_at),
                    # A connector removed having never connected is a failed
                    # setup; one removed after months of service is a
                    # decision. Reporting both as "removed" would hide the
                    # first, which is the one worth acting on.
                    "was_ever_connected": was_connected,
                    "room_count": room_count,
                },
            )
        # Every per-bridge map keyed by an id that will never be seen again.
        # Bridge ids are fresh UUIDs, so a deployment that repeatedly connects
        # and removes connectors grows these without bound otherwise.
        self._bridge_facts.pop(bridge_id, None)
        self._connect_failures.pop(bridge_id, None)
        self._connect_started.pop(bridge_id, None)

    def get(self, bridge_id: str) -> BridgeCore | None:
        return self._bridges.get(bridge_id)

    def expected_count(self) -> int:
        """Bridges that were started and have not been stopped deliberately."""
        return len(self._started)

    def running_count(self) -> int:
        """Of those, how many still have a task that has not finished.

        A bridge's task runs until shutdown, so a finished one has stopped
        serving whether it raised or returned.
        """
        running = 0
        for bridge_id in self._started:
            task = self._tasks.get(bridge_id)
            if bridge_id in self._bridges and task is not None and not task.done():
                running += 1
        return running

    def running_by_platform(self) -> dict[str, int]:
        """`running_count`, split by the platform each bridge talks to.

        The total answers "how many bridges died" and never "which", and which
        is the first thing anyone asks — a Slack outage and a misconfigured
        Teams app look identical in a single number. Read off `_bridge_facts`,
        which is written at start from the row, so a bridge whose `BridgeCore`
        has already been discarded by a crash is still attributable.

        Every platform this process has ever started a bridge for appears,
        zero included — which is why it is seeded from `_platforms_seen` rather
        than from `_started` alone. A gauge that stops being reported is
        indistinguishable on a dashboard from one nobody is looking at, and
        "Slack went from one to zero" is the whole signal; `_started` drops a
        bridge that was stopped deliberately, so reading only that would end
        the series at exactly the moment it has something to say.

        A process that has never started a bridge reports nothing at all, and
        that is the honest answer rather than a gap: there is no bridge here to
        be up or down, and five platforms sitting at zero would invite an alert
        on a platform nobody configured.
        """
        counts: dict[str, int] = dict.fromkeys(self._platforms_seen, 0)
        for bridge_id in self._started:
            platform, _ = self._bridge_facts.get(bridge_id, ("none", None))
            name = normalise_platform(platform)
            task = self._tasks.get(bridge_id)
            alive = bridge_id in self._bridges and task is not None and not task.done()
            counts[name] = counts.get(name, 0) + (1 if alive else 0)
        return counts

    def bridges_for_tenant(self, tenant_id: str) -> list[BridgeCore]:
        """Running bridges belonging to `tenant_id`, and none other.

        `_bridges` is a flat, instance-wide dict, so this is the only way to
        act on a tenant's bridges — e.g. creating an agent's platform identity
        — without reaching another tenant's.
        """
        return [
            bridge for bridge in self._bridges.values() if bridge.tenant_id == tenant_id
        ]

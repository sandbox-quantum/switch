from __future__ import annotations

import asyncio
import hmac
import html
import json
import logging
import re
import secrets
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar
from urllib.parse import quote

import httpx
from aiohttp import web
from pydantic import Field, model_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME
from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    LiveRuntimeIndicator,
    format_elapsed,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    ChannelType,
    DirectoryUser,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.teams.auth import (
    InboundActivityValidator,
    TeamsTokenProvider,
)
from switch_core.bridges.collaboration.teams.cards import (
    agent_message_card,
    card_attachment,
)
from switch_core.bridges.collaboration.teams.connector import BotConnectorClient
from switch_core.bridges.collaboration.teams.crypto import (
    decrypt_resource_data,
    generate_encryption_keypair,
    load_certificate_der_b64,
)
from switch_core.bridges.collaboration.teams.graph import GraphClient

logger = logging.getLogger(__name__)

_MENTION_TAG = re.compile(r"<at\b[^>]*>(.*?)</at>", re.IGNORECASE | re.DOTALL)
_HTML_TAG = re.compile(r"<[^>]+>")
_BR_TAG = re.compile(r"<br\s*/?>", re.IGNORECASE)
# The whole of a name, if every character of it can be part of an `@mention`.
_HANDLE_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
# What may follow a name for it to have ended there, rather than the name
# being a prefix of a longer one: `@ada` must not match inside `@adaline`.
_MENTION_END = r"(?![A-Za-z0-9._-])"
_AT_TAG = re.compile(r"<at>(.*?)</at>", re.DOTALL)
_ZERO_WIDTH_SPACE = "\u200b"
# A Teams identifier standing where a person's name should be: a channel
# account (`29:…`, `8:orgid:…`) or a bare Entra object id.
_TEAMS_ID = re.compile(
    r"^(?:\d+:\S+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)
# A newline with no newline either side of it.
_LONE_NEWLINE = re.compile(r"(?<!\n)\n(?!\n)")
# Both prefixes reach the same dispatcher. `!` is Switch's own; `/` is what a
# Teams command list types into the compose box when someone picks a command,
# and what anyone who has used Slack will try first.
_COMMAND_PREFIXES = ("!", "/")

# How long a failed Graph read of a channel is taken at its word before being
# tried again. Long enough that a channel Graph will not describe is not read
# on every message; short enough that a blip, or a permission granted after the
# bridge started, heals on its own.
_CHANNEL_READ_RETRY_AFTER = 300.0


def _handle_for(user: dict[str, Any]) -> str:
    """The handle Switch knows a Teams person by.

    The local part of their user principal name — `ada.lovelace` from
    `ada.lovelace@contoso.com`. Unique within a tenant, and unlike a display
    name it survives being written as `@handle`, which is how someone is
    addressed in a room and how an outbound mention is matched back to them.

    Every path that meets a person must agree on this, or the same human gets
    two records: the directory used to yield the whole principal name while
    inbound messages yielded the display name, and whichever arrived first won.
    """
    principal = str(user.get("userPrincipalName") or "")
    if principal:
        return principal.split("@", 1)[0]
    display = str(user.get("displayName") or "")
    return display or str(user.get("id") or "")


def _is_usable_handle(name: str) -> bool:
    """Whether `name` survives being written as `@name`.

    A handle is read back out of message text, where a mention ends at the
    first character that cannot be part of one. A name containing anything
    else — a space, above all, since most display names have one — is
    therefore unaddressable, and an id was never a name to begin with.
    """
    return (
        bool(name)
        and not _TEAMS_ID.match(name)
        and _HANDLE_SHAPE.match(name) is not None
    )


def _hard_wrap(text: str) -> str:
    """Make single line breaks survive into Teams.

    An Adaptive Card TextBlock follows Markdown's rule that one newline is
    whitespace, so a heading and the line under it arrive as one run-on
    sentence. Doubling a lone newline gives the break back. Existing blank
    lines are left alone — doubling those too would stretch every paragraph
    gap — and list items keep their own lines, which is why this is done here
    rather than by splitting the body into separate blocks.
    """
    return _LONE_NEWLINE.sub("\n\n", text)


def _render_mentions(text: str) -> str:
    """Rewrite Teams ``<at>Display</at>`` mention markup to ``@Display``.

    Teams sends an @mention as ``<at>Name</at>`` markup, with the addressable id
    carried separately in the activity ``entities`` / Graph ``mentions``.
    Deleting the markup would drop the ``@name`` the addressing layer matches on,
    so we keep the display text as a plain ``@name`` token instead."""

    def _sub(match: re.Match[str]) -> str:
        inner = html.unescape(match.group(1)).strip()
        return f"@{inner}" if inner else ""

    return _MENTION_TAG.sub(_sub, text)


_LEADING_MENTION_TAG = re.compile(
    r"^\s*(?:<(?:p|div|span)\b[^>]*>\s*)?<at\b[^>]*>.*?</at>\s*",
    re.IGNORECASE | re.DOTALL,
)


def _strip_leading_mention(text: str) -> str:
    """Drop a single leading ``<at>…</at>`` mention (optionally inside one wrapper
    tag) from Teams message markup.

    In a Teams channel the Bot Framework only delivers a message when the bot is
    @mentioned, so a command typed in a channel always arrives as
    ``@Bot !command``. Removing the leading bot mention lets the shared
    ``!``-command detection in ``_deliver`` see the ``!`` marker."""
    return _LEADING_MENTION_TAG.sub("", text, count=1)


def _aad_failure_message(exc: Exception) -> str:
    """Reduce an AAD token failure to the sentence an operator can act on.

    The raw failure carries the whole OAuth error body — trace ids, correlation
    ids, timestamps — wrapped around one useful sentence. Microsoft writes that
    sentence well (it names the client-secret value-vs-ID mix-up outright), so
    surface it and drop the rest. Falls back to the full text if the body is not
    the shape we expect, rather than losing the detail.
    """
    text = str(exc)
    start = text.find("{")
    if start != -1:
        try:
            body = json.loads(text[start:])
        except json.JSONDecodeError:
            body = None
        if isinstance(body, dict):
            description = body.get("error_description")
            if isinstance(description, str) and description:
                sentence = description.split("Trace ID:")[0].strip().rstrip(".")
                return f"Microsoft rejected these credentials — {sentence}."
    return f"Microsoft rejected these credentials — {text}"


# Channel-message subscriptions with resource data live at most 60 minutes; we
# request 55 and proactively renew well before expiry.
_SUBSCRIPTION_TTL = timedelta(minutes=55)
_RENEWAL_INTERVAL_SECONDS = 40 * 60
# How soon, and how rarely, to re-attempt a channel that has no live
# subscription. The floor is short because the common failure clears in about a
# minute (a load balancer registering a newly-started pod); the ceiling keeps a
# permanently broken channel from hammering Graph for the life of the process.
_REPAIR_MIN_INTERVAL_SECONDS = 30
_REPAIR_MAX_INTERVAL_SECONDS = 5 * 60


class TeamsConnectionConfig(BridgeConnectionConfig):
    """Per-bridge Microsoft Teams credentials and endpoints.

    Teams integration uses an Azure AD app registration that backs both a Bot
    Framework bot (outbound messaging, proactive messages) and Microsoft Graph
    access (channel-message capture, provisioning). Secrets live per-bridge in
    the ``connection_config`` JSONB column, like every other collaboration
    bridge — nothing here belongs in global config.
    """

    # Azure AD app registration (bot client id + secret + tenant).
    app_id: str
    app_password: str
    tenant_id: str

    # AAD team (group) id that outbound-created channels are provisioned into.
    team_id: str

    # Public HTTPS base URL where this adapter's inbound listener is reachable.
    # Teams and Graph are HTTP-push, so the adapter hosts its own listener:
    # Bot Framework activities at ``/api/messages`` and Graph change
    # notifications at ``/api/teams/notifications``, both under this base.
    public_base_url: str

    # Local bind for the inbound listener. This is a Switch-internal deployment
    # detail, not an admin concern, so it is hidden from the gateway config form
    # (SkipJsonSchema) and defaults are used; an operator can still override it
    # via the stored connection_config when running more than one Teams bridge on
    # a host (one bridge per listener port).
    listen_host: SkipJsonSchema[str] = "0.0.0.0"
    listen_port: SkipJsonSchema[int] = 3978

    # Graph change-notification resource-data encryption. Graph encrypts message
    # bodies with the public certificate; the private key decrypts them on
    # delivery. Required once channel-message subscriptions are enabled, so the
    # trio is generated on creation rather than asked for — an operator pasting
    # PEMs into a form is three chances to disable channel capture silently, and
    # the certificate is key transport that Graph never validates against a trust
    # store, so there is nothing an operator-supplied one would buy. Hidden from
    # the gateway form; supplying your own through the API still wins.
    encryption_certificate_id: SkipJsonSchema[str | None] = None
    encryption_public_certificate: SkipJsonSchema[str | None] = None
    encryption_private_key: SkipJsonSchema[str | None] = None

    # Shared secret echoed back in every change notification and validated on
    # receipt. The ONLY control that authenticates a notification's origin: Graph
    # resource-data encryption proves integrity but NOT origin (the wrapping key
    # is the public certificate, which anyone can encrypt to), so without
    # clientState the notification endpoint is spoofable.
    #
    # Generated, not asked for: it is a secret with no external meaning, so
    # prompting an operator to invent one only invites a weak or reused value.
    # Required rather than defaulted, and minted in prepare_config at
    # registration — a default here would mint a fresh secret every time a stored
    # config was validated, and every live subscription would start failing its
    # origin check with nothing to point at.
    client_state: SkipJsonSchema[str]

    # Bot Connector serviceUrl (the per-tenant outbound endpoint). It is learned
    # from inbound Bot Framework activities and persisted here so outbound
    # survives a process restart — otherwise, until the bot next receives a
    # (mention-triggered) activity, no serviceUrl is known and every outbound
    # message fails. The Graph channel-capture path never carries a serviceUrl,
    # so a busy channel whose traffic arrives only via capture would never
    # re-learn it. Refreshed automatically whenever a newer value is observed.
    # Learned at runtime and persisted here — never an admin input, so it is
    # hidden from the gateway config form (SkipJsonSchema).
    service_url: SkipJsonSchema[str | None] = None

    # Channel id -> the AAD group id of the team holding it, learned from the
    # `channelData` of inbound activities and persisted here. A Graph message
    # subscription names the team as well as the channel, and `team_id` above
    # is only the team Switch *provisions into* — a channel the bot was added
    # to in some other team belongs to none of it. Held in memory alone this
    # was lost on every restart, and capture in those channels stayed dead
    # until someone thought to mention the bot; see `_learn_channel_team`.
    # Learned at runtime, never an admin input, so it is hidden from the form.
    channel_teams: SkipJsonSchema[dict[str, str]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _encryption_material_is_all_or_nothing(self) -> TeamsConnectionConfig:
        """A half-supplied encryption trio is a mistake, not a partial request.

        Completing it for them would pair someone's certificate with a private
        key they do not hold, and the only symptom would be channel capture that
        never decrypts.
        """
        supplied = [
            self.encryption_certificate_id,
            self.encryption_public_certificate,
            self.encryption_private_key,
        ]
        if any(supplied) and not all(supplied):
            raise ValueError(
                "encryption_certificate_id, encryption_public_certificate and "
                "encryption_private_key must be supplied together, or all left "
                "unset to have them generated"
            )
        return self


class TeamsAdapter(CollaborationAdapter):
    """Microsoft Teams collaboration adapter.

    Single-bot identity model (like Slack): one Azure bot app backs every Switch
    agent, and per-agent presentation is done with Adaptive Card sender labels
    rather than a bot account per agent. Outbound messages are delivered through
    the Bot Framework connector; inbound activities arrive at a self-hosted
    aiohttp listener. Full (non-@mention) channel-message capture goes through
    Microsoft Graph change-notification subscriptions.
    """

    # Teams keeps only http(s) anchors: a link on any other scheme is stripped
    # whole, label and all, so a `switchdash://` deeplink left the literal
    # brackets around it and rendered as "()". It needs the https redirect,
    # which means `GATEWAY_PUBLIC_URL` must be set — and declaring this is what
    # makes the lifecycle say so at startup when it is not.
    renders_custom_url_schemes: ClassVar[bool] = False

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        """Mint the clientState secret and the Graph encryption trio.

        Here rather than as model defaults because this runs only at
        registration, so what it produces is persisted once and never re-derived.
        A default on the model would mint fresh values every time a stored config
        was validated — a new certificate and a new shared secret on every
        restart, while Graph carried on encrypting to the old certificate and
        echoing the old secret. Capture would fail its origin check and its
        decryption, with nothing in the logs pointing at why.
        """
        prepared = dict(connection_config)
        if not prepared.get("client_state"):
            prepared["client_state"] = secrets.token_urlsafe(32)
        keys = (
            "encryption_certificate_id",
            "encryption_public_certificate",
            "encryption_private_key",
        )
        if any(prepared.get(k) for k in keys):
            return prepared
        # RSA keygen is CPU-bound and switch-core runs every live Matrix
        # session on this loop, so it does not run on it.
        cert_pem, key_pem = await asyncio.to_thread(generate_encryption_keypair)
        prepared["encryption_certificate_id"] = f"switch-teams-{secrets.token_hex(8)}"
        prepared["encryption_public_certificate"] = cert_pem
        prepared["encryption_private_key"] = key_pem
        return prepared

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        """The inbound listener's TCP port, which one process can hold once.

        Teams is push-based, so each bridge runs an HTTP server; two on the same
        port means the second never binds. Declaring it here turns that into a
        refusal at registration naming the port, rather than a bind error in a
        background task that leaves the bridge silently dropped.
        """
        config = TeamsConnectionConfig.model_validate(connection_config)
        return f"tcp/{config.listen_port}"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask Azure AD for both tokens the bridge will need.

        This is the call that fails on a wrong client secret, and Microsoft's
        error names the mistake precisely — including the classic case of the
        secret's ID being pasted instead of its value. Getting that to the
        operator at save time is the whole point.
        """
        config = TeamsConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(timeout=30) as http:
            tokens = TeamsTokenProvider(
                tenant_id=config.tenant_id,
                app_id=config.app_id,
                app_password=config.app_password,
                http=http,
            )
            try:
                await tokens.graph_token()
                await tokens.bot_token()
            except RuntimeError as exc:
                raise BridgeCredentialError(_aad_failure_message(exc)) from exc
            except httpx.HTTPError as exc:
                raise BridgeCredentialError(
                    f"Could not reach Microsoft to verify these credentials: {exc}"
                ) from exc

    def __init__(self, *, config: TeamsConnectionConfig) -> None:
        super().__init__()
        self._config = config

        self._http: httpx.AsyncClient | None = None
        self._tokens: TeamsTokenProvider | None = None
        self._connector: BotConnectorClient | None = None
        self._graph: GraphClient | None = None
        self._validator: InboundActivityValidator | None = None
        self._runner: web.AppRunner | None = None

        # Per-tenant Bot Connector endpoint, captured from inbound activities and
        # seeded from persisted config so outbound works right after a restart,
        # before the bot next receives a Bot Framework activity.
        self._service_url: dict[str, str] = {}
        self._default_service_url: str | None = config.service_url
        # Installed by the bridge to persist a newly-learned serviceUrl so it
        # survives a restart. No-op until set.
        self._persist_service_url: Callable[[str], Awaitable[None]] | None = None
        # channel/chat id -> ChannelType, learned from inbound activities.
        self._channel_type: dict[str, ChannelType] = {}
        # casefolded username -> AAD object id, for rendering real @mentions.
        self._mention_targets: dict[str, str] = {}
        # `_mention_targets` compiled into an `@name` matcher; None until built,
        # and discarded whenever the targets change.
        self._mention_pattern: re.Pattern[str] | None = None
        # AAD object id -> the handle we know that person by, so a directory
        # read happens once per sender rather than once per message.
        self._sender_handles: dict[str, str] = {}
        # channel id -> the post the bridge last saw a message in there, so a
        # reply that names no thread lands under what it is answering.
        self._last_post: dict[str, str] = {}
        # channel id -> its display name; "" records that Graph was asked and
        # could not say, so it is not asked again on every message.
        self._channel_names: dict[str, str] = {}
        # channel id -> when a Graph read of it last failed (monotonic), so the
        # retry is throttled without being abandoned. See `_read_channel`.
        self._channel_read_failed_at: dict[str, float] = {}
        # channel id -> "post" | "chat", the conversation layout Graph reports.
        # "" records that Graph was asked and could not say. See
        # `_uses_post_layout` for what an unknown layout is treated as.
        self._channel_layouts: dict[str, str] = {}
        # message id -> (service_url, conversation_id) for later edit/delete.
        self._sent: dict[str, tuple[str, str]] = {}
        # Inbound de-duplication — the Bot Framework and Graph capture paths can
        # both deliver the same channel message, keyed on the Teams message id.
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._seen_max = 2000

        # channel id -> Graph subscription id, for channels we capture.
        self._subscriptions: dict[str, str] = {}
        # Channels that should be captured, whether or not they currently are.
        # Kept apart from `_subscriptions` so a failed attempt is remembered as
        # work still owed rather than forgotten the moment it fails.
        self._capture_wanted: set[str] = set()
        # channel id -> last failure, so the repair loop can retry quietly and
        # still speak up when the reason changes.
        self._capture_failures: dict[str, str] = {}
        # channel id -> AAD team id, learned from inbound activities so a
        # channel-message subscription can be created for it. Seeded from the
        # persisted config, so a channel outside the configured team keeps its
        # capture across a restart instead of waiting to be re-taught.
        self._team_of_channel: dict[str, str] = dict(config.channel_teams)
        # Installed by the bridge to persist a newly-learned channel/team pair.
        self._persist_channel_team: Callable[[str, str], Awaitable[None]] | None = None
        self._sub_lock = asyncio.Lock()
        self._renewal_task: asyncio.Task[None] | None = None
        self._repair_task: asyncio.Task[None] | None = None

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        self._http = httpx.AsyncClient(timeout=30)
        self._tokens = TeamsTokenProvider(
            tenant_id=self._config.tenant_id,
            app_id=self._config.app_id,
            app_password=self._config.app_password,
            http=self._http,
        )
        self._connector = BotConnectorClient(tokens=self._tokens, http=self._http)
        self._graph = GraphClient(tokens=self._tokens, http=self._http)
        self._validator = InboundActivityValidator(app_id=self._config.app_id)

        app = web.Application()
        app.router.add_post("/api/messages", self._handle_http_messages)
        app.router.add_post("/api/teams/notifications", self._handle_http_notifications)
        app.router.add_get("/api/teams/notifications", self._handle_http_notifications)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(
            self._runner, self._config.listen_host, self._config.listen_port
        )
        await site.start()
        logger.info(
            "Teams adapter listening on %s:%d (app %s)",
            self._config.listen_host,
            self._config.listen_port,
            self._config.app_id,
        )
        await self._adopt_existing_subscriptions()
        self._renewal_task = asyncio.create_task(self._renewal_loop())
        self._repair_task = asyncio.create_task(self._repair_loop())

    @property
    def _notification_url(self) -> str:
        base = self._config.public_base_url.rstrip("/")
        return f"{base}/api/teams/notifications"

    async def _adopt_existing_subscriptions(self) -> None:
        """Re-attach to subscriptions this bridge already owns after a restart,
        and delete stale ones left by a previous notification URL.

        Graph subscriptions outlive the process, so on start we reclaim any that
        point at our current notification URL rather than blindly creating
        duplicates. Subscriptions for our channels that point at a *different*
        URL (e.g. a rotated tunnel) can never deliver here, so we delete them;
        ``ensure_channel_subscriptions`` then recreates them against the current
        URL."""
        if self._graph is None:
            return
        try:
            existing = await self._graph.list_subscriptions()
        except Exception:
            logger.warning("Could not list existing Graph subscriptions on start")
            return
        for sub in existing:
            resource = str(sub.get("resource", ""))
            channel_id = self._channel_from_resource(resource)
            if not channel_id:
                continue
            if sub.get("notificationUrl") == self._notification_url:
                self._subscriptions[channel_id] = str(sub.get("id", ""))
                continue
            stale_id = str(sub.get("id", ""))
            if not stale_id:
                continue
            try:
                await self._graph.delete_subscription(subscription_id=stale_id)
                logger.info(
                    "Deleted stale Teams subscription %s for channel %s "
                    "(notification URL changed)",
                    stale_id,
                    channel_id,
                )
            except Exception:
                logger.warning("Failed to delete stale Teams subscription %s", stale_id)
        if self._subscriptions:
            logger.info(
                "Re-attached to %d existing Teams subscriptions",
                len(self._subscriptions),
            )

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """Recreate Graph subscriptions for known channels that lack a live one.

        Called on startup with the bridge's channels so capture self-heals after
        a restart or notification-URL change: ``_adopt_existing_subscriptions``
        keeps still-valid subscriptions and clears stale ones, then this creates
        any that are missing. ``_ensure_channel_subscription`` skips channels
        already subscribed and logs (does not raise) on failure, so one bad
        channel does not block the rest."""
        for channel_id, channel_type in channels:
            if channel_type in ("channel_public", "channel_private"):
                await self._ensure_channel_subscription(channel_id)

    async def _renewal_loop(self) -> None:
        """Proactively renew channel-message subscriptions before they expire.

        Complements the reactive ``reauthorizationRequired`` lifecycle handler:
        even if a lifecycle notification is missed, subscriptions are refreshed
        on this cadence so capture never silently lapses."""
        while True:
            await asyncio.sleep(_RENEWAL_INTERVAL_SECONDS)
            await self._renew_all_subscriptions()

    async def _renew_all_subscriptions(self) -> None:
        if self._graph is None:
            return
        for channel_id, subscription_id in list(self._subscriptions.items()):
            try:
                await self._graph.renew_subscription(
                    subscription_id=subscription_id,
                    expiration_iso=self._expiration_iso(),
                )
            except Exception:
                logger.exception(
                    "Failed to renew subscription %s for channel %s",
                    subscription_id,
                    channel_id,
                )

    @staticmethod
    async def _cancel(task: asyncio.Task[None] | None) -> None:
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def stop(self) -> None:
        await self._cancel(self._renewal_task)
        self._renewal_task = None
        await self._cancel(self._repair_task)
        self._repair_task = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._validator is not None:
            self._validator.close()
            self._validator = None
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        logger.info("Teams adapter stopped")

    # ── Outbound helpers ─────────────────────────────────────────────────────

    def _service_url_for(self, channel_id: str) -> str:
        url = self._service_url.get(channel_id) or self._default_service_url
        if not url:
            raise RuntimeError(
                f"no Bot Connector serviceUrl known for channel {channel_id} — "
                "the bot has not yet received an activity from this tenant"
            )
        return url

    def set_service_url_persister(
        self, persist: Callable[[str], Awaitable[None]]
    ) -> None:
        self._persist_service_url = persist

    async def _learn_service_url(self, service_url: str) -> None:
        """Record a serviceUrl observed on an inbound activity, persisting it
        when it is new or changed so outbound survives the next restart."""
        if service_url == self._default_service_url:
            return
        self._default_service_url = service_url
        if self._persist_service_url is None:
            return
        try:
            await self._persist_service_url(service_url)
        except Exception:
            logger.warning("Failed to persist Teams serviceUrl", exc_info=True)

    def set_channel_team_persister(
        self, persist: Callable[[str, str], Awaitable[None]]
    ) -> None:
        self._persist_channel_team = persist

    async def _learn_channel_team(self, channel_id: str, team_id: str) -> None:
        """Record which team a channel belongs to, and persist it.

        A Graph message subscription is created against
        ``teams/{team}/channels/{channel}/messages``, so the team is not
        optional — and the only place it arrives is the ``channelData`` of an
        inbound activity. Held in memory alone it is lost on every restart,
        and a channel in any team other than the configured one then falls
        back to that one, where Graph answers "Channel is not present in the
        team" and capture never starts.

        That failure cannot heal on its own: refilling the map needs an
        activity from the channel, and without capture Teams delivers only
        messages that mention the bot — so tagging an *agent*, which is the
        normal way to use the room, never arrives. Silence, until someone
        happens to tag the bot itself.
        """
        if self._team_of_channel.get(channel_id) == team_id:
            return
        # Anything already read for this channel was read against a different
        # team and is not to be trusted — most often it was not read at all,
        # because the wrong team is exactly what Graph refuses. Without this the
        # subscription heals on the new team while the name and layout stay
        # stuck at whatever the failed read left behind.
        self._team_of_channel[channel_id] = team_id
        self._channel_names.pop(channel_id, None)
        self._channel_layouts.pop(channel_id, None)
        self._channel_read_failed_at.pop(channel_id, None)
        if self._persist_channel_team is None:
            return
        try:
            await self._persist_channel_team(channel_id, team_id)
        except Exception:
            logger.warning(
                "Failed to persist the team of Teams channel %s; capture there "
                "will need the bot mentioned again after the next restart",
                channel_id,
                exc_info=True,
            )

    def _is_channel(self, channel_id: str) -> bool:
        """Whether ``channel_id`` is a Teams channel (threaded) vs a flat chat.

        Learned type wins; otherwise fall back to the id shape (channels use
        ``@thread.tacv2``). Switch-created channels default to channel."""
        known = self._channel_type.get(channel_id)
        if known is not None:
            return known in ("channel_public", "channel_private")
        return "@thread.tacv2" in channel_id or channel_id not in self._channel_type

    @staticmethod
    def _thread_conversation(channel_id: str, root_id: str) -> str:
        return f"{channel_id};messageid={root_id}"

    async def _channel_layout(self, channel_id: str) -> str | None:
        """The channel's conversation layout as Graph reports it, or None.

        Graph is the only thing that knows: a Bot Framework activity says
        nothing about layout, and listing a team's channels returns the
        property as null for every one of them. So it is a per-channel read,
        cached — and the same read the channel's name comes from, so learning
        both costs one call.
        """
        cached = self._channel_layouts.get(channel_id)
        if cached is not None:
            return cached or None
        if self._read_recently_failed(channel_id):
            return None
        await self._read_channel(channel_id)
        return self._channel_layouts.get(channel_id) or None

    async def _uses_post_layout(
        self, channel_id: str, *, is_channel: bool | None = None
    ) -> bool:
        """Whether replies in this channel have to be steered into a post.

        Teams has two channel layouts and they want opposite things.

        A **posts** channel is a list of conversations: a message at the root
        opens a new one. An agent answering a question there must land under
        the question, or the answer appears as a fresh post below and reads as
        a non-sequitur.

        A **chat** channel is a stream, like every other platform Switch
        bridges. "No thread" means the root, and steering is exactly wrong: it
        buries an agent's first message, the room-linked notice and the runtime
        status inside whatever thread the channel last used. So a chat channel
        gets the ordinary policy — the agent decides whether to thread, and
        nothing is rewritten on the way out.

        An unreadable layout is treated as posts. That is Graph's own default,
        and it is what every Teams channel was before the chat layout existed,
        so it is the answer least likely to surprise. Chats and group chats
        have no posts to be wrong about and are never steered.
        """
        threaded = self._is_channel(channel_id) if is_channel is None else is_channel
        if not threaded:
            return False
        return await self._channel_layout(channel_id) != "chat"

    async def _remember_post(
        self,
        channel_id: str,
        post_id: str,
        *,
        is_channel: bool | None = None,
        only_if_unset: bool = False,
    ) -> None:
        """Note the post a posts-channel conversation is currently in.

        Inbound, unconditionally: the message someone just sent is what an
        untied reply should answer under.

        Outbound, only when nothing is recorded yet (`only_if_unset`). The
        first thing an agent says in a channel has no question to answer — it
        opens a post — and what it says next belongs in that post rather than
        in a fresh one each time, or an agent greeting itself into a channel
        produces a column of one-line posts. But an agent's own message must
        never *displace* a real one: an agent deliberately replying into an
        older thread would otherwise drag every later answer back into it.
        """
        if not post_id:
            return
        if only_if_unset and channel_id in self._last_post:
            return
        if await self._uses_post_layout(channel_id, is_channel=is_channel):
            self._last_post[channel_id] = post_id

    async def _post_to_answer_in(
        self, channel_id: str, thread_root_id: str | None
    ) -> str | None:
        """Which post a channel reply belongs under, in a posts channel.

        A caller that named a thread knows better than we do and wins. What
        this covers is the caller that named none, which is any agent whose
        reply was not itself threaded in Matrix: answer in the post the bridge
        last saw this channel speak in, rather than opening a new one.

        The limitation, stated because it is real: "last" is per channel, so
        two conversations running in the same posts channel at the same moment
        can cross. Teams gives no better signal on an untied reply, and landing
        in the wrong post beats starting a fresh one every time.

        Chat-layout channels are left entirely alone — see `_uses_post_layout`.
        """
        if thread_root_id is not None:
            return thread_root_id
        if not await self._uses_post_layout(channel_id):
            return None
        return self._last_post.get(channel_id)

    async def _message_activity(self, sender_name: str, body: str) -> dict[str, Any]:
        agent = await self.agent_rendering(sender_name)
        mentions = self._mention_entities(body)
        return {
            "type": "message",
            # Notification/preview text; without it Teams renders a
            # "cards.unsupported" placeholder in toasts, mobile, and link previews.
            # Plain text, rendered by no markup engine, so the label goes in raw.
            "summary": f"{agent.field_label}: {body}",
            "attachments": [card_attachment(agent_message_card(agent, body, mentions))],
        }

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        if self._connector is None:
            raise RuntimeError("Cannot send message: Teams adapter not started")

        service_url = self._service_url_for(channel_id)
        # `content` arrives rendered: every caller of `send_message` runs
        # `translate_outbound` first, and rendering again here put the body
        # through the conversion twice.
        activity = await self._message_activity(sender_name, content)
        thread_root_id = await self._post_to_answer_in(channel_id, thread_root_id)

        if self._is_channel(channel_id) and thread_root_id is None:
            conversation_id, msg_id = await self._connector.create_channel_thread(
                service_url=service_url, channel_id=channel_id, activity=activity
            )
        else:
            conversation_id = (
                self._thread_conversation(channel_id, thread_root_id)
                if thread_root_id and self._is_channel(channel_id)
                else channel_id
            )
            msg_id = await self._connector.send_to_conversation(
                service_url=service_url,
                conversation_id=conversation_id,
                activity=activity,
            )

        if msg_id:
            self._sent[msg_id] = (service_url, conversation_id)
            await self._remember_post(
                channel_id, thread_root_id or msg_id, only_if_unset=True
            )
            return msg_id
        return None

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str | None:
        # Admin/system messages render as the Switch bot itself — a plain text
        # activity, no per-agent Adaptive Card — so they read as the platform
        # speaking rather than an agent.
        if self._connector is None:
            raise RuntimeError("Cannot post admin message: Teams adapter not started")

        service_url = self._service_url_for(channel_id)
        body = self.translate_outbound(content)
        thread_root_id = await self._post_to_answer_in(channel_id, thread_root_id)
        activity: dict[str, Any] = {"type": "message", "text": body}
        mentions = self._mention_entities(body)
        if mentions:
            # A plain-text activity carries its mention entities directly; only
            # a card puts them under `msteams`.
            activity["entities"] = mentions

        if self._is_channel(channel_id) and thread_root_id is None:
            conversation_id, msg_id = await self._connector.create_channel_thread(
                service_url=service_url, channel_id=channel_id, activity=activity
            )
        else:
            conversation_id = (
                self._thread_conversation(channel_id, thread_root_id)
                if thread_root_id and self._is_channel(channel_id)
                else channel_id
            )
            msg_id = await self._connector.send_to_conversation(
                service_url=service_url,
                conversation_id=conversation_id,
                activity=activity,
            )

        if msg_id:
            self._sent[msg_id] = (service_url, conversation_id)
            await self._remember_post(
                channel_id, thread_root_id or msg_id, only_if_unset=True
            )
            return msg_id
        return None

    def _locate(self, channel_id: str, message_ref: str) -> tuple[str, str]:
        """Resolve ``(service_url, conversation_id)`` for a previously sent
        message so it can be edited or deleted. Falls back to treating the
        message as its own thread root when it wasn't sent in this session."""
        located = self._sent.get(message_ref)
        if located is not None:
            return located
        logger.warning(
            "No tracked conversation for Teams message %s; reconstructing", message_ref
        )
        return (
            self._service_url_for(channel_id),
            self._thread_conversation(channel_id, message_ref),
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        if self._connector is None:
            raise RuntimeError("Cannot update message: Teams adapter not started")
        service_url, conversation_id = self._locate(channel_id, message_ref)
        await self._connector.update_activity(
            service_url=service_url,
            conversation_id=conversation_id,
            activity_id=message_ref,
            activity={"type": "message", "text": new_content},
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        if self._connector is None:
            raise RuntimeError("Cannot delete message: Teams adapter not started")
        service_url, conversation_id = self._locate(channel_id, message_ref)
        await self._connector.delete_activity(
            service_url=service_url,
            conversation_id=conversation_id,
            activity_id=message_ref,
        )
        self._sent.pop(message_ref, None)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Teams typing indicators auto-expire and are best-effort cosmetics; a
        # failure to show one must not break the turn.
        if not is_typing or self._connector is None:
            return
        try:
            await self._connector.send_to_conversation(
                service_url=self._service_url_for(channel_id),
                conversation_id=channel_id,
                activity={"type": "typing"},
            )
        except Exception:
            logger.warning("Failed to send typing indicator to %s", channel_id)

    # ── Runtime state ──────────────────────────────────────────────────────────

    async def _apply_runtime_state(
        self,
        channel_id: str,
        agent_name: str,
        state: str,
        *,
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None = None,
        detail: str | None = None,
        trigger_thread_root_id: str | None = None,
        anchor_message_ref: str | None = None,
    ) -> None:
        """Persistent status messages, mirroring Slack.

        A "working on it…" card is posted (as the agent) while the agent works
        and edited in place as the activity detail changes; it stays up through
        ``awaiting-input`` — where a "needs your input" ping is added — and both
        are retired when the turn goes ``idle`` (or resumes to ``working``,
        since the requested input was provided).

        **How they are retired depends on the channel's layout**, because Teams
        does not delete the same way in both. In a chat-layout channel a deleted
        message is gone, so the status is removed and leaves nothing behind. In
        a **posts** channel Teams substitutes *"This message has been deleted."*
        and keeps it in the post — so a status that appears and vanishes each
        turn litters the conversation with tombstones, one per turn per agent.
        There is no way to delete without one. So there, as on Mattermost, the
        status is never deleted: it is edited into a small terminal marker and
        left as the record of a turn that is over.
        """
        key = (channel_id, agent_name)
        if state == "working":
            await self._clear_input_pings(channel_id, agent_name)
            body = self._working_body(detail, deeplink_url)
            existing = self._working_msg.get(key)
            if existing is not None:
                await self._refresh_card(
                    channel_id, existing.message_ref, agent_name, body
                )
                self._working_msg[key] = replace(existing, body=body)
                return
            ref = await self.send_message(channel_id, agent_name, body, thread_root_id)
            if ref is not None:
                self._working_msg[key] = LiveRuntimeIndicator(
                    message_ref=ref,
                    body=body,
                    thread_root_id=thread_root_id,
                    started_at=time.monotonic(),
                )
        elif state == "awaiting-input":
            ref = await self._ping_operator(
                channel_id, agent_name, mention_handle, thread_root_id, deeplink_url
            )
            if ref is not None:
                self._input_pings.setdefault(key, []).append(ref)
        else:
            await self._retire_working(channel_id, agent_name)
            await self._clear_input_pings(channel_id, agent_name)

    async def _leaves_a_tombstone(self, channel_id: str) -> bool:
        """Whether deleting a message here would leave wreckage behind.

        Only in a posts channel, where Teams replaces a deleted message with
        *"This message has been deleted."* and keeps it in the post. A
        chat-layout channel drops it cleanly, and a chat or group chat has no
        post to litter.
        """
        return await self._uses_post_layout(channel_id)

    async def _refresh_card(
        self, channel_id: str, message_ref: str, agent_name: str, body: str
    ) -> None:
        if self._connector is None:
            return
        service_url, conversation_id = self._locate(channel_id, message_ref)
        await self._connector.update_activity(
            service_url=service_url,
            conversation_id=conversation_id,
            activity_id=message_ref,
            activity=await self._message_activity(agent_name, body),
        )

    async def _retire_working(self, channel_id: str, agent_name: str) -> None:
        """End the turn's live status: edited where a delete would scar, else
        removed.

        The marker is kept to the bare fact that the turn finished and how long
        it took, because in a posts channel this line stays there for good and
        has to earn its place. The session link is deliberately dropped: it
        belongs on a live indicator, where it is still worth following, not on
        the record of a turn that is over.
        """
        live = self._working_msg.pop((channel_id, agent_name), None)
        if live is None:
            return
        if not await self._leaves_a_tombstone(channel_id):
            await self.delete_message(channel_id, live.message_ref)
            return
        elapsed = format_elapsed(time.monotonic() - live.started_at)
        await self._refresh_card(
            channel_id,
            live.message_ref,
            agent_name,
            self.translate_outbound(f"✓ Done · {elapsed}"),
        )

    async def _reposition_runtime_state(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Follow the conversation, except where moving would leave a scar.

        Repositioning is a repost plus a delete, and in a posts channel that
        delete leaves *"This message has been deleted."* behind — once per move,
        so the busier the conversation the more of them. Pinned to where the
        turn began there instead: less precise about where the agent is up to,
        and it costs the reader nothing.
        """
        if await self._leaves_a_tombstone(channel_id):
            return
        await super()._reposition_runtime_state(channel_id, agent_name, thread_root_id)

    async def _remove_runtime_indicator(
        self, channel_id: str, message_ref: str
    ) -> None:
        """Drop a superseded indicator without letting a delete failure escape.

        Unlike the other adapters, Teams' delete raises — on a missing connector
        and on any non-2xx from the Bot Connector. When the indicator has
        already been reposted elsewhere, a failure here means a stale duplicate
        is left visible, which is preferable to aborting the turn."""
        try:
            await self.delete_message(channel_id, message_ref)
        except (RuntimeError, httpx.HTTPError) as e:
            logger.warning(
                "Could not remove the superseded runtime indicator %s in %s (%s); "
                "a stale copy may remain visible",
                message_ref,
                channel_id,
                e,
            )

    async def _clear_input_pings(self, channel_id: str, agent_name: str) -> None:
        """Resolve the operator pings raised during the turn.

        Edited rather than removed wherever a delete would leave a tombstone —
        and for a ping that matters more than for the status line, since the
        people looking at it are exactly the ones it was aimed at."""
        refs = self._input_pings.pop((channel_id, agent_name), [])
        if not refs:
            return
        scars = await self._leaves_a_tombstone(channel_id)
        for ref in refs:
            if scars:
                await self._refresh_card(
                    channel_id,
                    ref,
                    agent_name,
                    self.translate_outbound("✓ Input received"),
                )
            else:
                await self.delete_message(channel_id, ref)

    # ── Channels ─────────────────────────────────────────────────────────────

    @staticmethod
    def _sanitize_channel_name(name: str) -> str:
        """Teams channel display names disallow several characters and cap at
        50 chars. Replace the reserved set and trim."""
        cleaned = re.sub(r'[~#%&*{}+/\\:<>?|\'"]', "-", name).strip(" .-")
        return (cleaned or "switch")[:50]

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        if self._graph is None:
            raise RuntimeError("Teams adapter not started")
        if channel_type in ("group", "direct"):
            raise ValueError(
                f"Cannot create {channel_type} channels — they are initiated "
                "from the messaging platform"
            )

        membership_type = "private" if channel_type == "channel_private" else "standard"
        channel = await self._graph.create_channel(
            team_id=self._config.team_id,
            display_name=self._sanitize_channel_name(name),
            description=topic,
            membership_type=membership_type,
        )
        channel_id = str(channel.get("id", ""))
        if not channel_id:
            raise RuntimeError(f"Teams channel creation returned no id for '{name}'")

        self._channel_type[channel_id] = channel_type
        await self._learn_channel_team(channel_id, self._config.team_id)
        self._channel_names[channel_id] = str(channel.get("displayName") or "")
        self._channel_layouts[channel_id] = str(channel.get("layoutType") or "")
        # Capture the new channel's messages right away.
        await self._ensure_channel_subscription(channel_id)
        return channel_id

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        known = self._channel_type.get(channel_id)
        if known is not None:
            return known
        if self._graph is None:
            raise RuntimeError("Teams adapter not started")
        team_id = self._team_of_channel.get(channel_id, self._config.team_id)
        channel = await self._graph.get_channel(team_id=team_id, channel_id=channel_id)
        resolved: ChannelType = (
            "channel_private"
            if channel.get("membershipType") == "private"
            else "channel_public"
        )
        self._channel_type[channel_id] = resolved
        # The same response carries the name and layout, so record them rather
        # than reading the channel a second time on the first message.
        self._channel_names.setdefault(
            channel_id, str(channel.get("displayName") or "")
        )
        self._channel_layouts.setdefault(
            channel_id, str(channel.get("layoutType") or "")
        )
        return resolved

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Search the AAD directory for people to claim as an identity.

        Teams identifies a message sender by AAD object id where one is
        available, which is what Graph returns here, so a claim made from this
        list matches what arrives on the inbound path.
        """
        if self._graph is None:
            raise RuntimeError("Teams adapter not started")
        term = query.strip()
        if not term:
            return []
        users = await self._graph.search_users(query=term)
        results = [
            DirectoryUser(
                external_user_id=str(user.get("id")),
                username=_handle_for(user),
                display_name=str(
                    user.get("displayName") or user.get("userPrincipalName") or ""
                ),
                email=user.get("mail") or user.get("userPrincipalName") or None,
            )
            for user in users
            if user.get("id")
        ]
        results.sort(key=lambda u: u.display_name.lower())
        return results

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """`https://teams.microsoft.com/l/channel/...` opening the channel in the
        Teams client. Built from the channel id, its team, and the tenant."""
        if not external_channel_id:
            return None
        team_id = self._team_of_channel.get(external_channel_id, self._config.team_id)
        encoded = quote(external_channel_id, safe="")
        return (
            f"https://teams.microsoft.com/l/channel/{encoded}/channel"
            f"?groupId={team_id}&tenantId={self._config.tenant_id}"
        )

    async def home_deeplink(self) -> str | None:
        """`https://teams.microsoft.com/?tenantId=<tenant>` — opens Teams on the
        right tenant.

        Deliberately the tenant root rather than a team link: the
        `/l/team/{id}/conversations` form keys off the General channel's thread
        id, not the team id, and this adapter does not hold that. A link that
        reliably lands in the correct tenant beats one that may 404."""
        if not self._config.tenant_id:
            return None
        return f"https://teams.microsoft.com/?tenantId={self._config.tenant_id}"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Single-bot identity model: agents share one Teams bot, so there is no
        # per-agent membership to manage (mirrors Slack).
        pass

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        if self._graph is None:
            raise RuntimeError("Teams adapter not started")
        team_id = self._team_of_channel.get(channel_id, self._config.team_id)
        # Private channels have their own membership; standard channels inherit
        # the team's, so a user is added to the team instead.
        is_private = self._channel_type.get(channel_id) == "channel_private"
        failed: list[str] = []
        for user_id in user_external_ids:
            try:
                if is_private:
                    await self._graph.add_channel_member(
                        team_id=team_id, channel_id=channel_id, user_aad_id=user_id
                    )
                else:
                    await self._graph.add_team_member(
                        team_id=team_id, user_aad_id=user_id
                    )
            except Exception:
                logger.exception(
                    "Failed to add user %s to Teams channel %s", user_id, channel_id
                )
                failed.append(user_id)
        return failed

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        # Single-bot model: no per-agent platform account is created.
        pass

    async def remove_agent_identity(self, agent_name: str) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        # Single shared bot cannot enumerate per-agent membership (mirrors Slack).
        return []

    # ── Translation ──────────────────────────────────────────────────────────

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        """Learn ``username -> AAD object id`` so an ``@name`` can become a real
        Teams mention. Without it every ``@name`` goes out as inert text and the
        person it names is never notified."""
        self._mention_targets.update(
            {name.casefold(): external_id for name, external_id in targets.items()}
        )
        self._mention_pattern = None

    def _known_name_pattern(self) -> re.Pattern[str] | None:
        """An ``@name`` matcher covering the names we can actually address.

        Built from the targets rather than from a general name shape, because
        a Teams handle is often a display name and so often contains a space:
        no fixed pattern can tell where `@Louis Amaudruz` ends without knowing
        the name. Longest first, so the full name wins over its first word.

        Rebuilt when the targets change, which is on startup and once per
        person met.
        """
        if self._mention_pattern is None and self._mention_targets:
            names = sorted(self._mention_targets, key=len, reverse=True)
            alternatives = "|".join(re.escape(name) for name in names)
            self._mention_pattern = re.compile(
                f"@({alternatives}){_MENTION_END}", re.IGNORECASE
            )
        return self._mention_pattern

    def translate_outbound(self, content: str) -> str:
        return _hard_wrap(self._mark_mentions(content))

    def escape_label_for_body(self, label: str) -> str:
        """Add the `<at>` tag to what the base class already defuses.

        The inherited `@` rule is what stops `_mark_mentions` marking up an
        `@alice` a label carried in, and the inherited `]` rule is what stops
        a card's TextBlock, which renders markdown, turning a label's
        `[text](url)` into a link of its own choosing. Teams needs one
        more: `<at>alice</at>` written straight into a label skips the marking
        pass but is still found by `_mention_entities`, which scans the
        rendered body for the markup and pairs whatever it finds with an entity
        that notifies whoever `alice` actually is. A zero-width space after
        every `<` breaks the tag.

        Broken syntax rather than entity escaping, because an Adaptive Card is
        not HTML: `&lt;` here is shown to the reader as those four
        characters."""
        return (
            super().escape_label_for_body(label).replace("<", "<" + _ZERO_WIDTH_SPACE)
        )

    def _mark_mentions(self, content: str) -> str:
        """Wrap ``@name`` in Teams' ``<at>`` markup for people we can address.

        Only names we hold an AAD id for: the markup is half of a mention and
        the entity built from it in ``_mention_entities`` is the other, so
        marking a name we cannot pair would render a mention that highlights
        nobody. Agent names are deliberately among those left alone — an agent
        is not a Teams user, and ``@agent`` is Switch's own addressing, which
        wants the plain text.
        """
        pattern = self._known_name_pattern()
        if pattern is None:
            return content

        def _replace(match: re.Match[str]) -> str:
            name = match.group(1)
            # The pattern matches case-insensitively while the entity is looked
            # up by casefold, and for a few scripts those disagree. Emitting
            # markup the entity pass would not pair leaves a mention that
            # highlights nobody, so leave the text alone instead.
            if name.casefold() not in self._mention_targets:
                return match.group(0)
            return f"<at>{html.escape(name)}</at>"

        return pattern.sub(_replace, content)

    def _mention_entities(self, text: str) -> list[dict[str, Any]]:
        """Bot Framework mention entities for the ``<at>`` markup in ``text``.

        Teams needs both halves and rejects neither: markup with no entity is
        plain text, an entity with no markup does nothing. Built from the
        rendered body so the two cannot drift.
        """
        entities: list[dict[str, Any]] = []
        seen: set[str] = set()
        for escaped_name in _AT_TAG.findall(text):
            if escaped_name in seen:
                continue
            name = html.unescape(escaped_name)
            external_id = self._mention_targets.get(name.casefold())
            if external_id is None:
                continue
            seen.add(escaped_name)
            entities.append(
                {
                    "type": "mention",
                    "text": f"<at>{escaped_name}</at>",
                    "mentioned": {"id": external_id, "name": name},
                }
            )
        return entities

    async def _sender_handle(self, sender_id: str, offered_name: str) -> str:
        """The handle to file an inbound sender under.

        Teams omits the sender's name from some activities — 1:1 chats above
        all — and the fallback was the raw id, so `29:1AbCdEf…` became a
        person's name: in the room title, on their Matrix account, and in the
        text of every agent reply that addressed them. An id is never a name,
        so look one up instead, and only give up when Graph cannot say either.

        What Teams offers on an activity is the *display* name, which is
        usually two words. A handle is also what an agent writes to address
        someone, and `@Louis Amaudruz` cannot be read back — a mention ends at
        the first space — so taking the offered name at face value files
        people under something that can never be tagged. Ask the directory for
        the principal name instead, which is one word by construction, and
        keep the offered name only if the directory cannot say.

        Cached per sender: it is one directory read per person, on a value that
        does not change between messages.
        """
        cached = self._sender_handles.get(sender_id)
        if cached is not None:
            return cached
        handle = ""
        # A one-word name Teams offered is already a usable handle and costs
        # nothing. An id masquerading as a name, or a name with a space in it,
        # sends us to the directory for something better.
        if (
            offered_name
            and offered_name != sender_id
            and _is_usable_handle(offered_name)
        ):
            handle = offered_name
        elif self._graph is not None and sender_id:
            try:
                handle = _handle_for(await self._graph.get_user(user_id=sender_id))
            except Exception:
                logger.warning(
                    "Could not resolve a handle for Teams sender %s; falling "
                    "back to %s",
                    sender_id,
                    "the display name Teams offered" if offered_name else "their id",
                    exc_info=True,
                )
        # A display name with a space is a poor handle but a good deal better
        # than an id, so it stands when the directory yields nothing.
        handle = handle or offered_name or sender_id
        self._sender_handles[sender_id] = handle
        return handle

    @staticmethod
    def _command_name(token: str) -> str:
        """The command a leading `!name` or `/name` token names.

        Teams has no server-registered slash commands — a bot's command list
        is declared in its app manifest and, when picked, simply types the text
        into the compose box. So `/help` reaches us as an ordinary message and
        the two prefixes are the same thing by the time we see them.
        """
        return token.lstrip("!/")

    def slash_invite_hint(self) -> str | None:
        # Teams has no server-registered slash commands: a manifest command
        # list only types the text into the compose box, and the bot parses it
        # like any other message. So the slash form always works, whether or
        # not the operator has declared it, and reaches the same dispatcher.
        return (
            "`/invite-agent @agent-name` — the same thing, if you prefer the slash form"
        )

    def is_placeholder_username(self, username: str) -> bool:
        # Every id Teams hands out for a person is one of two shapes: a
        # channel-account id, prefixed with digits and a colon (`29:1AbC…`,
        # `8:orgid:…`), or a bare Entra object id. Neither is anybody's name.
        return bool(_TEAMS_ID.match(username.strip()))

    def render_app_mention(self, token: str) -> str:
        # Teams' handle for the app is an id, not a name, and it has no inline
        # syntax that turns one into a mention — so name nobody and read
        # naturally instead of printing `<@28:…>` at someone.
        return "me"

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    # ── Inbound listener ─────────────────────────────────────────────────────

    async def _handle_http_messages(self, request: web.Request) -> web.Response:
        auth_header = request.headers.get("Authorization")
        if self._validator is not None:
            try:
                await asyncio.get_running_loop().run_in_executor(
                    None, self._validator.validate, auth_header
                )
            except Exception as e:
                logger.warning("Rejected inbound Teams activity: %s", e)
                return web.Response(status=401, text="unauthorized")

        try:
            activity = await request.json()
        except Exception:
            return web.Response(status=400, text="invalid json")

        try:
            await self._dispatch_activity(activity)
        except Exception:
            logger.exception("Failed to handle inbound Teams activity")

        return web.Response(status=200)

    async def _dispatch_activity(self, activity: dict[str, Any]) -> None:
        service_url = str(activity.get("serviceUrl", "")).strip()
        activity_type = activity.get("type")

        channel_id, channel_type = self._channel_from_activity(activity)
        if service_url and channel_id:
            self._service_url[channel_id] = service_url
            await self._learn_service_url(service_url)
            self._channel_type[channel_id] = channel_type

        team = (activity.get("channelData") or {}).get("team") or {}
        # Graph channel subscriptions key on the team's AAD group GUID, which
        # Teams sends as ``aadGroupId``. ``team.id`` is the non-GUID channel
        # thread id and Graph rejects it ("TeamGroupId must be ... a valid
        # GUID"). Fall back to the configured team_id, which is also that GUID.
        group_id = team.get("aadGroupId") or self._config.team_id
        if group_id and channel_id:
            await self._learn_channel_team(channel_id, str(group_id))

        if activity_type == "message":
            await self._dispatch_message(activity, channel_id, channel_type)
        elif activity_type == "conversationUpdate":
            await self._dispatch_conversation_update(activity, channel_id, channel_type)

    @staticmethod
    def _channel_from_activity(
        activity: dict[str, Any],
    ) -> tuple[str, ChannelType]:
        conversation = activity.get("conversation") or {}
        conv_id = str(conversation.get("id", ""))
        conv_type = conversation.get("conversationType", "")
        channel_data = activity.get("channelData") or {}
        channel = channel_data.get("channel") or {}

        if conv_type == "channel" or "@thread.tacv2" in conv_id:
            channel_id = str(channel.get("id") or conv_id.split(";", 1)[0])
            return channel_id, "channel_public"
        if conv_type == "personal":
            return conv_id, "direct"
        if conv_type == "groupChat":
            return conv_id, "group"
        return conv_id.split(";", 1)[0], "channel_public"

    def _seen_activity(self, activity_id: str) -> bool:
        if not activity_id:
            return False
        if activity_id in self._seen:
            return True
        self._seen[activity_id] = None
        if len(self._seen) > self._seen_max:
            self._seen.popitem(last=False)
        return False

    async def _dispatch_message(
        self, activity: dict[str, Any], channel_id: str, channel_type: ChannelType
    ) -> None:
        activity_id = str(activity.get("id", ""))
        if self._seen_activity(activity_id):
            return

        sender = activity.get("from") or {}
        sender_id = str(sender.get("aadObjectId") or sender.get("id") or "")
        sender_name = await self._sender_handle(
            sender_id, str(sender.get("name") or "")
        )

        raw_text = str(activity.get("text", ""))
        text = self._clean_text(raw_text)
        text += self._disclosed_attachment_note(
            self._activity_attachment_descriptors(activity)
        )
        self_mention_token = self._self_mention_token(activity)
        command_text = (
            self._clean_text(_strip_leading_mention(raw_text))
            if self_mention_token is not None
            else text
        )

        conversation = activity.get("conversation") or {}
        conv_id = str(conversation.get("id", ""))
        root_id: str | None = None
        if ";messageid=" in conv_id:
            thread_root = conv_id.split(";messageid=", 1)[1]
            if thread_root and thread_root != activity_id:
                root_id = thread_root

        channel_name = await self._resolve_channel_name(activity, channel_id)

        await self._deliver(
            channel_id=channel_id,
            channel_type=channel_type,
            sender_id=sender_id,
            sender_name=sender_name,
            text=text,
            message_ref=activity_id,
            root_id=root_id,
            channel_name=channel_name,
            self_mention_token=self_mention_token,
            command_text=command_text,
            is_targeted=bool((activity.get("recipient") or {}).get("isTargeted")),
        )

    def _command_in(self, probe: str, *, is_targeted: bool) -> str | None:
        """The command this message runs, or None if it is ordinary text.

        Two ways a command arrives, and both need a name Switch knows.

        **Prefixed** — `!help`, or `/help`. The prefix alone used to be enough,
        which meant any message opening with a slash was swallowed: paste a
        path and you got "unknown command" instead of your message. Telegram
        already guards against that; this is the same guard.

        **Bare, on a targeted message** — Teams' `/` picker prepends the slash
        itself and inserts the command's bare name, so `activity.text` is
        `help`, not `/help`. That is why the slash-triggered list in the shipped
        manifest declares titles without one, matching Microsoft's own samples.
        A bare name is only read as a command when the message was targeted at
        this bot: outside that, "help" in a channel is somebody talking.
        """
        if not probe:
            return None
        first = probe.split(None, 1)[0]
        name = self._command_name(first)
        if name in COMMANDS_BY_NAME:
            # Known, however it was written: `!help`, `/help`, or the bare
            # `help` the picker inserts.
            return name if first[:1] in _COMMAND_PREFIXES or is_targeted else None
        # Unknown. Whether that is worth answering depends on which prefix was
        # used, because the two mean different things to a person.
        #
        # `!` is Switch's own and means nothing else, so `!list-agent` is a
        # misspelt command and deserves to be told so.
        #
        # `/` is not Switch's — it opens paths, dates and fractions, and Teams
        # delivers those as ordinary text. Reading every one as a command is
        # how `/Users/ada/notes.md` came back "unknown command" instead of
        # reaching an agent. So an unknown `/name` is left as what it looks
        # like: a message.
        return name if first.startswith("!") else None

    async def _deliver(
        self,
        *,
        channel_id: str,
        channel_type: ChannelType,
        sender_id: str,
        sender_name: str,
        text: str,
        message_ref: str,
        root_id: str | None,
        channel_name: str | None,
        self_mention_token: str | None = None,
        command_text: str | None = None,
        is_targeted: bool = False,
    ) -> None:
        """Route a parsed inbound message to the command or message callback.

        Shared by the Bot Framework activity path and the Graph capture path so
        both apply the same ``!``-command detection and translation.

        ``command_text`` is the message with a leading bot @mention removed; it is
        used only to detect and parse ``!``-commands (a channel command arrives as
        ``@Bot !cmd``), while ``text`` — mention intact — is what a plain message
        is bridged as. Defaults to ``text`` when the caller has nothing to strip."""
        # The post this message sits in — itself, when it opened the post.
        # Remembered so an untied reply lands under the question rather than
        # starting a conversation of its own; see _post_to_answer_in.
        await self._remember_post(
            channel_id,
            root_id or message_ref,
            # The caller was told the type; do not re-derive it from the id.
            is_channel=channel_type in ("channel_public", "channel_private"),
        )
        command_probe = (command_text if command_text is not None else text).strip()
        command = self._command_in(command_probe, is_targeted=is_targeted)
        if command is not None and self._on_command is not None:
            parts = command_probe.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    command=command,
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return

        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    content=self.translate_inbound(text),
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                    self_mention_token=self_mention_token,
                )
            )

    async def _dispatch_conversation_update(
        self, activity: dict[str, Any], channel_id: str, channel_type: ChannelType
    ) -> None:
        members_added = activity.get("membersAdded") or []
        recipient = activity.get("recipient") or {}
        bot_id = str(recipient.get("id", ""))
        channel_name = await self._resolve_channel_name(activity, channel_id)

        for member in members_added:
            member_id = str(member.get("id", ""))
            if member_id == bot_id:
                # The bot was added to a channel/team → start capturing all of
                # its messages via a Graph subscription (channels only; chats are
                # captured through the Bot Framework path).
                if channel_type in ("channel_public", "channel_private"):
                    await self._ensure_channel_subscription(channel_id)
                if self._on_app_joined is not None:
                    await self._on_app_joined(
                        InboundAppJoin(
                            channel_id=channel_id,
                            channel_type=channel_type,
                            channel_name=channel_name,
                        )
                    )
            elif self._on_user_joined is not None:
                joiner_id = str(member.get("aadObjectId") or member_id)
                await self._on_user_joined(
                    InboundUserJoin(
                        channel_id=channel_id,
                        channel_type=channel_type,
                        external_user_id=joiner_id,
                        external_username=await self._sender_handle(
                            joiner_id, str(member.get("name") or "")
                        ),
                        channel_name=channel_name,
                    )
                )

    @staticmethod
    def _channel_name(activity: dict[str, Any]) -> str | None:
        """The channel's name as the activity gives it, if it gives it.

        Prefer the channel's own name over the team's: the team's is the same
        for every channel in it, which makes a poor room title. Teams omits
        both more often than not — see `_resolve_channel_name`.
        """
        channel_data = activity.get("channelData") or {}
        channel = channel_data.get("channel") or {}
        team = channel_data.get("team") or {}
        name = channel.get("name") or team.get("name")
        return str(name) if name else None

    async def _resolve_channel_name(
        self, activity: dict[str, Any], channel_id: str
    ) -> str | None:
        """The channel's name, asking Graph when the activity does not say.

        Without this the caller has nothing to name an auto-created room after
        and falls back to the channel id, so a room ends up titled
        `19:7641f9de326b4…` — in the room list, in the sidebar, and in every
        session opened against it. Graph knows the name; one read per channel,
        cached, is a cheap price for a room somebody can recognise.
        """
        name = self._channel_name(activity)
        if name:
            return name
        cached = self._channel_names.get(channel_id)
        if cached is not None:
            return cached or None
        if self._read_recently_failed(channel_id):
            return None
        await self._read_channel(channel_id)
        return self._channel_names.get(channel_id) or None

    async def _read_channel(self, channel_id: str) -> dict[str, Any] | None:
        """Read a channel from Graph once and cache what the adapter needs.

        Two things come off this call — the display name, without which a room
        is titled after a `19:…` id, and the conversation layout, which decides
        whether an untied reply is steered into a post. They are cached
        together because they arrive together: asking twice would double the
        traffic for nothing.

        Returns None when the read could not be made or failed. A failure is
        remembered so the read is not retried on every message, but only for
        `_CHANNEL_READ_RETRY_AFTER` — a Graph blip, or a permission granted
        minutes later, must not pin a channel to "nameless, posts layout" for
        the life of the process. That is the same shape as the bug that made
        capture die at a restart, and it is not worth repeating for a cheaper
        symptom.
        """
        if self._graph is None or not self._is_channel(channel_id):
            return None
        team_id = self._team_of_channel.get(channel_id) or self._config.team_id
        if not team_id:
            return None
        try:
            channel = await self._graph.get_channel(
                team_id=team_id, channel_id=channel_id
            )
        except Exception:
            logger.warning(
                "Could not read Teams channel %s; until this succeeds a room "
                "created for it is named after its id, and replies there are "
                "threaded as if it used the posts layout",
                channel_id,
                exc_info=True,
            )
            self._channel_read_failed_at[channel_id] = time.monotonic()
            return None
        self._channel_read_failed_at.pop(channel_id, None)
        self._channel_names[channel_id] = str(channel.get("displayName") or "")
        self._channel_layouts[channel_id] = str(channel.get("layoutType") or "")
        return channel

    def _read_recently_failed(self, channel_id: str) -> bool:
        failed_at = self._channel_read_failed_at.get(channel_id)
        if failed_at is None:
            return False
        if time.monotonic() - failed_at < _CHANNEL_READ_RETRY_AFTER:
            return True
        del self._channel_read_failed_at[channel_id]
        return False

    def _self_mention_token(self, activity: dict[str, Any]) -> str | None:
        recipient = activity.get("recipient") or {}
        bot_id = str(recipient.get("id", ""))
        for entity in activity.get("entities") or []:
            if entity.get("type") == "mention":
                mentioned = entity.get("mentioned") or {}
                if str(mentioned.get("id", "")) == bot_id:
                    return bot_id
        return None

    @staticmethod
    def _clean_text(text: str) -> str:
        """Rewrite Teams ``<at>…</at>`` mention markup to ``@<name>`` text."""
        return _render_mentions(text).strip()

    @staticmethod
    def _disclosed_attachment_note(descriptors: list[str]) -> str:
        """A visible note naming inbound attachments that were not relayed.

        Teams inbound file/image relay is not yet implemented; rather than drop
        media silently (which would violate the fail-loud rule and mislead the
        agent), we bridge the text and append this disclosure. Empty when there
        is nothing to disclose."""
        if not descriptors:
            return ""
        if len(descriptors) == 1:
            return f"\n\n_📎 an attachment was not relayed: {descriptors[0]}_"
        joined = ", ".join(descriptors)
        return f"\n\n_📎 {len(descriptors)} attachments were not relayed: {joined}_"

    @staticmethod
    def _activity_attachment_descriptors(activity: dict[str, Any]) -> list[str]:
        """Names of real file/image attachments on a Bot Framework activity.

        Excludes ``text/*`` attachments, which carry the message's own HTML/text
        body rather than a user-supplied file."""
        out: list[str] = []
        for att in activity.get("attachments") or []:
            content_type = str(att.get("contentType", ""))
            if content_type.startswith("text/"):
                continue
            name = str(att.get("name") or "").strip()
            out.append(name or content_type or "attachment")
        return out

    @staticmethod
    def _graph_attachment_descriptors(chat_message: dict[str, Any]) -> list[str]:
        """Names of attachments + inline hosted images on a Graph chat message."""
        out: list[str] = []
        for att in chat_message.get("attachments") or []:
            name = str(att.get("name") or "").strip()
            content_type = str(att.get("contentType", ""))
            out.append(name or content_type or "attachment")
        hosted = chat_message.get("hostedContents") or []
        if hosted:
            out.append(f"{len(hosted)} inline image(s)")
        return out

    # ── Graph capture (subscriptions + notifications) ────────────────────────

    @staticmethod
    def _expiration_iso() -> str:
        expiry = datetime.now(UTC) + _SUBSCRIPTION_TTL
        return expiry.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _channel_from_resource(resource: str) -> str:
        """Extract the channel id from a subscription's ``resource`` string
        (``teams/{team}/channels/{channel}/messages``)."""
        match = re.search(r"channels/([^/]+)/messages", resource)
        return match.group(1) if match else ""

    async def _ensure_channel_subscription(self, channel_id: str) -> None:
        """Create a Graph change-notification subscription for a channel's
        messages, so the bridge captures every post — not just @mentions.

        Requires the encryption certificate + private key (Graph encrypts the
        message body) and the channel's team id. A missing prerequisite is a
        loud log, not a crash: the bot still joins, capture is simply degraded.
        """
        if channel_id in self._subscriptions or self._graph is None:
            return
        self._capture_wanted.add(channel_id)
        if not (
            self._config.encryption_public_certificate
            and self._config.encryption_certificate_id
        ):
            self._note_capture_failure(
                channel_id,
                "encryption certificate not configured on the Teams bridge",
            )
            return
        team_id = self._team_of_channel.get(channel_id) or self._config.team_id
        if not team_id:
            self._note_capture_failure(channel_id, "team id unknown")
            return

        async with self._sub_lock:
            if channel_id in self._subscriptions:
                return
            try:
                cert_der = load_certificate_der_b64(
                    self._config.encryption_public_certificate
                )
                sub = await self._graph.create_subscription(
                    resource=f"teams/{team_id}/channels/{channel_id}/messages",
                    notification_url=self._notification_url,
                    lifecycle_notification_url=self._notification_url,
                    client_state=self._config.client_state,
                    expiration_iso=self._expiration_iso(),
                    encryption_certificate=cert_der,
                    encryption_certificate_id=self._config.encryption_certificate_id,
                )
            except Exception as exc:
                self._note_capture_failure(channel_id, f"{type(exc).__name__}: {exc}")
                return
            self._subscriptions[channel_id] = str(sub.get("id", ""))
            recovered = self._capture_failures.pop(channel_id, None) is not None
            logger.info(
                "%s Teams channel %s messages (subscription %s)",
                "Capture recovered for" if recovered else "Subscribed to",
                channel_id,
                self._subscriptions[channel_id],
            )

    def _note_capture_failure(self, channel_id: str, summary: str) -> None:
        """Record that a channel still has no capture, logging without repeating.

        ``_repair_loop`` retries for as long as the bridge runs, so a channel
        that can never be subscribed would otherwise write the same error
        forever. The first failure is logged in full; after that only a *change*
        in what Graph says is worth a line, and it is worth a lot — a 403
        turning into a 400 is a permission problem turning into an unreachable
        endpoint, which is the one thing a reader needs to know.
        """
        previous = self._capture_failures.get(channel_id)
        self._capture_failures[channel_id] = summary
        if previous is None:
            logger.error(
                "Failed to create Graph subscription for channel %s (%s); "
                "capture is degraded and will be retried",
                channel_id,
                summary,
            )
        elif previous != summary:
            logger.warning(
                "Graph subscription for channel %s is still failing, now with: %s",
                channel_id,
                summary,
            )
        else:
            logger.debug(
                "Graph subscription for channel %s still failing: %s",
                channel_id,
                summary,
            )

    async def _repair_loop(self) -> None:
        """Keep retrying channels that should be captured and are not.

        A subscription can fail for reasons that pass on their own, and the two
        that bite are both startup: Graph validates the notification URL by
        calling it, which a load balancer will refuse for the first minute or so
        after a new pod starts, and an app's Graph roles are fixed when its token
        is issued, so consent granted while the bridge is running is invisible
        until the token is replaced. Both used to leave capture dead until
        someone restarted the process — and a restart is what caused the first
        one, so it could just as easily fail again.

        Backs off while a channel keeps failing so a genuinely broken one does
        not hammer Graph, and returns to the short interval as soon as something
        succeeds.
        """
        delay = _REPAIR_MIN_INTERVAL_SECONDS
        while True:
            await asyncio.sleep(delay)
            missing = [c for c in self._capture_wanted if c not in self._subscriptions]
            if not missing:
                delay = _REPAIR_MIN_INTERVAL_SECONDS
                continue
            for channel_id in missing:
                await self._ensure_channel_subscription(channel_id)
            if any(c not in self._subscriptions for c in missing):
                delay = min(delay * 2, _REPAIR_MAX_INTERVAL_SECONDS)
            else:
                delay = _REPAIR_MIN_INTERVAL_SECONDS

    async def _handle_http_notifications(self, request: web.Request) -> web.Response:
        # Subscription-creation handshake: Graph calls the endpoint with a
        # ``validationToken`` that must be echoed back verbatim as text/plain.
        validation_token = request.query.get("validationToken")
        if validation_token is not None:
            return web.Response(
                status=200, text=validation_token, content_type="text/plain"
            )

        try:
            payload = await request.json()
        except Exception:
            return web.Response(status=400, text="invalid json")

        for item in payload.get("value", []):
            try:
                await self._dispatch_graph_notification(item)
            except Exception:
                logger.exception("Failed to handle Graph change notification")

        return web.Response(status=202)

    async def _dispatch_graph_notification(self, item: dict[str, Any]) -> None:
        # Authenticate origin BEFORE acting on anything — data notifications and
        # lifecycle events alike. clientState is the only origin control (the
        # encryption proves integrity, not origin), so an unverified lifecycle
        # event (e.g. a forged reauthorizationRequired) must not be honoured.
        # Compared in constant time: this is an authentication check, and a
        # `!=` on a secret leaks its prefix through timing. 256 bits makes that
        # impractical to exploit rather than impossible to attempt, and the
        # cheap version is the same one line.
        if not hmac.compare_digest(
            str(item.get("clientState") or ""), self._config.client_state
        ):
            logger.warning("Rejected Graph notification: clientState mismatch")
            return

        if item.get("lifecycleEvent"):
            await self._handle_lifecycle_event(item)
            return

        encrypted = item.get("encryptedContent")
        if not encrypted:
            return
        if not self._config.encryption_private_key:
            logger.error(
                "Received encrypted Graph notification but no private key is "
                "configured to decrypt it"
            )
            return

        chat_message = decrypt_resource_data(
            encrypted, self._config.encryption_private_key
        )
        await self._deliver_graph_message(chat_message)

    async def _handle_lifecycle_event(self, item: dict[str, Any]) -> None:
        event = item.get("lifecycleEvent")
        subscription_id = str(item.get("subscriptionId", ""))
        if event == "reauthorizationRequired" and self._graph is not None:
            try:
                await self._graph.renew_subscription(
                    subscription_id=subscription_id,
                    expiration_iso=self._expiration_iso(),
                )
                logger.info("Renewed Teams subscription %s", subscription_id)
            except Exception:
                logger.exception(
                    "Failed to renew Teams subscription %s", subscription_id
                )
        elif event == "subscriptionRemoved":
            # Graph dropped the subscription (e.g. a transient permission/quota
            # issue). Recreate it rather than only logging — otherwise channel
            # capture silently lapses until the next full restart.
            await self._recreate_removed_subscription(subscription_id)
        else:
            logger.info(
                "Teams subscription %s lifecycle event: %s",
                subscription_id,
                event,
            )

    async def _recreate_removed_subscription(self, subscription_id: str) -> None:
        channel_id = next(
            (c for c, s in self._subscriptions.items() if s == subscription_id),
            None,
        )
        if channel_id is None:
            logger.info(
                "Teams subscriptionRemoved for unknown subscription %s; ignoring",
                subscription_id,
            )
            return
        logger.warning(
            "Teams subscription %s for channel %s was removed; recreating",
            subscription_id,
            channel_id,
        )
        # Drop the dead mapping so _ensure_channel_subscription rebuilds it.
        self._subscriptions.pop(channel_id, None)
        await self._ensure_channel_subscription(channel_id)

    async def _deliver_graph_message(self, chat_message: dict[str, Any]) -> None:
        if chat_message.get("messageType", "message") != "message":
            return

        message_id = str(chat_message.get("id", ""))
        if self._seen_activity(message_id):
            return

        sender = chat_message.get("from") or {}
        application = sender.get("application") or {}
        if application:
            # Drop our own bot's posts (they are captured too) to avoid a loop.
            if str(application.get("id", "")) == self._config.app_id:
                return
            sender_id = str(application.get("id", ""))
            sender_name = str(application.get("displayName") or sender_id)
        else:
            user = sender.get("user") or {}
            sender_id = str(user.get("id", ""))
            sender_name = await self._sender_handle(
                sender_id, str(user.get("displayName") or "")
            )

        identity = chat_message.get("channelIdentity") or {}
        channel_id = str(identity.get("channelId", ""))
        if not channel_id:
            return

        body = chat_message.get("body") or {}
        raw_content = str(body.get("content", ""))
        is_html = str(body.get("contentType", "")).lower() == "html"
        content = self._graph_text(raw_content) if is_html else raw_content
        content += self._disclosed_attachment_note(
            self._graph_attachment_descriptors(chat_message)
        )

        self_mention_token = self._graph_self_mention_token(chat_message)
        if self_mention_token is not None:
            stripped = _strip_leading_mention(raw_content)
            command_text = self._graph_text(stripped) if is_html else stripped
        else:
            command_text = content

        reply_to = chat_message.get("replyToId")
        root_id = str(reply_to) if reply_to and str(reply_to) != message_id else None

        await self._deliver(
            channel_id=channel_id,
            channel_type=self._channel_type.get(channel_id, "channel_public"),
            sender_id=sender_id,
            sender_name=sender_name,
            text=content,
            message_ref=message_id,
            root_id=root_id,
            channel_name=None,
            self_mention_token=self_mention_token,
            command_text=command_text,
        )

    def _graph_self_mention_token(self, chat_message: dict[str, Any]) -> str | None:
        """Return a truthy token when a Graph channel message @mentions our bot.

        Graph carries mentions in ``chat_message["mentions"]``; a bot mention is
        one whose ``mentioned.application.id`` matches our app id. Mirrors the
        Bot Framework path's ``_self_mention_token`` so both capture paths flag a
        bot mention identically."""
        for mention in chat_message.get("mentions") or []:
            mentioned = mention.get("mentioned") or {}
            application = mentioned.get("application") or {}
            if str(application.get("id", "")) == self._config.app_id:
                return self._config.app_id
        return None

    @staticmethod
    def _graph_text(content: str) -> str:
        """Flatten a Graph channel message's HTML body to plain text."""
        text = _BR_TAG.sub("\n", content)
        text = _render_mentions(text)
        text = _HTML_TAG.sub("", text)
        return html.unescape(text).strip()

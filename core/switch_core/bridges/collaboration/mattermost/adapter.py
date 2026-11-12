from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import threading
import uuid
import weakref
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, ClassVar
from urllib.parse import SplitResult, urlsplit

import requests as sync_requests
from mattermostdriver import Driver
from mattermostdriver.exceptions import (
    ContentTooLarge,
    FeatureDisabled,
    InvalidOrMissingParameters,
    MethodNotAllowed,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
)
from pydantic import field_validator
from websockets.asyncio.client import ClientConnection

from switch_core.agent_display_name import ZERO_WIDTH_SPACE
from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivitySnapshot,
    AgentIdentity,
    AgentIdentityConflict,
    CardRejectedError,
    MessagePartlySent,
    PlatformAdapter,
    RefusalKind,
    RemovalFailed,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.chunking import split_markdown
from switch_core.bridges.collaboration.ingress import (
    CallbackEndpoint,
    CallbackRefused,
)
from switch_core.bridges.collaboration.mattermost.callback import (
    MAX_BUTTON_LABEL,
    ActivityPress,
    CardPress,
    InterruptPress,
    activity_action,
    answer_actions,
    card_action,
    interrupt_action,
    read_press,
)
from switch_core.bridges.collaboration.mattermost.http_client import NoRedirectClient
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelNotUsable,
    ChannelType,
    CreatedChannel,
    DirectoryUser,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
    PrivateNoticeDelivery,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_QUEUED_NOTE,
    Drawn,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    ACTIVITY_AUDIENCE_UNKNOWN,
    ACTIVITY_FAILED,
    ACTIVITY_GONE,
    ACTIVITY_NOT_A_MEMBER,
    activity_log,
    render_request,
    turn_status,
)
from switch_core.outbound import guarded_async_client
from switch_core.sessions.contract import TURN_ENDED
from switch_core.ui_spec import (
    ActionsProps,
    ButtonProps,
    CardProps,
    ChartProps,
    DividerProps,
    FieldProps,
    FieldsProps,
    ImageProps,
    LinkButtonProps,
    PieChart,
    TableProps,
    TextProps,
    UISpec,
    button_action,
    to_text,
)

logger = logging.getLogger(__name__)

# Ceiling on a bot icon Switch downloads before re-uploading it to Mattermost.
# Generously above any real avatar; it exists so a hostile or broken URL cannot
# stream unbounded data into memory.
_MAX_BOT_ICON_BYTES = 5 * 1024 * 1024

# Every request to Mattermost gives up after this long. The driver's default is
# to wait for ever, so a server that accepts the connection and never answers
# would hold the call, and anything waiting on it, indefinitely.
_MM_REQUEST_TIMEOUT_SECONDS = 10.0
# How long a bot socket's closing handshake may take before the connection is
# dropped: it runs on the socket's own thread, between one connection and the
# next.
_MM_SOCKET_CLOSE_TIMEOUT_SECONDS = 2.0

# How long a directory search made while the adapter is still connecting waits
# for it. A bridge is searched as soon as it is registered (the gateway's
# directory dialog, the setup scripts), and connecting is a log-in and two
# reads, so it is normally under a second.
_CONNECT_WAIT_SECONDS = 15.0

# Mattermost channel types a bot can be *added* to: open and private channels.
# Membership of a DM ("D") or group DM ("G") is a property of the conversation
# existing rather than of anyone joining, so Mattermost raises no `user_added`
# for them and they must not be adopted from a membership sweep either — a DM
# becomes a room when someone actually writes in it.
_JOINABLE_MM_CHANNEL_TYPES = frozenset({"O", "P"})

# Emoji marking the message an agent is currently working on.
_REACTION: dict[ActivityMark, str] = {
    "working": "eyes",
    "queued": "hourglass_flowing_sand",
}

# The post property carrying a publication's recovery marker. Props are part of
# the post but not part of what anyone reads, which is exactly what this needs
# to be: a marker in the message body would be visible clutter, and a marker
# held only on this side is lost the moment a post's response is — which is the
# one case it exists for. `patch_post` leaves props it is not given alone, so
# editing the status in place cannot drop it.
_PUBLICATION_PROP = "switch_publication"

# Where a post's buttons live. Mattermost carries interactive actions inside a
# message attachment in the post's props, and keeps each action's `integration`
# — the callback URL and its context — server-side, never serialising it to a
# client.
_ATTACHMENTS_PROP = "attachments"

# Mattermost's `PostPropsMaxUserRunes`: the JSON of a post's props, in runes,
# less the room the server keeps for its own additions.
_MAX_PROPS = 760_000

# What Mattermost answers a post it did not create with: each a 4xx, so the
# post was not made and its text may be sent instead.
_MATTERMOST_REFUSALS = (
    InvalidOrMissingParameters,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
    MethodNotAllowed,
    ContentTooLarge,
)

# How far an attachment has got, in the order Mattermost draws its parts. A
# part that would draw above one already there goes in a new attachment.
_TITLE, _TEXT, _FIELDS, _IMAGE, _ACTIONS, _CLOSED = range(6)
_TABLE_ALIGN = {"left": ":---", "center": ":---:", "right": "---:"}

# How far before the recorded reservation time to start looking for a post that
# may or may not exist. Covers ordinary clock skew between Switch and the
# Mattermost server without widening the search into unrelated history.
_RECOVERY_SKEW_MS = 60_000

# Mattermost's own default `MaxPostSize`. Servers can raise it to 16383, and a
# message cut to fit the default is a message that fits everywhere. It is also
# what a message is split at when the server will not say its own limit.
_MAX_POST = 4000

# Ends an edited post whose text did not fit and whose remainder could not be
# posted after it.
_EDIT_CUT_SHORT = (
    "_(Cut short: the rest of this edit is longer than Mattermost accepts in "
    "one post and could not be posted after it.)_"
)

# How many reply-to-thread-root resolutions one bridge remembers. Forgetting one
# costs a refused post and a lookup the next time that reply is threaded under.
_MAX_THREAD_ROOTS = 1024

# The values of `TeamSettings.TeammateNameDisplay` under which Mattermost puts
# a bot's display name in the post header. Under any other value — including
# the server default, "username" — the display name is stored and never shown.
_NAME_DISPLAY_SHOWS_LABEL = frozenset({"full_name", "nickname_full_name"})

# The errors that mean Mattermost read the request and refused it. `mattermostdriver`
# maps these statuses to named exceptions; every one of them says the post does
# not exist and sending it again unchanged would be refused again.
#
# Everything else — a timeout, a dropped connection, a 5xx — leaves it unknown
# whether the post is on the server with only its response lost, and that is a
# different answer entirely: see `_as_rich_failure`.
_DEFINITE_REFUSALS = (
    InvalidOrMissingParameters,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
    MethodNotAllowed,
    ContentTooLarge,
    FeatureDisabled,
)

# Refusals that sending the same post again will not change.
_REFUSED_FOR_GOOD = (MethodNotAllowed, ContentTooLarge)

# Refusals that are usually final but can clear on their own: a 400 for a file
# id not ready yet, a 403 for a bot not yet added to the channel, a 404 for a
# post or channel not visible yet. A 401 is neither: a bot's session can be
# signed in again, so it is left to retry with the server errors.
_REFUSED_FOR_NOW = (InvalidOrMissingParameters, NotEnoughPermissions, ResourceNotFound)
_STATUS_REFUSED_FOR_GOOD = frozenset({405, 413})
_STATUS_TRANSIENT = frozenset({401, 408, 429})

# How long to wait after a rate limit that names no interval of its own.
# Matches the Slack adapter's fallback, for the same reason: long enough not to
# walk straight back into the limit, short enough that a live turn still moves.
_THROTTLE_FALLBACK_SECONDS = 30.0


def _throttle_delay(error: Exception) -> float | None:
    """Seconds Mattermost asked us to wait, or None if it did not ask.

    `mattermostdriver` has no exception for 429, so the underlying
    `requests.HTTPError` arrives with its response still attached — which is
    what carries the interval.
    """
    response = getattr(error, "response", None)
    if response is None or getattr(response, "status_code", None) != 429:
        return None
    headers = getattr(response, "headers", None) or {}
    try:
        return max(0.0, float(headers.get("Retry-After", "")))
    except (TypeError, ValueError):
        return _THROTTLE_FALLBACK_SECONDS


def _as_rich_failure(
    error: Exception, *, description: str, text: str
) -> RichContentFailed | None:
    """What a publication should make of a Mattermost error, or nothing.

    `None` means the outcome is unknown and the caller must let the error
    propagate: a post whose response was lost may be sitting in the channel,
    and `RichContentFailed` would have the caller drop its reservation and
    post a second copy of something a reader is meant to see once. The
    reservation survives instead, and `find_request_card` settles it.

    Only a server that understood the request and refused it becomes
    `RichContentFailed`, and only one asking us to slow down becomes
    `RichContentThrottled`.
    """
    retry_after = _throttle_delay(error)
    if retry_after is not None:
        return RichContentThrottled(retry_after=retry_after, text=text)
    if isinstance(error, _DEFINITE_REFUSALS):
        return RichContentFailed(f"{description}: {error}", text=text)
    return None


@dataclass(frozen=True)
class _Rendered:
    """A card drawn for Mattermost, and the same card drawn for anywhere else.

    `text` and `actions` go together on the post: where buttons carry the
    options the body stops listing them, so neither half is complete alone.
    `plain` is the drawing that needs no buttons, and it is what a failure is
    reported with — a payload the caller forwards as an ordinary message,
    which would otherwise ask for a choice it had stopped printing.
    """

    text: str
    actions: list[dict[str, Any]]
    plain: str


def _server_url(value: str) -> SplitResult:
    """`url` as the driver reads it (`_create_driver`): no scheme means http."""
    value = value.strip()
    return urlsplit(value if "://" in value else f"http://{value}")


# The port `_create_driver` connects to when the URL names none — not 80 for
# http, but Mattermost's own.
_DRIVER_DEFAULT_PORTS = {"http": 8065, "https": 443}


class MattermostConnectionConfig(BridgeConnectionConfig):
    url: str
    admin_user: str
    admin_password: str
    team_name: str
    # User-facing base URL of the Mattermost server, when it differs from `url`
    # (which is the internal URL Switch connects to — e.g. a private/tailnet
    # address). Used for the channel deeplink so the link works in the user's
    # desktop client. Falls back to `url` when unset.
    public_url: str | None = None
    # Human account to add to every channel this bridge creates. A bundled
    # Mattermost has exactly one human, and a room created by an agent names no
    # users — without this they would never be a member of a private channel and
    # could not read the room at all. Unset for bridges where membership is
    # managed on the platform.
    default_member: str | None = None
    # Verify the Mattermost server's TLS certificate. Defaults to True so admin
    # credentials and bot tokens are never sent over an unverified https
    # connection. Set False only for a self-signed internal CA you trust.
    verify_tls: bool = True
    # Base URL (scheme + host, no path) the *Mattermost server* reaches
    # Switch's callback listener on, for the button presses Mattermost delivers
    # by HTTP. Not `url` reversed and not `gateway_public_url`: this is a
    # separate port from the agent API, and the route between the two servers
    # is frequently nothing like the route a browser takes — a container alias
    # on a shared network, or an ingress hostname that only exists inside the
    # cluster. Unset means Switch has no address to give Mattermost, so cards
    # carry no buttons and stay answerable by typing.
    callback_base_url: str | None = None

    @field_validator("url")
    @classmethod
    def _url_names_a_server(cls, value: str) -> str:
        """`url` is what the bridge's claim on a team is worked out from, so
        it is checked here rather than failing deep inside that."""
        parts = _server_url(value)
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            raise ValueError("url must be an http(s) URL naming the server")
        try:
            parts.port
        except ValueError as exc:
            raise ValueError(f"url has an invalid port: {exc}") from exc
        return value


# A refusal being collected for the person who pressed, if a press is what we
# are in the middle of. Mattermost has one chance to say something privately —
# the `ephemeral_text` on the response to the callback — so a notice raised
# while the answer is being judged has to be caught here and carried back out
# rather than posted where the channel would read it.
_PRESS_NOTICE: ContextVar[list[str] | None] = ContextVar(
    "switch_mattermost_press_notice", default=None
)


def _defuse_at(text: str) -> str:
    """Card text that mentions nobody: Mattermost resolves `@user` and
    `@channel` in attachment text, fields and pretext as in a message."""
    return text.replace("@", "@" + ZERO_WIDTH_SPACE)


def _md_url(url: str) -> str:
    return url.replace(" ", "%20").replace("(", "%28").replace(")", "%29")


def _md_table(rows: list[list[str]], align: Sequence[str] | None) -> str:
    head, *body = rows
    rule = [_TABLE_ALIGN[a] for a in align] if align else ["---"] * len(head)
    return "\n".join("| " + " | ".join(row) + " |" for row in [head, rule, *body])


def _ephemeral(text: str) -> dict[str, Any]:
    """A callback reply Mattermost shows to the presser and to nobody else.

    `skip_slack_parsing` because what is in here is already Mattermost
    markdown, written by the neutral renderer. Without it the server runs the
    text through its Slack-to-Mattermost conversion first, which is a second
    pass of markup rules over something that has already been marked up — and
    the one case where that is visibly wrong is a log line whose emphasis comes
    back doubled.
    """
    return {"ephemeral_text": text, "skip_slack_parsing": True}


class _BotSocketConnection(ClientConnection):
    """A bot socket's `websockets` connection, remembered so `_close_loop` can
    close it: mattermostdriver holds it in a local variable and leaves it open
    when its loop stops, so its transport and file descriptor would otherwise
    last until the garbage collector found them."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        _BOT_SOCKET_CONNECTIONS.add(self)


_BOT_SOCKET_CONNECTIONS: weakref.WeakSet[_BotSocketConnection] = weakref.WeakSet()


def _close_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Close the connections opened on `loop`, cancel what is still running on
    it, then close it.

    A socket's `websockets` connection runs a keepalive task beside it that
    outlives the socket's own coroutine. A loop dropped with that task still
    pending is reported as "Task was destroyed but it is pending!" whenever it
    is collected, at ERROR, in the middle of whatever the server is doing.
    """
    connections = [c for c in list(_BOT_SOCKET_CONNECTIONS) if c.loop is loop]
    if connections:
        loop.run_until_complete(
            asyncio.gather(*(c.close() for c in connections), return_exceptions=True)
        )
    pending = asyncio.all_tasks(loop)
    for task in pending:
        task.cancel()
    if pending:
        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
    loop.run_until_complete(loop.shutdown_asyncgens())
    loop.close()
    asyncio.set_event_loop(None)


# The id a webhook's posts are filed under: the integration, never the person
# who created it, whose user id Mattermost puts on the post. See `_ws_handler`.
_WEBHOOK_STAND_IN_PREFIX = "webhook:"


class MattermostAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Mattermost"
    channel_on_delete = "archived"
    docs_slug: ClassVar[str | None] = "mattermost"
    # A quiet Mattermost bridge opens no websocket and mints no bot token: it
    # knows each agent's bot by id, for mentions, and calls the API as the
    # admin. Mattermost sends every event to every open socket, so a socket
    # in each process would hand each process every post.
    keeps_quiet_unless_listening: ClassVar[bool] = True

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Sign in as the admin user and find the team, as `start` will.

        `url` has been through the outbound policy before this is called, so
        the credentials are only sent where Switch may connect.
        """
        config = MattermostConnectionConfig.model_validate(connection_config)
        driver = cls(config=config)._create_driver(
            login_id=config.admin_user, password=config.admin_password
        )
        try:
            await asyncio.to_thread(driver.login)
        except NoAccessTokenProvided as exc:
            raise BridgeCredentialError(
                f"Mattermost refused the sign-in for {config.admin_user}: {exc}. "
                "Check admin_user and admin_password."
            ) from exc
        except sync_requests.RequestException as exc:
            raise BridgeCredentialError(
                f"Could not sign in to Mattermost at {config.url} to check the "
                f"credentials: {exc}"
            ) from exc
        try:
            await asyncio.to_thread(driver.teams.get_team_by_name, config.team_name)
        except (ResourceNotFound, NotEnoughPermissions) as exc:
            raise BridgeCredentialError(
                f"{config.admin_user} signed in, but Mattermost has no team "
                f"named {config.team_name!r} it can see: {exc}"
            ) from exc
        except sync_requests.RequestException as exc:
            raise BridgeCredentialError(
                f"Could not look up the Mattermost team {config.team_name!r}: {exc}"
            ) from exc
        finally:
            try:
                await asyncio.to_thread(driver.logout)
            except sync_requests.RequestException:
                logger.warning(
                    "Could not sign out the Mattermost session opened to check "
                    "%s's credentials; it lasts until the server expires it",
                    config.admin_user,
                    exc_info=True,
                )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        """`mattermostdriver` raises its named exceptions only for the status
        codes it maps; anything else — including a bare connection failure —
        surfaces as the underlying `requests` exception, since that is the
        client it wraps. Its named exceptions are `HTTPError`s, so the 401 and
        403 it maps are checked before the `HTTPError` that covers the rest.
        """
        if isinstance(exc, NoAccessTokenProvided | NotEnoughPermissions):
            return "auth_failed"
        if isinstance(
            exc,
            sync_requests.exceptions.ConnectionError | sync_requests.exceptions.Timeout,
        ):
            return "network"
        # `InvalidJSONError` is a `ValueError`, which the shared classifier
        # reads as a config somebody typed wrong. A Mattermost server answering
        # with a proxy's error page is the platform misbehaving.
        if isinstance(
            exc,
            sync_requests.exceptions.HTTPError
            | sync_requests.exceptions.InvalidJSONError,
        ):
            return "platform_error"
        return None

    @classmethod
    def classify_refusal(cls, exc: BaseException) -> RefusalKind:
        """Read the driver's error out of the chain: `RichContentFailed`
        carries it as its cause.

        "permanent" for a 405 or 413, "bounded" for any other 4xx but 401, 408
        and 429, "transient" for everything else. `mattermostdriver` raises its
        named exceptions without the response, so for those the status is read
        from the class; a status it does not name arrives as the `requests`
        error with the response still on it.

        A transient failure anywhere in the chain wins: a refused thread root
        whose post could not be looked up for the network is worth sending
        again once the lookup can get through.
        """
        if isinstance(exc, RichContentThrottled):
            return "transient"
        kind: RefusalKind = "transient"
        seen: BaseException | None = exc
        while seen is not None:
            if isinstance(
                seen,
                sync_requests.exceptions.ConnectionError
                | sync_requests.exceptions.Timeout,
            ):
                return "transient"
            if isinstance(seen, _REFUSED_FOR_GOOD):
                kind = "permanent"
            elif isinstance(seen, _REFUSED_FOR_NOW):
                if kind != "permanent":
                    kind = "bounded"
            elif isinstance(seen, sync_requests.exceptions.HTTPError):
                status = getattr(seen.response, "status_code", None)
                if isinstance(status, int):
                    if status in _STATUS_REFUSED_FOR_GOOD:
                        kind = "permanent"
                    elif 400 <= status < 500 and status not in _STATUS_TRANSIENT:
                        if kind != "permanent":
                            kind = "bounded"
                    else:
                        return "transient"
            seen = seen.__cause__
        return kind

    draws_session_activity: ClassVar[bool] = True

    #: A problem somebody has to act on still gets its own reply, so it
    #: notifies rather than arriving as a silent edit to a status the reader
    #: has already scrolled past. One per turn, cleared when it clears.
    separate_attention_slot: ClassVar[bool] = True

    #: A Mattermost thread notifies only the people named in it, so the agent's
    #: owner leads — they are who can open Console and act — and an attention
    #: post with nobody to name says as much. This is the legacy ping's policy,
    #: carried over: it is the one that reaches the person who can do something.
    notifies_only_by_mention: ClassVar[bool] = True
    channel_mention: ClassVar[str | None] = "@channel"
    #: `POST /posts/ephemeral`, made as the admin the bridge connects as: the
    #: endpoint needs `create_post_ephemeral`, which a system admin holds.
    private_notice_delivery: ClassVar[PrivateNoticeDelivery] = "ephemeral"

    #: The status is the turn's one post, not a line beside it, so the clock
    #: advancing is not on its own worth rewriting what a reader is reading.
    #: Elapsed time goes out with the next real change and with the ending.
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True

    #: Each agent posts and reacts as its own bot here, so two agents working
    #: on one message leave two independent 👀 and each is claimed and removed
    #: on its own.
    activity_reactions_per_agent: ClassVar[bool] = True

    #: `find_request_card` reads the channel's recent posts back, so a card
    #: whose send was never acknowledged can be bound to what is actually
    #: there instead of being disclosed as lost.
    recovers_uncertain_posts: ClassVar[bool] = True

    #: Every publication carries its token in a post prop, which is exact and
    #: invisible, so a status is as findable as a card despite printing no
    #: handle of its own.
    carries_publication_marker: ClassVar[bool] = True

    #: An answered card is edited down to its outcome rather than taken back.
    #: The bridge could delete it — it connects as a system admin, so it may
    #: remove any post in the team — but Mattermost is alone in leaving a
    #: "(message deleted)" placeholder behind one removed while a client has
    #: the channel open. A settled card reads better than that tombstone and
    #: keeps the channel a record of what was asked and what was decided.
    removes_answered_cards: ClassVar[bool] = False

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """The team on its server, compared in canonical form so a trailing
        slash, letter case, a missing scheme or an explicit default port does
        not make the same team look like a different one. Defaults are the
        driver's, so `http://mm` and `mm:8065` are one server and `mm:80`
        another."""
        url = _server_url(str(connection_config["url"]))
        scheme = url.scheme.lower()
        port = url.port
        default_port = _DRIVER_DEFAULT_PORTS.get(scheme)
        host = (url.hostname or "").lower()
        if port is not None and port != default_port:
            host = f"{host}:{port}"
        path = url.path.rstrip("/")
        team = str(connection_config["team_name"]).lower()
        return f"Mattermost team {team} on {scheme}://{host}{path}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        # The driver connects without our pinning, so this check at
        # registration, edit and start is the guard for the server URL.
        return [_server_url(str(connection_config["url"])).geturl()]

    def __init__(self, *, config: MattermostConnectionConfig) -> None:
        super().__init__()
        self._config = config

        self._admin_driver: Driver | None = None
        self._team_id: str = ""
        # Set once the admin driver has logged in and the team is known: what
        # a directory search needs. The lifecycle starts the adapter in the
        # background, so a search can arrive before then.
        self._connected = asyncio.Event()
        self._admin_user_id: str = ""

        self._agent_bots: dict[str, dict[str, str]] = {}
        self._bot_drivers: dict[str, Driver] = {}
        # Set to close an agent bot's socket for good: when the adapter stops,
        # or the agent's identity is removed. Each socket runs in a thread of
        # its own that reconnects whenever the connection drops, so without
        # this a stopped bridge's sockets stayed open for the life of the
        # process, handing it every post. A bridge handed from one process to
        # another stops here and starts there.
        self._ws_stops: dict[str, threading.Event] = {}
        self._identity_locks: dict[str, asyncio.Lock] = {}
        self._bot_id_to_username: dict[str, str] = {}
        self._bridge_bot_ids: set[str] = set()

        # Dedicated bot that posts admin/system messages (distinct from the
        # admin *user* and from per-agent bots). It can't join a 1:1 DM, so in
        # DM channels admin_message falls back to the agent's own bot.
        self._admin_bot_driver: Driver | None = None
        self._admin_bot_id: str | None = None

        self._seen_post_ids: OrderedDict[str, None] = OrderedDict()
        self._seen_post_ids_max = 1000
        self._seen_lock = threading.Lock()

        # (agent_name, post_id) currently carrying the working reaction. A
        # reaction belongs to the bot that added it, so two agents on the same
        # post are two independent marks.
        self._marked: set[tuple[str, str, ActivityMark]] = set()

        # Mattermost user id -> username, because a mention is written with the
        # handle and Switch stores the id. Stable for the life of a user, so a
        # hit here saves a round trip on every redraw that carries a mention.
        self._usernames: OrderedDict[str, str] = OrderedDict()
        self._usernames_max = 1000

        # post id -> the buttons last written onto it. A status post is redrawn
        # on every tool call and its buttons change at most twice in a turn, so
        # a redraw compares against this and leaves the props alone when there
        # is nothing to say — patching them means reading the post back first,
        # which is a round trip this bridge's hottest path cannot afford. A
        # post missing from here is treated as changed, so a restart costs one
        # read per post rather than leaving a dead control on it.
        self._post_actions: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
        self._post_actions_max = 1000

        self._main_loop: asyncio.AbstractEventLoop | None = None

        # channel id -> channel name (URL slug), for building channel deeplinks.
        self._channel_name_cache: dict[str, str] = {}

        # The server's `TeamSettings.TeammateNameDisplay`, read once per run:
        # it decides whether a bot's display name is rendered anywhere, and
        # under the default ("username") it never is. None once a read has been
        # attempted and could not answer.
        self._name_display_setting: str | None = None
        self._name_display_read = False
        self._name_display_warned = False

        # The server's `MaxPostSize`, read the first time a message is long
        # enough for it to matter. Mattermost refuses a longer post outright.
        self._max_post_size: int | None = None

        # A reply's id -> the id of the thread it is in. Mattermost threads a
        # post only under a thread's root, and Switch is sometimes handed a
        # reply to thread under. Only lookups that found a root are kept.
        self._thread_roots: OrderedDict[str, str] = OrderedDict()

        # This bridge's place on the shared callback listener, installed by the
        # lifecycle service before start. None when the adapter is running
        # without one behind it, which is how most of the tests build it.
        self._callback: CallbackEndpoint | None = None

    def set_callback_endpoint(self, endpoint: CallbackEndpoint) -> None:
        self._callback = endpoint

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
        # Mattermost mints a per-agent bot, so agent joins are detected directly
        # in _handle_user_added; the app-join hook is unused here.
        self._on_app_joined = on_app_joined
        self._main_loop = asyncio.get_event_loop()

        admin_driver = self._create_driver(
            login_id=self._config.admin_user,
            password=self._config.admin_password,
        )
        await self._main_loop.run_in_executor(None, admin_driver.login)
        self._admin_driver = admin_driver

        me = await self._main_loop.run_in_executor(
            None, self._admin_driver.users.get_user, "me"
        )
        self._admin_user_id = me["id"]

        team = await self._main_loop.run_in_executor(
            None, self._admin_driver.teams.get_team_by_name, self._config.team_name
        )
        self._team_id = team["id"]
        self._connected.set()

        await self._ensure_admin_bot()

        await self._start_callbacks()

        logger.info(
            "Mattermost adapter connected to %s as %s",
            self._config.url,
            self._config.admin_user,
        )

    async def stop(self) -> None:
        self._connected.clear()
        for agent_name in list(self._ws_stops):
            self._close_bot_socket(agent_name)
        self._admin_driver = None
        self._bot_drivers.clear()
        logger.info("Mattermost adapter stopped")

    def _close_bot_socket(self, agent_name: str) -> None:
        """Close an agent bot's socket and keep its thread from reconnecting.
        The thread finishes once the driver notices, within its read timeout,
        and hands nothing over meanwhile."""
        stopped = self._ws_stops.pop(agent_name, None)
        if stopped is not None:
            stopped.set()
        driver = self._bot_drivers.get(agent_name)
        if driver is not None and getattr(driver, "websocket", None) is not None:
            driver.disconnect()

    # ── Callbacks ────────────────────────────────────────────────────────────

    @property
    def callback_url(self) -> str | None:
        """Where this bridge's presses should be delivered, or None if nowhere.

        None when either half is missing: an operator who has not said how the
        Mattermost server reaches Switch, or an adapter running without a
        listener behind it. A caller building a button asks this first — there
        is no button to draw without an address on it.
        """
        base = self._config.callback_base_url
        if not base or self._callback is None:
            return None
        return f"{base.rstrip('/')}{self._callback.path}"

    async def _start_callbacks(self) -> None:
        """Take presses for this bridge, or say once why there will be none.

        A request card is answerable by typing whether or not it carries a
        button, so no callback address is a reduced service rather than a
        failure to start. It is said out loud because it is otherwise
        invisible: cards keep arriving and simply never have anything to press.
        """
        if self._callback is None:
            return
        url = self.callback_url
        if url is None:
            logger.warning(
                "Mattermost cards on %s will carry no buttons: this bridge has "
                "no callback_base_url, so there is no address to give the "
                "Mattermost server for a press. Requests stay answerable by "
                "typing.",
                self._config.url,
            )
            return
        await self._callback.serve(self._handle_callback)
        logger.info(
            "Mattermost presses for %s will be taken at %s", self._config.url, url
        )

    async def _handle_callback(self, body: dict[str, Any]) -> dict[str, Any]:
        """Someone pressed a button on a card this bridge posted.

        Who pressed comes from the body, which the Mattermost server fills in
        and the button cannot. What the button carried is the card and the
        option, signed with this bridge's key so that a body assembled by
        anything but Mattermost — the route is reachable by whoever can reach
        the port — does not read as a press at all.

        Which card comes from the signed token rather than from the post the
        press arrived on, and is resolved against the stored record. That is
        what makes a press work after a restart: nothing about the card is held
        in memory between posting it and answering it.

        Nothing here dedupes. The same press twice is the same option, by the
        same person, against the same revision, which the shared layer derives
        one command id from — so the second is the first rather than a second
        answer.

        The reply is the one chance to say something to the presser alone:
        Mattermost shows `ephemeral_text` to them and nobody else. A refusal
        raised while the answer is being judged reaches `tell_actor`, which
        leaves it here rather than posting it where the channel would read it.

        Three kinds of button arrive here. An answer to a request card and a
        press on a turn's stop control both go inwards as interactions and are
        judged by the shared layer; a request to see a turn's tool calls is a
        read, answered in the reply itself and going no further than the person
        who asked.

        The stop control's action id is rebuilt on the way in rather than read
        off the wire. Mattermost allows letters and digits in an id, and the id
        the shared layer routes on is neither — so what identifies the press is
        the shape of the context it carried, which is signed.
        """
        if self._callback is None:
            raise CallbackRefused("This bridge takes no callbacks.", status=404)
        press = read_press(self._callback.verification_keys, body)
        if press is None:
            raise CallbackRefused("Not a press this bridge will act on.", status=401)
        if isinstance(press, ActivityPress):
            return await self._show_activity(press)
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card in Mattermost channel %s has nowhere "
                "to go: this bridge handles no interactions, so the card should "
                "not have been drawn with buttons.",
                press.channel_id,
            )
            raise CallbackRefused("This bridge handles no presses.", status=404)

        name = await self._username_for(press.user_id)
        if name is None:
            # Refused rather than attributed to the raw id: the id is what the
            # answer is judged against, but the name is what a human actor is
            # created under, and inventing one from an id makes a person who
            # cannot be looked up into a permanent participant named after a
            # lookup failure.
            logger.error(
                "A press in Mattermost channel %s is from a user this bridge "
                "cannot resolve to a handle, so it is not acted on.",
                press.channel_id,
            )
            raise CallbackRefused("Switch could not identify you.", status=500)

        if isinstance(press, InterruptPress):
            action_id, value = INTERRUPT_ACTION, press.turn_id
        elif isinstance(press, CardPress):
            action_id, value = press.action_id, press.value
        else:
            action_id, value = position_action(press.position), press.token

        notices: list[str] = []
        held = _PRESS_NOTICE.set(notices)
        try:
            await self._on_interaction(
                InboundInteraction(
                    channel_id=press.channel_id,
                    sender_id=press.user_id,
                    sender_name=name,
                    sender_display_name=name,
                    action_id=action_id,
                    value=value,
                    message_ref=press.post_id,
                )
            )
        finally:
            _PRESS_NOTICE.reset(held)

        if notices:
            return _ephemeral(notices[0])
        return {}

    async def _show_activity(self, press: ActivityPress) -> dict[str, Any]:
        """Put a turn's tool calls in front of the one person who asked.

        The reply is the whole of the answer. Mattermost shows `ephemeral_text`
        to the presser and nobody else, the channel's history gains nothing,
        and a second reader pressing the same button gets a read of their own.
        It is also why there is no Refresh here: the log is drawn when the
        press arrives, so pressing again is the refresh, and nothing on the
        screen can be older than the press that put it there.

        Two separate questions, both asked. Whether this bridge published that
        turn into that channel is `_resolve_activity`'s, answered against the
        record. Whether this reader may see the channel is Mattermost's, asked
        on every press — a press establishes that the server accepted it, which
        is not a statement about what the presser may read now.

        Every way it can fail says something, and says which thing. A button
        that answers with nothing reads as the press having been dropped, and
        the reader would go on pressing it; a button that answers "gone" when
        this end simply cannot reach the log retires a turn that is still
        running, which the reader cannot come back from.
        """
        resolve = self._resolve_activity
        if resolve is None:
            logger.warning(
                "A Mattermost activity view was pressed on post %s, but this "
                "bridge has nothing to read the log with, so it is refused.",
                press.post_id,
            )
            return _ephemeral(ACTIVITY_FAILED)
        refusal = await self._reads_channel(press.channel_id, press.user_id)
        if refusal is not None:
            return _ephemeral(refusal)
        try:
            snapshot = await resolve(press.channel_id, press.post_id)
        except Exception:
            logger.exception(
                "Reading the activity behind post %s in Mattermost channel %s "
                "failed, so the reader is told rather than left waiting.",
                press.post_id,
                press.channel_id,
            )
            return _ephemeral(ACTIVITY_FAILED)
        if snapshot is None:
            return _ephemeral(ACTIVITY_GONE)
        return _ephemeral(self._activity_text(snapshot))

    async def _reads_channel(self, channel_id: str, user_id: str) -> str | None:
        """Why this person may not see the channel's activity, or None if they may.

        Membership, because that is the audience Mattermost actually holds, and
        it holds it the same way for an open channel, a private one and a
        direct message. It is narrower than readability on an open channel,
        where any member of the team may read without having joined; a reader
        in that position is refused and told so, which is the side to be wrong
        on for a disclosure this message does not already make. That is also
        why the refusal says they are not in the channel rather than that they
        cannot read it — membership is the fact this establishes, and
        readability is not.

        A lookup that cannot answer refuses too. "Mattermost did not say" is
        not "yes", and an audience that cannot be established is one nothing
        should be disclosed to. It is a different sentence, though: a reader
        told they cannot read something goes and asks to be let in, and this
        one has nothing to ask for.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot establish who is in Mattermost channel %s: the bridge "
                "is not connected, so no activity is shown.",
                channel_id,
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        try:
            member = await loop.run_in_executor(
                None, driver.channels.get_channel_member, channel_id, user_id
            )
        except ResourceNotFound:
            # An answer rather than a failure: Mattermost says "not a member"
            # with a 404.
            return ACTIVITY_NOT_A_MEMBER
        except NotEnoughPermissions as error:
            # A channel this bridge may not inspect is one whose audience it
            # cannot vouch for — which says nothing about the reader.
            logger.warning(
                "Mattermost will not let this bridge see who is in channel %s "
                "(%s), so no activity is shown.",
                channel_id,
                error,
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        except Exception as error:
            logger.warning(
                "Mattermost would not say whether user %s is in channel %s "
                "(%s), so no activity is shown.",
                user_id,
                channel_id,
                error,
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        if bool(member) and member.get("user_id") == user_id:
            return None
        return ACTIVITY_NOT_A_MEMBER

    def _activity_text(self, snapshot: ActivitySnapshot) -> str:
        """The tool calls, and the time the read behind them was taken.

        Stamped because an ephemeral reply stays on the screen until the reader
        dismisses it or reloads, and one left open for twenty minutes is not
        wrong but is not current either. An absolute time rather than a
        relative one: Mattermost renders no clock of its own in a message, so a
        "moments ago" written here would still say that an hour later.
        """
        stamp = f"_Read at {snapshot.read_at.astimezone(UTC):%H:%M:%S} UTC_"
        body = activity_log(
            snapshot.items,
            snapshot.turn,
            escape=self._rich_escape,
            limit=max(1, self.rich_fallback_limit() - len(stamp) - 1),
            markup=self.rich_markup(),
            elapsed_seconds=snapshot.elapsed_seconds,
            heading=True,
        )
        return f"{body}\n{stamp}"

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Tell one person their answer did not land, where they can see it.

        A press is answered in the reply to the press itself, which Mattermost
        shows to that person alone: the channel is told nothing, and it reaches
        them without the bot needing to be able to open a DM.

        A typed answer has no press to reply to, so it falls back to the base:
        said in the card's own thread, where everyone reading it sees a notice
        addressed to someone else. That is the platform's limit rather than a
        choice — nothing but a callback gives a bot a private reply here.
        """
        notices = _PRESS_NOTICE.get()
        if notices is not None:
            notices.append(text)
            return
        await super().tell_actor(channel_id, actor_ref, actor_name, thread_ref, text)

    async def notify_privately(
        self,
        *,
        channel_id: str,
        channel_name: str | None,
        user_id: str,
        content: str,
        thread_root_id: str | None,
    ) -> None:
        """An ephemeral post: shown in the channel, in the message's thread,
        to the person who posted it and to nobody else, and gone on reload."""
        driver = self._admin_driver
        if self._main_loop is None or driver is None:
            raise RuntimeError("Mattermost is not connected")
        message = self.translate_outbound(content)

        def send(root_id: str | None) -> Any:
            post: dict[str, Any] = {"channel_id": channel_id, "message": message}
            if root_id is not None:
                post["root_id"] = root_id
            return driver.posts.create_ephemeral_post(
                {"user_id": user_id, "post": post}
            )

        await self._in_thread(driver, thread_root_id, send)

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        bot_driver = self._bot_drivers.get(sender_name)
        if not bot_driver:
            logger.error("No Mattermost driver found for sender '%s'", sender_name)
            if not self._admin_driver:
                return None
            bot_driver = self._admin_driver
        return await self._create_posts(bot_driver, channel_id, content, thread_root_id)

    async def send_ui_message(
        self,
        channel_id: str,
        sender_name: str,
        spec: UISpec,
        fallback_text: str,
        thread_root_id: str | None,
        *,
        room_wide_mention: bool,
    ) -> str | None:
        """The card as message attachments under `fallback_text`, which stays
        the post's message: it is what a Mattermost notification shows. A card
        the post cannot carry, or that Mattermost refuses, raises
        `CardRejectedError` before anything is posted, so core sends the text."""
        attachments = self._card_attachments(channel_id, spec)
        attachments[0]["fallback"] = self._card_text(to_text(spec))
        props: dict[str, Any] = {_ATTACHMENTS_PROP: attachments}
        size = len(json.dumps(props, ensure_ascii=False))
        if size > _MAX_PROPS:
            raise CardRejectedError(
                f"The card is {size} characters of post props, over Mattermost's "
                f"{_MAX_PROPS}."
            )
        driver = self._bot_drivers.get(sender_name) or self._admin_driver
        if driver is None:
            raise RuntimeError("Mattermost is not connected.")
        try:
            return await self._post_or_raise(
                driver, channel_id, fallback_text, thread_root_id, props
            )
        except _MATTERMOST_REFUSALS as error:
            raise CardRejectedError(str(error)) from error

    def _card_text(self, text: str) -> str:
        return self.translate_outbound(_defuse_at(text))

    def _card_cell(self, text: str) -> str:
        return self._card_text(text.replace("\n", " ")).replace("|", "\\|")

    def _card_attachments(self, channel_id: str, spec: UISpec) -> list[dict[str, Any]]:
        """The attachments a card draws as. Buttons are drawn only where a
        press can reach this bridge; elsewhere they are listed as text."""
        address = self._button_address()
        text, cell = self._card_text, self._card_cell
        attachments: list[dict[str, Any]] = []
        buttons_drawn = 0
        stage = _CLOSED

        def at(part: int) -> dict[str, Any]:
            nonlocal stage
            if stage > part:
                attachments.append({})
            stage = part
            return attachments[-1]

        def add_text(line: str) -> None:
            attachment = at(_TEXT)
            attachment["text"] = (
                f"{attachment['text']}\n\n{line}" if "text" in attachment else line
            )

        def walk(key: str) -> None:
            nonlocal stage, buttons_drawn
            element = spec.elements[key]
            p = element.props
            children = [spec.elements[c].props for c in element.children]
            if isinstance(p, CardProps):
                if p.title:
                    at(_TITLE)["title"] = text(p.title)
                if p.subtitle:
                    add_text(f"_{text(p.subtitle)}_")
                if p.imageUrl:
                    at(_IMAGE)["image_url"] = p.imageUrl
            elif isinstance(p, TextProps):
                content = text(p.content)
                if p.style == "bold":
                    content = f"**{content}**"
                elif p.style == "muted":
                    content = f"_{content}_"
                add_text(content)
            elif isinstance(p, FieldsProps):
                at(_FIELDS).setdefault("fields", []).extend(
                    {"title": text(f.label), "value": text(f.value), "short": True}
                    for f in children
                    if isinstance(f, FieldProps)
                )
            elif isinstance(p, TableProps):
                table = _md_table(
                    [[cell(c) for c in row] for row in [p.headers, *p.rows]], p.align
                )
                add_text(table + (f"\n{text(p.caption)}" if p.caption else ""))
            elif isinstance(p, ChartProps):
                chart = p.chart
                if isinstance(chart, PieChart):
                    rows = [["", "Value"]] + [
                        [cell(s.label), f"{s.value:g}"] for s in chart.segments
                    ]
                else:
                    rows = [
                        [
                            cell(chart.xLabel or ""),
                            *(cell(s.name) for s in chart.series),
                        ]
                    ]
                    rows += [
                        [cell(c), *(f"{s.values[i]:g}" for s in chart.series)]
                        for i, c in enumerate(chart.categories)
                    ]
                axis = (
                    f" ({text(chart.yLabel)})"
                    if not isinstance(chart, PieChart) and chart.yLabel
                    else ""
                )
                add_text(f"**{text(p.title)}**{axis}\n{_md_table(rows, None)}")
            elif isinstance(p, DividerProps):
                stage = _CLOSED
            elif isinstance(p, ImageProps):
                add_text(f"![{cell(p.alt).replace(']', '')}]({_md_url(p.url)})")
            elif isinstance(p, ActionsProps):
                links = [
                    f"[{cell(b.label).replace(']', '')}]({_md_url(b.url)})"
                    for b in children
                    if isinstance(b, LinkButtonProps)
                ]
                if links:
                    add_text(" · ".join(links))
                buttons = [b for b in children if isinstance(b, ButtonProps)]
                if buttons and address is None:
                    add_text(" · ".join(f"**{cell(b.label)}**" for b in buttons))
                elif buttons and address is not None:
                    url, key = address
                    # A row of its own, as the card groups its buttons.
                    if stage == _ACTIONS:
                        stage = _CLOSED
                    actions = at(_ACTIONS).setdefault("actions", [])
                    for b in buttons:
                        actions.append(
                            card_action(
                                key,
                                url,
                                channel_id,
                                f"switchui{buttons_drawn}",
                                b.label,
                                b.style,
                                *button_action(b),
                            )
                        )
                        buttons_drawn += 1
            for child in element.children:
                walk(child)

        walk(spec.root)
        return attachments or [{}]

    async def settle_card_press(
        self,
        interaction: InboundInteraction,
        label: str,
        *,
        author: str,
        spec: UISpec,
        body: str,
    ) -> None:
        """Take every button off the card and say under it who chose what: a
        card takes one answer, and its links are text, not buttons."""
        driver, loop = self._admin_driver, self._main_loop
        ref = interaction.message_ref
        if driver is None or loop is None or ref is None:
            logger.warning(
                "Cannot mark the card press in Mattermost channel %s as done: "
                "not connected or no post, so its buttons stay pressable",
                interaction.channel_id,
            )
            return
        chosen = _defuse_at(f"✅ {interaction.sender_display_name} chose {label}")
        try:
            post = await loop.run_in_executor(None, driver.posts.get_post, ref)
            props = dict(post.get("props") or {})
            attachments = [
                {k: v for k, v in attachment.items() if k != "actions"}
                for attachment in props.get(_ATTACHMENTS_PROP) or []
            ]
            attachments = [a for a in attachments if a] or [{}]
            attachments[-1]["footer"] = chosen
            props[_ATTACHMENTS_PROP] = attachments
            await loop.run_in_executor(
                None, driver.posts.patch_post, ref, {"props": props}
            )
        except Exception:
            # The press was delivered; only its mark on the card is missing.
            logger.exception(
                "Could not mark the card press on Mattermost post %s as done, so "
                "its buttons stay pressable",
                ref,
            )

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        """Post an admin/system message natively on Mattermost.

        In a normal channel it goes out as the dedicated Switch Admin bot. A
        1:1 DM channel cannot admit a third bot, so there it falls back to the
        agent bot that owns the DM, lightly marked so it reads as a system
        notice rather than the agent's own voice.

        Renders its own body: every caller passes Switch Markdown, so the
        conversion belongs here rather than at each of them — one of them
        forgetting is how a notice reached a channel with its markup showing.
        """
        content = self._admin_body(self.translate_outbound(content), drawn)
        loop = self._main_loop
        if loop is None:
            logger.error("Cannot post admin message: event loop not initialized")
            return None

        channel_type = await self.get_channel_type(channel_id)
        if channel_type == "direct":
            agent_names = await self.get_channel_agent_names(channel_id)
            driver = self._bot_drivers.get(agent_names[0]) if agent_names else None
            if driver is None:
                driver = self._admin_driver
            if driver is None:
                logger.error("No driver to post admin message in DM %s", channel_id)
                return None
            return await self._create_posts(
                driver, channel_id, f"_Switch:_ {content}", thread_root_id
            )

        driver = self._admin_bot_driver
        if driver is None:
            logger.warning(
                "Switch Admin bot not provisioned; posting admin message as "
                "admin user in %s",
                channel_id,
            )
            driver = self._admin_driver
        else:
            await self._ensure_admin_bot_in_channel(channel_id)
        if driver is None:
            return None
        return await self._create_posts(driver, channel_id, content, thread_root_id)

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Upload the file with the agent's own bot and attach it to a post —
        full identity and threading parity with text messages."""
        loop = self._main_loop
        if loop is None:
            logger.error("Cannot send attachment: event loop not initialized")
            return None
        driver = self._bot_drivers.get(sender_name)
        if not driver:
            logger.error("No Mattermost driver found for sender '%s'", sender_name)
            if not self._admin_driver:
                return None
            driver = self._admin_driver

        def _upload() -> list[str]:
            result = driver.files.upload_file(
                channel_id,
                files={"files": (filename, io.BytesIO(data), mimetype)},
            )
            return [info["id"] for info in result.get("file_infos", [])]

        try:
            file_ids = await loop.run_in_executor(None, _upload)
        except Exception as e:
            logger.error(
                "Failed to upload attachment '%s' to Mattermost channel %s: %s",
                filename,
                channel_id,
                e,
            )
            file_ids = []
        if not file_ids:
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )

        post: dict[str, Any] = {
            "channel_id": channel_id,
            "message": self.translate_outbound(caption) if caption else "",
            "file_ids": file_ids,
        }
        try:
            result = await self._create_threaded_post(driver, post, thread_root_id)
            post_id: str = result.get("id", "")
            return post_id or None
        except Exception as e:
            logger.error(
                "Failed to post attachment '%s' to Mattermost channel %s: %s",
                filename,
                channel_id,
                e,
            )
            return None

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Upload several files and attach them all to ONE post — Mattermost
        posts natively carry a list of file ids."""
        if not files:
            return None
        if len(files) == 1:
            file = files[0]
            return await self.send_attachment(
                channel_id,
                sender_name,
                file.filename,
                file.mimetype,
                file.data,
                caption,
                thread_root_id,
            )
        loop = self._main_loop
        if loop is None:
            logger.error("Cannot send attachments: event loop not initialized")
            return None
        driver = self._bot_drivers.get(sender_name)
        if not driver:
            logger.error("No Mattermost driver found for sender '%s'", sender_name)
            if not self._admin_driver:
                return None
            driver = self._admin_driver

        def _upload_all() -> list[str]:
            ids: list[str] = []
            for file in files:
                result = driver.files.upload_file(
                    channel_id,
                    files={
                        "files": (file.filename, io.BytesIO(file.data), file.mimetype)
                    },
                )
                ids.extend(info["id"] for info in result.get("file_infos", []))
            return ids

        try:
            file_ids = await loop.run_in_executor(None, _upload_all)
        except Exception as e:
            logger.error(
                "Failed to upload %d attachments to Mattermost channel %s: %s",
                len(files),
                channel_id,
                e,
            )
            file_ids = []
        if not file_ids:
            return await super().send_attachments(
                channel_id, sender_name, files, caption, thread_root_id
            )

        post: dict[str, Any] = {
            "channel_id": channel_id,
            "message": self.translate_outbound(caption) if caption else "",
            "file_ids": file_ids,
        }
        try:
            result = await self._create_threaded_post(driver, post, thread_root_id)
            post_id: str = result.get("id", "")
            return post_id or None
        except Exception as e:
            logger.error(
                "Failed to post %d attachments to Mattermost channel %s: %s",
                len(files),
                channel_id,
                e,
            )
            return None

    async def _create_posts(
        self,
        driver: Driver,
        channel_id: str,
        content: str,
        thread_root_id: str | None,
    ) -> str | None:
        """Post `content` as however many posts the server's limit needs.

        The parts go out in order, each in `thread_root_id`'s thread when there
        is one. Returns the FIRST post's id: that is the one the bridge maps
        the room event to, so a reply threads under the start of what was said
        rather than its tail. `None` when not even the first part was taken.

        Raises `MessagePartlySent` when a later part is refused, after saying
        in the channel that the rest is missing.
        """
        parts = split_markdown(content, await self._post_limit(content))
        first_id = await self._create_post(driver, channel_id, parts[0], thread_root_id)
        if first_id is None:
            return None
        await self._post_rest(driver, channel_id, parts, thread_root_id, first_id)
        return first_id

    async def _post_rest(
        self,
        driver: Driver,
        channel_id: str,
        parts: list[str],
        thread_root_id: str | None,
        first_id: str,
    ) -> None:
        """Post every part after the first, which is already `first_id`.

        A refused part ends the run: the channel is told how much of the
        message it has, and `MessagePartlySent` is raised."""
        for index, part in enumerate(parts[1:], start=1):
            if await self._create_post(driver, channel_id, part, thread_root_id):
                continue
            logger.error(
                "Only %d of %d parts of a message reached Mattermost channel %s",
                index,
                len(parts),
                channel_id,
            )
            notice = (
                f"_Only {index} of {len(parts)} parts of this message could be "
                "delivered; Mattermost rejected the rest._"
            )
            if (
                await self._create_post(driver, channel_id, notice, thread_root_id)
                is None
            ):
                logger.error(
                    "Could not tell Mattermost channel %s that the message %s is "
                    "missing its last %d parts; nothing there says it is cut short",
                    channel_id,
                    first_id,
                    len(parts) - index,
                )
            raise MessagePartlySent(
                platform="Mattermost",
                first_ref=first_id,
                delivered=index,
                total=len(parts),
            )

    async def _post_limit(self, content: str) -> int:
        """The longest post this server accepts, asked for only when `content`
        is longer than every server accepts.

        Only an answer is kept. A read that fails splits this message at
        `_MAX_POST` and is tried again for the next one, so a passing fault
        does not hold every later message to the smallest limit."""
        if len(content) <= _MAX_POST:
            return _MAX_POST
        if self._max_post_size is None:
            self._max_post_size = await self._read_max_post_size()
        return _MAX_POST if self._max_post_size is None else self._max_post_size

    async def _read_max_post_size(self) -> int | None:
        """`MaxPostSize` from the client config, which any signed-in user can
        read; `None`, with a warning, when the server does not answer with one."""
        try:
            config = await self._mm_api("get", "/config/client?format=old")
            size = int(config["MaxPostSize"])
        except Exception as e:
            logger.warning(
                "Could not read MaxPostSize from the Mattermost client config "
                "(%s); splitting this message at %d characters and asking again "
                "for the next",
                e,
                _MAX_POST,
            )
            return None
        if size <= 0:
            logger.warning(
                "Mattermost reported a MaxPostSize of %d; splitting this message "
                "at %d characters and asking again for the next",
                size,
                _MAX_POST,
            )
            return None
        return size

    async def _create_post(
        self,
        driver: Driver,
        channel_id: str,
        content: str,
        thread_root_id: str | None,
        props: dict[str, Any] | None = None,
    ) -> str | None:
        try:
            return await self._post_or_raise(
                driver, channel_id, content, thread_root_id, props
            )
        except Exception as e:
            logger.error("Failed to send Mattermost message to %s: %s", channel_id, e)
            return None

    async def _post_or_raise(
        self,
        driver: Driver,
        channel_id: str,
        content: str,
        thread_root_id: str | None,
        props: dict[str, Any] | None,
    ) -> str:
        """Create a post and hand back its id, or raise saying why not.

        `_create_post` is the swallowing wrapper for callers whose failure is
        cosmetic. A publication's is not: the exception carries what Mattermost
        actually said, which is the difference between a caller that can retry
        sensibly and one that only knows it got `None`.
        """
        post: dict[str, Any] = {"channel_id": channel_id, "message": content}
        if props:
            post["props"] = props
        result = await self._create_threaded_post(driver, post, thread_root_id)
        post_id: str = result.get("id", "")
        if not post_id:
            raise RuntimeError("Mattermost accepted the post but returned no id.")
        return post_id

    async def _create_threaded_post(
        self, driver: Driver, post: dict[str, Any], thread_root_id: str | None
    ) -> dict[str, Any]:
        def send(root_id: str | None) -> dict[str, Any]:
            body = dict(post)
            if root_id is not None:
                body["root_id"] = root_id
            result: dict[str, Any] = driver.posts.create_post(body)
            return result

        return await self._in_thread(driver, thread_root_id, send)

    async def _in_thread[T](
        self,
        driver: Driver,
        thread_root_id: str | None,
        send: Callable[[str | None], T],
    ) -> T:
        """Run `send` with the root id to thread under, on the driver's thread.

        Mattermost takes only a thread's root as `root_id` and refuses a reply's
        id with a 400. Switch is handed a reply to thread under whenever what it
        answers was itself posted in a thread, so on any 400 the reference is
        looked up, and if it is a reply `send` is tried once more under the
        root of its thread. The refusal's text is not consulted: Mattermost
        translates it, and the driver keeps nothing else of the response.

        A root found this way is remembered for the reference. A send under a
        remembered root that is refused forgets it and looks the reference up
        again, once, since the thread may have changed since.
        """
        loop = self._main_loop
        if loop is None:
            raise RuntimeError("Mattermost is not connected.")
        if thread_root_id is None:
            return await loop.run_in_executor(None, send, None)
        known_root = self._thread_root_for(thread_root_id)
        if known_root is not None and known_root != thread_root_id:
            try:
                return await loop.run_in_executor(None, send, known_root)
            except (InvalidOrMissingParameters, ResourceNotFound) as error:
                logger.warning(
                    "Mattermost refused %s, the remembered thread root of %s "
                    "(%s); looking %s up again",
                    known_root,
                    thread_root_id,
                    error,
                    thread_root_id,
                )
                self._thread_roots.pop(thread_root_id, None)
                refusal: InvalidOrMissingParameters | ResourceNotFound = error
        else:
            try:
                return await loop.run_in_executor(None, send, thread_root_id)
            except InvalidOrMissingParameters as error:
                refusal = error
        root = await self._root_of_reply(driver, thread_root_id, refusal)
        return await loop.run_in_executor(None, send, root)

    def _thread_root_for(self, thread_root_id: str | None) -> str | None:
        """The root `thread_root_id` is known to resolve to, or itself."""
        if thread_root_id is None:
            return None
        known_root = self._thread_roots.get(thread_root_id)
        if known_root is None:
            return thread_root_id
        self._thread_roots.move_to_end(thread_root_id)
        return known_root

    async def _root_of_reply(
        self,
        driver: Driver,
        post_id: str,
        refusal: InvalidOrMissingParameters | ResourceNotFound,
    ) -> str:
        """The root of the thread `post_id` is a reply in, or `refusal` raised
        when Mattermost cannot say it is a reply in one."""
        loop = self._main_loop
        assert loop is not None
        try:
            referenced = await loop.run_in_executor(
                None, driver.posts.get_post, post_id
            )
        except Exception as lookup_error:
            logger.warning(
                "Mattermost refused a post threaded under %s (%s), and looking "
                "%s up to find its thread failed: %s",
                post_id,
                refusal,
                post_id,
                lookup_error,
            )
            raise refusal from lookup_error
        root = referenced.get("root_id") if isinstance(referenced, dict) else None
        if not isinstance(root, str) or not root or root == post_id:
            logger.warning(
                "Mattermost refused a post threaded under %s (%s), and %s is a "
                "thread root, so threading was not the problem",
                post_id,
                refusal,
                post_id,
            )
            raise refusal
        self._thread_roots[post_id] = root
        if len(self._thread_roots) > _MAX_THREAD_ROOTS:
            self._thread_roots.popitem(last=False)
        return root

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Rewrite a post, continuing in its thread when the new text is
        longer than one post.

        The post keeps the first part, and the rest follows it in its thread
        (the post's own, when it is a thread's root) from the bot that wrote
        it, so the edit reads as the post went on. Where that cannot be done,
        the post is written to as much as fits and says it was cut short.
        Each call that runs over posts its own follow-ups.
        """
        if not self._admin_driver or not self._main_loop:
            logger.error("Cannot update message: Mattermost client not connected")
            return
        try:
            await self._update_post(
                self._admin_driver,
                self._main_loop,
                channel_id,
                message_ref,
                new_content,
            )
        except Exception as e:
            logger.error("Failed to update Mattermost post %s: %s", message_ref, e)

    async def _update_post(
        self,
        admin: Driver,
        loop: asyncio.AbstractEventLoop,
        channel_id: str,
        message_ref: str,
        new_content: str,
    ) -> None:
        limit = await self._post_limit(new_content)
        parts = split_markdown(new_content, limit)
        if len(parts) == 1:
            await self._patch_message(admin, loop, message_ref, new_content)
            return

        try:
            post = await loop.run_in_executor(None, admin.posts.get_post, message_ref)
        except Exception as e:
            logger.error(
                "Could not read Mattermost post %s to continue its %d-character "
                "edit in its thread (%s); writing what fits and marking it cut short",
                message_ref,
                len(new_content),
                e,
            )
            await self._patch_truncated(admin, loop, message_ref, new_content, limit)
            return
        driver = self._author_driver(str(post.get("user_id", "")))
        if driver is None:
            logger.error(
                "Mattermost post %s was not written by a bot this bridge drives, "
                "so the rest of its %d-character edit cannot follow it as the "
                "same author; writing what fits and marking it cut short",
                message_ref,
                len(new_content),
            )
            await self._patch_truncated(admin, loop, message_ref, new_content, limit)
            return

        await self._patch_message(admin, loop, message_ref, parts[0])
        thread_root_id = str(post.get("root_id") or "") or message_ref
        try:
            await self._post_rest(
                driver, channel_id, parts, thread_root_id, message_ref
            )
        except MessagePartlySent as e:
            logger.error(
                "The edit of Mattermost post %s was cut short: %s", message_ref, e
            )

    def _author_driver(self, user_id: str) -> Driver | None:
        """The driver that posts as `user_id`, when it is one of this bridge's
        own identities."""
        agent_name = self._bot_id_to_username.get(user_id)
        if agent_name is not None:
            return self._bot_drivers.get(agent_name)
        if user_id and user_id == self._admin_bot_id:
            return self._admin_bot_driver
        if user_id and user_id == self._admin_user_id:
            return self._admin_driver
        return None

    async def _patch_truncated(
        self,
        admin: Driver,
        loop: asyncio.AbstractEventLoop,
        message_ref: str,
        content: str,
        limit: int,
    ) -> None:
        """Write as much of `content` as fits, ending in a line that says the
        rest is missing, for an edit whose remainder has nowhere to go."""
        marker = f"\n\n{_EDIT_CUT_SHORT}"
        head = split_markdown(content, limit - len(marker))[0]
        await self._patch_message(admin, loop, message_ref, head + marker)

    @staticmethod
    async def _patch_message(
        admin: Driver, loop: asyncio.AbstractEventLoop, message_ref: str, message: str
    ) -> None:
        await loop.run_in_executor(
            None, admin.posts.patch_post, message_ref, {"message": message}
        )

    # ── SDK session publication ──────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return _MAX_POST

    def rich_fallback_text(self, content: RichContent) -> str:
        """What a publication says, with nothing that needed looking up.

        The renderers are the same ones `post_rich` uses; what is missing is
        the mention and the responder's handle, both of which come from an id
        Switch holds and a call to Mattermost to turn it into a name. This is
        the string that goes in a `RichContentFailed`, where a failed lookup
        on top of a failed post would say nothing useful anyway.

        Drawn without controls because nothing carries them here. A card that
        dropped an option from its body on the promise of a button, and then
        went out as the text of a failure, would ask for a choice it had
        stopped printing.
        """
        return self._draw(content, mention=None, responder=None, controls=False).text

    def _draw(
        self,
        content: RichContent,
        *,
        mention: str | None,
        responder: str | None,
        controls: bool,
    ) -> Drawn:
        escape = self._rich_escape
        limit = self.rich_fallback_limit()
        markup = self.rich_markup()
        if isinstance(content, TurnActivity):
            # Charged to the same budget as the status it follows: a post that
            # just fits, plus a line saying it reached nobody, is a post
            # Mattermost refuses. The note under a queued turn's stop control
            # is charged the same way, and for the same reason.
            lines = []
            if self._offers_interrupt(content) and content.turn.status == "queued":
                lines.append(INTERRUPT_QUEUED_NOTE)
            if content.notify_unreachable:
                lines.append(self.unnotified_notice())
            tail = "".join(f"\n{line}" for line in lines)
            return Drawn(
                text=turn_status(
                    content.items,
                    content.turn,
                    escape=escape,
                    limit=max(1, limit - len(tail)),
                    markup=markup,
                    elapsed_seconds=content.elapsed_seconds,
                    mention=mention,
                    error_summary=content.error_summary,
                    tool_detail=True,
                )
                + tail,
                answerable=False,
            )
        # The handle goes on its own line rather than in front of the heading:
        # a card is a block, and a handle wedged before "**Permission needed**"
        # reads as part of the heading. It is charged to the same budget, or a
        # form that just fits becomes a post Mattermost refuses. So is the
        # notice below it, which is the same admission the turn status makes:
        # a request nobody was named in is a request nobody was asked.
        lead = f"{mention}\n" if mention else ""
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        drawn = render_request(
            content.request,
            content.reference,
            escape=escape,
            limit=max(1, limit - len(lead) - len(tail)),
            markup=markup,
            responder=responder,
            unavailable_reason=content.unavailable_reason,
            control_label_limit=MAX_BUTTON_LABEL if controls else None,
        )
        return replace(drawn, text=f"{lead}{drawn.text}{tail}")

    def _button_address(self) -> tuple[str, str] | None:
        """Where a press goes and what signs it, or None if this bridge takes none.

        All three have to hold and they are settled at different moments: an
        address the Mattermost server can reach, a place on the shared listener
        for a press to arrive at, and something to route it to once it has.

        A question about offering a button, and only that. Taking one off asks
        the post instead: a deployment that has withdrawn its callback address
        is exactly the one whose old buttons most need removing, and it is the
        one this answers None for.
        """
        url = self.callback_url
        endpoint = self._callback
        if url is None or endpoint is None or self._on_interaction is None:
            return None
        return url, endpoint.key

    def _offers_interrupt(self, content: RichContent) -> bool:
        """Whether this post gets a control that stops the agent's current work.

        Three things, each removing it on its own: something running to stop,
        named by the caller when the message was drawn; this message's own turn
        still unfinished, so that scrolling back to yesterday's turn does not
        offer a control over today's work; and somewhere for a press to go.

        Asked before the text is drawn as well as when the buttons are built,
        because a queued turn's control needs a line saying what it stops and
        that line is part of the post's body.
        """
        return (
            isinstance(content, TurnActivity)
            and content.interrupt_turn_id is not None
            and content.turn.status not in TURN_ENDED
            and self._button_address() is not None
        )

    def _controls(
        self, channel_id: str, content: RichContent, drawn: Drawn
    ) -> list[dict[str, Any]]:
        """A post's buttons: a card's options, or a turn's way into its log.

        Nothing at all is an ordinary answer: a settled card has no options
        left, a bridge with no callback address has nowhere for a press to go,
        and a card that cannot be answered where it is showing says so — a live
        control under that sentence invites the refusal the sentence just
        explained. Because every redraw builds this again, the buttons come off
        a card at the moment it stops being pressable, without anything having
        to remember that it once had them.

        A turn's status earns the button into its log whatever state it is in,
        the attention slot included. The log is read when the press arrives
        rather than drawn into the post, so a running turn's is as current as
        an ended turn's and neither goes stale on the channel — and a message
        saying somebody has to act is the one a reader most needs to be able
        to ask what happened from.

        The stop control beside it is the one button here that does go stale,
        because what it offers depends on there being work to stop. It comes
        and goes over a turn's life, which is why a redraw has to be able to
        rewrite a status post's buttons at all.

        Whether the drawing earned the option buttons comes from `drawn` rather
        than from reading the request a second time. A body cut short of the
        difference between two options is one a reader cannot decide from, and
        only the renderer that cut it knows that. A press would still resolve
        against the stored record and settle the request, so the whole of the
        protection is not offering the button.
        """
        address = self._button_address()
        if address is None:
            return []
        url, key = address
        if isinstance(content, TurnActivity):
            actions = []
            if self._resolve_activity is not None:
                actions.append(activity_action(key, url, channel_id))
            turn_id = content.interrupt_turn_id
            if turn_id is not None and self._offers_interrupt(content):
                actions.append(interrupt_action(key, url, channel_id, turn_id))
            return actions
        if not isinstance(content, RequestCard) or not drawn.answerable:
            return []
        controls = offered_controls(content.request)
        if not controls:
            return []
        return answer_actions(key, url, content.reference.token, controls)

    async def _render_rich(self, channel_id: str, content: RichContent) -> _Rendered:
        mention = await self._mention(content.notify_external_id)
        responder = (
            await self._mention(content.responder_external_id)
            if isinstance(content, RequestCard)
            else None
        )
        controls = (
            isinstance(content, RequestCard) and self._button_address() is not None
        )
        drawn = self._draw(
            content, mention=mention, responder=responder, controls=controls
        )
        actions = self._controls(channel_id, content, drawn)
        if not controls:
            return _Rendered(text=drawn.text, actions=actions, plain=drawn.text)
        # The body drops an option only where a button carries it, so wherever
        # buttons were possible the card is also drawn as if none were. That
        # second drawing is what a failure is reported with, and it is what
        # goes on the post itself when the card turned out to earn no controls
        # — which is not known until it has been drawn, because a form too big
        # to show faithfully is discovered by drawing it.
        plain = self._draw(
            content, mention=mention, responder=responder, controls=False
        ).text
        return _Rendered(
            text=drawn.text if actions else plain, actions=actions, plain=plain
        )

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's status or a request's form as the agent's own bot.

        The recovery marker rides along in the post's props rather than in
        anything a reader sees, so a post whose response was lost can be found
        again by `find_request_card` instead of being sent twice.

        Raises on every failure, unlike `send_message`, which reports one by
        returning `None`: a publication that silently did not happen is a
        reservation that never gets retried and a turn the channel never sees.
        What it raises is the point — `RichContentFailed` is the caller's
        licence to discard the reservation, so it is reserved for a refusal
        Mattermost actually gave. A send whose outcome nobody knows raises the
        transport's own error and keeps the reservation.
        """
        rendered = await self._render_rich(channel_id, content)
        driver = self._bot_drivers.get(agent_name)
        if driver is None:
            raise RichContentFailed(
                f"No Mattermost bot for agent {agent_name!r}, so its activity "
                f"cannot be posted in channel {channel_id}.",
                text=rendered.plain,
            )
        token = (
            content.publication_token
            if isinstance(content, TurnActivity)
            else content.reference.token
        )
        props: dict[str, Any] = {}
        if token:
            props[_PUBLICATION_PROP] = token
        if rendered.actions:
            props[_ATTACHMENTS_PROP] = [{"actions": rendered.actions}]
        try:
            ref = await self._post_or_raise(
                driver, channel_id, rendered.text, thread_root_id, props or None
            )
        except Exception as error:
            failure = _as_rich_failure(
                error,
                description=f"Mattermost refused the post in channel {channel_id}",
                text=rendered.plain,
            )
            if failure is None:
                raise
            raise failure from error
        self._remember_actions(ref, rendered.actions)
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place, and say so when it did not happen.

        Not `update_message`: that one logs and returns, which is right for the
        legacy status line nobody is waiting on and wrong here. A card that
        failed to redraw is still showing a settled request as open, and the
        caller has a reply to post about it — but only if it is told.

        Edited as the agent's own bot where there is one. Mattermost keeps the
        original author through a patch either way, so the fallback to the
        admin driver changes who a reader sees the post from not at all; what
        it changes is the permission the edit is made with, and an agent bot
        editing its own post is the narrower of the two.

        Says "did not happen" only where Mattermost refused the edit. An edit
        whose outcome is unknown may well have landed, and reporting it as a
        refusal buys a fallback reply about a card that is already correct.

        A post's buttons are carried in its props, so the props are part of the
        edit — which is what takes them off a card the moment it stops being
        answerable, and off a status post the moment its turn ends. Part of
        every card's edit, not just the edits of a bridge that could put a
        button on: a deployment that has since dropped its callback address can
        offer no new button and has old ones still inviting a press at a route
        that has gone.

        A status post's props are rewritten only when its buttons have actually
        changed, which over a turn is at most twice. Writing props means reading
        the post back first, and a status post is redrawn on every tool call —
        the round trip belongs on the edit that has something to say, not on the
        hundred that are redrawing the same two buttons under new text.
        """
        # A post notifies; an edit does not. Repeating the mention on every
        # redraw would be a handle in the channel that never resolves to
        # anything new for the person it names.
        rendered = await self._render_rich(
            channel_id, replace(content, notify_external_id=None)
        )
        driver = self._bot_drivers.get(agent_name) or self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            raise RichContentFailed(
                "Mattermost is not connected, so the post could not be updated.",
                text=rendered.plain,
            )
        try:
            patch: dict[str, Any] = {"message": rendered.text}
            if isinstance(content, RequestCard) or self._actions_changed(
                message_ref, rendered.actions
            ):
                patch["props"] = await self._props_with_actions(
                    driver, loop, message_ref, rendered.actions
                )
            await loop.run_in_executor(
                None, driver.posts.patch_post, message_ref, patch
            )
        except Exception as error:
            failure = _as_rich_failure(
                error,
                description=(
                    f"Mattermost refused the edit to post {message_ref} in "
                    f"channel {channel_id}"
                ),
                text=rendered.plain,
            )
            if failure is None:
                raise
            raise failure from error
        self._remember_actions(message_ref, rendered.actions)

    def _actions_changed(self, message_ref: str, actions: list[dict[str, Any]]) -> bool:
        """Whether this post's buttons need rewriting, or already say this.

        A post nothing is remembered about counts as changed. Its buttons are
        unknown rather than known to be right, and the two cases this arises in
        both want the write: a bridge that has restarted since the post was
        made, and one whose memory of it has aged out under a thousand newer
        posts. The cost is one read-back per post once, against leaving a
        control on screen that no longer matches the turn behind it.

        Compared by value, which works because a button is derived entirely
        from what it is for — the same turn in the same state signs to the same
        context every time, so equality here means the post already carries
        exactly these buttons.
        """
        return self._post_actions.get(message_ref) != actions

    def _remember_actions(
        self, message_ref: str, actions: list[dict[str, Any]]
    ) -> None:
        self._post_actions.pop(message_ref, None)
        self._post_actions[message_ref] = actions
        while len(self._post_actions) > self._post_actions_max:
            self._post_actions.popitem(last=False)

    async def _props_with_actions(
        self,
        driver: Driver,
        loop: asyncio.AbstractEventLoop,
        message_ref: str,
        actions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """The post's props as they should be, with its buttons set to `actions`.

        Read back first rather than written fresh. A patch replaces a post's
        props wholesale, and some of what is on them was put there by the
        Mattermost server when the post was made — the marker saying it came
        from a bot among them. Sending only the props Switch knows about would
        strip those off the card as a side effect of taking a button off it.

        No actions means the key goes, which is how a settled card loses its
        buttons: an empty list would leave an attachment on the post with
        nothing in it.
        """
        post = await loop.run_in_executor(None, driver.posts.get_post, message_ref)
        props = dict(post.get("props") or {})
        if actions:
            props[_ATTACHMENTS_PROP] = [{"actions": actions}]
        else:
            props.pop(_ATTACHMENTS_PROP, None)
        return props

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        """Look for a publication this bridge may already have posted.

        Asked when a post's outcome is unknown — the request timed out, or the
        process died between sending and recording the id. The answer decides
        between binding the reservation to what is there and posting a second
        copy of a card somebody is meant to answer exactly once, so a lookup
        that cannot be trusted must come back as "not found" rather than as a
        guess: `None` keeps the reservation and asks again.

        Matched on the props marker and on the post's author, because a token
        quoted back in somebody's message must not be mistaken for the post
        that carries it. `handle` is unused for the same reason it is on
        Slack: the props marker is exact, and invisible to a reader.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot look for the publication marked %s in channel %s: "
                "Mattermost is not connected.",
                token,
                channel_id,
            )
            return None
        since = max(0, int(created_at.timestamp() * 1000) - _RECOVERY_SKEW_MS)

        def _read() -> dict[str, Any]:
            if thread_root_id:
                return dict(driver.posts.get_thread(thread_root_id))
            return dict(
                driver.posts.get_posts_for_channel(channel_id, params={"since": since})
            )

        try:
            page = await loop.run_in_executor(None, _read)
        except Exception as e:
            logger.warning(
                "Could not read %s looking for the publication marked %s: %s.",
                f"thread {thread_root_id}"
                if thread_root_id
                else f"channel {channel_id}",
                token,
                e,
            )
            return None
        for post in (page.get("posts") or {}).values():
            if post.get("user_id") not in self._bridge_bot_ids:
                continue
            if (post.get("props") or {}).get(_PUBLICATION_PROP) != token:
                continue
            found = str(post.get("id") or "")
            if found:
                return found
        return None

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        """Whether this message is the first thing said under a thread root.

        Mattermost's websocket event names the root but not the position in the
        thread, so the thread itself is the only place the answer is. Ordered
        here on `create_at` rather than trusted from the API's own `order`: a
        bare "yes" deciding a permission is not worth resting on a field whose
        direction is not part of the contract.

        Never raises. This is on the inbound path of every message, ahead of
        the relay, so an exception out of it is not a refused answer but a
        message the room never sees.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot read the thread under %s in %s: Mattermost is not "
                "connected. Treating %s as not the first reply.",
                root_ref,
                channel_id,
                message_ref,
            )
            return False
        try:
            thread = await loop.run_in_executor(None, driver.posts.get_thread, root_ref)
        except Exception as e:
            logger.warning(
                "Could not read the thread under %s in %s: %s. Treating %s as "
                "not the first reply.",
                root_ref,
                channel_id,
                e,
                message_ref,
            )
            return False
        replies = sorted(
            (
                post
                for post in (thread.get("posts") or {}).values()
                if post.get("id") != root_ref and not post.get("delete_at")
            ),
            key=lambda post: (post.get("create_at") or 0, str(post.get("id") or "")),
        )
        return bool(replies) and replies[0].get("id") == message_ref

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: ActivityMark,
        on: bool,
        force: bool = False,
    ) -> None:
        """Put this agent's mark on the message, or take it off.

        Per agent, because the reaction belongs to the bot that added it:
        two agents on one message are two marks, and one finishing leaves the
        other's alone. `force` is the durable publisher reconciling after a
        restart, when this process's record of what is already there is empty
        and wrong rather than empty and right.

        Raises when the mark did not happen, including when there is no bot to
        make it with. The publisher retries on that and records completion
        only once the channel actually shows what it says it shows.
        """
        await self._react_or_raise(
            agent_name, message_ref, mark=mark, on=on, force=force
        )

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """The one-shot typing nudge, at the place the agent was asked.

        What the legacy runtime path sent as a turn opened, kept for the SDK
        one: Mattermost expires it after a few seconds, so it costs the channel
        nothing and it is the only signal that arrives before the first post.
        """
        await self._post_typing(channel_id, agent_name, thread_root_id)

    async def _mention(self, external_user_id: str | None) -> str | None:
        """`@handle` for a Mattermost user id, or None if it cannot be resolved.

        None rather than the raw id: an id printed where a handle belongs
        notifies nobody and reads as noise, and the message it decorates is
        worth sending without it.
        """
        if not external_user_id or external_user_id.startswith(
            _WEBHOOK_STAND_IN_PREFIX
        ):
            # A webhook's stand-in is nobody Mattermost can notify.
            return None
        username = await self._username_for(external_user_id)
        return f"@{username}" if username else None

    async def _username_for(self, external_user_id: str) -> str | None:
        """The handle behind a Mattermost user id, or None if it cannot be read.

        Cached because a handle is stable for the life of an account, so a hit
        saves a round trip on every redraw carrying a mention and on every
        press.
        """
        username = self._usernames.get(external_user_id)
        if username is not None:
            return username
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            return None
        try:
            user = await loop.run_in_executor(
                None, driver.users.get_user, external_user_id
            )
        except Exception as e:
            logger.warning(
                "Could not resolve Mattermost user %s to a handle: %s",
                external_user_id,
                e,
            )
            return None
        username = str(user.get("username") or "")
        if not username:
            return None
        self._usernames[external_user_id] = username
        while len(self._usernames) > self._usernames_max:
            self._usernames.popitem(last=False)
        return username

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        if not self._admin_driver or not self._main_loop:
            logger.error("Cannot delete message: Mattermost client not connected")
            return

        try:
            await self._main_loop.run_in_executor(
                None, self._admin_driver.posts.delete_post, message_ref
            )
        except Exception as e:
            logger.error("Failed to delete Mattermost post %s: %s", message_ref, e)

    async def remove_publication(self, channel_id: str, message_ref: str) -> None:
        """Take an answered card out of the channel, or say why it is still there.

        Deleted as the admin, which is the account that may delete a post it
        did not write — the card was posted by the agent's bot, and nothing in
        the reference says which agent that was. `update_rich` can prefer the
        narrower bot because it is handed the agent's name; this is not.

        Told the post does not exist, this returns: the id came from Mattermost
        when it accepted the card, so nothing remains at it, which is what the
        caller asked for.

        Not `delete_message`, which logs and returns either way. A caller
        writing down that a card is gone must not be told success where none
        was established.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            raise RemovalFailed("Mattermost is not connected.")
        if not message_ref.strip():
            # A blank id is a DELETE against the collection rather than a post.
            raise RemovalFailed("No Mattermost post id to delete.")

        try:
            await loop.run_in_executor(None, driver.posts.delete_post, message_ref)
        except ResourceNotFound as error:
            # Worth a line because the innocent reading — a deletion whose
            # acknowledgement we lost, or one done by hand — is not the only one.
            logger.warning(
                "Mattermost card %s was already gone when it was taken back: %s",
                message_ref,
                error,
            )
        except Exception as error:
            raise self._removal_failure(error, message_ref, channel_id) from error

    @staticmethod
    def _removal_failure(
        error: Exception, message_ref: str, channel_id: str
    ) -> Exception:
        """What a failed deletion should be reported as.

        Only a wait survives as itself. Everything else — a refusal, a server
        error, a request that never came back — becomes `RemovalFailed`,
        because the caller does the same thing with all three: keep the settled
        card, record nothing, and ask again later. The uncertainty an uncertain
        *send* has to preserve does not arise here, since asking again about a
        deletion that did land is answered with "not found".
        """
        retry_after = _throttle_delay(error)
        if retry_after is not None:
            return RichContentThrottled(retry_after=retry_after, text="")
        return RemovalFailed(
            f"Mattermost would not delete post {message_ref} in channel "
            f"{channel_id}: {error}"
        )

    # ── Typing ───────────────────────────────────────────────────────────────

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        logger.debug("Mattermost set typing: %s", is_typing)
        if not is_typing:
            return
        await self._post_typing(channel_id, sender_name, None)

    async def _post_typing(
        self, channel_id: str, sender_name: str, thread_root_id: str | None
    ) -> None:
        """Tell Mattermost the agent's bot is typing, in a thread when given one.

        Mattermost expires the indicator on its own after a few seconds, so
        this is a one-shot nudge rather than something to switch off. Without
        `parent_id` it only ever shows at the channel root, which is the wrong
        place when the agent is answering inside a thread.
        """
        bot_info = self._agent_bots.get(sender_name)
        if not bot_info:
            logger.warning("No bot info found for sender name %s", sender_name)
            return

        bot_driver = self._bot_drivers.get(sender_name)
        loop = self._main_loop
        if not bot_driver or not loop:
            logger.warning("No bot driver found for sender name %s", sender_name)
            return

        body: dict[str, str] = {"channel_id": channel_id}
        if thread_root_id is not None:
            body["parent_id"] = thread_root_id

        try:
            await loop.run_in_executor(
                None,
                bot_driver.client.make_request,
                "post",
                f"/users/{bot_info['user_id']}/typing",
                body,
            )
        except Exception as e:
            logger.debug("Failed to send MM typing for %s: %s", sender_name, e)

    # ── The eyes on the message being worked on ──────────────────────────────

    async def _react_or_raise(
        self,
        agent_name: str,
        post_id: str,
        *,
        mark: ActivityMark,
        on: bool,
        force: bool,
    ) -> None:
        """Put 👀 on the post an agent is working on, and take it off after.

        Added by the agent's own bot rather than the bridge account, so the
        reaction says *which* agent picked the message up and two agents on one
        message read as two. This is the progress signal that always works:
        unlike the status post it needs no thread, and unlike the typing
        indicator it does not expire.

        `self._marked` is this process's memory of what it has already done,
        and a restart empties it while the reactions stay in the channel.
        `force` is for the caller that knows better from the journal: skipping
        the call because the set is empty would strand a 👀 on a turn that
        ended while the bridge was down. It is remembered per reaction: a
        queued prompt that starts running loses the hourglass and keeps the
        eyes, so one cannot answer for the other.

        A failure leaves that memory alone, so the next attempt is a real
        attempt rather than one the record talks out of trying. Removing a
        reaction Mattermost says is not there is the exception: the channel is
        already in the state being asked for, and there is nothing to retry.
        """
        key = (agent_name, post_id, mark)
        if not force and on == (key in self._marked):
            return

        bot_info = self._agent_bots.get(agent_name)
        driver = self._bot_drivers.get(agent_name)
        loop = self._main_loop
        if not bot_info or driver is None or loop is None:
            raise RuntimeError(f"no connected bot for {agent_name!r}")
        user_id = bot_info["user_id"]

        if on:
            await loop.run_in_executor(
                None,
                driver.reactions.create_reaction,
                {
                    "user_id": user_id,
                    "post_id": post_id,
                    "emoji_name": _REACTION[mark],
                },
            )
            self._marked.add(key)
            return
        try:
            await loop.run_in_executor(
                None,
                driver.reactions.delete_reaction,
                user_id,
                post_id,
                _REACTION[mark],
            )
        except ResourceNotFound:
            pass
        self._marked.discard(key)

    # ── Channel creation ──────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Cannot create channel: Mattermost client not connected")

        loop = self._main_loop

        if channel_type in ("group", "direct"):
            raise ValueError(
                f"Cannot create {channel_type} channels — they are initiated from the messaging platform"
            )

        mm_type = "P" if channel_type == "channel_private" else "O"
        channel_name = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")[:64]
        channel_id: str | None = None

        try:
            channel = await loop.run_in_executor(
                None,
                self._admin_driver.channels.create_channel,
                {
                    "team_id": self._team_id,
                    "name": channel_name,
                    "display_name": name,
                    "type": mm_type,
                    "purpose": topic,
                },
            )
            channel_id = channel["id"]
        except Exception as e:
            logger.debug(
                "Channel name '%s' taken, retrying with suffix: %s", channel_name, e
            )

        if channel_id is None:
            unique_name = f"{channel_name[:55]}-{uuid.uuid4().hex[:8]}"
            channel = await loop.run_in_executor(
                None,
                self._admin_driver.channels.create_channel,
                {
                    "team_id": self._team_id,
                    "name": unique_name,
                    "display_name": name,
                    "type": mm_type,
                    "purpose": topic,
                },
            )
            channel_id = channel["id"]

        await self._add_default_member(channel_id)
        return CreatedChannel(id=channel_id, name=channel.get("display_name") or name)

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """Archive the channel: Mattermost's channel DELETE archives unless
        asked to delete permanently."""
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Mattermost client not connected")
        try:
            await self._main_loop.run_in_executor(
                None, self._admin_driver.channels.delete_channel, external_channel_id
            )
        except Exception as e:
            return RetireOutcome.failed(
                f"Mattermost refused to archive the channel: {e}"
            )
        return RetireOutcome(outcome="archived")

    async def _add_default_member(self, channel_id: str) -> None:
        """Add the deployment's human account to a channel we just created.

        Public channels would let them join by navigating, but private ones
        would not — and a room created by an agent names no users, so nothing
        else would ever add them. Best-effort and loudly logged: the channel and
        room already exist by this point, so failing here should not undo them,
        but it does mean a human cannot see the room.
        """
        member = self._config.default_member
        if not member:
            return
        try:
            await self.add_users_to_channel(channel_id, [member], [])
        except Exception:
            logger.exception(
                "Failed to add default member '%s' to Mattermost channel %s — "
                "the room exists but no human is in its channel",
                member,
                channel_id,
            )

    async def check_channel_usable(self, channel_id: str) -> None:
        """The channel exists, is in this connection's team, and — when it is
        private — Switch's account is in it, since that account is the one that
        adds the agents."""
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            raise RuntimeError("Mattermost client not connected")
        try:
            channel = await loop.run_in_executor(
                None, driver.channels.get_channel, channel_id
            )
        except ResourceNotFound as error:
            raise ChannelNotUsable(
                f"Mattermost cannot find channel {channel_id}: {error}"
            ) from error
        except NotEnoughPermissions as error:
            raise ChannelNotUsable(
                f"Mattermost will not let Switch's account see channel "
                f"{channel_id}: {error}"
            ) from error
        except sync_requests.RequestException as error:
            # Any other refusal from Mattermost (the driver's errors are
            # requests' HTTPError) or a failed request: the platform's, not
            # the caller's. Anything else is a bug and propagates.
            raise BridgeOperationError(
                f"Mattermost would not describe channel {channel_id}: {error}"
            ) from error
        team_id = str(channel.get("team_id") or "")
        if team_id and self._team_id and team_id != self._team_id:
            raise ChannelNotUsable(
                f"Mattermost channel {channel_id} is in another team, not this "
                f"connection's team ({self._config.team_name})."
            )
        if self._to_channel_type(channel.get("type", "")) != "channel_private":
            return
        try:
            await loop.run_in_executor(
                None,
                driver.channels.get_channel_member,
                channel_id,
                self._admin_user_id,
            )
        except (ResourceNotFound, NotEnoughPermissions) as error:
            # Mattermost answers "not a member" with a 404, and may refuse to
            # say with a 403. Either way the fix is the same: add the account.
            raise ChannelNotUsable(
                f"Switch's Mattermost account is not in private channel "
                f"{channel_id}. Add it to the channel, then try again."
            ) from error
        except sync_requests.RequestException as error:
            raise BridgeOperationError(
                f"Mattermost would not say whether Switch's account is in "
                f"channel {channel_id}: {error}"
            ) from error

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Mattermost client not connected")
        channel = await self._main_loop.run_in_executor(
            None, self._admin_driver.channels.get_channel, channel_id
        )
        return self._to_channel_type(channel.get("type", ""))

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """`mattermost://<host>/<team>/channels/<name>` — opens the channel in
        the Mattermost desktop app. Mattermost channel URLs key off the channel
        *name* (slug), not its id, so resolve the name (cached) from the id."""
        if not external_channel_id or not self._admin_driver or not self._main_loop:
            return None
        name = self._channel_name_cache.get(external_channel_id)
        if name is None:
            try:
                channel = await self._main_loop.run_in_executor(
                    None, self._admin_driver.channels.get_channel, external_channel_id
                )
            except Exception:
                logger.warning(
                    "Failed to resolve Mattermost channel name for %s",
                    external_channel_id,
                )
                return None
            name = str(channel.get("name", ""))
            if not name:
                return None
            self._channel_name_cache[external_channel_id] = name
        # Prefer the public URL so the link resolves in the user's client; the
        # internal `url` may be a private/tailnet address they can't reach.
        base_url = self._config.public_url or self._config.url
        host = re.sub(r"^https?://", "", base_url).rstrip("/")
        return f"mattermost://{host}/{self._config.team_name}/channels/{name}"

    async def home_deeplink(self) -> str | None:
        """`mattermost://<host>/<team>` — the team's home in the desktop app.

        Uses `public_url` when set, for the same reason `channel_deeplink`
        does: `url` may be an address only Switch can reach. For the bundled
        deployment neither is reachable from a user's machine (`url` is the
        in-compose `http://mattermost:8065` and `public_url` is unset), so a
        client that knows where it published Mattermost should prefer its own
        origin over this."""
        base_url = self._config.public_url or self._config.url
        if not base_url or not self._config.team_name:
            return None
        host = re.sub(r"^https?://", "", base_url).rstrip("/")
        return f"mattermost://{host}/{self._config.team_name}"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                "Cannot add agents to channel: Mattermost client not connected"
            )

        logger.debug("Inviting agents %s to channel %s", agent_names, channel_id)
        loop = self._main_loop
        for agent_name in agent_names:
            bot_info = self._agent_bots.get(agent_name)
            if not bot_info:
                logger.warning(
                    "No Mattermost bot for agent '%s', cannot add to channel",
                    agent_name,
                )
                continue
            try:
                await loop.run_in_executor(
                    None,
                    self._admin_driver.channels.add_user,
                    channel_id,
                    {"user_id": bot_info["user_id"]},
                )
            except Exception as e:
                logger.warning(
                    "Failed to add agent '%s' to channel %s: %s",
                    agent_name,
                    channel_id,
                    e,
                )

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                "Cannot add users to channel: Mattermost client not connected"
            )

        loop = self._main_loop
        failed: list[str] = []
        # Mattermost resolves people by username and ignores the ids, and one
        # internal caller (the default-member add) has only a name to give — so
        # walk the names and reach for a paired id only if one was supplied.
        for index, username in enumerate(user_names):
            external_id = (
                user_external_ids[index] if index < len(user_external_ids) else username
            )
            try:
                user = await loop.run_in_executor(
                    None, self._admin_driver.users.get_user_by_username, username
                )
                await loop.run_in_executor(
                    None,
                    self._admin_driver.channels.add_user,
                    channel_id,
                    {"user_id": user["id"]},
                )
            except Exception:
                logger.exception(
                    "Failed to add user '%s' to Mattermost channel %s",
                    username,
                    channel_id,
                )
                failed.append(external_id)
        return failed

    async def get_external_user_id(self, username: str) -> str | None:
        """Resolve a platform username to its current user id, or None if the
        user does not exist. Used to rebind a human actor's ``external_user_id`` when
        Mattermost has been rebuilt and ids changed."""
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Mattermost client not connected")
        try:
            user = await self._main_loop.run_in_executor(
                None, self._admin_driver.users.get_user_by_username, username
            )
            return str(user["id"])
        except Exception:
            return None

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # The Mattermost calls inside yield, so two overlapping registrations
        # of one agent would each mint a token and open a second socket.
        async with self._identity_locks.setdefault(agent.agent_id, asyncio.Lock()):
            await self._create_agent_identity(agent.name, agent.description)

    async def check_agent_identity_name(self, agent_id: str, new_name: str) -> None:
        if not self._admin_driver or not self._main_loop:
            return
        # The plural lookup answers an empty list for a free username, where
        # the singular one answers 404 and the driver logs it as an error.
        users = await self._main_loop.run_in_executor(
            None, self._admin_driver.users.get_users_by_usernames, [new_name]
        )
        for user in users or []:
            user_id = str(user.get("id", ""))
            if not user_id or user_id in self._bot_id_to_username:
                continue
            raise AgentIdentityConflict(
                f"The Mattermost username '{new_name}' is already used by an "
                "account that is not a Switch agent. Pick another name."
            )

    async def rename_agent_identity(self, old_name: str, agent: AgentIdentity) -> None:
        """Rename the agent's bot in place: same account, new username.

        The username is the routing handle here, so it must follow the agent's
        name. Keeping the account keeps its channel memberships, its posts and
        its token, so nothing has to be re-provisioned."""
        async with self._identity_locks.setdefault(agent.agent_id, asyncio.Lock()):
            if not self._admin_driver or not self._main_loop:
                raise RuntimeError(
                    f"Cannot rename agent identity '{old_name}': adapter not started"
                )
            bot = self._agent_bots.get(old_name)
            bot_id = str(bot["bot_id"]) if bot else None
            if not self._listening:
                # The process holding the bridge renames the bot; this copy
                # only follows it under the new name.
                self._agent_bots.pop(old_name, None)
                if bot_id is not None:
                    self._bot_id_to_username.pop(bot_id, None)
                await self._create_agent_identity(agent.name, agent.description)
                return
            if bot_id is None:
                existing = await self._find_existing_bot(old_name)
                bot_id = str(existing["user_id"]) if existing else None
            if bot_id is None:
                await self._create_agent_identity(agent.name, agent.description)
                return

            label = (await self.agent_rendering(agent.name)).field_label
            await self._mm_api(
                "put",
                f"/bots/{bot_id}",
                {"username": agent.name, "display_name": label},
            )
            self._bot_id_to_username[bot_id] = agent.name
            logger.info(
                "Renamed Mattermost bot %s from %s to %s", bot_id, old_name, agent.name
            )
            if bot is None:
                # Found by its old username but never provisioned in this run:
                # adopt it under the new one, which gives it its token and
                # socket like any other agent's bot.
                await self._create_agent_identity(agent.name, agent.description)
                return
            self._agent_bots[agent.name] = {**bot, "username": agent.name}
            self._agent_bots.pop(old_name, None)
            driver = self._bot_drivers.pop(old_name, None)
            if driver is not None:
                self._bot_drivers[agent.name] = driver
            stop = self._ws_stops.pop(old_name, None)
            if stop is not None:
                self._ws_stops[agent.name] = stop

    async def update_agent_identity(self, agent: AgentIdentity) -> None:
        """Show the agent's new display name on its bot."""
        bot = self._agent_bots.get(agent.name)
        if bot is None or not self._listening:
            return
        label = (await self.agent_rendering(agent.name)).field_label
        await self._mm_api("put", f"/bots/{bot['bot_id']}", {"display_name": label})

    async def _create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                f"Cannot create agent identity '{agent_name}': adapter not started"
            )
        if agent_name in self._agent_bots:
            return

        loop = self._main_loop

        # The username is the routing handle — the mention, the member-list key
        # and the key this adapter adopts a bot back by — so it stays the
        # identifier. Only the bot's own display name carries the label.
        label = (await self.agent_rendering(agent_name)).field_label
        if label != agent_name:
            await self._warn_once_if_display_names_are_hidden()

        existing = await self._find_existing_bot(agent_name)
        if existing:
            bot_id: str = str(existing["user_id"])
            if existing.get("display_name") != label and self._listening:
                try:
                    await self._mm_api(
                        "put", f"/bots/{bot_id}", {"display_name": label}
                    )
                except Exception as e:
                    logger.exception(
                        "Failed to update the display name of Mattermost bot %s: %s",
                        agent_name,
                        e,
                    )
        else:
            try:
                bot = await self._mm_api(
                    "post",
                    "/bots",
                    {
                        "username": agent_name,
                        "display_name": label,
                        "description": f"Switch agent: {agent_description}",
                    },
                )
                bot_id = str(bot["user_id"])
            except Exception as e:
                # Another switch-core process may have created it a moment ago:
                # every process provisions its copy of the bridge.
                created = await self._find_existing_bot(agent_name)
                if created is None:
                    logger.exception(
                        "Failed to create Mattermost bot %s: %s", agent_name, e
                    )
                    return
                bot_id = str(created["user_id"])

        if not self._listening:
            # Known by id, for mentions and for telling its posts from people's.
            # The process holding the bridge posts as the bot and listens on
            # its socket.
            self._agent_bots[agent_name] = {
                "bot_id": bot_id,
                "user_id": bot_id,
                "username": agent_name,
            }
            self._bridge_bot_ids.add(bot_id)
            self._bot_id_to_username[bot_id] = agent_name
            logger.info("Found Mattermost bot identity %s (quiet)", agent_name)
            return

        try:
            token_resp = await self._mm_api(
                "post",
                f"/users/{bot_id}/tokens",
                {"description": f"Switch bridge token for {agent_name}"},
            )
            token: str = str(token_resp["token"])
        except Exception as e:
            logger.exception("Failed to create token for bot %s: %s", agent_name, e)
            return

        self._agent_bots[agent_name] = {
            "bot_id": bot_id,
            "user_id": bot_id,
            "token": token,
            "username": agent_name,
        }
        self._bridge_bot_ids.add(bot_id)
        self._bot_id_to_username[bot_id] = agent_name

        await self._set_bot_icon(bot_id, agent_name)

        bot_driver = self._create_driver(token=token)
        await loop.run_in_executor(None, bot_driver.login)
        self._bot_drivers[agent_name] = bot_driver

        try:
            await loop.run_in_executor(
                None,
                self._admin_driver.teams.add_user_to_team,
                self._team_id,
                {"team_id": self._team_id, "user_id": bot_id},
            )
        except Exception:
            pass

        stopped = threading.Event()
        self._ws_stops[agent_name] = stopped

        def _run_ws(driver: Driver = bot_driver, name: str = agent_name) -> None:
            async def _handler(event_data: str) -> None:
                if stopped.is_set():
                    return
                # Read per event: a rename moves the bot to a new name while
                # this socket keeps running.
                current = self._bot_id_to_username.get(bot_id, name)
                await self._ws_handler(event_data, current)

            if stopped.wait(1):
                return
            backoff = 2
            while not stopped.is_set():
                # `init_websocket` is synchronous: it runs the thread's current
                # loop until the socket closes, so each connection gets a loop
                # of its own, closed with it.
                ws_loop = asyncio.new_event_loop()
                asyncio.set_event_loop(ws_loop)
                try:
                    driver.init_websocket(_handler)
                except Exception as e:
                    reason = str(e)
                    backoff_next = min(backoff * 2, 30)
                else:
                    # It returns only once an established connection closed.
                    reason = "connection closed"
                    backoff, backoff_next = 2, 2
                finally:
                    _close_loop(ws_loop)
                if stopped.is_set():
                    break
                logger.debug(
                    "WebSocket for %s disconnected: %s, retrying in %ds",
                    name,
                    reason,
                    backoff,
                )
                stopped.wait(backoff)
                backoff = backoff_next

        ws_thread = threading.Thread(
            target=_run_ws, daemon=True, name=f"mm-ws-{agent_name}"
        )
        ws_thread.start()

        await self._bridge_channels_already_joined(agent_name, bot_id)

        logger.info("Created Mattermost bot identity: %s", agent_name)

    async def _bridge_channels_already_joined(
        self, agent_name: str, bot_id: str
    ) -> None:
        """Bridge the channels this bot is a member of but was never seen joining.

        A bot cannot witness its own joins: its websocket opens only after it has
        been added to the team, by which point Mattermost has already put it in
        the team's default channels. Those joins are therefore noticed only if
        some *other* agent's socket happens to be listening, which means the
        first agent on an instance bridges nothing at all and a later one drags
        the backlog in with it. Ask Mattermost outright instead of waiting to
        overhear it.

        Also runs for every known agent on startup, so a channel joined while the
        bridge was down is picked up rather than waiting for the next message in
        it.
        """
        loop = self._main_loop
        if self._on_agent_joined is None or self._admin_driver is None or loop is None:
            return
        try:
            channels = await loop.run_in_executor(
                None,
                self._admin_driver.channels.get_channels_for_user,
                bot_id,
                self._team_id,
            )
        except Exception:
            logger.exception(
                "Could not list Mattermost channels for agent %s", agent_name
            )
            return

        for channel in channels or []:
            channel_id = str(channel.get("id", ""))
            mm_type = str(channel.get("type", ""))
            if not channel_id or mm_type not in _JOINABLE_MM_CHANNEL_TYPES:
                continue
            try:
                await self._on_agent_joined(
                    InboundAgentJoin(
                        channel_id=channel_id,
                        channel_type=self._to_channel_type(mm_type),
                        agent_name=agent_name,
                        channel_name=str(channel.get("display_name", "")) or None,
                    )
                )
            except Exception:
                # One channel that cannot be bridged is not a reason to abandon
                # the rest, nor to fail the agent's registration.
                logger.exception(
                    "Could not bridge Mattermost channel %s for agent %s",
                    channel_id,
                    agent_name,
                )

    async def _ensure_admin_bot(self) -> None:
        """Provision the dedicated Switch Admin bot used to post admin/system
        messages in regular channels. Idempotent — reuses an existing bot."""
        loop = self._main_loop
        if loop is None or self._admin_driver is None:
            return
        username = "switch-admin"
        existing = await self._find_existing_bot(username)
        if existing:
            bot_id = str(existing["user_id"])
        elif not self._listening:
            # Created by the process holding the bridge; this one posts no
            # notices.
            return
        else:
            try:
                bot = await self._mm_api(
                    "post",
                    "/bots",
                    {
                        "username": username,
                        "display_name": "Switch",
                        "description": "Switch system / admin notices",
                    },
                )
                bot_id = str(bot["user_id"])
            except Exception:
                logger.exception("Failed to create Switch Admin bot")
                return
        if not self._listening:
            self._admin_bot_id = bot_id
            self._bridge_bot_ids.add(bot_id)
            return
        try:
            token_resp = await self._mm_api(
                "post",
                f"/users/{bot_id}/tokens",
                {"description": "Switch admin bot token"},
            )
            token = str(token_resp["token"])
        except Exception:
            logger.exception("Failed to create token for Switch Admin bot")
            return

        self._admin_bot_id = bot_id
        self._bridge_bot_ids.add(bot_id)

        driver = self._create_driver(token=token)
        await loop.run_in_executor(None, driver.login)
        self._admin_bot_driver = driver

        try:
            await loop.run_in_executor(
                None,
                self._admin_driver.teams.add_user_to_team,
                self._team_id,
                {"team_id": self._team_id, "user_id": bot_id},
            )
        except Exception:
            pass

        logger.info("Created Switch Admin bot identity")

    async def _ensure_admin_bot_in_channel(self, channel_id: str) -> None:
        """Add the Switch Admin bot to a channel so it can post there. A bot
        must be a member to post; this is idempotent (a re-add is a no-op)."""
        if (
            self._admin_bot_id is None
            or self._admin_driver is None
            or self._main_loop is None
        ):
            return
        try:
            await self._main_loop.run_in_executor(
                None,
                self._admin_driver.channels.add_user,
                channel_id,
                {"user_id": self._admin_bot_id},
            )
        except Exception:
            # Already a member, or a transient error — the post attempt that
            # follows will surface a real failure.
            pass

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        self._close_bot_socket(agent.name)
        self._agent_bots.pop(agent.name, None)
        self._bot_drivers.pop(agent.name, None)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Cannot resolve channel agents: adapter not started")

        members = await self._main_loop.run_in_executor(
            None, self._admin_driver.channels.get_channel_members, channel_id
        )
        agent_names = []
        for member in members:
            member_id = member.get("user_id", "")
            bot_name = self._bot_id_to_username.get(member_id)
            if bot_name:
                agent_names.append(bot_name)
        return agent_names

    async def _read_name_display_setting(self) -> str | None:
        """`TeamSettings.TeammateNameDisplay`, read at most once per run.

        None when the read could not answer — the server config is readable
        only by a system admin, and an agent's bot is worth having either
        way, so the caller reports the blind spot instead of failing on it."""
        if self._name_display_read:
            return self._name_display_setting
        self._name_display_read = True
        try:
            config = await self._mm_api("get", "/config")
            setting = (config.get("TeamSettings") or {}).get("TeammateNameDisplay")
        except Exception as e:
            logger.warning(
                "Could not read the Mattermost server config (%s), so whether "
                "agent display names are rendered on this server is unknown",
                e,
            )
            return None
        if not isinstance(setting, str):
            logger.warning(
                "The Mattermost server config carries no "
                "TeamSettings.TeammateNameDisplay, so whether agent display "
                "names are rendered on this server is unknown"
            )
            return None
        self._name_display_setting = setting
        return setting

    async def _warn_once_if_display_names_are_hidden(self) -> None:
        """Say so when this server will store an agent's display name and show
        nobody. Mattermost renders a bot under its username unless the server
        is told otherwise, so a display name Switch sets can be invisible with
        nothing about the write itself failing."""
        if self._name_display_warned:
            return
        setting = await self._read_name_display_setting()
        if setting is None or setting in _NAME_DISPLAY_SHOWS_LABEL:
            return
        self._name_display_warned = True
        logger.warning(
            "Mattermost TeamSettings.TeammateNameDisplay is '%s', so agent "
            "display names will not appear in the post header on this server — "
            "set it to 'full_name' or 'nickname_full_name' to render them",
            setting,
        )

    # ── Bot icons ────────────────────────────────────────────────────────────

    async def _fetch_icon(self, url: str) -> bytes | None:
        """The icon's bytes, or None if it is larger than the ceiling."""
        async with guarded_async_client(
            self.outbound_policy, follow_redirects=False, timeout=10.0
        ) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                chunks: list[bytes] = []
                size = 0
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > _MAX_BOT_ICON_BYTES:
                        return None
                    chunks.append(chunk)
        return b"".join(chunks)

    async def _set_bot_icon(self, bot_id: str, agent_name: str) -> None:
        if not self._admin_driver or not self._main_loop:
            logger.error("[BOT-ICON] skipping %s: no driver or loop", agent_name)
            return
        driver = self._admin_driver
        try:
            url = await self.agent_icon_url(agent_name)
            if url is None:
                # Nothing is uploaded, so the bot keeps the image it has: the
                # default for a new bot, or whatever an earlier start set.
                logger.debug(
                    "[BOT-ICON] no icon to send for %s; leaving the bot's current image",
                    agent_name,
                )
                return
            logger.debug("[BOT-ICON] fetching avatar for %s", agent_name)
            # This is the one place Switch dereferences an agent's icon URL
            # rather than handing it to a platform, so the fetch is bounded:
            # only addresses the outbound policy allows, checked as the
            # connection is made (validation at write time cannot see what a
            # name resolves to later), no redirects, and a size ceiling
            # enforced while reading rather than after.
            image_bytes = await self._fetch_icon(url)
            if image_bytes is None:
                logger.error(
                    "[BOT-ICON] icon for %s is over the %d byte limit — "
                    "leaving the current icon in place",
                    agent_name,
                    _MAX_BOT_ICON_BYTES,
                )
                return
            logger.debug(
                "[BOT-ICON] fetched %d bytes for %s", len(image_bytes), agent_name
            )

            def _upload(data: bytes = image_bytes) -> None:
                base_url = driver.client.url
                token = driver.client.token
                upload_url = f"{base_url}/users/{bot_id}/image"
                r = sync_requests.post(
                    upload_url,
                    headers={"Authorization": f"Bearer {token}"},
                    files={"image": ("icon.png", data, "image/png")},
                    allow_redirects=False,
                    timeout=_MM_REQUEST_TIMEOUT_SECONDS,
                )
                if not r.ok:
                    logger.error(
                        "[BOT-ICON] upload failed for %s: %s %s",
                        bot_id,
                        r.status_code,
                        r.text[:200],
                    )
                r.raise_for_status()

            await self._main_loop.run_in_executor(None, _upload)
            logger.debug(
                "[BOT-ICON] uploaded icon for %s (bot_id=%s)", agent_name, bot_id
            )
        except Exception:
            logger.exception("[BOT-ICON] failed to set icon for %s", agent_name)

    # ── Translation ──────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return re.sub(r"@(\w+):\S+", r"@\1", content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    # ── WebSocket handling ───────────────────────────────────────────────────

    def _first_sighting(self, post_id: str) -> bool:
        """Whether this post is new to the bridge. Every agent's bot holds a
        socket of its own, so a post in a channel several of them are in
        arrives once per bot."""
        with self._seen_lock:
            if post_id in self._seen_post_ids:
                return False
            self._seen_post_ids[post_id] = None
            if len(self._seen_post_ids) > self._seen_post_ids_max:
                self._seen_post_ids.popitem(last=False)
            return True

    async def _handle_display_name_change(self, post: dict[str, Any]) -> None:
        """Mattermost posts a system line into a channel whose display name
        changed, carrying the old and the new one. The display name is what
        a room adopted from the channel is named after, so it is what the room
        follows. Runs on a bot's socket loop, so the bridge is handed the
        rename on the main loop, as a message is."""
        if not self._first_sighting(post.get("id", "")):
            return
        props = post.get("props") or {}
        channel_id = str(post.get("channel_id") or "")
        new_name = str(props.get("new_displayname") or "")
        if not channel_id or not new_name:
            logger.warning(
                "Mattermost display-name change without a channel or a new "
                "name, skipping post %s",
                post.get("id"),
            )
            return
        loop = self._main_loop
        if loop is None:
            raise RuntimeError("Cannot handle a channel rename: adapter not started")
        if self._on_channel_named is not None:
            self._dispatch(
                self._on_channel_named(
                    channel_id, str(props.get("old_displayname") or ""), new_name
                ),
                loop,
            )

    async def _ws_handler(self, event_data: str, agent_name: str) -> None:
        try:
            event = json.loads(event_data)
        except (json.JSONDecodeError, TypeError):
            return

        event_type = event.get("event")

        if event_type == "user_added":
            await self._handle_user_added(event)
            return

        if event_type != "posted":
            return

        data = event.get("data", {})
        post_str = data.get("post")
        if not post_str:
            return

        try:
            post = json.loads(post_str)
        except (json.JSONDecodeError, TypeError):
            return

        user_id = post.get("user_id", "")
        post_type = post.get("type", "")
        if post_type == "system_displayname_change":
            await self._handle_display_name_change(post)
            return
        if post_type:
            return

        if user_id in self._bridge_bot_ids or user_id == self._admin_user_id:
            return

        post_id = post.get("id", "")
        if not self._first_sighting(post_id):
            return

        channel_id = post.get("channel_id", "")
        message = post.get("message", "")
        # Mattermost sets root_id to the thread root for replies, "" otherwise.
        root_id = post.get("root_id", "") or None
        mm_channel_type = data.get("channel_type", "")
        channel_name = str(data.get("channel_display_name", "")) or None

        loop = self._main_loop
        if loop is None or self._admin_driver is None:
            raise RuntimeError("Cannot handle posted event: adapter not started")

        ws_loop = asyncio.get_event_loop()
        user_is_bot = False
        try:
            user = await ws_loop.run_in_executor(
                None, self._admin_driver.users.get_user, user_id
            )
            username: str = user.get("username", user_id)
            user_is_bot = bool(user.get("is_bot", False))
        except Exception:
            logger.exception("Failed to resolve Mattermost user %s", user_id)
            username = user_id
        props = post.get("props") or {}
        from_webhook = str(props.get("from_webhook", "")).lower() == "true"
        # An integration rather than a person: an incoming webhook, or a bot
        # account other than the bridge's own (those never reach here).
        sender_is_app = (
            from_webhook
            or user_is_bot
            or str(props.get("from_bot", "")).lower() == "true"
        )
        if from_webhook:
            # An incoming webhook's post (or a custom slash command's reply)
            # carries the user id of whoever set the integration up, though
            # anyone holding its URL may have sent it. It is the integration
            # talking, not that person, so it goes under a stand-in of its own
            # that no link and no owner rule can match (CHOO-3881). One per
            # person, named after them, since every webhook they set up posts
            # under their id and the name a post gives itself is the sender's
            # to choose.
            user_id = f"{_WEBHOOK_STAND_IN_PREFIX}{user_id}"
            username = f"{username}'s webhook"

        channel_type = self._to_channel_type(mm_channel_type)
        stripped = message.strip()

        logger.debug(
            "[MM-INBOUND] post_id=%s channel=%s user=%s msg=%s",
            post_id,
            channel_id,
            username,
            message[:80],
        )

        if stripped.startswith("!") and self._on_command:
            parts = stripped.split(None, 1)
            command = parts[0].lstrip("!")
            args = parts[1].strip() if len(parts) > 1 else ""
            coro = self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=user_id,
                    sender_name=username,
                    command=command,
                    args=args,
                    message_ref=post_id or None,
                    root_id=root_id,
                    agent_name=agent_name,
                    channel_name=channel_name,
                )
            )
            self._dispatch(coro, loop)  # type: ignore[arg-type]
            return

        if self._on_message:
            attachments, attachment_failures = await self._fetch_attachments(
                post.get("file_ids", []), ws_loop
            )
            inbound = InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=user_id,
                sender_name=username,
                content=message,
                message_ref=post_id,
                root_id=root_id,
                agent_name=agent_name,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=attachment_failures,
                sender_is_app=sender_is_app,
            )
            coro = self._on_message(inbound)
            self._dispatch(coro, loop)  # type: ignore[arg-type]

    async def _fetch_attachments(
        self, file_ids: list[str], loop: asyncio.AbstractEventLoop
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download every attachment for a post's file ids, whatever the type.

        Metadata and bytes are fetched via the admin driver off the websocket
        loop. Returns the downloaded attachments and, separately, the ones that
        could not be relayed (oversize, download failure) so the bridge can
        disclose them in the room rather than dropping them silently.
        """
        if not file_ids or self._admin_driver is None:
            return [], []

        driver = self._admin_driver
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for file_id in file_ids:
            filename = file_id
            try:
                meta = await loop.run_in_executor(
                    None, driver.files.get_file_metadata, file_id
                )
                mimetype = str(meta.get("mime_type", "")) or "application/octet-stream"
                filename = str(meta.get("name", file_id))
                size = meta.get("size")
                if isinstance(size, int) and size > self._max_attachment_bytes:
                    logger.warning(
                        "[MM-INBOUND] attachment %s is %d bytes, over the %d cap",
                        filename,
                        size,
                        self._max_attachment_bytes,
                    )
                    failures.append(
                        AttachmentFailure(
                            filename=filename,
                            reason=f"{size} bytes exceeds the {self._max_attachment_bytes} byte limit",
                        )
                    )
                    continue
                resp = await loop.run_in_executor(None, driver.files.get_file, file_id)
                data: bytes = resp.content
            except Exception as exc:
                logger.exception(
                    "[MM-INBOUND] failed to download attachment %s", file_id
                )
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"download failed: {exc}"
                    )
                )
                continue
            if len(data) > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{len(data)} bytes exceeds the {self._max_attachment_bytes} byte limit",
                    )
                )
                continue
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
            )
        return attachments, failures

    async def _handle_user_added(self, event: dict[str, Any]) -> None:
        data: dict[str, Any] = event.get("data", {})
        user_id = str(data.get("user_id", ""))
        if not user_id:
            return

        broadcast: dict[str, Any] = event.get("broadcast", {})
        channel_id = str(broadcast.get("channel_id", ""))
        if not channel_id:
            logger.error("user_added event missing channel_id (user=%s)", user_id)
            return

        loop = self._main_loop
        if loop is None or self._admin_driver is None:
            raise RuntimeError("Cannot handle user_added: adapter not started")

        ws_loop = asyncio.get_event_loop()
        channel = await ws_loop.run_in_executor(
            None, self._admin_driver.channels.get_channel, channel_id
        )
        channel_type = self._to_channel_type(channel.get("type", ""))
        channel_name = str(channel.get("display_name", "")) or None

        agent_name = self._bot_id_to_username.get(user_id)
        if agent_name:
            if not self._on_agent_joined:
                logger.error("No on agent joined available for bridge")
                return
            coro = self._on_agent_joined(
                InboundAgentJoin(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    agent_name=agent_name,
                    channel_name=channel_name,
                )
            )
            self._dispatch(coro, loop)  # type: ignore[arg-type]
            return

        if user_id == self._admin_user_id:
            return

        if not self._on_user_joined:
            return

        try:
            user = await ws_loop.run_in_executor(
                None, self._admin_driver.users.get_user, user_id
            )
            username: str = user.get("username", user_id)
        except Exception:
            logger.exception("Failed to resolve Mattermost user %s", user_id)
            return

        coro = self._on_user_joined(
            InboundUserJoin(
                channel_id=channel_id,
                channel_type=channel_type,
                external_user_id=user_id,
                external_username=username,
                channel_name=channel_name,
            )
        )
        self._dispatch(coro, loop)  # type: ignore[arg-type]

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        # Switch hears Mattermost through its agents' bots, so a channel with no
        # agent in it is one where nothing reaches Switch, and someone linking
        # while they set up a server may have no agent anywhere yet.
        return (
            f"Post `!link-account {code}` from that account in a Mattermost "
            "channel that has a Switch agent in it. No agent yet? Add one first, "
            "then get a new code here."
        )

    @classmethod
    def unlinkable_account_reason(cls, external_user_id: str) -> str | None:
        if external_user_id.startswith(_WEBHOOK_STAND_IN_PREFIX):
            return (
                "This stands for a Mattermost webhook, which anyone holding "
                "its URL can post through."
            )
        return None

    async def account_unlinkable_reason(self, external_user_id: str) -> str | None:
        reason = self.unlinkable_account_reason(external_user_id)
        if reason is not None:
            return reason
        driver = self._admin_driver
        if driver is None:
            raise RuntimeError(
                "The Mattermost bridge is not started, so it cannot be asked"
            )
        try:
            user = await asyncio.to_thread(driver.users.get_user, external_user_id)
        except ResourceNotFound as e:
            raise LookupError(
                f"No Mattermost account {external_user_id} exists on this server"
            ) from e
        except sync_requests.RequestException as e:
            raise RuntimeError(
                f"Could not ask Mattermost about account {external_user_id}: {e}"
            ) from e
        if user.get("is_bot"):
            return "This is a Mattermost bot's account, which whoever runs it posts as."
        return None

    async def account_id_for_session(self, token: str) -> str:
        driver = self._create_driver(token=token)
        try:
            me = await asyncio.to_thread(driver.login)
        except NoAccessTokenProvided as e:
            raise PermissionError("Mattermost did not accept that session token") from e
        except sync_requests.RequestException as e:
            raise RuntimeError(
                f"Could not ask Mattermost whose session token that is: {e}"
            ) from e
        user_id = me.get("id") if isinstance(me, dict) else None
        if not user_id:
            raise RuntimeError("Mattermost did not say whose session token that is")
        return str(user_id)

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Find team members via Mattermost's own user search.

        Scoped to the bridge's team, and bots are dropped — a bot is not a
        person who can own an agent.
        """
        term = query.strip()
        if not term:
            return []

        try:
            async with asyncio.timeout(_CONNECT_WAIT_SECONDS):
                await self._connected.wait()
        except TimeoutError:
            raise RuntimeError(
                "The Mattermost bridge is not connected yet, so its directory "
                f"cannot be searched; it did not connect within {_CONNECT_WAIT_SECONDS:.0f}s."
            ) from None
        driver = self._admin_driver
        if driver is None or self._main_loop is None:
            raise RuntimeError("Mattermost adapter is not started")
        try:
            found = await self._main_loop.run_in_executor(
                None,
                driver.users.search_users,
                {"term": term, "team_id": self._team_id, "allow_inactive": False},
            )
        except Exception as e:
            raise RuntimeError(f"Mattermost user directory lookup failed: {e}") from e

        results: list[DirectoryUser] = []
        for user in found or []:
            if user.get("is_bot"):
                continue
            username = user.get("username", "") or ""
            first = user.get("first_name", "") or ""
            last = user.get("last_name", "") or ""
            full_name = " ".join(part for part in (first, last) if part)
            results.append(
                DirectoryUser(
                    external_user_id=str(user.get("id")),
                    username=username,
                    display_name=(user.get("nickname") or full_name or username),
                    email=user.get("email") or None,
                )
            )
        results.sort(key=lambda u: u.display_name.lower())
        return results

    @staticmethod
    def _to_channel_type(mm_type: str) -> ChannelType:
        if mm_type == "D":
            return "direct"
        if mm_type == "G":
            return "group"
        if mm_type == "P":
            return "channel_private"
        return "channel_public"

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _dispatch(self, coro: Any, loop: asyncio.AbstractEventLoop) -> None:
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        future.add_done_callback(self._on_dispatch_done)

    @staticmethod
    def _on_dispatch_done(future: Any) -> None:
        exc = future.exception()
        if exc is not None:
            logger.error("Dispatched coroutine failed: %s", exc, exc_info=exc)

    def _create_driver(
        self,
        login_id: str | None = None,
        password: str | None = None,
        token: str | None = None,
    ) -> Driver:
        url = self._config.url.rstrip("/")
        scheme = "https" if url.startswith("https") else "http"
        host = re.sub(r"^https?://", "", url)
        port = 443 if scheme == "https" else 8065

        if ":" in host:
            host, port_str = host.rsplit(":", 1)
            port = int(port_str)

        opts: dict[str, object] = {
            "url": host,
            "scheme": scheme,
            "port": port,
            "verify": self._config.verify_tls,
            "request_timeout": _MM_REQUEST_TIMEOUT_SECONDS,
            "websocket_kw_args": {
                "create_connection": _BotSocketConnection,
                "close_timeout": _MM_SOCKET_CLOSE_TIMEOUT_SECONDS,
            },
        }
        if token:
            opts["token"] = token
        elif login_id and password:
            opts["login_id"] = login_id
            opts["password"] = password

        return Driver(opts, client_cls=NoRedirectClient)

    async def _mm_api(
        self, method: str, endpoint: str, data: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        # On a thread: the driver is blocking, and on the event loop one slow
        # Mattermost response would stall every agent and bridge in Switch.
        return await asyncio.to_thread(self._mm_api_blocking, method, endpoint, data)

    def _mm_api_blocking(
        self, method: str, endpoint: str, data: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if self._admin_driver is None:
            raise RuntimeError("Admin driver not initialized")
        try:
            resp = self._admin_driver.client.make_request(
                method, endpoint, options=data
            )
        except NoAccessTokenProvided:
            logger.warning("Mattermost session expired, re-authenticating")
            self._admin_driver.login()
            resp = self._admin_driver.client.make_request(
                method, endpoint, options=data
            )
        return resp.json()  # type: ignore[no-any-return]

    async def _find_existing_bot(self, username: str) -> dict[str, Any] | None:
        """The bot named `username`, or None when Mattermost has no such bot.

        A failed lookup raises instead of answering None: both callers read
        None as "this bot does not exist yet" and go on to create it, so a
        session expiry or a 500 that collapsed into None turned into a
        username-taken failure with the real cause unrecorded."""
        try:
            page = 0
            per_page = 200
            while True:
                result = await self._mm_api(
                    "get",
                    f"/bots?include_deleted=true&page={page}&per_page={per_page}",
                )
                bots: list[dict[str, Any]] = result  # type: ignore[assignment]
                for bot in bots:
                    if bot.get("username") == username:
                        if bot.get("delete_at", 0) > 0:
                            await self._mm_api("post", f"/bots/{bot['user_id']}/enable")
                        return bot
                if len(bots) < per_page:
                    break
                page += 1
        except Exception:
            logger.exception(
                "Failed to look up the Mattermost bot %s; this is not the same "
                "answer as 'no such bot'",
                username,
            )
            raise
        return None

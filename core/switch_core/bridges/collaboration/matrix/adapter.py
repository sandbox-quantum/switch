"""Matrix: rooms on any homeserver, through a bot account the operator creates.

This is a client of somebody else's homeserver, reached over the
Client-Server API with the bot's access token. It has nothing to do with how
Switch itself works: Switch's message bus is PostgreSQL, and names such as
`matrix_room_id` or `m.room.message` inside Switch are kept identifiers and
wire shapes from when it ran on Matrix, not a server this adapter talks to.
To keep the two apart, everything here says *homeserver* or *external*, and
nothing outside this folder knows the platform is Matrix.

How it works:

- **Events** arrive by long-polling `/sync`, on the one process that holds the
  bridge (`keeps_quiet_unless_listening`). Every other copy only calls the API.
- **Where it got to** is the sync position (`next_batch`), kept in the bot's own
  account data on the homeserver, under a type named for the bridge. It is
  written after each batch has been handed to Switch, so a restart or a move to
  another process resumes from there. A batch interrupted before its position
  was written is delivered again, and writes nothing twice, because every
  message is handed over with its Matrix event id as its reference. An event
  Switch could not take holds the position back. A batch none of whose events
  reached Switch is held for as long as that lasts; one event failing beside
  others that went through is given up on alone after a few tries, by name,
  in the log (`_hold_batch`).
- **The bot account** is what a connection claims (`claimed_workspace`): two
  connections on one account would both relay every room it is in.
- **The first start** takes the current position without reading history, so
  connecting a bot that is already in busy rooms does not replay them.
- **Memory** holds only what can be read again from the homeserver: a room's
  name and type, the server's upload limit, the handles seen so far.
- **Encrypted rooms are refused.** The bot cannot read or write end-to-end
  encrypted messages, so on an invite to an encrypted room, or when encryption
  is turned on in a room it bridges, it says so in a plain notice and leaves.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, ClassVar
from urllib.parse import quote, urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.matrix.chunking import (
    MAX_BODY_BYTES,
    split_message,
)
from switch_core.bridges.collaboration.matrix.client import (
    HomeserverApi,
    MatrixApiError,
    MediaTooLarge,
    NotAMatrixAnswer,
    open_http,
)
from switch_core.bridges.collaboration.matrix.formatting import (
    PERMALINK,
    USER_ID_RE,
    pill,
    render,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
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
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import (
    MARKDOWN,
    Markup,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.clients.mentions import mention_regex
from switch_core.outbound import guarded_async_client

logger = logging.getLogger(__name__)

#: Said in a room the bot will not bridge because it is end-to-end encrypted.
ENCRYPTED_ROOM_NOTICE = (
    "This room is end-to-end encrypted. Switch cannot read or send encrypted "
    "messages, so it will not bridge this room and is leaving it. To talk to "
    "Switch agents, invite this account to a room without encryption."
)

# Where the bridge's sync position is kept: account data of the bot's own,
# one type per bridge so two connections sharing a bot cannot overwrite each
# other's place.
_SYNC_POSITION_TYPE = "com.switch.matrix.sync.{bridge_id}"

# Carried in the content of every publication (a request card or a turn's
# status), invisible to readers: its token, so `find_request_card` can find a
# post whose send was never acknowledged, and its kind, so a reaction is only
# ever read as an answer on a card.
_PUBLICATION_KEY = "com.switch.publication"

# Written into `m.room.create` of the rooms Switch creates, so their type is
# read from the room rather than guessed from its members.
_CHANNEL_TYPE_KEY = "com.switch.channel_type"

# On everything the bridge posts, so another Switch bridge in the room (on
# another account, or another deployment's) reads it as an app's message.
_RELAYED_KEY = "com.switch.relayed"

_SYNC_TIMEOUT_MS = 30_000
# Enough of a room's timeline in one batch for an ordinary gap; a longer one is
# filled in from `/messages` (`_backfill`).
_TIMELINE_LIMIT = 50
_BACKFILL_PAGE = 100
_BACKFILL_PAGES = 20
_RETRY_BASE_SECONDS = 1.0
_RETRY_MAX_SECONDS = 60.0
_TYPING_MS = 30_000
# Consecutive sync failures after which the connection says so in Console.
_ATTENTION_AFTER = 3
# How many times one event is tried, while others in its batch reach Switch or
# when the homeserver turned it down for good, before it alone is given up on.
# A batch none of whose events reach Switch for any other reason is held for as
# long as it takes (`_hold_batch`).
_HANDLER_ATTEMPTS = 3
# The events that, handled without error, have reached Switch.
_HANDED_TYPES = frozenset({"m.room.message", "m.reaction"})
# The most a reply, a card and its reactions, or a file may spend waiting out
# rate limits in all; past it, the send fails visibly rather than stall.
_SEND_RATE_BUDGET_SECONDS = 60.0
# How long a room's encryption state, or the upload limit, is trusted for.
_ENCRYPTION_TTL_SECONDS = 60.0
_UPLOAD_LIMIT_TTL_SECONDS = 3600.0
# Replies whose thread was looked up, so a busy reply chain costs one read; and
# reaction targets read, so keycaps on one card cost one read between them.
_THREAD_CACHE_MAX = 1000
_CARD_CACHE_MAX = 1000
# How many events around a plain reply are asked for when checking it is the
# first reply to a card; a homeserver returns about half of them from before it.
_FIRST_REPLY_CONTEXT = 100

# The reactions a card offers, one per option, in the order the options are
# numbered. Ten, because that is how many keycaps there are.
_KEYCAPS = (
    "1\ufe0f\u20e3",
    "2\ufe0f\u20e3",
    "3\ufe0f\u20e3",
    "4\ufe0f\u20e3",
    "5\ufe0f\u20e3",
    "6\ufe0f\u20e3",
    "7\ufe0f\u20e3",
    "8\ufe0f\u20e3",
    "9\ufe0f\u20e3",
    "\U0001f51f",
)
_MARKS: dict[str, str] = {"working": "\U0001f440", "queued": "\u23f3"}

_TEXT_TYPES = frozenset({"m.text", "m.notice", "m.emote"})
_MEDIA_TYPES = frozenset({"m.image", "m.file", "m.audio", "m.video"})

_ROOM_EVENT_TYPES = [
    "m.room.message",
    "m.reaction",
    "m.room.encryption",
    "m.room.member",
    "m.room.name",
    "m.room.join_rules",
    "m.room.tombstone",
]
_STATE_TYPES = [
    "m.room.encryption",
    "m.room.member",
    "m.room.name",
    "m.room.join_rules",
    "m.room.tombstone",
]

_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# A server name is a DNS name, an IPv4 address or a bracketed IPv6 one, with
# an optional port.
_USER_ID_SHAPE = re.compile(
    r"@[^:\s]+:(?:\[[0-9A-Fa-f:.]+\]|[^\s:\[\]]+)(?::[0-9]{1,5})?"
)


def _same_account(one: str, other: str) -> bool:
    """Whether two Matrix IDs name one account. Server names are DNS names,
    so case does not matter there; historical localparts may carry capitals,
    and two spellings of one are not two accounts to Switch either."""
    return one.casefold() == other.casefold()


_CLIENT_ADDRESS_HINT = (
    "Use the address Matrix clients use, which often starts with matrix. and "
    "is listed at https://<server name>/.well-known/matrix/client."
)


def _not_a_homeserver(url: str, error: MatrixApiError) -> str:
    return (
        f"The server at {url} is not a Matrix homeserver's client API: it "
        f"answered with {error.error or error.status}. Did you enter the server "
        f"name? {_CLIENT_ADDRESS_HINT}"
    )


def _strip_variation(key: str) -> str:
    return key.replace("\ufe0f", "")


_KEYCAP_POSITIONS = {
    _strip_variation(key): position for position, key in enumerate(_KEYCAPS, start=1)
}


class MatrixConnectionConfig(BridgeConnectionConfig):
    homeserver_url: str = Field(
        title="Homeserver URL",
        description=(
            "The address of the bot account's homeserver, as its clients use it "
            "(for example https://matrix.example.org). Not the server name in "
            "the user id, where the two differ."
        ),
    )
    bot_user_id: str = Field(
        title="Bot user ID",
        description=(
            "The bot account's full Matrix ID, such as @switch:example.org. "
            "Switch checks the access token belongs to it, and connects each "
            "account only once."
        ),
    )
    access_token: str = Field(
        title="Access token",
        description=(
            "The bot account's access token. In Element: Settings, Help & "
            "About, Advanced, Access Token. Signing that session out revokes it."
        ),
    )
    accept_invites_from_other_servers: bool = Field(
        default=False,
        title="Accept invites from other homeservers",
        description=(
            "Let people on other homeservers invite the bot into their rooms. "
            "Off, only accounts on the bot's own homeserver can."
        ),
    )

    @field_validator("homeserver_url")
    @classmethod
    def _an_https_server(cls, value: str) -> str:
        """The address the token is sent to, so it has to be https.

        Plain http is accepted for a homeserver on this machine only, which is
        what local development runs.
        """
        url = value.strip().rstrip("/")
        parts = urlsplit(url)
        if not parts.hostname:
            raise ValueError("homeserver_url must be a URL naming the homeserver")
        if parts.scheme != "https" and not (
            parts.scheme == "http" and parts.hostname in _LOCAL_HOSTS
        ):
            raise ValueError(
                "homeserver_url must use https: the access token is sent to it "
                "on every request"
            )
        if parts.query or parts.fragment or parts.username or parts.password:
            raise ValueError(
                "homeserver_url is the server's base address, with no query, "
                "fragment or credentials in it"
            )
        try:
            parts.port
        except ValueError as exc:
            raise ValueError(f"homeserver_url has an invalid port: {exc}") from exc
        return url

    @field_validator("bot_user_id")
    @classmethod
    def _a_user_id(cls, value: str) -> str:
        user_id = value.strip()
        if not _USER_ID_SHAPE.fullmatch(user_id):
            raise ValueError(
                "bot_user_id must be a full Matrix ID, such as @switch:example.org"
            )
        return user_id

    @field_validator("access_token")
    @classmethod
    def _a_token(cls, value: str) -> str:
        token = value.strip()
        if not token or any(character.isspace() for character in token):
            raise ValueError("access_token must be the token alone, with no spaces")
        return token


@dataclass(frozen=True)
class _RoomInfo:
    name: str | None
    channel_type: ChannelType
    encrypted: bool


@dataclass(frozen=True)
class _Card:
    """What a press on one of the bot's request cards answers."""

    token: str
    thread_ref: str | None


@dataclass(frozen=True)
class _Drawn:
    text: str
    controls: tuple[str, ...]


@dataclass(frozen=True)
class _BatchOutcome:
    #: Whether the batch had anything in it, so its position is worth storing.
    carried: bool
    #: What could not be handed to Switch, by event id where there is one.
    failed: list[str]
    #: How many events were handed to Switch.
    succeeded: int


class EncryptedRoomRefused(BridgeOperationError):
    """Switch will not send into this room: it is end-to-end encrypted.

    Anything the bridge sends is plain text, which in an encrypted room would
    reach every member's client unencrypted, beside messages they were told
    are private.
    """


def _label(event: dict[str, Any]) -> str:
    """How a failed event is named in the log: its id, or its type without one."""
    return str(event.get("event_id") or event.get("type") or "event")


def _reason(error: BaseException) -> str:
    return str(error) or type(error).__name__


def _refused_by_homeserver(error: BaseException | None) -> bool:
    """Whether the homeserver turned down a request about one event for good.

    Not found, forbidden, malformed: asking again gets the same answer, so it is
    the event that failed, not Switch. A rate limit, a rejected token, a server
    error or no answer at all says nothing about the event.
    """
    return (
        isinstance(error, MatrixApiError)
        and 400 <= error.status < 500
        and not error.rate_limited
        and not error.rejects_token
    )


class MatrixAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Matrix"
    # A bot can leave a room; deleting one is not something Matrix has.
    channel_on_delete = "left"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # Clients link http(s) and a few others, and drop the rest from HTML.
    renders_custom_url_schemes: ClassVar[bool] = False

    draws_session_activity: ClassVar[bool] = True
    #: An edit does not notify on Matrix, so a problem somebody has to act on
    #: gets a message of its own rather than a silent rewrite of the status.
    separate_attention_slot: ClassVar[bool] = True
    #: Rooms notify their members of every message by default, so a mention is
    #: emphasis rather than the only route to a reader.
    notifies_only_by_mention: ClassVar[bool] = False
    channel_mention: ClassVar[str | None] = "@room"
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = True
    #: A Matrix account may hold several reactions on one message.
    supports_queue_reaction: ClassVar[bool] = True
    #: One bot account posts for every agent, so there is one mark between them.
    activity_reactions_per_agent: ClassVar[bool] = False

    #: A publication carries its token in its content (`_PUBLICATION_KEY`), and
    #: the room can be read back, so a post whose send was not acknowledged is
    #: found again rather than posted twice.
    recovers_uncertain_posts: ClassVar[bool] = True
    carries_publication_marker: ClassVar[bool] = True
    #: An answered card is edited to its outcome. A redaction would leave a
    #: "message deleted" placeholder in its place.
    removes_answered_cards: ClassVar[bool] = False

    #: Rooms are created with `createRoom` and people invited; the user
    #: directory is searchable, within what the homeserver lets the bot see.
    supports_channel_creation: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = True

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [str(connection_config["homeserver_url"])]

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """The bot account: every connection on it sees every room it is in.

        Two connections on one account, in one tenant or two, would each relay
        all of those rooms into their own tenant. `verify_credentials` holds
        the ID to the token's own account, so the claim cannot be typed around.
        """
        return f"Matrix account {str(connection_config['bot_user_id']).casefold()}"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask the homeserver whose token this is (`/account/whoami`).

        It has to be `bot_user_id`'s, since that is what the connection
        claims. An address that answers, but not as a homeserver's client API
        does (a redirect, a web page, an empty body), is refused with what to
        enter instead: usually the server name was given for the client address.
        """
        config = MatrixConnectionConfig.model_validate(connection_config)
        api = HomeserverApi(
            open_http(config.homeserver_url), access_token=config.access_token
        )
        try:
            who = await api.whoami()
        except NotAMatrixAnswer as exc:
            raise BridgeCredentialError(
                _not_a_homeserver(config.homeserver_url, exc)
            ) from exc
        except MatrixApiError as exc:
            if exc.rejects_token:
                raise BridgeCredentialError(
                    f"The homeserver at {config.homeserver_url} does not accept "
                    f"this access token ({exc.errcode or exc.status}: "
                    f"{exc.error or 'no detail'}). Copy a current token for the "
                    "bot account; signing out the session it came from revokes it."
                ) from exc
            raise BridgeCredentialError(
                f"Could not check the access token with the homeserver at "
                f"{config.homeserver_url}: it answered {exc.status} "
                f"({exc.errcode or 'no error code'}). Check homeserver_url is the "
                "address clients use."
            ) from exc
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(
                f"Could not reach the homeserver at {config.homeserver_url} to "
                f"check the access token: {exc}"
            ) from exc
        finally:
            await api.aclose()
        user_id = who.get("user_id")
        if not isinstance(user_id, str) or not _USER_ID_SHAPE.fullmatch(user_id):
            raise BridgeCredentialError(
                f"The server at {config.homeserver_url} answered, but not with the "
                "account the token belongs to, so it is not a Matrix homeserver's "
                "client API. " + _CLIENT_ADDRESS_HINT
            )
        if who.get("is_guest"):
            raise BridgeCredentialError(
                "That access token belongs to a guest account. Use a registered "
                "account for the bot."
            )
        if not _same_account(user_id, config.bot_user_id):
            raise BridgeCredentialError(
                f"That access token belongs to {user_id}, not {config.bot_user_id}. "
                "Enter the bot account's own ID, or a token of that account."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, MatrixApiError):
            return "auth_failed" if exc.rejects_token else "platform_error"
        return None

    def __init__(self, *, config: MatrixConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._api: HomeserverApi | None = None
        self._user_id = ""
        self._server_name = ""
        self._localpart = ""
        self._bridge_id: str | None = None
        self._sync_task: asyncio.Task[None] | None = None
        self._attention: str | None = None
        # Everything below can be read again from the homeserver, so losing it
        # with the process costs a request, never a message.
        self._rooms: dict[str, _RoomInfo] = {}
        # room id -> (encrypted, when it was read), for the check before a send.
        self._encryption: dict[str, tuple[bool, float]] = {}
        # Rooms refused for encryption whose leave has not gone through yet.
        self._refused: set[str] = set()
        # event id -> the thread it sits in (None at the top level).
        self._threads: OrderedDict[str, str | None] = OrderedDict()
        # event id -> the card it is, or None for an event that is not one.
        self._cards: OrderedDict[str, _Card | None] = OrderedDict()
        self._upload_limit: int | None = None
        self._upload_limit_read_at: float | None = None
        self._batch_attempts = 0
        # Across the attempts at one batch: how many of its events reached
        # Switch, and how many times each failed one has failed.
        self._batch_succeeded = 0
        self._event_failures: dict[str, int] = {}
        self._event_errors: dict[str, BaseException] = {}
        self._last_handler_error: BaseException | None = None
        # Rooms replaced by an upgrade, whose leave has not gone through yet.
        self._tombstoned: set[str] = set()
        # handle -> Matrix user id, for writing an agent's `@handle` as a pill.
        self._mention_targets: dict[str, str] = {}
        # Events handled lately, for a batch that overlaps the one before it.
        # The room's own de-duplication is what makes a redelivery harmless.
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._seen_max = 2000

    def set_bridge_id(self, bridge_id: str) -> None:
        self._bridge_id = bridge_id

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
        if self._listening and self._bridge_id is None:
            raise RuntimeError(
                "The Matrix bridge was started without its bridge id, which names "
                "where its sync position is kept."
            )
        api = HomeserverApi(
            guarded_async_client(
                self.outbound_policy, base_url=self._config.homeserver_url
            ),
            access_token=self._config.access_token,
        )
        try:
            who = await api.whoami()
        except MatrixApiError as exc:
            await api.aclose()
            if exc.rejects_token:
                raise BridgeCredentialError(
                    f"The homeserver at {self._config.homeserver_url} no longer "
                    "accepts the bot's access token. Paste a current one."
                ) from exc
            raise
        except BaseException:
            await api.aclose()
            raise
        user_id = str(who.get("user_id") or "")
        if not _USER_ID_SHAPE.fullmatch(user_id):
            await api.aclose()
            raise BridgeCredentialError(
                "The homeserver accepted the token but did not say which account "
                "it belongs to."
            )
        if not _same_account(user_id, self._config.bot_user_id):
            # The claim this connection holds is `bot_user_id`; running on
            # another account would bridge rooms nobody claimed.
            await api.aclose()
            raise BridgeCredentialError(
                f"The access token now belongs to {user_id}, not "
                f"{self._config.bot_user_id}, which this connection is for."
            )
        self._api = api
        self._user_id = user_id
        self._localpart, _, self._server_name = user_id[1:].partition(":")
        if not self._listening:
            logger.info(
                "Matrix bridge for %s runs quietly here: another process syncs it",
                user_id,
            )
            return
        self._sync_task = asyncio.create_task(
            self._sync_forever(), name=f"matrix-sync-{self._bridge_id}"
        )
        logger.info(
            "Matrix bridge connected to %s as %s",
            self._config.homeserver_url,
            user_id,
        )

    async def stop(self) -> None:
        task, self._sync_task = self._sync_task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("The Matrix sync loop had stopped on an error")
        api, self._api = self._api, None
        if api is not None:
            await api.aclose()

    async def attention(self) -> str | None:
        return self._attention

    def _require_api(self) -> HomeserverApi:
        if self._api is None:
            raise RuntimeError("The Matrix bridge is not connected.")
        return self._api

    def _send_budget(self) -> AbstractContextManager[None]:
        """One send's shared rate-limit budget (`_SEND_RATE_BUDGET_SECONDS`).

        Without a connection there is nothing to bound: the send itself then
        fails as it would have.
        """
        if self._api is None:
            return nullcontext()
        return self._api.rate_budget(_SEND_RATE_BUDGET_SECONDS)

    # ── Sync ─────────────────────────────────────────────────────────────────

    def _position_type(self) -> str:
        assert self._bridge_id is not None
        return _SYNC_POSITION_TYPE.format(bridge_id=self._bridge_id)

    def _sync_filter(self, timeline_limit: int) -> dict[str, Any]:
        return {
            "presence": {"not_types": ["*"]},
            "account_data": {"not_types": ["*"]},
            "room": {
                "account_data": {"not_types": ["*"]},
                "ephemeral": {"not_types": ["*"]},
                "state": {"types": _STATE_TYPES, "lazy_load_members": True},
                # The bot's own events are wanted too: its join is where a
                # room's history ends and what the bridge relays begins.
                "timeline": {"types": _ROOM_EVENT_TYPES, "limit": timeline_limit},
            },
        }

    async def _load_position(self) -> str | None:
        stored = await self._require_api().account_data(
            self._user_id, self._position_type()
        )
        if stored is None:
            return None
        position = stored.get("next_batch")
        return position if isinstance(position, str) and position else None

    async def _save_position(self, position: str) -> None:
        await self._require_api().set_account_data(
            self._user_id, self._position_type(), {"next_batch": position}
        )

    async def _sync_forever(self) -> None:
        """Sync until stopped, whatever goes wrong on the way.

        Nothing ends this but `stop`: this process holds the bridge, so no
        other is syncing it, and a loop that died here would leave the
        connection looking healthy while nothing reached Switch. A failure is
        logged, waited out with a backoff and tried again; one that keeps
        happening is also said on the connection (`attention`), where the
        operator sees it, until a sync goes through again.
        """
        failures = 0
        since: str | None = None
        while True:
            try:
                if since is None:
                    since = await self._load_position()
                if since is None:
                    since = await self._first_sync()
                    if since is None:
                        await asyncio.sleep(
                            self._retry_delay(self._batch_attempts, None)
                        )
                        continue
                batch = await self._require_api().sync(
                    since=since,
                    timeout_ms=_SYNC_TIMEOUT_MS,
                    sync_filter=self._sync_filter(_TIMELINE_LIMIT),
                )
                position = batch.get("next_batch")
                if not isinstance(position, str) or not position:
                    raise NotAMatrixAnswer(
                        method="GET",
                        path="/_matrix/client/v3/sync",
                        status=200,
                        what="a sync with no next_batch",
                    )
                outcome = await self._handle_batch(batch, since)
                if outcome.failed and self._hold_batch(outcome):
                    # The position stays where it was, so the same events are
                    # read again; what was handed over is skipped (`_seen`).
                    await asyncio.sleep(self._retry_delay(self._batch_attempts, None))
                    continue
                self._batch_done()
                if outcome.carried:
                    await self._save_position(position)
                since = position
                failures = 0
                self._attention = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failures += 1
                rate = exc if isinstance(exc, MatrixApiError) else None
                delay = self._retry_delay(failures, rate)
                if isinstance(exc, MatrixApiError) and exc.rejects_token:
                    self._attention = (
                        "The homeserver no longer accepts the bot's access token, "
                        "so nothing reaches Switch from Matrix. Paste a current "
                        "token in this connection's settings."
                    )
                    logger.error(
                        "Matrix bridge %s cannot sync: the homeserver rejected its "
                        "access token (%s). Trying again in %.0fs",
                        self._bridge_id,
                        exc,
                        delay,
                    )
                else:
                    if isinstance(exc, MatrixApiError) and exc.rate_limited:
                        # The client waits out an ordinary limit; this is one
                        # it would not, so it is said at once.
                        self._attention = (
                            f"The homeserver at {self._config.homeserver_url} is "
                            "rate-limiting the bot beyond what Switch waits out, so "
                            "messages from Matrix are delayed. Exempt the bot "
                            "account from the homeserver's rate limits."
                        )
                    elif failures >= _ATTENTION_AFTER:
                        self._attention = (
                            f"Switch has not been able to sync with the homeserver "
                            f"at {self._config.homeserver_url} for the last "
                            f"{failures} attempts ({_reason(exc)}), so messages "
                            "from Matrix are not reaching Switch. It keeps trying."
                        )
                    expected = isinstance(exc, (MatrixApiError, httpx.HTTPError))
                    logger.log(
                        logging.ERROR
                        if failures >= _ATTENTION_AFTER
                        else logging.WARNING,
                        "Matrix sync with %s failed (attempt %d): %s. Trying again "
                        "in %.0fs",
                        self._config.homeserver_url,
                        failures,
                        exc,
                        delay,
                        exc_info=not expected,
                    )
                await asyncio.sleep(delay)

    def _hold_batch(self, outcome: _BatchOutcome) -> bool:
        """Whether to read the batch again for events Switch could not take.

        An event is at fault when the homeserver turned down a request about
        it for good (`_refused_by_homeserver`: a reaction on an event it will
        not show, an invite withdrawn before it was accepted), or when it keeps
        failing while others in the batch reached Switch. It is tried
        `_HANDLER_ATTEMPTS` times, then given up on alone, by id, at error
        level, and the rest of the batch moves on.

        Any other failure, when nothing in the batch has reached Switch across
        every attempt at it, is Switch's own (its database or transport away),
        not the events': the batch is held, for as long as it takes, and the
        connection says so in Console meanwhile. Nothing is skipped.
        """
        self._batch_attempts += 1
        self._batch_succeeded += outcome.succeeded
        for label in outcome.failed:
            self._event_failures[label] = self._event_failures.get(label, 0) + 1
        outage = [
            label
            for label in outcome.failed
            if self._batch_succeeded == 0
            and not _refused_by_homeserver(self._event_errors.get(label))
        ]
        given_up = [
            label
            for label in outcome.failed
            if label not in outage and self._event_failures[label] >= _HANDLER_ATTEMPTS
        ]
        newly_given_up = [
            label
            for label in given_up
            if self._event_failures[label] == _HANDLER_ATTEMPTS
        ]
        if newly_given_up:
            logger.error(
                "Giving up on Matrix events %s after %d attempts; they are not in "
                "the Switch room",
                ", ".join(newly_given_up),
                _HANDLER_ATTEMPTS,
            )
        retrying = [label for label in outcome.failed if label not in given_up]
        if not retrying:
            return False
        for label in retrying:
            self._seen.pop(label, None)
        if outage:
            cause = self._last_handler_error
            why = f" ({_reason(cause)})" if cause is not None else ""
            self._attention = (
                f"Switch could not take the {len(outage)} events that "
                f"arrived from Matrix{why}. They "
                "are held, and tried again until Switch can take them; nothing is "
                "skipped."
            )
            logger.error(
                "Could not hand any of %d Matrix events to Switch (%s); holding the "
                "batch and reading it again (attempt %d)",
                len(outage),
                ", ".join(outage),
                self._batch_attempts,
            )
        else:
            logger.error(
                "Could not hand %d Matrix events to Switch (%s); reading the batch "
                "again",
                len(retrying),
                ", ".join(retrying),
            )
        return True

    def _batch_done(self) -> None:
        """Forget the attempts at a batch that has been dealt with."""
        self._batch_attempts = 0
        self._batch_succeeded = 0
        self._event_failures.clear()
        self._event_errors.clear()

    @staticmethod
    def _retry_delay(failures: int, error: MatrixApiError | None) -> float:
        """How long to wait before the next attempt: the server's wait where it
        named one, never less than the base and never more than the cap."""
        if error is not None and error.retry_after_ms is not None:
            asked = error.retry_after_ms / 1000
            return min(max(asked, _RETRY_BASE_SECONDS), _RETRY_MAX_SECONDS)
        return min(_RETRY_BASE_SECONDS * 2.0 ** min(failures, 6), _RETRY_MAX_SECONDS)

    async def _first_sync(self) -> str | None:
        """Take the current position without reading any room's history.

        A bot already in busy rooms would otherwise hand Switch everything
        their timelines still hold. Invites waiting for the bot are answered,
        since nothing else would ever answer them: an incremental sync lists an
        invite only when it changes. So the position is stored only once they
        have been, held to the same rules as a batch (`_hold_batch`); None
        when they are to be tried again.
        """
        batch = await self._require_api().sync(
            since=None, timeout_ms=0, sync_filter=self._sync_filter(0)
        )
        position = batch.get("next_batch")
        if not isinstance(position, str) or not position:
            raise NotAMatrixAnswer(
                method="GET",
                path="/_matrix/client/v3/sync",
                status=200,
                what="a first sync with no next_batch",
            )
        rooms = batch.get("rooms") or {}
        failed: list[str] = []
        succeeded: list[str] = []
        for room_id, invite in (rooms.get("invite") or {}).items():
            await self._guarded(
                room_id,
                f"invite to {room_id}",
                self._handle_invite(room_id, invite),
                failed,
                succeeded,
            )
        if failed and self._hold_batch(
            _BatchOutcome(carried=True, failed=failed, succeeded=len(succeeded))
        ):
            return None
        self._batch_done()
        await self._save_position(position)
        logger.info(
            "Matrix bridge %s started from the current position; earlier "
            "messages are not relayed",
            self._bridge_id,
        )
        return position

    async def _guarded(
        self,
        room_id: str,
        label: str,
        work: Awaitable[Any],
        failed: list[str],
        succeeded: list[str] | None = None,
    ) -> Any:
        """One event's work: a failure is logged, noted, and the batch goes on.

        `succeeded` collects the events that reached Switch, which is what
        tells an outage of Switch's own (nothing reached it) from one event
        that keeps failing while its neighbours went through.
        """
        try:
            result = await work
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception(
                "Could not hand Matrix %s in room %s to Switch", label, room_id
            )
            self._last_handler_error = exc
            self._event_errors[label] = exc
            failed.append(label)
            return None
        if succeeded is not None:
            succeeded.append(label)
        return result

    async def _handle_batch(self, batch: dict[str, Any], since: str) -> _BatchOutcome:
        """Hand one sync batch to Switch: what it carried, and what failed."""
        rooms = batch.get("rooms") or {}
        invites = rooms.get("invite") or {}
        joined = rooms.get("join") or {}
        left = rooms.get("leave") or {}
        failed: list[str] = []
        succeeded: list[str] = []
        for room_id, invite in invites.items():
            await self._guarded(
                room_id,
                f"invite to {room_id}",
                self._handle_invite(room_id, invite),
                failed,
                succeeded,
            )
        for room_id, room in joined.items():
            await self._guarded(
                room_id,
                f"room {room_id}",
                self._handle_room(room_id, room, since, failed, succeeded),
                failed,
            )
        for room_id in left:
            self._forget_room(room_id)
            logger.info("The Matrix bot is no longer in room %s", room_id)
        return _BatchOutcome(
            carried=bool(invites or joined or left),
            failed=failed,
            succeeded=len(succeeded),
        )

    async def _handle_room(
        self,
        room_id: str,
        room: dict[str, Any],
        since: str,
        failed: list[str],
        succeeded: list[str],
    ) -> None:
        if room_id in self._refused:
            # Refused earlier, and the leave did not go through: try again.
            await self._leave_refused(room_id)
            return
        if room_id in self._tombstoned:
            # Upgraded and moved: nothing said here is bridged any more, and a
            # leave that failed is tried again.
            await self._leave_upgraded(room_id)
            return
        # The room's state as of the batch, which can carry encryption
        # turned on while nobody was syncing.
        for event in (room.get("state") or {}).get("events") or []:
            if await self._guarded(
                room_id, _label(event), self._handle_state(room_id, event), failed
            ):
                return
        for event in await self._timeline(room_id, room, since):
            handed = (
                event.get("type") in _HANDED_TYPES
                and event.get("sender") != self._user_id
                and str(event.get("event_id") or "") not in self._seen
            )
            if await self._guarded(
                room_id,
                _label(event),
                self._handle_event(room_id, event),
                failed,
                succeeded if handed else None,
            ):
                return

    async def _timeline(
        self, room_id: str, room: dict[str, Any], since: str
    ) -> list[dict[str, Any]]:
        timeline = room.get("timeline") or {}
        events = list(timeline.get("events") or [])
        # Where the bot joined in this batch, nothing before its join is
        # relayed (`_after_own_join`), so the gap is not read back.
        if (
            timeline.get("limited")
            and timeline.get("prev_batch")
            and not any(self._is_own_join(event) for event in events)
        ):
            try:
                events = (
                    await self._backfill(room_id, timeline["prev_batch"], since)
                    + events
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                # One room's history that cannot be read must not hold up
                # every other room, as retrying the whole batch would.
                logger.exception(
                    "Could not read back what happened in Matrix room %s while the "
                    "bridge was not syncing; relaying only the %d newest events, "
                    "and the ones before them are not in the Switch room",
                    room_id,
                    len(events),
                )
        return self._after_own_join(room_id, events)

    def _after_own_join(
        self, room_id: str, events: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Only what happened after the bot joined, where it joined in this batch.

        The homeserver hands a room the bot has just joined over with the
        history its new member may see, which is nothing said to the bridge.
        """
        for index in range(len(events) - 1, -1, -1):
            if self._is_own_join(events[index]):
                if index:
                    logger.info(
                        "Not relaying %d events from before the bot joined Matrix "
                        "room %s",
                        index,
                        room_id,
                    )
                return events[index + 1 :]
        return events

    def _is_own_join(self, event: dict[str, Any]) -> bool:
        """Whether `event` is the bot joining, not a change to its profile."""
        content = event.get("content") or {}
        previous = ((event.get("unsigned") or {}).get("prev_content") or {}).get(
            "membership"
        )
        return (
            event.get("type") == "m.room.member"
            and event.get("state_key") == self._user_id
            and content.get("membership") == "join"
            and previous != "join"
        )

    async def _handle_state(self, room_id: str, event: dict[str, Any]) -> bool:
        """Act on the state a batch carries ahead of its timeline.

        Not events in themselves — a member listed here may have joined long
        ago, and is listed because a message of theirs follows — so only what
        changes how the room is bridged is acted on. True when the bot left.
        """
        event_type = event.get("type")
        if event_type == "m.room.encryption":
            await self._refuse_encrypted(room_id)
            return True
        if event_type == "m.room.tombstone":
            return await self._follow_upgrade(room_id, event)
        if event_type in ("m.room.name", "m.room.join_rules"):
            await self._refresh_room(room_id)
        return False

    async def _backfill(
        self, room_id: str, prev_batch: str, since: str
    ) -> list[dict[str, Any]]:
        """What happened between the last batch and this one's first event.

        A homeserver hands over only the newest events of a busy room; the rest
        are read back here, up to `_BACKFILL_PAGES` pages, so a restart after
        an outage loses nothing short of that, and says so when it does. It
        stops at the bot's own join: nothing before it is relayed.
        """
        api = self._require_api()
        room_filter = {"types": _ROOM_EVENT_TYPES, "lazy_load_members": True}
        found: list[dict[str, Any]] = []
        token: str | None = prev_batch
        for _ in range(_BACKFILL_PAGES):
            page = await api.messages(
                room_id,
                from_token=token,
                to_token=since,
                direction="b",
                limit=_BACKFILL_PAGE,
                event_filter=room_filter,
            )
            chunk = page.get("chunk") or []
            found.extend(chunk)
            token = page.get("end")
            if not chunk or not token:
                break
            if any(self._is_own_join(event) for event in chunk):
                break
        else:
            logger.warning(
                "Room %s had more than %d events while the Matrix bridge was not "
                "syncing; only the newest of them are relayed",
                room_id,
                _BACKFILL_PAGES * _BACKFILL_PAGE,
            )
        found.reverse()
        return found

    def _first_sight(self, event_id: str) -> bool:
        if event_id in self._seen:
            return False
        self._seen[event_id] = None
        while len(self._seen) > self._seen_max:
            self._seen.popitem(last=False)
        return True

    async def _handle_event(self, room_id: str, event: dict[str, Any]) -> bool:
        """Act on one room event. True when the bot has left the room."""
        event_type = event.get("type")
        sender = str(event.get("sender") or "")
        content = event.get("content")
        if not isinstance(content, dict):
            return False
        if event_type == "m.room.encryption":
            await self._refuse_encrypted(room_id)
            return True
        if event_type == "m.room.member":
            return await self._handle_membership(room_id, event, content)
        if event_type == "m.room.tombstone":
            return await self._follow_upgrade(room_id, event)
        if event_type in ("m.room.name", "m.room.join_rules"):
            await self._refresh_room(room_id)
            return False
        if sender == self._user_id:
            return False
        event_id = str(event.get("event_id") or "")
        if not event_id or not self._first_sight(event_id):
            return False
        if event_type == "m.room.message":
            await self._handle_message(room_id, event_id, sender, content)
        elif event_type == "m.reaction":
            await self._handle_reaction(room_id, sender, content)
        return False

    # ── Rooms and membership ─────────────────────────────────────────────────

    def _may_invite(self, inviter: str) -> bool:
        if self._config.accept_invites_from_other_servers:
            return True
        return inviter.partition(":")[2] == self._server_name

    async def _handle_invite(self, room_id: str, invite: dict[str, Any]) -> None:
        stripped = (invite.get("invite_state") or {}).get("events") or []
        inviter = ""
        encrypted = False
        upgraded_from: str | None = None
        for event in stripped:
            content = event.get("content") or {}
            if event.get("type") == "m.room.encryption":
                encrypted = True
            if event.get("type") == "m.room.create" and isinstance(
                content.get("predecessor"), dict
            ):
                upgraded_from = str(content["predecessor"].get("room_id") or "") or None
            if (
                event.get("type") == "m.room.member"
                and event.get("state_key") == self._user_id
            ):
                inviter = str(event.get("sender") or "")
        api = self._require_api()
        if not self._may_invite(inviter):
            logger.warning(
                "Declining an invite to Matrix room %s from %s: only accounts on "
                "%s may invite the bot (accept_invites_from_other_servers is off)",
                room_id,
                inviter or "an unknown account",
                self._server_name,
            )
            await api.leave(room_id)
            return
        await api.join(room_id)
        info = await self._refresh_room(room_id)
        if encrypted or info.encrypted:
            await self._refuse_encrypted(room_id)
            return
        logger.info("The Matrix bot joined room %s, invited by %s", room_id, inviter)
        if upgraded_from is not None and await self._upgrade_moves_here(
            upgraded_from, room_id
        ):
            logger.info(
                "Matrix room %s replaces %s; its Switch room follows the upgrade",
                room_id,
                upgraded_from,
            )
            return
        if self._on_app_joined is not None:
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=room_id,
                    channel_type=info.channel_type,
                    channel_name=info.name,
                )
            )

    async def _upgrade_moves_here(self, old_room: str, room_id: str) -> bool:
        """Whether `old_room`'s tombstone moves its Switch room to `room_id`.

        The `predecessor` an invite carries is only what the new room's
        creator wrote, so the old room's tombstone is read instead. When it
        names this room and its sender may invite the bot, `_follow_upgrade`
        moves the Switch room here, and adopting the room as well would make a
        second one for the same conversation. Otherwise (the bot is not in the
        old room, it has no tombstone, the tombstone names another room or
        would be ignored) nothing else brings the room into Switch, and the
        invite adopts it as any other.
        """
        try:
            tombstone = await self._require_api().state_event_full(
                old_room, "m.room.tombstone"
            )
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.info(
                "Could not read the tombstone of %s, which Matrix room %s names as "
                "its predecessor (%s); adopting %s as a room of its own",
                old_room,
                room_id,
                exc,
                room_id,
            )
            return False
        # Without `format=event` there is no sender to check, so nothing in it
        # is trusted.
        content = tombstone.get("content") if tombstone else None
        if not isinstance(content, dict):
            return False
        return content.get("replacement_room") == room_id and self._may_invite(
            str(tombstone.get("sender") or "") if tombstone else ""
        )

    async def _refuse_encrypted(self, room_id: str) -> None:
        """Say why the room will not be bridged, then leave it.

        Leaving is what makes the refusal hold on every process: a bot that is
        not in the room receives nothing from it, and anything sent to it is
        refused by the homeserver. Until the leave has gone through, every
        send checks the room first (`_ensure_unencrypted`), and a leave that
        failed is tried again whenever the room next appears in a sync.
        """
        api = self._require_api()
        logger.warning(
            "Matrix room %s is end-to-end encrypted; the bridge refuses it and leaves",
            room_id,
        )
        self._encryption[room_id] = (True, time.monotonic())
        self._refused.add(room_id)
        try:
            await api.send_event(
                room_id,
                "m.room.message",
                {
                    "msgtype": "m.notice",
                    "body": ENCRYPTED_ROOM_NOTICE,
                    "m.mentions": {},
                    _RELAYED_KEY: True,
                },
            )
        except (MatrixApiError, httpx.HTTPError, RuntimeError) as exc:
            logger.error(
                "Could not tell Matrix room %s why it is not bridged: %s", room_id, exc
            )
        await self._leave_refused(room_id)

    async def _leave_refused(self, room_id: str) -> None:
        try:
            await self._require_api().leave(room_id)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.error(
                "Could not leave encrypted Matrix room %s (%s); nothing is sent to "
                "it, and the leave is tried again when the room next syncs",
                room_id,
                exc,
            )
            return
        self._forget_room(room_id)

    def _forget_room(self, room_id: str) -> None:
        """Drop what is held about a room the bot is no longer in.

        Thread and card lookups and handled events are kept by event id in
        bounded caches, and a handle's account is the same in every room, so
        those stay.
        """
        self._rooms.pop(room_id, None)
        self._encryption.pop(room_id, None)
        self._refused.discard(room_id)
        self._tombstoned.discard(room_id)

    async def _follow_upgrade(self, room_id: str, event: dict[str, Any]) -> bool:
        """Move the room's bridge onto the room that replaces it. True when it
        moved, and nothing more said in the old room is bridged.

        An upgraded room gets a new id, and the old one is closed with a
        tombstone naming it. Anyone with the power level to send state can
        write a tombstone, though, naming any room, so it is believed only
        when its sender may invite the bot (the invite rule, and
        `accept_invites_from_other_servers`, apply) and the room it names was
        created as this one's successor: its `m.room.create` names this room
        as `predecessor`, which only an upgrade can make so. The bot joins
        the new room, held to the same rules as an invite (encryption
        included), the Switch room is moved onto it through the base's
        channel-migration hook, and the bot leaves the old room, so a message
        said there later does not make a second Switch room.
        """
        content = event.get("content")
        replacement = (
            content.get("replacement_room") if isinstance(content, dict) else None
        )
        if not isinstance(replacement, str) or not replacement:
            return False
        sender = str(event.get("sender") or "")
        if not self._may_invite(sender):
            logger.warning(
                "Ignoring a tombstone in Matrix room %s from %s, who may not invite "
                "the bot (accept_invites_from_other_servers is off)",
                room_id,
                sender or "an unknown account",
            )
            return False
        via = replacement.partition(":")[2] or self._server_name
        api = self._require_api()
        try:
            await api.join(replacement, via=via)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.error(
                "Matrix room %s was upgraded to %s, but the bot could not join it: %s",
                room_id,
                replacement,
                exc,
            )
            await self.admin_message(
                room_id,
                "This room was upgraded, but Switch could not join the new room, "
                "so it is no longer bridged. Invite this account to the new room.",
            )
            return False
        if not await self._succeeds(replacement, room_id):
            logger.warning(
                "Ignoring a tombstone in Matrix room %s from %s: %s was not created "
                "as its replacement (its m.room.create names no such predecessor)",
                room_id,
                sender,
                replacement,
            )
            await self._leave_quietly(replacement)
            return False
        info = await self._refresh_room(replacement)
        if info.encrypted:
            await self.admin_message(
                room_id,
                "This room was upgraded to an end-to-end encrypted room, which "
                "Switch cannot bridge, so it is no longer bridged.",
            )
            await self._refuse_encrypted(replacement)
            return False
        logger.warning("Matrix room %s was upgraded to %s", room_id, replacement)
        self._rooms.pop(room_id, None)
        if self._on_channel_migrated is not None:
            await self._on_channel_migrated(room_id, replacement)
        self._tombstoned.add(room_id)
        await self._leave_upgraded(room_id)
        return True

    async def _succeeds(self, replacement: str, room_id: str) -> bool:
        """Whether `replacement` was created as the successor of `room_id`."""
        create = await self._require_api().state_event_full(
            replacement, "m.room.create"
        )
        if not create:
            return False
        # A homeserver that ignores `format=event` answers with the content.
        content = create.get("content") if "content" in create else create
        predecessor = content.get("predecessor") if isinstance(content, dict) else None
        return isinstance(predecessor, dict) and predecessor.get("room_id") == room_id

    async def _leave_quietly(self, room_id: str) -> None:
        try:
            await self._require_api().leave(room_id)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.error("Could not leave Matrix room %s: %s", room_id, exc)

    async def _leave_upgraded(self, room_id: str) -> None:
        """Leave a room an upgrade replaced. Until that goes through, nothing
        said in it is bridged, and the leave is tried again when it next syncs."""
        try:
            await self._require_api().leave(room_id)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.error(
                "Could not leave upgraded Matrix room %s (%s); nothing said in it is "
                "bridged, and the leave is tried again when the room next syncs",
                room_id,
                exc,
            )
            return
        self._forget_room(room_id)

    async def _ensure_unencrypted(self, room_id: str) -> None:
        """Refuse to send into an end-to-end encrypted room.

        Checked before every send rather than left to the leave: a leave can
        fail, a quiet process never sees the encryption event, and the holder
        may not have handled it yet. Read from the room's state. The process
        that syncs sees encryption turned on as it happens and updates what it
        read, so it trusts that for a minute; a quiet one sees nothing happen,
        so it reads the state before every send.
        """
        cached = self._encryption.get(room_id)
        now = time.monotonic()
        ttl = _ENCRYPTION_TTL_SECONDS if self._listening else 0.0
        if cached is None or now - cached[1] >= ttl:
            encrypted = (
                await self._require_api().state_event(room_id, "m.room.encryption")
                is not None
            )
            cached = (encrypted, now)
            self._encryption[room_id] = cached
        if cached[0]:
            self._refused.add(room_id)
            raise EncryptedRoomRefused(
                f"Matrix room {room_id} is end-to-end encrypted, so Switch sends "
                "nothing to it."
            )

    async def _handle_membership(
        self, room_id: str, event: dict[str, Any], content: dict[str, Any]
    ) -> bool:
        member = str(event.get("state_key") or "")
        membership = content.get("membership")
        if member == self._user_id:
            if membership in ("leave", "ban"):
                self._forget_room(room_id)
                logger.info(
                    "The Matrix bot was removed from room %s by %s",
                    room_id,
                    event.get("sender"),
                )
                return True
            return False
        previous = await self._previous_membership(room_id, event)
        if previous == membership:
            # A profile change: a new display name or avatar, nothing more.
            return False
        if room_id in self._rooms:
            # Who is in the room is part of what kind of room it is.
            await self._refresh_room(room_id)
        if membership != "join":
            return False
        event_id = str(event.get("event_id") or "")
        if not event_id or not self._first_sight(event_id):
            return False
        if self._on_user_joined is not None:
            info = await self._room_info(room_id)
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=room_id,
                    channel_type=info.channel_type,
                    external_user_id=member,
                    external_username=self._remember(member),
                    channel_name=info.name,
                )
            )
        return False

    async def _previous_membership(
        self, room_id: str, event: dict[str, Any]
    ) -> str | None:
        """The membership a member event replaced, None for the member's first.

        A sync carries it as `unsigned.prev_content`. An event read back through
        `/messages` may carry only `unsigned.replaces_state`, the id of the
        event it replaced, which is then read; one the homeserver will not show
        is taken as the member's first. Without either, it is the first.
        """
        unsigned = event.get("unsigned") or {}
        if "prev_content" in unsigned:
            previous = unsigned.get("prev_content")
            return previous.get("membership") if isinstance(previous, dict) else None
        replaced = unsigned.get("replaces_state")
        if not isinstance(replaced, str) or not replaced:
            return None
        try:
            earlier = await self._require_api().event(room_id, replaced)
        except MatrixApiError as exc:
            if not _refused_by_homeserver(exc):
                raise
            logger.warning(
                "Could not read %s, the membership %s replaced in Matrix room %s "
                "(%s); taking it as a join",
                replaced,
                event.get("event_id"),
                room_id,
                exc,
            )
            return None
        content = earlier.get("content")
        return content.get("membership") if isinstance(content, dict) else None

    async def _room_info(self, room_id: str) -> _RoomInfo:
        info = self._rooms.get(room_id)
        if info is None:
            info = await self._read_room(room_id)
            self._rooms[room_id] = info
        return info

    async def _refresh_room(self, room_id: str) -> _RoomInfo:
        """Read the room again, and tell Switch if its name or type changed."""
        before = self._rooms.get(room_id)
        info = await self._read_room(room_id)
        self._rooms[room_id] = info
        if before is not None:
            if (
                before.channel_type != info.channel_type
                and self._on_channel_type_learned
            ):
                await self._on_channel_type_learned(room_id, info.channel_type)
            if before.name != info.name and info.name and self._on_channel_named:
                await self._on_channel_named(room_id, before.name or "", info.name)
        return info

    async def _read_room(self, room_id: str) -> _RoomInfo:
        """A room's name, kind and whether it is encrypted, from its state.

        A room Switch created says what it is in its creation content, which is
        believed only when the bot created the room: anyone can put the key in
        a room of their own, and a group room passed off as a direct one would
        have every message in it go to its agent. Any other room is public
        when anyone may join, a direct conversation when it has no name and
        the bot shares it with one person (as the direct chats clients start
        look), and private otherwise.
        """
        api = self._require_api()
        encrypted = await api.state_event(room_id, "m.room.encryption") is not None
        self._encryption[room_id] = (encrypted, time.monotonic())
        name_state = await api.state_event(room_id, "m.room.name")
        name = name_state.get("name") if name_state else None
        create = await api.state_event_full(room_id, "m.room.create") or {}
        create_content = create.get("content")
        declared = (
            create_content.get(_CHANNEL_TYPE_KEY)
            if isinstance(create_content, dict)
            and create.get("sender") == self._user_id
            else None
        )
        channel_type: ChannelType
        if declared in ("channel_public", "channel_private", "direct"):
            channel_type = declared
        else:
            rules = await api.state_event(room_id, "m.room.join_rules") or {}
            if rules.get("join_rule") == "public":
                channel_type = "channel_public"
            elif not name and len(await api.joined_members(room_id)) <= 2:
                channel_type = "direct"
            else:
                channel_type = "channel_private"
        return _RoomInfo(
            name=name if isinstance(name, str) and name else None,
            channel_type=channel_type,
            encrypted=encrypted,
        )

    async def _room_info_or_default(self, room_id: str) -> _RoomInfo:
        """The room's info, or a private room with no name if it cannot be read.

        Used on the way in, where a state read that failed must not cost the
        room the message it came with.
        """
        try:
            return await self._room_info(room_id)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.warning(
                "Could not read Matrix room %s's state (%s); relaying its message "
                "as from a private room",
                room_id,
                exc,
            )
            return _RoomInfo(name=None, channel_type="channel_private", encrypted=False)

    # ── Inbound ──────────────────────────────────────────────────────────────

    def _handle_for(self, user_id: str) -> str:
        """The `@handle` Switch knows a Matrix account by.

        The localpart for an account on the bot's own homeserver, and the
        localpart and server joined by a dot for anyone else, so two people
        called alice on two servers stay two people. Both survive being written
        as `@name` in a room.
        """
        local, _, server = user_id.removeprefix("@").partition(":")
        return local if server == self._server_name else f"{local}.{server}"

    def _remember(self, user_id: str) -> str:
        """Note who a handle stands for, so an agent's `@handle` reaches them.

        The first account seen under a handle keeps it. Two accounts can come
        out as one handle (`@alice.evil.example` here and `@alice` on
        evil.example), and the later one taking over would have mentions of
        the first person notify the second.
        """
        handle = self._handle_for(user_id)
        known = self._mention_targets.setdefault(handle, user_id)
        if known != user_id:
            logger.warning(
                "Matrix accounts %s and %s share the handle @%s; mentions of it "
                "go to %s",
                known,
                user_id,
                handle,
                known,
            )
        return handle

    async def _thread_root(self, room_id: str, content: dict[str, Any]) -> str | None:
        """The external root a message belongs under, or None at the top level.

        A thread names its root. A reply outside a thread is threaded under the
        message it replies to, as on Telegram: that is the conversation the
        person meant to continue, and Switch's answer goes back there. Unless
        what it replies to is itself in a thread, as when a client that does
        not show threads answers a message inside one: then it belongs to that
        thread, since a thread cannot be started from an event that already
        has a relation, and an answer posted that way would be refused.
        """
        relates = content.get("m.relates_to")
        if not isinstance(relates, dict):
            return None
        if relates.get("rel_type") == "m.thread" and relates.get("event_id"):
            return str(relates["event_id"])
        reply = relates.get("m.in_reply_to")
        if not isinstance(reply, dict) or not reply.get("event_id"):
            return None
        replied = str(reply["event_id"])
        if replied in self._threads:
            return self._threads[replied] or replied
        try:
            target = await self._require_api().event(room_id, replied)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.warning(
                "Could not read %s, which a message in Matrix room %s replies to "
                "(%s); threading under it as it is",
                replied,
                room_id,
                exc,
            )
            return replied
        target_content = target.get("content")
        root = _thread_of(target_content) if isinstance(target_content, dict) else None
        self._threads[replied] = root
        while len(self._threads) > _THREAD_CACHE_MAX:
            self._threads.popitem(last=False)
        return root or replied

    def _mentions_bot(self, content: dict[str, Any], text: str) -> bool:
        mentions = content.get("m.mentions")
        if isinstance(mentions, dict) and self._user_id in (
            mentions.get("user_ids") or []
        ):
            return True
        return self._user_id in text or bool(
            mention_regex(self._localpart).search(text)
        )

    async def _handle_message(
        self, room_id: str, event_id: str, sender: str, content: dict[str, Any]
    ) -> None:
        relates = content.get("m.relates_to")
        if isinstance(relates, dict) and relates.get("rel_type") == "m.replace":
            # An edit is not carried into the room, as on every other
            # platform: the room keeps what was first said. Relaying it as a
            # message of its own would present the correction as something
            # new, and address its agents a second time.
            logger.debug(
                "Not relaying edit %s in Matrix room %s to the room", event_id, room_id
            )
            return
        msgtype = content.get("msgtype")
        if "file" in content and "url" not in content:
            text = ""
        else:
            text = _without_reply_fallback(str(content.get("body") or ""), content)
        info = await self._room_info_or_default(room_id)
        handle = self._remember(sender)
        root_id = await self._thread_root(room_id, content)
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        if msgtype in _MEDIA_TYPES or "file" in content:
            text, attachments, failures = await self._fetch_attachment(content)
        elif msgtype == "m.emote":
            text = f"* {handle} {text}"
        elif msgtype not in _TEXT_TYPES and not text:
            logger.debug("Skipping a Matrix %s event with no text", msgtype)
            return

        # A notice is what Matrix bots and integrations post, automated by the
        # spec's own convention; a message carrying the relay marker was
        # posted by a Switch bridge, this one on another account or another
        # deployment's. Either is relayed but is never a person's answer, and
        # never runs a command: two bridges in one room would otherwise run
        # each other's notices and could set each other off.
        from_app = msgtype == "m.notice" or bool(content.get(_RELAYED_KEY))
        stripped = text.strip()
        if (
            stripped.startswith("!")
            and not attachments
            and not from_app
            and self._on_command is not None
        ):
            parsed = _COMMAND_RE.match(stripped)
            if parsed:
                command, args = parsed.group(1), parsed.group(2) or ""
                await self._on_command(
                    InboundCommand(
                        channel_id=room_id,
                        channel_type=info.channel_type,
                        sender_id=sender,
                        sender_name=handle,
                        command=command,
                        args=args.strip(),
                        message_ref=event_id,
                        root_id=root_id,
                        channel_name=info.name,
                    )
                )
                return
        if self._on_message is None:
            return
        if not text and not attachments and not failures:
            return
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=info.channel_type,
                sender_id=sender,
                sender_name=handle,
                content=text,
                message_ref=event_id,
                root_id=root_id,
                channel_name=info.name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=(
                    self._localpart if self._mentions_bot(content, text) else None
                ),
                sender_is_app=from_app,
            )
        )

    async def _fetch_attachment(
        self, content: dict[str, Any]
    ) -> tuple[str, list[Attachment], list[AttachmentFailure]]:
        """The caption and the file of a media message.

        The file name is `filename` where the client sent one, and the body is
        then a caption; otherwise the body is the name. A file too big for
        Switch is refused before it is downloaded, from the size the event
        states, and again while downloading in case that understated it.
        """
        body = str(content.get("body") or "")
        filename = str(content.get("filename") or body or "attachment")
        caption = body if content.get("filename") and body != filename else ""
        if "file" in content and "url" not in content:
            return (
                caption,
                [],
                [
                    AttachmentFailure(
                        filename=filename,
                        reason="it is end-to-end encrypted, which the bridge cannot read",
                    )
                ],
            )
        info = content.get("info")
        if not isinstance(info, dict):
            info = {}
        size = info.get("size")
        cap = self._max_attachment_bytes
        if isinstance(size, int) and size > cap:
            logger.warning(
                "Matrix attachment %s is %d bytes, over the %d cap", filename, size, cap
            )
            return (
                caption,
                [],
                [
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{size} bytes exceeds the {cap} byte limit",
                    )
                ],
            )
        uri = str(content.get("url") or "")
        try:
            data, served_type = await self._require_api().download(uri, max_bytes=cap)
        except MediaTooLarge as exc:
            return (
                caption,
                [],
                [
                    AttachmentFailure(
                        filename=filename, reason=f"{exc} ({cap} byte limit)"
                    )
                ],
            )
        except (MatrixApiError, httpx.HTTPError, ValueError) as exc:
            logger.error("Could not download Matrix attachment %s: %s", filename, exc)
            return (
                caption,
                [],
                [
                    AttachmentFailure(
                        filename=filename, reason=f"download failed: {exc}"
                    )
                ],
            )
        mimetype = str(
            info.get("mimetype") or served_type or "application/octet-stream"
        )
        return (
            caption,
            [Attachment(filename=filename, mimetype=mimetype, data=data)],
            [],
        )

    async def _handle_reaction(
        self, room_id: str, sender: str, content: dict[str, Any]
    ) -> None:
        """A keycap on one of the bot's cards is a press of that option.

        What the card is for is read from the card itself, the token in its
        content, so it does not matter which process posted it or when.
        """
        relates = content.get("m.relates_to")
        if not isinstance(relates, dict) or relates.get("rel_type") != "m.annotation":
            return
        position = _KEYCAP_POSITIONS.get(
            _strip_variation(str(relates.get("key") or ""))
        )
        target_id = relates.get("event_id")
        if position is None or not target_id or self._on_interaction is None:
            return
        card = await self._card(room_id, str(target_id))
        if card is None:
            return
        await self._on_interaction(
            InboundInteraction(
                channel_id=room_id,
                sender_id=sender,
                sender_name=self._remember(sender),
                action_id=position_action(position),
                value=card.token,
                message_ref=str(target_id),
                thread_ref=card.thread_ref,
            )
        )

    async def _card(self, room_id: str, event_id: str) -> _Card | None:
        """The bot's request card `event_id`, or None when it is not one.

        Read from the event once and kept (`_CARD_CACHE_MAX`), since an event
        does not change and every keycap on a card names it. An event the
        homeserver will not show (purged, or in history the bot may not see)
        is not a card the bot can answer.
        """
        if event_id in self._cards:
            self._cards.move_to_end(event_id)
            return self._cards[event_id]
        try:
            target = await self._require_api().event(room_id, event_id)
        except MatrixApiError as exc:
            if not _refused_by_homeserver(exc):
                raise
            logger.debug(
                "Not reading a reaction to %s in Matrix room %s as an answer: the "
                "homeserver will not show it (%s)",
                event_id,
                room_id,
                exc,
            )
            target = {}
        content = target.get("content")
        marker = content.get(_PUBLICATION_KEY) if isinstance(content, dict) else None
        token = marker.get("token") if isinstance(marker, dict) else None
        card = (
            _Card(token=token, thread_ref=_thread_of(content))
            if target.get("sender") == self._user_id
            and isinstance(content, dict)
            and isinstance(marker, dict)
            and marker.get("kind") == "request"
            and isinstance(token, str)
            and token
            else None
        )
        self._cards[event_id] = card
        while len(self._cards) > _CARD_CACHE_MAX:
            self._cards.popitem(last=False)
        return card

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _content(
        self,
        markdown_text: str,
        *,
        msgtype: str,
        thread_root_id: str | None,
        room_wide_mention: bool,
    ) -> dict[str, Any]:
        rendered = render(markdown_text)
        mentions: dict[str, Any] = {"user_ids": list(rendered.mentioned)}
        if room_wide_mention:
            mentions["room"] = True
        # `m.mentions` is always sent, even empty: it is what tells a current
        # homeserver to notify only the people named there, so an `@room` or a
        # display name in an agent's text pages nobody by accident.
        content: dict[str, Any] = {
            "msgtype": msgtype,
            "body": rendered.body,
            "format": "org.matrix.custom.html",
            "formatted_body": rendered.formatted_body,
            "m.mentions": mentions,
            _RELAYED_KEY: True,
        }
        if thread_root_id is not None:
            content["m.relates_to"] = _thread_relation(thread_root_id)
        return content

    async def _post(
        self,
        channel_id: str,
        markdown_text: str,
        thread_root_id: str | None,
        *,
        msgtype: str,
        room_wide_mention: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> str:
        """Post one event and return its id, raising on any failure.

        Refused, with `EncryptedRoomRefused`, in an encrypted room. A rate
        limit is waited out by the client, within a bound, before it is
        raised.
        """
        await self._ensure_unencrypted(channel_id)
        content = self._content(
            markdown_text,
            msgtype=msgtype,
            thread_root_id=thread_root_id,
            room_wide_mention=room_wide_mention,
        )
        if extra:
            content.update(extra)
        return await self._require_api().send_event(
            channel_id, "m.room.message", content
        )

    async def _post_text(
        self,
        channel_id: str,
        markdown_text: str,
        thread_root_id: str | None,
        *,
        msgtype: str,
        prefix: str = "",
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post a body of any length, split into as many events as it needs.

        Each piece carries `prefix`, the agent's name, so a piece read on its
        own — between another agent's — still says whose it is. Returns the
        first piece's id, which is what a reply threads under, or None when the
        homeserver took none of it (logged), so the room's message is offered
        again later.

        A piece the homeserver still refuses after its rate limit was waited
        out leaves the message visibly cut, as on Discord: what was posted
        stays, and a notice in the same place says how much did not arrive.
        Raising instead would have the whole message posted again from its
        first piece, which the room already shows. The pieces share one
        rate-limit budget (`_SEND_RATE_BUDGET_SECONDS`), so a long reply cannot
        stall for minutes a piece at a time; the notice has its own.
        """
        first: str | None = None
        budget = MAX_BODY_BYTES - len(prefix.encode("utf-8"))
        pieces = split_message(markdown_text, budget) if markdown_text else [""]
        cut_at: int | None = None
        with self._send_budget():
            for index, piece in enumerate(pieces):
                try:
                    event_id = await self._post(
                        channel_id,
                        f"{prefix}{piece}",
                        thread_root_id,
                        msgtype=msgtype,
                        room_wide_mention=room_wide_mention and index == 0,
                    )
                except (MatrixApiError, httpx.HTTPError, RuntimeError) as exc:
                    logger.error(
                        "Failed to send a message to Matrix room %s (part %d of "
                        "%d): %s",
                        channel_id,
                        index + 1,
                        len(pieces),
                        exc,
                    )
                    cut_at = index
                    break
                if first is None:
                    first = event_id
        if cut_at is not None and first is not None:
            await self._note_truncation(channel_id, thread_root_id, cut_at, len(pieces))
        return first

    async def _note_truncation(
        self, channel_id: str, thread_root_id: str | None, delivered: int, total: int
    ) -> None:
        try:
            await self._post(
                channel_id,
                f"\u26a0\ufe0f Only {delivered} of {total} parts of this message "
                "were delivered; the rest could not be confirmed delivered.",
                thread_root_id,
                msgtype="m.notice",
            )
        except (MatrixApiError, httpx.HTTPError, RuntimeError):
            logger.exception(
                "Could not say in Matrix room %s that a message was cut", channel_id
            )

    async def _attribution(self, sender_name: str) -> str:
        """The agent's name at the head of its message.

        One bot account posts for every agent, and Matrix has no way to change
        the name a message is shown under, so the name is part of the text, as
        on Telegram. The label is the escaped one (`body_label`): it goes into
        Markdown, where a display name could otherwise forge a link or a
        mention.
        """
        agent = await self.agent_rendering(sender_name)
        return f"**{agent.body_label}**: "

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        prefix = await self._attribution(sender_name)
        if "\n" in content:
            prefix = prefix.removesuffix(": ") + "\n"
        return await self._post_text(
            channel_id,
            content,
            thread_root_id,
            msgtype="m.text",
            prefix=prefix,
            room_wide_mention=room_wide_mention,
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
        # A notice, as Matrix bots post their own messages: the bot speaking,
        # not one of the agents.
        return await self._post_text(
            channel_id,
            self._admin_body(self.translate_outbound(content), drawn),
            thread_root_id,
            msgtype="m.notice",
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._edit(channel_id, message_ref, new_content, msgtype="m.text")
        except (MatrixApiError, httpx.HTTPError, RuntimeError) as exc:
            logger.error("Failed to edit Matrix message %s: %s", message_ref, exc)

    async def _edit(
        self, channel_id: str, message_ref: str, markdown_text: str, *, msgtype: str
    ) -> None:
        """Replace a message's text in place (`m.replace`).

        An edit is one event, so a text longer than one message is cut, and
        says so. The edit itself mentions nobody: its new content names who the
        message mentions, and a redraw notifying them again would be noise.
        """
        await self._ensure_unencrypted(channel_id)
        pieces = split_message(markdown_text, MAX_BODY_BYTES - 16)
        text = pieces[0] if len(pieces) == 1 else f"{pieces[0]}\n…"
        new = self._content(
            text, msgtype=msgtype, thread_root_id=None, room_wide_mention=False
        )
        content = {
            "msgtype": msgtype,
            "body": f"* {new['body']}",
            "format": "org.matrix.custom.html",
            "formatted_body": f"* {new['formatted_body']}",
            "m.new_content": new,
            "m.mentions": {},
            "m.relates_to": {"rel_type": "m.replace", "event_id": message_ref},
            _RELAYED_KEY: True,
        }
        await self._require_api().send_event(channel_id, "m.room.message", content)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._require_api().redact(channel_id, message_ref)
        except (MatrixApiError, httpx.HTTPError, RuntimeError) as exc:
            logger.error("Failed to redact Matrix message %s: %s", message_ref, exc)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        try:
            await self._require_api().typing(
                channel_id, self._user_id, typing=is_typing, timeout_ms=_TYPING_MS
            )
        except (MatrixApiError, httpx.HTTPError, RuntimeError) as exc:
            logger.warning(
                "Could not set typing in Matrix room %s: %s", channel_id, exc
            )

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        # Matrix typing is per room, not per thread, and expires by itself.
        await self.send_typing(channel_id, agent_name, True)

    # ── Attachments ──────────────────────────────────────────────────────────

    async def _upload_limit_bytes(self) -> int | None:
        """The homeserver's upload limit (`m.upload.size`), or None if it states none.

        Read again after an hour, so a limit the administrator changed is
        picked up without restarting the bridge.
        """
        now = time.monotonic()
        read_at = self._upload_limit_read_at
        if read_at is None or now - read_at > _UPLOAD_LIMIT_TTL_SECONDS:
            config = await self._require_api().media_config()
            limit = config.get("m.upload.size")
            self._upload_limit = limit if isinstance(limit, int) else None
            self._upload_limit_read_at = now
        return self._upload_limit

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
        """Upload the file and post it, with the agent's name as its caption.

        A file larger than the homeserver takes is refused before uploading,
        with a message saying so in the room, as is one the homeserver refuses
        as too large. One that uploaded but whose message the homeserver
        refused is reported the same way, so a file is never dropped silently.
        Nothing is uploaded for an encrypted room.
        """
        with self._send_budget():
            return await self._send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )

    async def _send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None,
        thread_root_id: str | None,
    ) -> str | None:
        api = self._require_api()
        try:
            await self._ensure_unencrypted(channel_id)
        except EncryptedRoomRefused as exc:
            logger.error("Not sending %s to Matrix: %s", filename, exc)
            return None
        except (MatrixApiError, httpx.HTTPError) as exc:
            # Not known to be unencrypted, so nothing is uploaded or said.
            logger.error(
                "Not sending %s to Matrix room %s: its encryption could not be "
                "checked (%s)",
                filename,
                channel_id,
                exc,
            )
            return None
        try:
            limit = await self._upload_limit_bytes()
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.warning(
                "Could not read the homeserver's upload limit (%s); uploading %s "
                "and letting the homeserver decide",
                exc,
                filename,
            )
            limit = None
        if limit is not None and len(data) > limit:
            logger.warning(
                "Not uploading %s to Matrix: %d bytes, over the homeserver's "
                "%d-byte limit",
                filename,
                len(data),
                limit,
            )
            return await self._refuse_attachment(
                channel_id,
                sender_name,
                filename,
                f"{len(data)} bytes is over this homeserver's {limit}-byte upload limit",
                caption,
                thread_root_id,
            )
        try:
            uri = await api.upload(data, content_type=mimetype, filename=filename)
        except MatrixApiError as exc:
            logger.error("The homeserver refused the upload of %s: %s", filename, exc)
            reason = (
                "the homeserver refused it as too large"
                if exc.errcode == "M_TOO_LARGE" or exc.status == 413
                else "the homeserver refused the upload"
            )
            return await self._refuse_attachment(
                channel_id, sender_name, filename, reason, caption, thread_root_id
            )
        except httpx.HTTPError as exc:
            logger.error("Could not upload %s to the homeserver: %s", filename, exc)
            return await self._refuse_attachment(
                channel_id,
                sender_name,
                filename,
                "the upload failed",
                caption,
                thread_root_id,
            )
        prefix = await self._attribution(sender_name)
        text = (
            f"{prefix}{self.translate_outbound(caption)}"
            if caption
            else prefix.removesuffix(": ")
        )
        msgtype = (
            "m.image"
            if mimetype.startswith("image/")
            else "m.video"
            if mimetype.startswith("video/")
            else "m.audio"
            if mimetype.startswith("audio/")
            else "m.file"
        )
        rendered = render(text)
        content: dict[str, Any] = {
            "msgtype": msgtype,
            "body": rendered.body,
            "format": "org.matrix.custom.html",
            "formatted_body": rendered.formatted_body,
            "filename": filename,
            "url": uri,
            "info": {"mimetype": mimetype, "size": len(data)},
            "m.mentions": {"user_ids": list(rendered.mentioned)},
            _RELAYED_KEY: True,
        }
        if thread_root_id is not None:
            content["m.relates_to"] = _thread_relation(thread_root_id)
        try:
            return await api.send_event(channel_id, "m.room.message", content)
        except (MatrixApiError, httpx.HTTPError, RuntimeError) as exc:
            logger.error(
                "Failed to post attachment %s to Matrix room %s: %s",
                filename,
                channel_id,
                exc,
            )
            return await self._refuse_attachment(
                channel_id,
                sender_name,
                filename,
                "the homeserver refused the message carrying it",
                caption,
                thread_root_id,
            )

    async def _refuse_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        reason: str,
        caption: str | None,
        thread_root_id: str | None,
    ) -> str | None:
        note = f"_sent an attachment that couldn't be relayed: {filename} ({reason})_"
        body = f"{caption}\n{note}" if caption else note
        return await self.send_message(
            channel_id, sender_name, self.translate_outbound(body), thread_root_id
        )

    # ── Session activity: statuses and cards ─────────────────────────────────

    def rich_fallback_limit(self) -> int:
        # One event, since an edit cannot be split; well inside its size cap.
        return 4000

    def rich_markup(self) -> Markup:
        return MARKDOWN

    def rich_fallback_text(self, content: RichContent) -> str:
        return self._draw(content, prefix="", mention=None, responder=None).text

    def _draw(
        self,
        content: RichContent,
        *,
        prefix: str,
        mention: str | None,
        responder: str | None,
    ) -> _Drawn:
        """A status or a card as Markdown, and the reactions a card offers.

        Matrix has no buttons. A card's options are numbered as everywhere, and
        the bot puts one keycap reaction per option under the card; reacting
        with one is the same as pressing it, and typing the answer works too.
        Only a card that can be answered from what it shows offers them.
        """
        limit = max(1, self.rich_fallback_limit() - len(prefix))
        if isinstance(content, TurnActivity):
            tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
            body = turn_status(
                content.items,
                content.turn,
                escape=self._rich_escape,
                limit=max(1, limit - len(tail)),
                markup=MARKDOWN,
                elapsed_seconds=content.elapsed_seconds,
                mention=mention,
                error_summary=content.error_summary,
                tool_detail=False,
            )
            return _Drawn(text=f"{prefix}{body}{tail}", controls=())
        controls = [
            _KEYCAPS[control.position - 1]
            for control in offered_controls(content.request)
            if control.position <= len(_KEYCAPS)
        ]
        hint = f"\nOr react with {' '.join(controls)} to choose." if controls else ""
        lead = f"{mention}\n" if mention else ""
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        drawn = render_request(
            content.request,
            content.reference,
            escape=self._rich_escape,
            limit=max(1, limit - len(lead) - len(tail) - len(hint)),
            markup=MARKDOWN,
            responder=responder,
            unavailable_reason=content.unavailable_reason,
            control_label_limit=None,
        )
        if not drawn.answerable:
            controls, hint = [], ""
        return _Drawn(
            text=f"{prefix}{lead}{drawn.text}{hint}{tail}", controls=tuple(controls)
        )

    def _mention(self, user_id: str | None) -> str | None:
        if not user_id or not user_id.startswith("@") or ":" not in user_id:
            return None
        return pill(user_id, f"@{self._handle_for(user_id)}")

    async def _render_rich(
        self, agent_name: str, content: RichContent, *, notify: bool
    ) -> _Drawn:
        agent = await self.agent_rendering(agent_name)
        return self._draw(
            content,
            prefix=f"**{agent.body_label}**\n",
            mention=self._mention(content.notify_external_id) if notify else None,
            responder=(
                self._mention(content.responder_external_id)
                if isinstance(content, RequestCard)
                else None
            ),
        )

    @staticmethod
    def _marker(content: RichContent) -> dict[str, Any] | None:
        if isinstance(content, RequestCard):
            return {"token": content.reference.token, "kind": "request"}
        if content.publication_token:
            return {"token": content.publication_token, "kind": "turn"}
        return None

    @staticmethod
    def _rich_failure(error: MatrixApiError, description: str, text: str) -> Exception:
        """What a publication makes of a homeserver's error.

        A refusal the server stands behind (4xx) is `RichContentFailed`, which
        lets the caller drop its reservation; a rate limit is a wait. A server
        error may have stored the event anyway, so it is raised as itself and
        the reservation is kept for `find_request_card` to settle.
        """
        if error.rate_limited:
            asked = (error.retry_after_ms or 0) / 1000
            retry = min(max(asked, _RETRY_BASE_SECONDS), _RETRY_MAX_SECONDS)
            return RichContentThrottled(retry_after=retry, text=text)
        if 400 <= error.status < 500:
            return RichContentFailed(f"{description}: {error}", text=text)
        return error

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a status or a card; a card's keycaps go under it.

        The card and its keycaps share one rate-limit budget, so a card is not
        held up for minutes behind its reactions; a keycap that does not make it
        leaves the option to be answered by typing, as the card says.
        """
        drawn = await self._render_rich(agent_name, content, notify=True)
        marker = self._marker(content)
        with self._send_budget():
            try:
                ref = await self._post(
                    channel_id,
                    drawn.text,
                    thread_root_id,
                    msgtype=(
                        "m.notice" if isinstance(content, TurnActivity) else "m.text"
                    ),
                    extra={_PUBLICATION_KEY: marker} if marker else None,
                )
            except EncryptedRoomRefused as error:
                raise RichContentFailed(
                    str(error), text=self.rich_fallback_text(content)
                ) from error
            except MatrixApiError as error:
                raise self._rich_failure(
                    error,
                    f"The homeserver refused the post in room {channel_id}",
                    self.rich_fallback_text(content),
                ) from error
            for key in drawn.controls:
                try:
                    await self._react(channel_id, ref, key)
                except (MatrixApiError, httpx.HTTPError) as exc:
                    logger.warning(
                        "Could not add the %s reaction to card %s in %s (%s); it "
                        "can still be answered by typing",
                        key,
                        ref,
                        channel_id,
                        exc,
                    )
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        drawn = await self._render_rich(
            agent_name, replace(content, notify_external_id=None), notify=False
        )
        try:
            with self._send_budget():
                await self._edit(
                    channel_id,
                    message_ref,
                    drawn.text,
                    msgtype=(
                        "m.notice" if isinstance(content, TurnActivity) else "m.text"
                    ),
                )
        except EncryptedRoomRefused as error:
            raise RichContentFailed(
                str(error), text=self.rich_fallback_text(content)
            ) from error
        except MatrixApiError as error:
            raise self._rich_failure(
                error,
                f"The homeserver refused the edit to {message_ref} in {channel_id}",
                self.rich_fallback_text(content),
            ) from error
        if isinstance(content, RequestCard) and not drawn.controls:
            await self._withdraw_reactions(channel_id, message_ref, set(_KEYCAPS))

    async def _withdraw_reactions(
        self, channel_id: str, message_ref: str, keys: set[str]
    ) -> None:
        """Take the bot's own reactions with these keys off a message."""
        wanted = {_strip_variation(key) for key in keys}
        try:
            for event_id in await self._own_reactions(channel_id, message_ref, wanted):
                await self._require_api().redact(channel_id, event_id)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.warning(
                "Could not take the reactions off card %s in %s: %s",
                message_ref,
                channel_id,
                exc,
            )

    async def _own_reactions(
        self, channel_id: str, message_ref: str, keys: set[str]
    ) -> list[str]:
        """The bot's reactions on a message with one of `keys`, read from the room."""
        api = self._require_api()
        found: list[str] = []
        token: str | None = None
        while True:
            page = await api.relations(
                channel_id,
                message_ref,
                "m.annotation",
                event_type="m.reaction",
                direction="b",
                limit=100,
                from_token=token,
            )
            for event in page.get("chunk") or []:
                relates = (event.get("content") or {}).get("m.relates_to") or {}
                if (
                    event.get("sender") == self._user_id
                    and _strip_variation(str(relates.get("key") or "")) in keys
                ):
                    found.append(str(event.get("event_id")))
            token = page.get("next_batch")
            if not token:
                return found

    async def _react(self, channel_id: str, message_ref: str, key: str) -> None:
        try:
            await self._require_api().send_event(
                channel_id,
                "m.reaction",
                {
                    "m.relates_to": {
                        "rel_type": "m.annotation",
                        "event_id": message_ref,
                        "key": key,
                    }
                },
            )
        except MatrixApiError as error:
            # Already there: what was asked for is what the message shows.
            if error.errcode == "M_DUPLICATE_ANNOTATION":
                return
            raise

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
        """Put 👀 (working) or ⏳ (queued) on the asking message, or take it off.

        Read from the room each time rather than remembered, so a restart or
        another process taking over finds the marks that are really there.
        """
        key = _MARKS[mark]
        try:
            if on:
                # A reaction is not encrypted either; it says which message an
                # agent is working on.
                try:
                    await self._ensure_unencrypted(channel_id)
                except EncryptedRoomRefused as exc:
                    raise ActivityMarkRefused(str(exc)) from exc
                await self._react(channel_id, message_ref, key)
                return
            for event_id in await self._own_reactions(
                channel_id, message_ref, {_strip_variation(key)}
            ):
                await self._require_api().redact(channel_id, event_id)
        except MatrixApiError as error:
            if error.status == 403:
                raise ActivityMarkRefused(
                    f"The homeserver will not let the bot react in {channel_id}: {error}"
                ) from error
            raise

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        """Look for a publication the bot may already have posted, by its token.

        Matched on the marker in the event's content and on the bot being its
        sender, so a token quoted in somebody's message is not taken for the
        post that carries it. None — "not found yet" — when the room cannot be
        read.

        One page of the newest hundred: asked moments after a send whose
        answer was lost, the publication is among them unless the room has had
        a hundred messages since, and `created_at` is not needed to narrow it.
        """
        api = self._require_api()
        try:
            if thread_root_id:
                page = await api.relations(
                    channel_id,
                    thread_root_id,
                    "m.thread",
                    event_type=None,
                    direction="b",
                    limit=100,
                    from_token=None,
                )
            else:
                page = await api.messages(
                    channel_id,
                    from_token=None,
                    to_token=None,
                    direction="b",
                    limit=100,
                    event_filter={
                        "types": ["m.room.message"],
                        "senders": [self._user_id],
                    },
                )
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.warning(
                "Could not read Matrix room %s looking for the publication marked "
                "%s: %s",
                channel_id,
                token,
                exc,
            )
            return None
        for event in page.get("chunk") or []:
            marker = (event.get("content") or {}).get(_PUBLICATION_KEY)
            if (
                event.get("sender") == self._user_id
                and isinstance(marker, dict)
                and marker.get("token") == token
            ):
                return str(event.get("event_id"))
        return None

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        """Whether `message_ref` is the oldest reply to `root_ref`.

        A reply in the thread under it is found through the thread's
        relations. A plain reply (`m.in_reply_to` with no thread, which is what
        Element's Reply sends outside a thread) is in no such index, so the
        events just before it are read instead, back to the root: it is the
        first when no other reply to the root comes between them, and not when
        the root is further back than that window.

        Never raises: this runs on the way in, ahead of the relay.
        """
        api = self._require_api()
        try:
            page = await api.relations(
                channel_id,
                root_ref,
                "m.thread",
                event_type=None,
                direction="f",
                limit=1,
                from_token=None,
            )
            chunk = page.get("chunk") or []
            if chunk and chunk[0].get("event_id") == message_ref:
                return True
            message = await api.event(channel_id, message_ref)
            content = message.get("content")
            if not (
                isinstance(content, dict)
                and _thread_of(content) is None
                and _replied_to(content) == root_ref
            ):
                return False
            around = await api.context(
                channel_id,
                message_ref,
                limit=_FIRST_REPLY_CONTEXT,
                event_filter={"types": ["m.room.message"]},
            )
        except (MatrixApiError, httpx.HTTPError, RuntimeError) as exc:
            logger.warning(
                "Could not read the replies to %s in %s (%s); treating %s as not "
                "the first reply",
                root_ref,
                channel_id,
                exc,
                message_ref,
            )
            return False
        # Newest first, back from the reply.
        for event in around.get("events_before") or []:
            if event.get("event_id") == root_ref:
                return True
            earlier = event.get("content")
            if isinstance(earlier, dict) and root_ref in (
                _thread_of(earlier),
                _replied_to(earlier),
            ):
                return False
        logger.info(
            "%s in %s replies to %s, which is further back than the events read "
            "around it; treating it as not the first reply",
            message_ref,
            channel_id,
            root_ref,
        )
        return False

    # ── Rooms ────────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        """Create a room, unencrypted, and return its id.

        A public room is one anyone on the homeserver may join, but it is not
        listed in the room directory. A private room is invite-only, and the
        people asked for are invited by `add_users_to_channel`.
        """
        if channel_type not in ("channel_public", "channel_private"):
            raise ChannelCreationUnsupported(
                f"A Matrix room created this way is public or private, not {channel_type}"
            )
        body: dict[str, Any] = {
            "name": name,
            "topic": topic,
            "preset": "public_chat"
            if channel_type == "channel_public"
            else "private_chat",
            "visibility": "private",
            "creation_content": {_CHANNEL_TYPE_KEY: channel_type},
        }
        return CreatedChannel(id=await self._create_room(body), name=name)

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        return await self._create_room(
            {
                "preset": "trusted_private_chat",
                "is_direct": True,
                "invite": [user_external_id],
                "visibility": "private",
                "creation_content": {_CHANNEL_TYPE_KEY: "direct"},
            }
        )

    async def _create_room(self, body: dict[str, Any]) -> str:
        """Create a room the bridge can use, or say why the homeserver will not.

        The request asks for no encryption: it carries no `m.room.encryption`
        in its initial state. A homeserver can still add it, as Synapse does
        with `encryption_enabled_by_default_for_room_type`, and the bridge
        cannot use such a room. That is found out here, the room is left, and
        the caller is told what to change, rather than the room being created,
        refused and left behind a notice the moment the sync sees it.

        `MatrixApiError` is a `BridgeOperationError`, so a refusal reaches
        whoever asked for the room with the homeserver's own words.
        """
        api = self._require_api()
        room_id = await api.create_room(body)
        self._rooms.pop(room_id, None)
        if await api.state_event(room_id, "m.room.encryption") is not None:
            self._encryption[room_id] = (True, time.monotonic())
            self._refused.add(room_id)
            await self._leave_refused(room_id)
            raise BridgeOperationError(
                "The homeserver made the new Matrix room end-to-end encrypted, "
                "which Switch cannot bridge, so it was left. The homeserver "
                "encrypts new rooms by default (on Synapse, "
                "encryption_enabled_by_default_for_room_type); turn that off, or "
                "create the room in Matrix without encryption and invite the bot."
            )
        self._encryption[room_id] = (False, time.monotonic())
        return room_id

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            await self._require_api().leave(external_channel_id)
        except (MatrixApiError, httpx.HTTPError) as exc:
            return RetireOutcome.failed(f"The bot could not leave the room: {exc}")
        self._forget_room(external_channel_id)
        return RetireOutcome(outcome="left")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return (await self._room_info(channel_id)).channel_type

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents are not Matrix accounts: they post through the bot, which is
        # already in the room.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        api = self._require_api()
        left_out: list[str] = []
        for user_id in user_external_ids:
            try:
                member = await api.state_event(channel_id, "m.room.member", user_id)
                if member is not None and member.get("membership") in (
                    "join",
                    "invite",
                ):
                    continue
                await api.invite(channel_id, user_id)
            except (MatrixApiError, httpx.HTTPError) as exc:
                logger.warning(
                    "Could not invite %s to Matrix room %s: %s",
                    user_id,
                    channel_id,
                    exc,
                )
                left_out.append(user_id)
        return left_out

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # One bot account speaks for every agent; there is nothing per agent
        # to create on the homeserver.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        via = f"?via={quote(self._server_name, safe='')}" if self._server_name else ""
        return f"{PERMALINK}{quote(external_channel_id, safe='!:')}{via}"

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """The homeserver's user directory, as far as it shows it to the bot.

        Most homeservers list only people who share a room with the bot or
        are in a public room, unless the administrator opened it wider.
        """
        answer = await self._require_api().search_users(query, limit=20)
        found: list[DirectoryUser] = []
        for result in answer.get("results") or []:
            user_id = str(result.get("user_id") or "")
            if not user_id or user_id == self._user_id:
                continue
            handle = self._remember(user_id)
            found.append(
                DirectoryUser(
                    external_user_id=user_id,
                    username=handle,
                    display_name=str(result.get("display_name") or handle),
                )
            )
        return found

    # ── Translation ──────────────────────────────────────────────────────────

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        for username, user_id in targets.items():
            if username and user_id.startswith("@") and ":" in user_id:
                self._mention_targets[username] = user_id

    def render_app_mention(self, token: str) -> str:
        return pill(self._user_id, f"@{token}") if self._user_id else f"@{token}"

    def _render_outbound(self, content: str) -> str:
        """Switch Markdown, with each person it names written as a Matrix pill.

        An `@handle` Switch knows, or a full `@user:server`, becomes a link
        clients draw as a mention and that `m.mentions` is built from. Code and
        existing links are left exactly as written.
        """
        return _outside_code_and_links(content, self._pills)

    def _pills(self, text: str) -> str:
        def full_id(match: re.Match[str]) -> str:
            user_id = match.group(0)
            return pill(user_id, f"@{self._handle_for(user_id)}")

        def handle(match: re.Match[str]) -> str:
            name = match.group(1)
            # A sentence that ends on a handle ends with a dot the handle is not.
            trailing = len(name) - len(name.rstrip("."))
            user_id = self._mention_targets.get(name.rstrip("."))
            if user_id is None:
                return match.group(0)
            return pill(user_id, f"@{name.rstrip('.')}") + "." * trailing

        text = USER_ID_RE.sub(full_id, text)
        if not self._mention_targets:
            return text
        return _HANDLE_RE.sub(handle, text)

    def translate_inbound(self, raw_message: str) -> str:
        """A Matrix body is already plain text with `@names` as typed."""
        return raw_message


# An `@handle` in prose. Not one that is part of a link's label or target,
# which is what a pill already written looks like, nor the localpart of a full
# `@user:server`; `@alice: the build failed` is a handle.
_HANDLE_RE = re.compile(
    r"(?<![\w@\[/])@([A-Za-z0-9._\-]+)(?![A-Za-z0-9_\-\]]|:[A-Za-z0-9\[])"
)

# A `!command`, with its arguments after any whitespace, a line break included.
_COMMAND_RE = re.compile(r"!(\S+)(?:\s+(.*))?\Z", re.DOTALL)

# What a mention pass must not touch: fenced and inline code, Markdown links and
# bare URLs, where an `@` is part of the text or the address, not a mention.
_PROTECTED_RE = re.compile(
    r"```.*?```|`[^`\n]*`|\[[^\[\]\n]*\]\([^()\s]*\)|<https?://[^>\s]*>|https?://\S+",
    re.DOTALL,
)


def _thread_of(content: dict[str, Any]) -> str | None:
    """The thread an event's content says it is in, or None."""
    relates = content.get("m.relates_to")
    if isinstance(relates, dict) and relates.get("rel_type") == "m.thread":
        root = relates.get("event_id")
        return str(root) if root else None
    return None


def _replied_to(content: dict[str, Any]) -> str | None:
    """The event a message's content says it replies to, or None."""
    relates = content.get("m.relates_to")
    reply = relates.get("m.in_reply_to") if isinstance(relates, dict) else None
    if isinstance(reply, dict) and reply.get("event_id"):
        return str(reply["event_id"])
    return None


def _thread_relation(root_id: str) -> dict[str, Any]:
    """A reply in the thread under `root_id`.

    With the reply fallback the spec asks for, so a client that does not show
    threads still shows the message as a reply to the root.
    """
    return {
        "rel_type": "m.thread",
        "event_id": root_id,
        "is_falling_back": True,
        "m.in_reply_to": {"event_id": root_id},
    }


def _outside_code_and_links(text: str, transform: Callable[[str], str]) -> str:
    pieces: list[str] = []
    last = 0
    for match in _PROTECTED_RE.finditer(text):
        pieces.append(transform(text[last : match.start()]))
        pieces.append(match.group(0))
        last = match.end()
    pieces.append(transform(text[last:]))
    return "".join(pieces)


def _without_reply_fallback(body: str, content: dict[str, Any]) -> str:
    """The body without the quote of the replied-to message older clients prepend.

    That quote is the other message's text, so relaying it would put someone
    else's words in this person's mouth, mentions included.
    """
    relates = content.get("m.relates_to")
    if not isinstance(relates, dict) or "m.in_reply_to" not in relates:
        return body
    if not body.startswith("> <"):
        return body
    lines = body.split("\n")
    index = 0
    while index < len(lines) and lines[index].startswith(">"):
        index += 1
    if index < len(lines) and not lines[index].strip():
        index += 1
    return "\n".join(lines[index:])

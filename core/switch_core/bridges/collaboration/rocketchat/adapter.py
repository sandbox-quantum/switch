"""Rocket.Chat, through one bot user on the operator's own server.

The bot speaks for every agent: a message carries the agent's name and icon in
`alias` and `avatar`, which is what the `bot` role's `message-impersonate`
permission allows. Agents therefore have no accounts of their own. A person
addresses one by typing `@name`, which Switch reads from the text, and every
agent shares the bot's one reaction.

Events arrive on a realtime connection, opened only by the process holding the
bridge. Everything else is REST, so a quiet copy can still serve what reaches
it.

What is said while the bridge is away is read back when it returns. The bot's
read marker on each room is the cursor: it is kept by Rocket.Chat, so a restart or a handover
to another process needs no state of Switch's own. It moves only once what came
before it has been handed over, and a new connection reads back from it. A post
read twice is written to the room once, since `message_ref` is the post's own
id, though a notice about it can be repeated. At most `_MAX_READ_BACK` messages per room are read back, and the cut is
logged.

`subscriptions.read` sets the marker to the server's clock, which can pass a
message whose event is still on the way, so the marker is then pulled back to
the last message handed over. A read-back starts slightly behind that, which
reads that message again. The case not recovered is a message delivered after a
later one by more than that overlap, on a connection that dies before delivering
it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, ClassVar
from urllib.parse import quote, urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    AgentRendering,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.discord.chunking import chunk_message
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    DirectoryUser,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.rocketchat.client import (
    AttachmentTooLarge,
    RocketChatAuthError,
    RocketChatClient,
    RocketChatRefused,
    RocketChatThrottled,
    RocketChatUnavailable,
)
from switch_core.bridges.collaboration.rocketchat.realtime import (
    RealtimeError,
    RocketChatRealtime,
)
from switch_core.bridges.collaboration.session.renderers import (
    Drawn,
    offered_controls,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.outbound import (
    OutboundPolicy,
    OutboundURLRefused,
    guarded_async_client,
)

logger = logging.getLogger(__name__)

# A call to the server that did not do what it was asked.
_CALL_FAILED = (
    httpx.HTTPError,
    BridgeOperationError,
    RocketChatAuthError,
    OutboundURLRefused,
)

_REQUEST_TIMEOUT_SECONDS = 15.0

# A Switch handle, `@name:server` with an optional port. The server stops where
# a host name does, so punctuation after a handle stays in the text.
_HANDLE_SERVER = re.compile(r"(?<![\w.])@([\w.-]+):[\w-]+(?:\.[\w-]+)*(?::\d+)?")

# Below this, `Message_MaxAllowedSize` is not a limit anybody set on purpose,
# and splitting a message to fit it would make no sense.
_MIN_MAX_MESSAGE = 100

# How many times one message is handed over before it is given up on. A message
# that fails every time would otherwise hold its room's read marker forever.
_MAX_HANDOVER_ATTEMPTS = 3

# `Message_MaxAllowedSize` as it ships. Read from the server on start, because
# an admin can change it, and used only if that read fails.
_DEFAULT_MAX_MESSAGE = 5000

# Long enough for an option to read as itself on a button.
_MAX_BUTTON_LABEL = 76

_REACTION: dict[ActivityMark, str] = {
    "working": "eyes",
    "queued": "hourglass_flowing_sand",
}

# How far behind the read marker a read-back starts. Both times are the
# server's, so this is about messages in flight rather than clock skew.
_READ_BACK_OVERLAP_MS = 2_000

# How soon a read-back that failed is tried again.
_READ_BACK_RETRY_SECONDS = 30.0

# Most messages read back for one room. A marker that has not moved in months
# belongs to a room nobody used, and replaying all of it into the room would
# wake every agent there for nothing. The cut is logged.
_MAX_READ_BACK = 500

# A message whose last change is this long after it was sent is not arriving,
# it is being touched: the stream sends a message again whenever it gains a
# reaction or a reply. Only messages not seen yet are in question, so this
# decides what an old message means after a restart.
_FRESH_WINDOW_MS = 5_000

_MAX_SEEN = 2000

_DIRECTORY_PAGE = 200
_DIRECTORY_MAX_USERS = 2000

# Rocket.Chat's letter for each kind of room Switch bridges. Omnichannel ("l")
# and video ("v") rooms are not conversations Switch can join.
_ROOM_TYPES: dict[str, ChannelType] = {
    "c": "channel_public",
    "p": "channel_private",
    "d": "direct",
}

# The system messages that say a person arrived.
_JOIN_MESSAGES = frozenset({"au", "uj"})

# Where each kind of room lists its uploads.
_ROOM_FILES = {"c": "channels", "p": "groups", "d": "im"}

_NON_NAME_CHARACTERS = re.compile(r"[^a-z0-9._-]+")

# A quoted message is written into the text as an empty link to the original.
_QUOTE_LINK = re.compile(r"^(?:\[ \]\(\S+\)\s*)+")

_CODE = re.compile(r"(```.*?```|`[^`\n]+`)", re.DOTALL)

# One asterisk is bold on Rocket.Chat and italic in Switch Markdown.
_SINGLE_ASTERISK = re.compile(r"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])")


def _server_url(value: str) -> str:
    """`value` in one spelling: a scheme, no trailing slash, no default port."""
    parts = urlsplit(value.strip())
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    if port is not None and port != {"http": 80, "https": 443}.get(scheme):
        host = f"{host}:{port}"
    return f"{scheme}://{host}{parts.path.rstrip('/')}"


def _required_text(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError("must not be empty")
    return stripped


class RocketChatConnectionConfig(BridgeConnectionConfig):
    url: str = Field(
        title="Server URL",
        description="The address of your Rocket.Chat server, such as "
        "https://chat.example.com.",
    )
    user_id: str = Field(
        title="Bot user ID",
        description="The _id of the bot's user, shown with its personal access token.",
    )
    personal_access_token: str = Field(
        title="Personal access token",
        description="A token created while signed in as the bot, with "
        "'Ignore Two Factor Authentication' ticked.",
    )
    public_url: str | None = Field(
        default=None,
        title="Public URL",
        description="The address people open Rocket.Chat at, if that is not the "
        "server URL. Used for links to channels.",
    )
    verify_tls: bool = Field(
        default=True,
        title="Verify TLS certificate",
        description="Turn off only for a self-signed certificate you trust.",
    )

    @field_validator("url", mode="before")
    @classmethod
    def _url_is_given(cls, value: object) -> object:
        return _required_text(value) if isinstance(value, str) else value

    @field_validator("url", "public_url")
    @classmethod
    def _names_a_server(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        parts = urlsplit(value.strip())
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            raise ValueError("must be an http(s) URL naming the server")
        if parts.query or parts.fragment:
            raise ValueError("must be the server's address, with no query or fragment")
        try:
            parts.port
        except ValueError as exc:
            raise ValueError(f"has an invalid port: {exc}") from exc
        return _server_url(value)

    @field_validator("user_id", "personal_access_token")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        return _required_text(value)


def _millis(value: Any) -> int:
    """A time as Rocket.Chat sends it, in milliseconds since the epoch: a
    `{"$date": …}` on the realtime connection, ISO text from the REST API."""
    if isinstance(value, dict):
        return int(value.get("$date") or 0)
    if isinstance(value, int | float):
        return int(value)
    if isinstance(value, str) and value:
        return int(
            datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
        )
    return 0


def _iso(millis: int) -> str:
    moment = datetime.fromtimestamp(millis / 1000, UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis % 1000:03d}Z"


_EDIT_CUT_NOTICE = "\n\n⚠️ This edit was cut to fit Rocket.Chat's message size limit."


def _split(text: str, limit: int) -> list[str]:
    """`text` in parts that each fit `limit` as Rocket.Chat measures it. Halving
    the limit is always enough: no character is more than two UTF-16 units."""
    chunks = chunk_message(text, limit)
    if all(_utf16_length(chunk) <= limit for chunk in chunks):
        return chunks
    return chunk_message(text, limit // 2)


def _utf16_length(text: str) -> int:
    """The length Rocket.Chat measures a message by, which is JavaScript's."""
    return len(text.encode("utf-16-le")) // 2


def _publication_id(token: str) -> str:
    """The message id a publication is posted under, worked out from its
    token. Rocket.Chat takes an id from the client, so whether a post whose
    answer was lost exists is a lookup by id rather than a search."""
    return hashlib.sha256(f"switch:{token}".encode()).hexdigest()[:24]


@dataclass(frozen=True)
class _Posted:
    message: dict[str, Any]
    room_type: str
    room_name: str | None
    reading_back: bool = False


@dataclass(frozen=True)
class _Joined:
    room_id: str
    room_type: str
    room_name: str | None


@dataclass(frozen=True)
class _ReadBack:
    pass


@dataclass(frozen=True)
class _Handed:
    message_id: str
    sent_ms: int


@dataclass(frozen=True)
class _Rendered:
    """A card or status as posted, and the same card with no buttons to lean
    on, which is what a failure reports."""

    text: str
    actions: list[dict[str, Any]]
    plain: str


class RocketChatAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Rocket.Chat"
    channel_on_delete = "archived"
    # The server sends each event to every connection the bot has open, so
    # only the process holding the bridge opens one.
    keeps_quiet_unless_listening: ClassVar[bool] = True

    draws_session_activity: ClassVar[bool] = True
    separate_attention_slot: ClassVar[bool] = True
    # By default a person is notified of a message only when it mentions them.
    notifies_only_by_mention: ClassVar[bool] = True
    # The `bot` role has neither `mention-all` nor `mention-here`, and the
    # server refuses the whole message when one is used without it.
    channel_mention: ClassVar[str | None] = None
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True
    activity_reactions_per_agent: ClassVar[bool] = False

    # Every publication is posted under an id worked out from its token.
    recovers_uncertain_posts: ClassVar[bool] = True
    carries_publication_marker: ClassVar[bool] = True
    removes_answered_cards: ClassVar[bool] = False

    renders_custom_url_schemes: ClassVar[bool] = False

    @classmethod
    async def verify_credentials(
        cls, connection_config: dict[str, object], outbound_policy: OutboundPolicy
    ) -> None:
        """Sign in with the token and check the account can speak for agents."""
        config = RocketChatConnectionConfig.model_validate(connection_config)
        async with guarded_async_client(
            outbound_policy, verify=config.verify_tls, timeout=_REQUEST_TIMEOUT_SECONDS
        ) as http:
            client = _client_for(config, http)
            try:
                me = await client.get("me")
                roles = await _permission_roles(client)
            except RocketChatAuthError as exc:
                raise BridgeCredentialError(
                    "Rocket.Chat rejected the sign-in. Check the bot user ID and "
                    "the personal access token."
                ) from exc
            except httpx.TransportError as exc:
                raise BridgeCredentialError(
                    f"Could not reach Rocket.Chat at {config.url}: {exc}"
                ) from exc
            except OutboundURLRefused as exc:
                raise BridgeCredentialError(
                    f"Switch may not connect to Rocket.Chat at {config.url}: {exc}"
                ) from exc
            except BridgeOperationError as exc:
                raise BridgeCredentialError(str(exc)) from exc
        if not _granted(roles, me, "message-impersonate"):
            raise BridgeCredentialError(
                f"{me.get('username')} has no permission to post under an agent's "
                "name (message-impersonate). Give the account the bot role."
            )

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        return f"Rocket.Chat server {_server_url(str(connection_config['url']))}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [_server_url(str(connection_config["url"]))]

    def __init__(self, *, config: RocketChatConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._http: httpx.AsyncClient | None = None
        self._client: RocketChatClient | None = None
        self._realtime: RocketChatRealtime | None = None
        self._tasks: list[asyncio.Task[None]] = []
        # Set once the bot's own account is known. The lifecycle starts the
        # adapter in the background, so a directory search can arrive sooner.
        self._connected = asyncio.Event()
        self._bot_username = ""
        self._max_message = _DEFAULT_MAX_MESSAGE
        self._attention: str | None = None
        self._login_refused = False

        # One queue, handled in order, because the read marker can only pass
        # what has been handed over.
        self._incoming: asyncio.Queue[_Posted | _Joined | _ReadBack] = asyncio.Queue()
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._handover_failures: dict[str, int] = {}
        self._known_rooms: set[str] = set()
        self._unread: set[str] = set()
        # A room whose message could not be handed over keeps its marker, so
        # the message is read back on the next start.
        self._marker_held: set[str] = set()
        self._read_back_retry: asyncio.TimerHandle | None = None
        self._warned_encrypted: set[str] = set()
        self._last_handed: dict[str, _Handed] = {}

        self._rooms: dict[str, dict[str, Any]] = {}
        self._usernames: OrderedDict[str, str] = OrderedDict()

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

        self._http = guarded_async_client(
            self.outbound_policy,
            verify=self._config.verify_tls,
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        self._client = _client_for(self._config, self._http)
        try:
            me = await self._client.get("me")
            self._attention = await self._missing_permissions(me)
        except BaseException:
            await self.stop()
            raise
        self._bot_username = str(me["username"])
        self._max_message = await self._read_max_message()
        self._connected.set()

        if self._listening:
            self._realtime = RocketChatRealtime(
                url=self._config.url,
                token=self._config.personal_access_token,
                policy=self.outbound_policy,
                verify_tls=self._config.verify_tls,
                subscriptions=[
                    ("stream-room-messages", "__my_messages__"),
                    (
                        "stream-notify-user",
                        f"{self._config.user_id}/subscriptions-changed",
                    ),
                ],
                on_event=self._on_stream_event,
                on_ready=self._on_realtime_ready,
                on_login_refused=self._note_login_refused,
            )
            self._tasks = [
                asyncio.create_task(self._realtime.run()),
                asyncio.create_task(self._handle_incoming()),
            ]
        logger.info(
            "Rocket.Chat adapter connected to %s as %s",
            self._config.url,
            self._bot_username,
        )

    async def stop(self) -> None:
        self._connected.clear()
        if self._read_back_retry is not None:
            self._read_back_retry.cancel()
            self._read_back_retry = None
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        self._realtime = None
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        self._client = None
        logger.info("Rocket.Chat adapter stopped")

    async def attention(self) -> str | None:
        if self._login_refused or (self._client is not None and self._client.rejected):
            return (
                "Rocket.Chat refused the bot's personal access token, so messages "
                "are not getting through. Replace it on this connection."
            )
        return self._attention

    def _note_login_refused(self) -> None:
        self._login_refused = True

    def _on_realtime_ready(self) -> None:
        self._login_refused = False
        self._incoming.put_nowait(_ReadBack())

    async def _read_max_message(self) -> int:
        try:
            found = await self._api().get(
                "settings.public", {"_id": "Message_MaxAllowedSize"}
            )
            limit = int(found["settings"][0]["value"])
        except (KeyError, IndexError, TypeError, ValueError, *_CALL_FAILED) as exc:
            logger.warning(
                "Could not read Rocket.Chat's message size limit, so assuming %d: %s",
                _DEFAULT_MAX_MESSAGE,
                exc,
            )
            return _DEFAULT_MAX_MESSAGE
        if limit < _MIN_MAX_MESSAGE:
            logger.warning(
                "Rocket.Chat's message size limit is %d, below the %d Switch can "
                "split a message to fit, so assuming %d",
                limit,
                _MIN_MAX_MESSAGE,
                _DEFAULT_MAX_MESSAGE,
            )
            return _DEFAULT_MAX_MESSAGE
        return limit

    async def _missing_permissions(self, me: dict[str, Any]) -> str | None:
        """What an operator should grant for everything to work.

        A default install leaves `delete-own-message` off the `bot` role, so
        an agent's deletions are refused while its messages post normally.
        """
        roles = await _permission_roles(self._api())
        if _granted(roles, me, "delete-own-message"):
            return None
        return (
            "Rocket.Chat refuses this bot's deletions, so an agent deleting a "
            "message leaves it in the channel. Add the delete-own-message "
            "permission to the bot role."
        )

    def _api(self) -> RocketChatClient:
        if self._client is None:
            raise RuntimeError("Rocket.Chat is not connected.")
        return self._client

    # ── Inbound ──────────────────────────────────────────────────────────────

    def _on_stream_event(self, stream: str, event_name: str, args: list[Any]) -> None:
        if stream == "stream-room-messages" and args:
            if not isinstance(args[0], dict):
                logger.warning(
                    "Ignoring a Rocket.Chat room message that is not an object: %r",
                    args[0],
                )
                return
            room = args[1] if len(args) > 1 and isinstance(args[1], dict) else {}
            self._incoming.put_nowait(
                _Posted(
                    message=args[0],
                    room_type=str(room.get("roomType") or ""),
                    room_name=room.get("roomName"),
                )
            )
        elif stream == "stream-notify-user" and len(args) > 1 and args[0] == "inserted":
            subscription = args[1]
            if not isinstance(subscription, dict):
                logger.warning(
                    "Ignoring a Rocket.Chat subscription that is not an object: %r",
                    subscription,
                )
                return
            self._incoming.put_nowait(
                _Joined(
                    room_id=str(subscription.get("rid")),
                    room_type=str(subscription.get("t") or ""),
                    room_name=subscription.get("fname") or subscription.get("name"),
                )
            )

    async def _handle_incoming(self) -> None:
        while True:
            item = await self._incoming.get()
            try:
                await self._handle(item)
            except Exception:
                # Broad because one bad event must not end delivery for the
                # whole server.
                logger.exception("Could not handle a Rocket.Chat event")
                if isinstance(item, _Posted) and not self._give_up_on(item.message):
                    self._marker_held.add(str(item.message.get("rid")))
            if self._incoming.empty():
                try:
                    await self._advance_read_markers()
                except Exception:
                    logger.exception("Could not move the Rocket.Chat read markers")

    async def _handle(self, item: _Posted | _Joined | _ReadBack) -> None:
        if isinstance(item, _ReadBack):
            await self._read_back()
        elif isinstance(item, _Joined):
            await self._handle_bot_joined(item)
        else:
            await self._handle_posted(item)

    async def _handle_bot_joined(self, joined: _Joined) -> None:
        """The bot was added to a room. A direct message is not joined: it
        becomes a room when somebody writes in it."""
        channel_type = _ROOM_TYPES.get(joined.room_type)
        if channel_type is None or channel_type == "direct":
            return
        if self._on_app_joined is None:
            return
        self._known_rooms.add(joined.room_id)
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=joined.room_id,
                channel_type=channel_type,
                channel_name=joined.room_name,
            )
        )

    async def _handle_posted(self, posted: _Posted) -> None:
        message = posted.message
        message_id = str(message.get("_id") or "")
        room_id = str(message.get("rid") or "")
        system_type = message.get("t")
        sender = message.get("u") or {}
        if not message_id or not room_id or message_id in self._seen:
            return
        if system_type == "e2e":
            self._warn_encrypted(room_id)
            return
        if sender.get("_id") == self._config.user_id and system_type is None:
            return
        if not posted.reading_back and not _is_arriving(message):
            return
        editor = (message.get("editedBy") or {}).get("_id")
        if editor is not None and editor != sender.get("_id"):
            logger.warning(
                "Rocket.Chat message %s was changed by %s, not by its author, so "
                "it is not relayed under the author's name",
                message_id,
                editor,
            )
            return
        # After the handover, so one that fails can be read back.
        await self._hand_over(posted)
        self._remember_seen(message_id)
        self._handover_failures.pop(message_id, None)
        sent_ms = _millis(message.get("ts"))
        handed = self._last_handed.get(room_id)
        # The server refuses to mark the bot's own message unread.
        if sender.get("_id") != self._config.user_id and (
            handed is None or sent_ms >= handed.sent_ms
        ):
            self._last_handed[room_id] = _Handed(message_id, sent_ms)

    async def _hand_over(self, posted: _Posted) -> None:
        message = posted.message
        message_id = str(message["_id"])
        room_id = str(message["rid"])
        sender = message.get("u") or {}
        system_type = message.get("t")
        if system_type in _JOIN_MESSAGES:
            await self._handle_person_joined(posted)
            return
        if system_type:
            return

        channel_type = await self._channel_type_of(room_id, posted.room_type)
        if channel_type is None:
            return
        self._known_rooms.add(room_id)
        self._unread.add(room_id)
        channel_name = None if channel_type == "direct" else posted.room_name
        text = str(message.get("msg") or "") or _file_caption(message)
        stripped = text.strip()
        root_id = message.get("tmid") or None
        if stripped.startswith("!"):
            parts = stripped.split(None, 1)
            if self._on_command is not None:
                await self._on_command(
                    InboundCommand(
                        channel_id=room_id,
                        channel_type=channel_type,
                        sender_id=str(sender.get("_id")),
                        sender_name=str(sender.get("username")),
                        command=parts[0].lstrip("!"),
                        args=parts[1].strip() if len(parts) > 1 else "",
                        message_ref=message_id,
                        root_id=root_id,
                        channel_name=channel_name,
                    )
                )
            return
        if self._on_message is None:
            return
        attachments, failures = await self._fetch_attachments(message, posted.room_type)
        mentions_bot = any(
            mention.get("_id") == self._config.user_id
            for mention in message.get("mentions") or []
        )
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=channel_type,
                sender_id=str(sender.get("_id")),
                sender_name=str(sender.get("username")),
                content=text,
                message_ref=message_id,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self._bot_username if mentions_bot else None,
                sender_is_app=bool(message.get("bot")),
            )
        )

    def _remember_seen(self, message_id: str) -> None:
        self._seen[message_id] = None
        if len(self._seen) > _MAX_SEEN:
            self._seen.popitem(last=False)

    def _warn_encrypted(self, room_id: str) -> None:
        if room_id in self._warned_encrypted:
            return
        self._warned_encrypted.add(room_id)
        logger.warning(
            "Rocket.Chat room %s is end-to-end encrypted, so the bot cannot read "
            "its messages and none of them reach Switch",
            room_id,
        )

    async def _handle_person_joined(self, posted: _Posted) -> None:
        """Someone else joined a room. Rocket.Chat writes the name in `msg`
        for a person added by another, and `u` for one who joined themselves."""
        message = posted.message
        room_id = str(message["rid"])
        username = str(message.get("msg") or (message.get("u") or {}).get("username"))
        if username == self._bot_username or self._on_user_joined is None:
            return
        channel_type = await self._channel_type_of(room_id, posted.room_type)
        if channel_type is None:
            return
        found = await self._api().get("users.info", {"username": username})
        await self._on_user_joined(
            InboundUserJoin(
                channel_id=room_id,
                channel_type=channel_type,
                external_user_id=str(found["user"]["_id"]),
                external_username=username,
                channel_name=posted.room_name,
            )
        )

    async def _fetch_attachments(
        self, message: dict[str, Any], room_type: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download what was uploaded with a message.

        A client can write `files` as well as the server, and the download
        carries the bot's token into every room the bot is in, so a file is
        fetched only once the room it was posted in lists it as its own. Links
        in `attachments` are never fetched. A thumbnail is the server's own
        copy of an image listed beside it.
        """
        files = message.get("files") or (
            [message["file"]] if message.get("file") else []
        )
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for file in files if isinstance(files, list) else []:
            if not isinstance(file, dict) or file.get("typeGroup") == "thumb":
                continue
            name = str(file.get("name") or file.get("_id"))
            size = file.get("size")
            limit = self._max_attachment_bytes
            if isinstance(size, int) and size > limit:
                failures.append(
                    AttachmentFailure(
                        filename=name,
                        reason=f"{size} bytes exceeds the {limit} byte limit",
                    )
                )
                continue
            try:
                uploaded = await self._uploads_named(
                    str(message.get("rid")), room_type, name
                )
            except _CALL_FAILED as exc:
                logger.warning("Could not check Rocket.Chat file %s: %s", name, exc)
                failures.append(
                    AttachmentFailure(filename=name, reason="could not be checked")
                )
                continue
            if file.get("_id") not in uploaded:
                logger.warning(
                    "Rocket.Chat message %s names file %s, which was not uploaded "
                    "in its room, so it is not fetched",
                    message.get("_id"),
                    file.get("_id"),
                )
                failures.append(
                    AttachmentFailure(filename=name, reason="not uploaded in this room")
                )
                continue
            path = (
                f"/file-upload/{quote(str(file.get('_id')), safe='')}"
                f"/{quote(name, safe='')}"
            )
            try:
                data = await self._api().download(path, limit=limit)
            except AttachmentTooLarge:
                failures.append(
                    AttachmentFailure(
                        filename=name, reason=f"exceeds the {limit} byte limit"
                    )
                )
                continue
            except (httpx.HTTPError, OutboundURLRefused) as exc:
                # Not the error's own text: it can carry a signed storage
                # address, or what a name resolved to, and this goes to the room.
                reason = _download_failure(exc)
                logger.warning(
                    "Could not download Rocket.Chat file %s: %s", name, reason
                )
                failures.append(
                    AttachmentFailure(
                        filename=name, reason=f"download failed: {reason}"
                    )
                )
                continue
            attachments.append(
                Attachment(
                    filename=name,
                    mimetype=str(file.get("type") or "application/octet-stream"),
                    data=data,
                )
            )
        return attachments, failures

    async def _uploads_named(self, room_id: str, room_type: str, name: str) -> set[str]:
        """The ids of the files uploaded in a room under a name. The server
        reads `name` as a regular expression."""
        kind = _ROOM_FILES.get(room_type)
        if kind is None:
            return set()
        found = await self._api().get(
            f"{kind}.files", {"roomId": room_id, "name": re.escape(name), "count": 100}
        )
        return {
            str(file.get("_id"))
            for file in found.get("files") or []
            if isinstance(file, dict)
        }

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """Note which rooms Switch knows, because they are the ones read back.
        A room the bot is in and Switch has never heard of has no history
        worth replaying: it becomes a room when somebody next writes there."""
        if not self._listening:
            return
        self._known_rooms.update(channel_id for channel_id, _ in channels)
        self._incoming.put_nowait(_ReadBack())

    async def _read_back(self) -> None:
        """Hand over what was said in Switch's rooms past the read markers.

        A marker is held from the moment a read-back fails, because a live
        message moving it would pass what was never read. This pass reads
        from the markers again, so it starts by letting go of those.
        """
        if not self._known_rooms:
            return
        self._marker_held.clear()
        try:
            found = await self._api().get("subscriptions.get")
        except _CALL_FAILED as exc:
            self._read_back_failed(set(self._known_rooms), exc)
            return
        failed: set[str] = set()
        error: Exception | None = None
        for subscription in found.get("update") or []:
            room_id = str(subscription.get("rid"))
            if room_id not in self._known_rooms:
                continue
            try:
                await self._read_back_room(room_id, subscription)
            except Exception as exc:
                # Broad because a room that cannot be read back must not stop
                # the others, and must still be held and tried again.
                if not isinstance(exc, _CALL_FAILED):
                    logger.exception("Could not read back Rocket.Chat room %s", room_id)
                failed.add(room_id)
                error = exc
        if error is not None:
            self._read_back_failed(failed, error)

    def _read_back_failed(self, rooms: set[str], error: Exception) -> None:
        """Hold the markers and try again later. A retry reads every room, so
        one is enough however many rooms or passes failed."""
        self._marker_held.update(rooms)
        logger.error(
            "Could not read back %d Rocket.Chat room(s), so messages sent while "
            "the bridge was away may be missing until the next attempt in %.0fs: %s",
            len(rooms),
            _READ_BACK_RETRY_SECONDS,
            error,
        )
        if self._read_back_retry is None:
            self._read_back_retry = asyncio.get_running_loop().call_later(
                _READ_BACK_RETRY_SECONDS, self._retry_read_back
            )

    def _retry_read_back(self) -> None:
        self._read_back_retry = None
        self._incoming.put_nowait(_ReadBack())

    async def _read_back_room(self, room_id: str, subscription: dict[str, Any]) -> None:
        marker = _millis(subscription.get("ls") or subscription.get("ts"))
        handed = self._last_handed.get(room_id)
        if handed is not None:
            marker = min(marker, handed.sent_ms)
        since = max(0, marker - _READ_BACK_OVERLAP_MS)
        result = await self._api().get(
            "chat.syncMessages", {"roomId": room_id, "lastUpdate": _iso(since)}
        )
        updated = (result.get("result") or {}).get("updated") or []
        missed = sorted(
            (message for message in updated if _millis(message.get("ts")) >= since),
            key=lambda message: _millis(message.get("ts")),
        )
        if len(missed) > _MAX_READ_BACK:
            logger.warning(
                "Rocket.Chat room %s has %d messages since its read marker; "
                "reading back the latest %d",
                room_id,
                len(missed),
                _MAX_READ_BACK,
            )
            missed = missed[-_MAX_READ_BACK:]
        for message in missed:
            await self._read_back_message(room_id, subscription, message)

    async def _read_back_message(
        self,
        room_id: str,
        subscription: dict[str, Any],
        message: dict[str, Any],
    ) -> None:
        try:
            await self._handle_posted(
                _Posted(
                    message=message,
                    room_type=str(subscription.get("t") or ""),
                    room_name=subscription.get("fname") or subscription.get("name"),
                    reading_back=True,
                )
            )
        except Exception as exc:
            # Broad for the reason `_handle_incoming` is: the rest of the room
            # still has to be read.
            logger.exception(
                "Could not hand over Rocket.Chat message %s", message.get("_id")
            )
            if not self._give_up_on(message):
                self._read_back_failed({room_id}, exc)

    def _give_up_on(self, message: dict[str, Any]) -> bool:
        """Count a failed handover, and once there have been too many, give the
        message up so its room's marker can move again. True if given up."""
        message_id = str(message.get("_id") or "")
        attempts = self._handover_failures.get(message_id, 0) + 1
        if attempts < _MAX_HANDOVER_ATTEMPTS:
            self._handover_failures[message_id] = attempts
            return False
        self._handover_failures.pop(message_id, None)
        self._remember_seen(message_id)
        logger.error(
            "Giving up on Rocket.Chat message %s in room %s after %d failed "
            "attempts; it is not relayed",
            message_id,
            message.get("rid"),
            attempts,
        )
        return True

    async def _advance_read_markers(self) -> None:
        for room_id in self._unread - self._marker_held:
            handed = self._last_handed.get(room_id)
            if handed is not None:
                await self._advance_read_marker(room_id, handed)
        self._unread.clear()

    async def _advance_read_marker(self, room_id: str, handed: _Handed) -> None:
        """Move the marker to the message handed over, by way of the server's
        clock: `subscriptions.unread` only ever moves a marker back."""
        try:
            await self._api().post("subscriptions.read", {"rid": room_id})
        except _CALL_FAILED as exc:
            logger.warning(
                "Could not move the read marker in Rocket.Chat room %s, so "
                "its recent messages are read again on the next start: %s",
                room_id,
                exc,
            )
            return
        try:
            await self._api().post(
                "subscriptions.unread",
                {"firstUnreadMessage": {"_id": handed.message_id}},
            )
        except _CALL_FAILED as exc:
            logger.warning(
                "Could not pull the read marker in Rocket.Chat room %s back to "
                "message %s, so a message still on its way could be missed after "
                "a restart: %s",
                room_id,
                handed.message_id,
                exc,
            )

    async def _channel_type_of(
        self, room_id: str, room_type: str
    ) -> ChannelType | None:
        """None for a kind of room Switch does not bridge."""
        channel_type = _ROOM_TYPES.get(room_type)
        if channel_type == "direct":
            return await self.get_channel_type(room_id)
        return channel_type

    # ── Messaging ────────────────────────────────────────────────────────────

    def _message(
        self,
        channel_id: str,
        rendering: AgentRendering,
        text: str,
        thread_root_id: str | None,
    ) -> dict[str, Any]:
        message: dict[str, Any] = {
            "rid": channel_id,
            "msg": text,
            "alias": rendering.field_label,
        }
        if rendering.icon_url is not None:
            message["avatar"] = rendering.icon_url
        if thread_root_id is not None:
            message["tmid"] = thread_root_id
        return message

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        rendering = await self.agent_rendering(sender_name)
        chunks = _split(content, self._max_message)
        first: str | None = None
        for index, chunk in enumerate(chunks):
            body = self._message(channel_id, rendering, chunk, thread_root_id)
            try:
                result = await self._api().post("chat.sendMessage", {"message": body})
            except _CALL_FAILED as exc:
                logger.error(
                    "Failed to send part %d of %d of a Rocket.Chat message to %s: %s",
                    index + 1,
                    len(chunks),
                    channel_id,
                    exc,
                )
                if first is not None:
                    await self._note_truncation(
                        channel_id, rendering, thread_root_id, index, len(chunks)
                    )
                return first
            first = first or str(result["message"]["_id"])
        return first

    async def _note_truncation(
        self,
        channel_id: str,
        rendering: AgentRendering,
        thread_root_id: str | None,
        delivered: int,
        total: int,
    ) -> None:
        text = (
            f"⚠️ Only {delivered} of {total} parts of this message could be "
            "delivered — the rest was rejected by Rocket.Chat."
        )
        body = self._message(channel_id, rendering, text, thread_root_id)
        try:
            await self._api().post("chat.sendMessage", {"message": body})
        except _CALL_FAILED:
            logger.exception("Failed to post a Rocket.Chat truncation notice")

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        text = new_content
        if _utf16_length(text) > self._max_message:
            logger.warning(
                "An edit to Rocket.Chat message %s is over the size limit, so it "
                "keeps only its first part",
                message_ref,
            )
            room = self._max_message - _utf16_length(_EDIT_CUT_NOTICE)
            text = _split(text, room)[0] + _EDIT_CUT_NOTICE
        try:
            await self._api().post(
                "chat.update",
                {"roomId": channel_id, "msgId": message_ref, "text": text},
            )
        except _CALL_FAILED as exc:
            logger.error(
                "Failed to update Rocket.Chat message %s: %s", message_ref, exc
            )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._api().post(
                "chat.delete", {"roomId": channel_id, "msgId": message_ref}
            )
        except _CALL_FAILED as exc:
            logger.error(
                "Failed to delete Rocket.Chat message %s: %s", message_ref, exc
            )

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
        """Upload the file and post it under the agent's name. A refusal, such
        as a file over the server's limit, goes to the base, which says in the
        channel that the file could not be relayed."""
        rendering = await self.agent_rendering(sender_name)
        text = self.translate_outbound(caption) if caption else ""
        body = {
            key: value
            for key, value in self._message(
                channel_id, rendering, text, thread_root_id
            ).items()
            if key != "rid"
        }
        try:
            file_id = await self._api().upload(channel_id, filename, mimetype, data)
            result = await self._api().post(
                f"rooms.mediaConfirm/{channel_id}/{file_id}", body
            )
            return str(result["message"]["_id"])
        except _CALL_FAILED as exc:
            logger.error(
                "Failed to send %s to Rocket.Chat channel %s: %s",
                filename,
                channel_id,
                exc,
            )
        return await super().send_attachment(
            channel_id, sender_name, filename, mimetype, data, caption, thread_root_id
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        await self._send_activity(channel_id, ["user-typing"] if is_typing else [])

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        await self._send_activity(channel_id, ["user-typing"])

    async def _send_activity(self, channel_id: str, activity: list[str]) -> None:
        """Say so on the realtime connection, which is the only place typing
        can be said. A quiet copy has none, and typing is worth no more than
        what the bridge's holder already shows."""
        realtime = self._realtime
        if realtime is None or not realtime.connected:
            return
        try:
            await realtime.call(
                "stream-notify-room",
                [f"{channel_id}/user-activity", self._bot_username, activity, {}],
            )
        except RealtimeError as exc:
            logger.debug("Could not show typing in %s: %s", channel_id, exc)

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
        """Add or remove the mark. Asking for what is already so succeeds, so
        reconciling after a restart needs nothing special."""
        try:
            await self._api().post(
                "chat.react",
                {
                    "messageId": message_ref,
                    "emoji": _REACTION[mark],
                    "shouldReact": on,
                },
            )
        except RocketChatRefused as exc:
            raise ActivityMarkRefused(str(exc)) from exc

    # ── Session activity ─────────────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return self._max_message

    def rich_fallback_text(self, content: RichContent) -> str:
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
            tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
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
            control_label_limit=_MAX_BUTTON_LABEL if controls else None,
        )
        return replace(drawn, text=f"{lead}{drawn.text}{tail}")

    def _answer_buttons(
        self, content: RichContent, drawn: Drawn
    ) -> list[dict[str, Any]]:
        """Buttons that say the answer for the person pressing.

        A bot has no way to be told a button was pressed. These post the same
        words the card tells people to type, as the person who pressed, so the
        answer takes the path a typed one does and is attributed the same way.
        Anybody can already type them, so the button adds no authority.
        """
        if not isinstance(content, RequestCard) or not drawn.answerable:
            return []
        return [
            {
                "type": "button",
                "text": control.label[:_MAX_BUTTON_LABEL],
                "msg": f"{content.reference.handle} {control.position}",
                "msg_in_chat_window": True,
            }
            for control in offered_controls(content.request)
        ]

    async def _render_rich(self, content: RichContent) -> _Rendered:
        mention = await self._mention(content.notify_external_id)
        responder = (
            await self._mention(content.responder_external_id)
            if isinstance(content, RequestCard)
            else None
        )
        drawn = self._draw(content, mention=mention, responder=responder, controls=True)
        actions = self._answer_buttons(content, drawn)
        plain = self._draw(
            content, mention=mention, responder=responder, controls=False
        )
        return _Rendered(
            text=drawn.text if actions else plain.text,
            actions=actions,
            plain=plain.text,
        )

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a status or a card under the agent's name, with an id worked
        out from its token so a post whose answer was lost can be found."""
        rendered = await self._render_rich(content)
        rendering = await self.agent_rendering(agent_name)
        body = self._message(channel_id, rendering, rendered.text, thread_root_id)
        token = (
            content.publication_token
            if isinstance(content, TurnActivity)
            else content.reference.token
        )
        if token:
            body["_id"] = _publication_id(token)
        if rendered.actions:
            body["attachments"] = [
                {"button_alignment": "horizontal", "actions": rendered.actions}
            ]
        try:
            result = await self._api().post("chat.sendMessage", {"message": body})
        except RocketChatThrottled as exc:
            raise RichContentThrottled(
                retry_after=exc.retry_after, text=rendered.plain
            ) from exc
        except RocketChatAuthError as exc:
            raise RichContentFailed(str(exc), text=rendered.plain) from exc
        except RocketChatRefused as exc:
            # A repeat of an id is refused, and means the post is already there.
            if token:
                found = await self._find_publication(channel_id, token)
                if found is not None:
                    return found
            raise RichContentFailed(str(exc), text=rendered.plain) from exc
        return str(result["message"]["_id"])

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw in place, keeping the name the message was posted under.

        REST can change a message's text and not its attachments, so taking
        the buttons off a settled card goes over the realtime connection. If
        that is not up the text still changes, and a press on what is left is
        refused for naming a settled request.
        """
        rendered = await self._render_rich(replace(content, notify_external_id=None))
        if isinstance(content, RequestCard) and not rendered.actions:
            if await self._rewrite_without_buttons(
                channel_id, message_ref, rendered.text
            ):
                return
        try:
            await self._api().post(
                "chat.update",
                {"roomId": channel_id, "msgId": message_ref, "text": rendered.text},
            )
        except RocketChatThrottled as exc:
            raise RichContentThrottled(
                retry_after=exc.retry_after, text=rendered.plain
            ) from exc
        except (RocketChatRefused, RocketChatAuthError) as exc:
            raise RichContentFailed(str(exc), text=rendered.plain) from exc

    async def _rewrite_without_buttons(
        self, channel_id: str, message_ref: str, text: str
    ) -> bool:
        realtime = self._realtime
        if realtime is None or not realtime.connected:
            logger.warning(
                "No realtime connection, so Rocket.Chat card %s keeps its buttons",
                message_ref,
            )
            return False
        try:
            await realtime.call(
                "updateMessage",
                [
                    {
                        "_id": message_ref,
                        "rid": channel_id,
                        "msg": text,
                        "attachments": [],
                    }
                ],
            )
        except RealtimeError as exc:
            logger.warning(
                "Rocket.Chat card %s keeps its buttons: %s", message_ref, exc
            )
            return False
        return True

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        """Look the publication up by the id its token gives. Checked against
        the room and the bot, so an id somebody else managed to take first is
        not mistaken for it. A lookup that fails answers None and is asked
        again."""
        try:
            return await self._find_publication(channel_id, token)
        except (httpx.HTTPError, RocketChatThrottled, RocketChatUnavailable) as exc:
            logger.warning(
                "Could not look for the publication marked %s in %s: %s",
                token,
                channel_id,
                exc,
            )
            return None

    async def _find_publication(self, channel_id: str, token: str) -> str | None:
        message_id = _publication_id(token)
        try:
            found = await self._api().get("chat.getMessage", {"msgId": message_id})
        except RocketChatRefused:
            return None
        message = found.get("message") or {}
        if (
            message.get("rid") != channel_id
            or (message.get("u") or {}).get("_id") != self._config.user_id
        ):
            return None
        return message_id

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        try:
            thread = await self._api().get(
                "chat.getThreadMessages",
                {"tmid": root_ref, "count": 1, "sort": json.dumps({"ts": 1})},
            )
        except (*_CALL_FAILED, RuntimeError) as exc:
            logger.warning(
                "Could not read the thread under %s in %s, so %s is not treated "
                "as its first reply: %s",
                root_ref,
                channel_id,
                message_ref,
                exc,
            )
            return False
        replies = thread.get("messages") or []
        return bool(replies) and replies[0].get("_id") == message_ref

    async def _mention(self, external_user_id: str | None) -> str | None:
        if not external_user_id:
            return None
        username = self._usernames.get(external_user_id)
        if username is None:
            try:
                found = await self._api().get(
                    "users.info", {"userId": external_user_id}
                )
            except _CALL_FAILED as exc:
                logger.warning(
                    "Could not resolve Rocket.Chat user %s: %s", external_user_id, exc
                )
                return None
            username = str(found["user"]["username"])
            self._usernames[external_user_id] = username
            if len(self._usernames) > _MAX_SEEN:
                self._usernames.popitem(last=False)
        return f"@{username}"

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        if channel_type not in ("channel_public", "channel_private"):
            raise ChannelCreationUnsupported(
                f"Rocket.Chat rooms of type {channel_type} are started from the "
                "client, not created by a bot"
            )
        kind = "channels" if channel_type == "channel_public" else "groups"
        field = "channel" if kind == "channels" else "group"
        slug = _NON_NAME_CHARACTERS.sub("-", name.lower()).strip("-.")[:64] or "switch"
        try:
            created = await self._api().post(f"{kind}.create", {"name": slug})
        except RocketChatRefused as exc:
            if exc.error_type != "error-duplicate-channel-name":
                raise
            created = await self._api().post(
                f"{kind}.create",
                {
                    "name": f"{slug[:55]}-{hashlib.sha256(name.encode()).hexdigest()[:8]}"
                },
            )
        room_id = str(created[field]["_id"])
        if topic:
            await self._api().post(
                f"{kind}.setTopic", {"roomId": room_id, "topic": topic}
            )
        return room_id

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        # Opened by name, which a person can give up and another take.
        found = await self._api().get("users.info", {"username": user_name})
        if found["user"]["_id"] != user_external_id:
            raise BridgeOperationError(
                f"The Rocket.Chat user named {user_name} is no longer the person "
                "Switch knows by that name, so no direct message was opened"
            )
        created = await self._api().post("im.create", {"username": user_name})
        return str(created["room"]["rid"])

    async def _room_info(self, channel_id: str) -> dict[str, Any]:
        room = self._rooms.get(channel_id)
        if room is None:
            room = dict(
                (await self._api().get("rooms.info", {"roomId": channel_id}))["room"]
            )
            self._rooms[channel_id] = room
        return room

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._room_info(channel_id)
        channel_type = _ROOM_TYPES.get(str(room.get("t")))
        if channel_type is None:
            raise BridgeOperationError(
                f"Rocket.Chat room {channel_id} is of kind {room.get('t')!r}, "
                "which Switch does not bridge"
            )
        if channel_type == "direct" and int(room.get("usersCount") or 0) > 2:
            return "group"
        return channel_type

    def _public_url(self) -> str:
        return self._config.public_url or self._config.url

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        # Read afresh, because a room can be renamed and its link has the name.
        self._rooms.pop(external_channel_id, None)
        try:
            room = await self._room_info(external_channel_id)
        except _CALL_FAILED as exc:
            logger.warning(
                "Could not build a link to Rocket.Chat room %s: %s",
                external_channel_id,
                exc,
            )
            return None
        name = room.get("name")
        kind = {"c": "channel", "p": "group"}.get(str(room.get("t")))
        if kind is None or not name:
            return f"{self._public_url()}/direct/{external_channel_id}"
        return f"{self._public_url()}/{kind}/{quote(str(name))}"

    async def home_deeplink(self) -> str | None:
        return self._public_url()

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """Invite each person. The bot may invite to rooms it owns, which are
        the ones it created; anywhere else needs an owner to do it."""
        if not user_external_ids:
            return []
        left_out: list[str] = []
        try:
            kind = {"channel_public": "channels", "channel_private": "groups"}.get(
                await self.get_channel_type(channel_id)
            )
        except _CALL_FAILED as exc:
            logger.warning("Could not read Rocket.Chat room %s: %s", channel_id, exc)
            return list(user_external_ids)
        if kind is None:
            return list(user_external_ids)
        for user_id in user_external_ids:
            try:
                await self._api().post(
                    f"{kind}.invite", {"roomId": channel_id, "userId": user_id}
                )
            except _CALL_FAILED as exc:
                logger.warning(
                    "Could not add %s to Rocket.Chat room %s: %s",
                    user_id,
                    channel_id,
                    exc,
                )
                left_out.append(user_id)
        return left_out

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            kind = {"channel_public": "channels", "channel_private": "groups"}.get(
                await self.get_channel_type(external_channel_id)
            )
            if kind is None:
                return RetireOutcome(outcome="kept")
            await self._api().post(f"{kind}.archive", {"roomId": external_channel_id})
        except _CALL_FAILED as exc:
            return RetireOutcome.failed(str(exc))
        return RetireOutcome(outcome="archived")

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def render_app_mention(self, token: str) -> str:
        return f"@{token}"

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Search `users.list`, which a bot may read in full. The server takes
        no filter on it, so the match is made here, up to a limit.

        `users.autocomplete` and the directory answer a bot only about people
        it shares a room with, which leaves a new connection with nobody to
        offer.
        """
        term = query.strip().lower()
        if not term:
            return []
        await self._connected.wait()
        results: list[DirectoryUser] = []
        offset = 0
        while offset < _DIRECTORY_MAX_USERS:
            try:
                page = await self._api().get(
                    "users.list", {"count": _DIRECTORY_PAGE, "offset": offset}
                )
            except _CALL_FAILED as exc:
                raise RuntimeError(
                    f"Rocket.Chat user directory lookup failed: {exc}"
                ) from exc
            users = page.get("users") or []
            for user in users:
                username = str(user.get("username") or "")
                name = str(user.get("name") or username)
                if (
                    user.get("type") == "bot"
                    or user.get("_id") == self._config.user_id
                    or user.get("active") is False
                    or (term not in username.lower() and term not in name.lower())
                ):
                    continue
                results.append(
                    DirectoryUser(
                        external_user_id=str(user.get("_id")),
                        username=username,
                        display_name=name,
                    )
                )
            offset += len(users)
            if not users or offset >= int(page.get("total") or 0):
                break
        else:
            logger.warning(
                "Rocket.Chat has more than %d users, so a directory search looked "
                "at the first %d only",
                _DIRECTORY_MAX_USERS,
                _DIRECTORY_MAX_USERS,
            )
        results.sort(key=lambda user: user.display_name.lower())
        return results

    # ── Translation ──────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        """Switch Markdown in Rocket.Chat's dialect, which reads it as written
        but for one asterisk, and with no `:server` on a handle."""
        handles = _HANDLE_SERVER.sub(r"@\1", content)
        return "".join(
            part if index % 2 else _SINGLE_ASTERISK.sub(r"_\1_", part)
            for index, part in enumerate(_CODE.split(handles))
        )

    def translate_inbound(self, raw_message: str) -> str:
        return _QUOTE_LINK.sub("", raw_message)


def _client_for(
    config: RocketChatConnectionConfig, http: httpx.AsyncClient
) -> RocketChatClient:
    return RocketChatClient(
        http,
        url=config.url,
        user_id=config.user_id,
        token=config.personal_access_token,
    )


async def _permission_roles(client: RocketChatClient) -> dict[str, list[str]]:
    listed = await client.get("permissions.listAll")
    return {
        str(permission["_id"]): list(permission.get("roles") or [])
        for permission in listed.get("update") or []
    }


def _granted(
    permissions: dict[str, list[str]], me: dict[str, Any], permission: str
) -> bool:
    return bool(set(permissions.get(permission, [])) & set(me.get("roles") or []))


def _is_arriving(message: dict[str, Any]) -> bool:
    """Whether a message on the stream is new rather than changed."""
    if message.get("editedAt"):
        return False
    sent = _millis(message.get("ts"))
    return _millis(message.get("_updatedAt")) - sent <= _FRESH_WINDOW_MS


def _download_failure(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        return f"HTTP {error.response.status_code}"
    if isinstance(error, OutboundURLRefused):
        return "it is stored at an address Switch may not connect to"
    return type(error).__name__


def _file_caption(message: dict[str, Any]) -> str:
    """What was written with a file, which clients put in its description."""
    for attachment in message.get("attachments") or []:
        if not isinstance(attachment, dict):
            continue
        description = attachment.get("description")
        if description:
            return str(description)
    return ""

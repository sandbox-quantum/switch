from __future__ import annotations

import asyncio
import json
import logging
import re
import ssl
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar
from urllib.parse import quote, urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    PlatformAdapter,
    RichContent,
)
from switch_core.bridges.collaboration.discord.chunking import chunk_message
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    DirectoryUser,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.rocketchat.markup import (
    from_rocketchat,
    to_rocketchat,
)
from switch_core.bridges.collaboration.rocketchat.realtime import (
    MY_MESSAGES,
    RealtimeLoginRefused,
    RealtimeSession,
)
from switch_core.bridges.collaboration.rocketchat.rest import (
    RocketChatApiError,
    RocketChatRest,
)
from switch_core.outbound import guarded_async_client

logger = logging.getLogger(__name__)

# Rocket.Chat refuses a message over `Message_MaxAllowedSize`, 5000 characters
# unless an admin changed it. Cutting below that leaves room for the fence a
# split code block is closed and reopened with.
_MAX_MESSAGE = 4000

_REQUEST_TIMEOUT_SECONDS = 15.0

# How long a directory search made while the adapter is still connecting waits
# for it: the lifecycle starts adapters in the background, and a bridge can be
# searched the moment it is registered.
_CONNECT_WAIT_SECONDS = 15.0

# Messages read back after a reconnect start this far before the room was last
# marked read. A message that reached the server between being relayed and the
# room being marked read is then read back too; one relayed twice is dropped by
# Switch, which keys every inbound post on its id.
_REPLAY_OVERLAP = timedelta(minutes=2)

# How far back a reconnect reads at most. A room's last-read mark can be far
# older than any outage — a bot that sat in a busy room for weeks before the
# bridge was connected has never read it — and relaying all of that would hand
# agents weeks of conversation nobody asked them about.
_REPLAY_LIMIT = timedelta(days=1)

# How many relayed message ids are remembered, to skip a message the socket
# sends again because it changed (a reaction, a reply under it).
_SEEN_MAX = 1000

_REACTION: dict[ActivityMark, str] = {
    "working": ":eyes:",
    "queued": ":hourglass_flowing_sand:",
}

# Rocket.Chat's ids are alphanumeric. An id is put in a download path, so one
# that is not is refused rather than let it name some other path on the server.
_FILE_ID = re.compile(r"[A-Za-z0-9]+")

# The system messages that say someone joined a room: by themselves, or added
# by someone else (the added user's name is the message text).
_JOINED = "uj"
_ADDED = "au"

# Rocket.Chat room names allow letters, digits, `-`, `_` and `.` by default
# (`UTF8_Channel_Names_Validation`).
_ROOM_NAME_INVALID = re.compile(r"[^a-z0-9_.-]+")


def _split_server_url(value: str) -> tuple[str, str, int | None, str]:
    parts = urlsplit(value.strip())
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError(
            "server_url must be the http(s) address of the Rocket.Chat server, "
            "e.g. https://chat.example.com"
        )
    if parts.query or parts.fragment:
        raise ValueError("server_url must not carry a query or a fragment")
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError(f"server_url has an invalid port: {exc}") from exc
    return parts.scheme.lower(), parts.hostname.lower(), port, parts.path.rstrip("/")


class RocketChatConnectionConfig(BridgeConnectionConfig):
    server_url: str = Field(
        title="Server URL",
        description="The address of your Rocket.Chat server, as you open it in "
        "a browser, e.g. https://chat.example.com",
    )
    bot_user_id: str = Field(
        title="Bot user ID",
        description="The ID Rocket.Chat shows beside the bot's personal access "
        "token when the token is created.",
    )
    personal_access_token: str = Field(
        title="Personal access token",
        description="A personal access token created while signed in as the bot.",
    )
    verify_tls: bool = Field(
        default=True,
        title="Verify TLS certificate",
        description="Turn off only for a server with a self-signed certificate "
        "you trust.",
    )

    @field_validator("server_url")
    @classmethod
    def _server_url_names_a_server(cls, value: str) -> str:
        _split_server_url(value)
        return value.strip().rstrip("/")

    @field_validator("bot_user_id", "personal_access_token")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


def _websocket_url(server_url: str) -> str:
    scheme, _, rest = server_url.partition("://")
    return f"{'wss' if scheme.lower() == 'https' else 'ws'}://{rest}/websocket"


def _timestamp(value: object) -> datetime | None:
    """A Rocket.Chat date: `{"$date": ms}` on the socket, ISO text over REST."""
    if isinstance(value, dict) and isinstance(value.get("$date"), int | float):
        return datetime.fromtimestamp(value["$date"] / 1000, UTC)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _room_name(name: str) -> str:
    cleaned = _ROOM_NAME_INVALID.sub("-", name.strip().lower()).strip("-.")
    return cleaned[:64] or "switch-room"


class RocketChatAdapter(PlatformAdapter):
    """Rocket.Chat collaboration bridge adapter.

    One bot user on the operator's own server speaks for every agent. Each
    message carries the agent's name and icon as its `alias` and `avatar`,
    which Rocket.Chat draws in place of the bot's, so agents read as
    themselves while sharing one account. Inbound arrives on the bot's
    realtime WebSocket; everything else is REST, which any process can call.

    Rooms are the bot's: a public or private channel it is a member of, or a
    direct message with it. Threads map to threads.
    """

    display_name: ClassVar[str] = "Rocket.Chat"
    channel_on_delete = "archived"
    # Rocket.Chat sends each message to every socket the bot has open, so a
    # socket in every process would relay each message once per process. A
    # quiet copy opens none and still calls the REST API.
    keeps_quiet_unless_listening: ClassVar[bool] = True

    supports_channel_creation: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = True
    # Rocket.Chat linkifies http(s) only, so a `switchdash://` link would show
    # as text.
    renders_custom_url_schemes: ClassVar[bool] = False

    # Turns and request cards are drawn as text, and a card is answered by
    # replying to it, which is the one way a bot user can be answered here:
    # a button on a message posts as the person who pressed it, and only an
    # app installed on the server is told about the press.
    draws_session_activity: ClassVar[bool] = True

    supports_activity_reactions: ClassVar[bool] = True
    # One account can hold several different reactions on a message.
    supports_queue_reaction: ClassVar[bool] = True
    # Every agent reacts through the one bot, so there is one mark between them.
    activity_reactions_per_agent: ClassVar[bool] = False

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask Rocket.Chat who the token belongs to (`me`), as `start` will.

        `server_url` has been through the outbound policy before this is
        called, and redirects are not followed, so the token is only sent
        where Switch may connect.
        """
        config = RocketChatConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(
            base_url=config.server_url,
            verify=config.verify_tls,
            timeout=_REQUEST_TIMEOUT_SECONDS,
            trust_env=False,
        ) as client:
            rest = RocketChatRest(
                client, user_id=config.bot_user_id, token=config.personal_access_token
            )
            try:
                me = await rest.get("me")
            except RocketChatApiError as exc:
                if exc.status == 401:
                    raise BridgeCredentialError(
                        f"Rocket.Chat at {config.server_url} did not accept the "
                        "bot user ID and personal access token. Check both, and "
                        "that the token was created while signed in as the bot."
                    ) from exc
                raise BridgeCredentialError(
                    f"Rocket.Chat at {config.server_url} answered the "
                    f"credential check with an error: {exc}. Check the server URL."
                ) from exc
            except httpx.HTTPError as exc:
                raise BridgeCredentialError(
                    f"Could not reach Rocket.Chat at {config.server_url} to check "
                    f"the credentials: {exc}"
                ) from exc
        username = me.get("username", config.bot_user_id)
        if "bot" not in me.get("roles", []):
            raise BridgeCredentialError(
                f"{username} is not a bot user. Give the account the bot role "
                "in Administration → Users: only a bot may post under each "
                "agent's name."
            )
        if me.get("active") is False:
            raise BridgeCredentialError(
                f"The Rocket.Chat user {username} is deactivated."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, RealtimeLoginRefused):
            return "auth_failed"
        if isinstance(exc, RocketChatApiError):
            return "auth_failed" if exc.status == 401 else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """The bot on its server. Two bridges on one bot would each be handed
        every message the bot sees."""
        scheme, host, port, path = _split_server_url(
            str(connection_config["server_url"])
        )
        if port is not None and port != {"http": 80, "https": 443}[scheme]:
            host = f"{host}:{port}"
        bot = str(connection_config["bot_user_id"]).strip()
        return f"Rocket.Chat bot {bot} on {scheme}://{host}{path}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [str(connection_config["server_url"])]

    def __init__(self, *, config: RocketChatConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._rest: RocketChatRest | None = None
        self._session: RealtimeSession | None = None
        self._bot_username = ""
        # Set once `me` has answered: what a directory search needs.
        self._connected = asyncio.Event()
        # Messages already handed to Switch, so a message re-sent on the socket
        # because someone reacted to it is not downloaded again. Losing this
        # costs nothing more: Switch drops a post it has seen by its id.
        self._seen: OrderedDict[str, None] = OrderedDict()
        # room id -> what kind of room it is, which never changes.
        self._channel_types: dict[str, ChannelType] = {}
        # Rooms with a message Switch could not take. Their read mark stays
        # where it is until a reconnect has read that message back, since
        # marking the room read for a later message would skip it.
        self._unrelayed: set[str] = set()
        # Set once Rocket.Chat refuses a message under an agent's name and
        # takes it with the name in the text: the bot lacks
        # `message-impersonate`, and every message from then on is sent the
        # second way.
        self._names_in_text = False

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
        # Unused: one bot speaks for every agent, so no agent joins on its own.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        client = guarded_async_client(
            self.outbound_policy,
            verify=self._config.verify_tls,
            base_url=self._config.server_url,
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        self._rest = RocketChatRest(
            client,
            user_id=self._config.bot_user_id,
            token=self._config.personal_access_token,
        )
        me = await self._rest.get("me")
        self._bot_username = str(me.get("username", ""))
        self._connected.set()

        if not self._listening:
            logger.info(
                "Rocket.Chat adapter for %s running quietly: another process "
                "holds this bridge and listens for it",
                self._bot_username,
            )
            return
        self._session = RealtimeSession(
            url=_websocket_url(self._config.server_url),
            user_id=self._config.bot_user_id,
            token=self._config.personal_access_token,
            ssl_context=self._ssl_context(),
            resolve=self.outbound_policy.resolve,
            on_event=self._on_realtime_event,
            on_subscribed=self._catch_up,
        )
        self._session.start()
        logger.info(
            "Rocket.Chat adapter connected to %s as %s",
            self._config.server_url,
            self._bot_username,
        )

    async def stop(self) -> None:
        self._connected.clear()
        if self._session is not None:
            await self._session.stop()
            self._session = None
        if self._rest is not None:
            await self._rest.aclose()
            self._rest = None
        logger.info("Rocket.Chat adapter stopped")

    def _ssl_context(self) -> ssl.SSLContext | None:
        if not self._config.server_url.lower().startswith("https"):
            return None
        context = ssl.create_default_context()
        if not self._config.verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        return context

    @property
    def _api(self) -> RocketChatRest:
        if self._rest is None:
            raise RuntimeError("Rocket.Chat adapter is not started")
        return self._rest

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def _on_realtime_event(
        self, collection: str, event: str, args: list[Any]
    ) -> None:
        if collection == "stream-room-messages" and event == MY_MESSAGES:
            message = args[0] if args and isinstance(args[0], dict) else None
            room = args[1] if len(args) > 1 and isinstance(args[1], dict) else {}
            # The stream also carries public channels the bot can read but has
            # not joined; those are not the bot's rooms.
            if message is None or not room.get("roomParticipant"):
                return
            room_id = str(message.get("rid", ""))
            try:
                relayed = await self._receive(
                    message,
                    room_type=str(room.get("roomType", "")),
                    room_name=room.get("roomName"),
                    replayed=False,
                )
            except Exception:
                self._unrelayed.add(room_id)
                raise
            if relayed and room_id not in self._unrelayed:
                await self._mark_read(room_id)
        elif collection == "stream-notify-user" and len(args) > 1:
            action, subscription = args[0], args[1]
            if action == "inserted" and isinstance(subscription, dict):
                await self._receive_bot_added(subscription)

    async def _receive_bot_added(self, subscription: dict[str, Any]) -> None:
        """The bot was added to a room. A room it created itself is one Switch
        asked for, and is bound to its Switch room already."""
        room_type = subscription.get("t")
        if room_type not in ("c", "p") or "owner" in subscription.get("roles", []):
            return
        if self._on_app_joined is None:
            return
        room_id = str(subscription["rid"])
        channel_type = self._channel_type_of(str(room_type), users_count=0)
        self._channel_types[room_id] = channel_type
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=room_id,
                channel_type=channel_type,
                channel_name=subscription.get("fname") or subscription.get("name"),
            )
        )

    async def _catch_up(self) -> None:
        """Relay what was said in the bot's rooms while nobody listened.

        Each room's checkpoint is the bot's own "last read" mark, which the
        server keeps and which moves only past what Switch has taken. It is
        the same for every process, so whichever holds the bridge next starts
        where the last one stopped, after a restart or a handover.
        """
        subscriptions = (await self._api.get("subscriptions.get")).get("update", [])
        for subscription in subscriptions:
            room_id = subscription.get("rid")
            if not room_id or subscription.get("archived"):
                continue
            try:
                await self._read_back(str(room_id), subscription)
            except Exception:
                # The room stays unread from where it stopped, and is read
                # back from there next time. The other rooms go on.
                logger.exception(
                    "Could not read back what was said in Rocket.Chat room %s "
                    "while Switch was not listening; it is tried again on the "
                    "next reconnect",
                    room_id,
                )

    async def _read_back(self, room_id: str, subscription: dict[str, Any]) -> None:
        last_read = _timestamp(subscription.get("ls"))
        if last_read is None:
            return
        since = last_read - _REPLAY_OVERLAP
        oldest = datetime.now(UTC) - _REPLAY_LIMIT
        if since < oldest:
            if subscription.get("unread"):
                logger.warning(
                    "Rocket.Chat room %s has unread messages from before the "
                    "last %s; only that much is read back, and anything older "
                    "is not relayed",
                    room_id,
                    _REPLAY_LIMIT,
                )
            since = oldest
        synced = await self._api.get(
            "chat.syncMessages",
            roomId=room_id,
            lastUpdate=since.isoformat().replace("+00:00", "Z"),
        )
        missed = [
            message
            for message in synced.get("result", {}).get("updated", [])
            if (sent := _timestamp(message.get("ts"))) is not None and sent >= since
        ]
        missed.sort(key=lambda message: _timestamp(message.get("ts")) or since)
        relayed = False
        for message in missed:
            # In order, and stopping at the first that fails, so the room is
            # marked read only once everything before now has reached Switch.
            relayed |= await self._receive(
                message,
                room_type=str(subscription.get("t", "")),
                room_name=subscription.get("fname") or subscription.get("name"),
                replayed=True,
            )
        if relayed or room_id in self._unrelayed:
            await self._mark_read(room_id)
            self._unrelayed.discard(room_id)

    async def _receive(
        self,
        message: dict[str, Any],
        *,
        room_type: str,
        room_name: str | None,
        replayed: bool,
    ) -> bool:
        """Hand one message to Switch; whether it was one to hand over."""
        message_id = message.get("_id")
        room_id = message.get("rid")
        sender = message.get("u") or {}
        if not message_id or not room_id:
            return False
        # Every agent posts as the bot, so everything the bot said is an echo.
        if sender.get("_id") == self._config.bot_user_id:
            return False
        kind = message.get("t")
        if kind and kind not in (_JOINED, _ADDED):
            # Other system messages, and a removed message ("rm"). Deletions
            # are not mirrored into Switch, which has no event for one.
            return False
        # An edit re-sends the message with `editedAt`; Switch has no event for
        # an edit either. Read back after a reconnect it is the latest text of
        # a message that may never have been relayed, and is relayed if not.
        if message.get("editedAt") and not replayed:
            return False
        if message_id in self._seen:
            return False

        room_id = str(room_id)
        channel_type = await self._channel_type(room_id, room_type)
        if channel_type is None:
            return False
        if kind:
            await self._receive_join(message, room_id, channel_type, room_name)
        else:
            await self._receive_post(message, room_id, channel_type, room_name)
        # Only once Switch has it, so a message whose relay failed is not
        # skipped when it is read back.
        self._seen[message_id] = None
        if len(self._seen) > _SEEN_MAX:
            self._seen.popitem(last=False)
        return True

    async def _receive_post(
        self,
        message: dict[str, Any],
        room_id: str,
        channel_type: ChannelType,
        room_name: str | None,
    ) -> None:
        sender = message.get("u") or {}
        sender_id = str(sender.get("_id", ""))
        sender_name = str(sender.get("username") or sender_id)
        text = str(message.get("msg") or "")
        stripped = text.strip()
        root_id = message.get("tmid") or None
        # A post made through an integration (an incoming webhook) carries
        # `bot` and is credited to whichever user the integration posts as, so
        # it is not that person speaking.
        from_integration = bool(message.get("bot"))

        if stripped.startswith("!"):
            if from_integration:
                logger.warning(
                    "Ignoring command %r posted by an integration in Rocket.Chat "
                    "room %s: a command must come from a person",
                    stripped.split(None, 1)[0],
                    room_id,
                )
                return
            if self._on_command is not None:
                command, _, args = stripped.partition(" ")
                await self._on_command(
                    InboundCommand(
                        channel_id=room_id,
                        channel_type=channel_type,
                        sender_id=sender_id,
                        sender_name=sender_name,
                        command=command.lstrip("!"),
                        args=args.strip(),
                        message_ref=str(message["_id"]),
                        root_id=root_id,
                        channel_name=room_name,
                    )
                )
            return

        if self._on_message is None:
            return
        attachments, failures = await self._fetch_attachments(message)
        if not stripped and not attachments and not failures:
            return
        mentioned = {str(m.get("_id")) for m in message.get("mentions") or []}
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=sender_name,
                content=text,
                message_ref=str(message["_id"]),
                root_id=root_id,
                channel_name=room_name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=(
                    self._bot_username
                    if self._config.bot_user_id in mentioned
                    else None
                ),
                sender_is_app=from_integration,
            )
        )

    async def _receive_join(
        self,
        message: dict[str, Any],
        room_id: str,
        channel_type: ChannelType,
        room_name: str | None,
    ) -> None:
        if self._on_user_joined is None:
            return
        if message.get("t") == _JOINED:
            user = message.get("u") or {}
            user_id, username = str(user.get("_id", "")), str(user.get("username", ""))
        else:
            username = str(message.get("msg") or "")
            if username == self._bot_username:
                return  # the bot's own arrival: see `_receive_bot_added`
            try:
                found = await self._api.get("users.info", username=username)
            except (RocketChatApiError, httpx.HTTPError) as error:
                logger.warning(
                    "Could not look up %s, added to Rocket.Chat room %s: %s",
                    username,
                    room_id,
                    error,
                )
                return
            user_id = str(found.get("user", {}).get("_id", ""))
        if not user_id or not username:
            return
        await self._on_user_joined(
            InboundUserJoin(
                channel_id=room_id,
                channel_type=channel_type,
                external_user_id=user_id,
                external_username=username,
                channel_name=room_name,
            )
        )

    async def _fetch_attachments(
        self, message: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download every file on a message, or say why one could not be."""
        files = message.get("files") or (
            [message["file"]] if message.get("file") else []
        )
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        limit = self._max_attachment_bytes
        for file in files:
            file_id = str(file.get("_id", ""))
            filename = str(file.get("name") or file_id)
            if not _FILE_ID.fullmatch(file_id):
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason="it has no valid file id"
                    )
                )
                continue
            size = file.get("size")
            if isinstance(size, int) and size > limit:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{size} bytes exceeds the {limit} byte limit",
                    )
                )
                continue
            try:
                data = await self._api.download(
                    f"/file-upload/{file_id}/{quote(filename, safe='')}", limit
                )
            except ValueError as over:
                failures.append(AttachmentFailure(filename=filename, reason=str(over)))
                continue
            except (RocketChatApiError, httpx.HTTPError) as error:
                logger.warning(
                    "Could not download %s from Rocket.Chat: %s", filename, error
                )
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"download failed: {error}"
                    )
                )
                continue
            attachments.append(
                Attachment(
                    filename=filename,
                    mimetype=str(file.get("type") or "application/octet-stream"),
                    data=data,
                )
            )
        return attachments, failures

    async def _mark_read(self, room_id: str) -> None:
        """Move the room's checkpoint (see `_catch_up`) past what was relayed."""
        try:
            await self._api.post("subscriptions.read", {"rid": room_id})
        except (RocketChatApiError, httpx.HTTPError) as error:
            logger.warning(
                "Could not mark Rocket.Chat room %s read, so a reconnect will "
                "read its messages back again: %s",
                room_id,
                error,
            )

    async def _channel_type(self, room_id: str, room_type: str) -> ChannelType | None:
        """What kind of room this is, or None for one the bridge does not serve
        (an omnichannel conversation, say)."""
        known = self._channel_types.get(room_id)
        if known is not None:
            return known
        if room_type in ("c", "p"):
            channel_type = self._channel_type_of(room_type, users_count=0)
        else:
            # A direct message is one-to-one or a group, which only the room says.
            room = await self._room(room_id)
            room_type = str(room.get("t", ""))
            if room_type not in ("c", "p", "d"):
                logger.debug(
                    "Ignoring Rocket.Chat room %s of type %r", room_id, room_type
                )
                return None
            channel_type = self._channel_type_of(
                room_type, users_count=int(room.get("usersCount") or 0)
            )
        self._channel_types[room_id] = channel_type
        return channel_type

    @staticmethod
    def _channel_type_of(room_type: str, *, users_count: int) -> ChannelType:
        if room_type == "c":
            return "channel_public"
        if room_type == "p":
            return "channel_private"
        return "group" if users_count > 2 else "direct"

    async def _room(self, room_id: str) -> dict[str, Any]:
        room: dict[str, Any] = (await self._api.get("rooms.info", roomId=room_id))[
            "room"
        ]
        return room

    def translate_inbound(self, raw_message: str) -> str:
        return from_rocketchat(raw_message)

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_rocketchat(content)

    def rich_fallback_limit(self) -> int:
        return _MAX_MESSAGE

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the bot, under the agent's name and icon.

        Setting a message's name and icon takes the `message-impersonate`
        permission, which the bot role has unless an admin took it away. A
        post refused while carrying them is tried again with the agent named
        in the text instead. If that one is taken, the permission is what was
        missing, and from then on agents are named in the text; if it is
        refused too, the refusal was about something else.
        """
        agent = await self.agent_rendering(sender_name)
        if not self._names_in_text:
            identity = {"alias": agent.field_label}
            if agent.icon_url:
                identity["avatar"] = agent.icon_url
            try:
                return await self._post_text(
                    channel_id, content, thread_root_id, identity=identity
                )
            except httpx.HTTPError as error:
                return self._not_posted(channel_id, error)
            except RocketChatApiError as error:
                if error.status != 400:
                    return self._not_posted(channel_id, error)
                refused = error
        try:
            ref = await self._post_text(
                channel_id,
                self._named(agent.body_label, content),
                thread_root_id,
                identity={},
            )
        except (RocketChatApiError, httpx.HTTPError) as error:
            return self._not_posted(channel_id, error)
        if not self._names_in_text:
            self._names_in_text = True
            logger.warning(
                "Rocket.Chat refused a message under %s's name (%s), so agents "
                "are named in their messages' text instead. Grant the bot role "
                "the message-impersonate permission to show them as senders.",
                sender_name,
                refused,
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
        """Redraw in place, keeping the agent's name in the text where
        `send_message` had to put it there."""
        if not self._names_in_text:
            await super().update_rich(
                channel_id, agent_name, message_ref, content, thread_root_id
            )
            return
        label = await self.agent_label_for_body(agent_name)
        await self.update_message(
            channel_id,
            message_ref,
            self._named(label, self.rich_fallback_text(content)),
        )

    @staticmethod
    def _named(label: str, body: str) -> str:
        return f"**{label}**: {body}" if body else f"**{label}**"

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        # Under the bot's own name: a notice is Switch speaking, not an agent.
        try:
            return await self._post_text(
                channel_id,
                self._admin_body(self.translate_outbound(content), drawn),
                thread_root_id,
                identity={},
            )
        except (RocketChatApiError, httpx.HTTPError) as error:
            return self._not_posted(channel_id, error)

    async def _post_text(
        self,
        channel_id: str,
        text: str,
        thread_root_id: str | None,
        *,
        identity: dict[str, str],
    ) -> str | None:
        """Post `text`, split where it is too long for one message, and return
        the first part's id. Every part goes where the first went, in order.

        Raises if the first part is refused, when nothing has been posted. A
        later part refused is logged, and the parts already posted stand.
        """
        first: str | None = None
        for part in chunk_message(text, _MAX_MESSAGE):
            body: dict[str, Any] = {"roomId": channel_id, "text": part, **identity}
            if thread_root_id:
                body["tmid"] = thread_root_id
            try:
                posted = await self._api.post("chat.postMessage", body)
            except (RocketChatApiError, httpx.HTTPError) as error:
                if first is None:
                    raise
                logger.error(
                    "Rocket.Chat refused the rest of a long message in room %s "
                    "after its first part was posted: %s",
                    channel_id,
                    error,
                )
                return first
            first = first or str(posted["message"]["_id"])
        return first

    @staticmethod
    def _not_posted(channel_id: str, error: Exception) -> str | None:
        """Log a message that was not posted, and answer as `send_message`
        does for one: no message id."""
        logger.error(
            "Rocket.Chat did not accept a message in room %s: %s", channel_id, error
        )
        return None

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
        """Upload one file into the room, captioned with the agent's name.

        A file goes up as the bot without an alias — Rocket.Chat's upload takes
        none — so the agent is named in the caption instead. A file the server
        refuses, most often for being over its upload limit, is replaced by a
        message saying so, rather than vanishing.
        """
        label = await self.agent_label_for_body(sender_name)
        body = self.translate_outbound(caption or "")
        text = self._named(label, body)
        try:
            staged = await self._api.upload(channel_id, filename, mimetype, data)
            confirm: dict[str, Any] = {"msg": text}
            if thread_root_id:
                confirm["tmid"] = thread_root_id
            posted = await self._api.post(
                f"rooms.mediaConfirm/{channel_id}/{staged['file']['_id']}", confirm
            )
        except (RocketChatApiError, httpx.HTTPError) as error:
            logger.error(
                "Rocket.Chat refused the file %s in room %s: %s",
                filename,
                channel_id,
                error,
            )
            notice = self.translate_outbound(
                f"_could not share the file {filename}: Rocket.Chat refused it ({error})_"
            )
            return await self.send_message(
                channel_id,
                sender_name,
                f"{body}\n{notice}" if body else notice,
                thread_root_id,
            )
        return str(posted["message"]["_id"])

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        text = new_content
        if len(text) > _MAX_MESSAGE:
            text = text[: _MAX_MESSAGE - 1] + "…"
        try:
            await self._api.post(
                "chat.update",
                {"roomId": channel_id, "msgId": message_ref, "text": text},
            )
        except (RocketChatApiError, httpx.HTTPError) as error:
            logger.error(
                "Rocket.Chat did not update message %s in room %s: %s",
                message_ref,
                channel_id,
                error,
            )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._api.post(
                "chat.delete", {"roomId": channel_id, "msgId": message_ref}
            )
        except (RocketChatApiError, httpx.HTTPError) as error:
            logger.error(
                "Rocket.Chat did not delete message %s in room %s (the bot needs "
                "the delete-own-message permission): %s",
                message_ref,
                channel_id,
                error,
            )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Rocket.Chat has no REST call for typing, and the realtime one is a
        # deprecated method call. The working reaction says the same thing.
        return None

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
        """React to the message being worked on, or take the reaction back.

        Setting a reaction to what it already is changes nothing, so the
        call is the same whether or not this process remembers the mark.
        A refusal (reactions turned off, a message gone) is the same on every
        attempt and is raised as `ActivityMarkRefused`; anything else is
        raised as itself, to be tried again.
        """
        try:
            await self._api.post(
                "chat.react",
                {"messageId": message_ref, "emoji": _REACTION[mark], "shouldReact": on},
            )
        except RocketChatApiError as error:
            if error.status == 429 or error.status >= 500:
                raise
            raise ActivityMarkRefused(
                f"Rocket.Chat will not {'add' if on else 'remove'} the "
                f"{mark} reaction on {message_ref} in room {channel_id} ({error})."
            ) from error

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        try:
            replies = (
                await self._api.get("chat.getThreadMessages", tmid=root_ref, count=100)
            ).get("messages", [])
        except Exception as error:
            # Never raised: this is asked on the way in of every reply.
            logger.warning(
                "Could not read the thread under %s in Rocket.Chat room %s: %s",
                root_ref,
                channel_id,
                error,
            )
            return False
        dated = [(_timestamp(r.get("ts")), r.get("_id")) for r in replies]
        known = [(sent, ref) for sent, ref in dated if sent is not None]
        return bool(known) and min(known)[1] == message_ref

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        method, key = (
            ("channels.create", "channel")
            if channel_type == "channel_public"
            else ("groups.create", "group")
        )
        body: dict[str, Any] = {"name": _room_name(name)}
        if topic:
            body["extraData"] = {"topic": topic}
        try:
            created = await self._api.post(method, body)
        except RocketChatApiError as error:
            raise BridgeOperationError(
                f"Rocket.Chat would not create the room {body['name']!r}: {error}"
            ) from error
        room_id = str(created[key]["_id"])
        self._channel_types[room_id] = (
            "channel_public" if key == "channel" else "channel_private"
        )
        return room_id

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        """A direct message between the bot and the person. Every agent talks
        through the bot, so it is the agent's direct message as well."""
        try:
            user = (await self._api.get("users.info", userId=user_external_id))["user"]
            opened = await self._api.post("im.create", {"username": user["username"]})
        except RocketChatApiError as error:
            raise BridgeOperationError(
                f"Rocket.Chat would not open a direct message with {user_name}: {error}"
            ) from error
        room_id = str(opened["room"]["_id"])
        return room_id

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            room_type = str((await self._room(external_channel_id)).get("t", ""))
            if room_type not in ("c", "p"):
                # A direct message cannot be archived.
                return RetireOutcome(outcome="kept")
            method = "channels.archive" if room_type == "c" else "groups.archive"
            await self._api.post(method, {"roomId": external_channel_id})
        except (RocketChatApiError, httpx.HTTPError) as error:
            return RetireOutcome.failed(
                f"Rocket.Chat would not archive the room: {error}"
            )
        return RetireOutcome(outcome="archived")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._room(channel_id)
        return self._channel_type_of(
            str(room.get("t", "")), users_count=int(room.get("usersCount") or 0)
        )

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents speak through the bot, which is in the room already.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        if not user_external_ids:
            return []
        try:
            room_type = str((await self._room(channel_id)).get("t", ""))
        except (RocketChatApiError, httpx.HTTPError) as error:
            logger.warning("Could not read Rocket.Chat room %s: %s", channel_id, error)
            return list(user_external_ids)
        method = "channels.invite" if room_type == "c" else "groups.invite"
        left_out: list[str] = []
        for name, user_id in zip(user_names, user_external_ids, strict=True):
            try:
                await self._api.post(method, {"roomId": channel_id, "userId": user_id})
            except (RocketChatApiError, httpx.HTTPError) as error:
                logger.warning(
                    "Could not add %s to Rocket.Chat room %s: %s",
                    name,
                    channel_id,
                    error,
                )
                left_out.append(user_id)
        return left_out

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        if not self._config.server_url.lower().startswith("https://"):
            return None
        try:
            room = await self._room(external_channel_id)
        except (RocketChatApiError, httpx.HTTPError):
            logger.debug("Could not read Rocket.Chat room %s", external_channel_id)
            return None
        kind = {"c": "channel", "p": "group"}.get(str(room.get("t")))
        if kind is None:
            return f"{self._config.server_url}/direct/{quote(external_channel_id)}"
        return f"{self._config.server_url}/{kind}/{quote(str(room.get('name', '')))}"

    async def home_deeplink(self) -> str | None:
        if not self._config.server_url.lower().startswith("https://"):
            return None
        return f"{self._config.server_url}/home"

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # An agent's name and icon travel on each of its messages.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    # ── Directory ────────────────────────────────────────────────────────────

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        term = query.strip()
        if not term:
            return []
        try:
            async with asyncio.timeout(_CONNECT_WAIT_SECONDS):
                await self._connected.wait()
        except TimeoutError:
            raise RuntimeError(
                "The Rocket.Chat bridge is not connected yet, so its directory "
                f"cannot be searched; it did not connect within {_CONNECT_WAIT_SECONDS:.0f}s."
            ) from None
        try:
            found = await self._api.get(
                "users.autocomplete", selector=json.dumps({"term": term})
            )
        except (RocketChatApiError, httpx.HTTPError) as error:
            raise RuntimeError(
                f"Rocket.Chat user directory lookup failed: {error}"
            ) from error
        users = [
            DirectoryUser(
                external_user_id=str(item["_id"]),
                username=str(item.get("username", "")),
                display_name=str(item.get("name") or item.get("username", "")),
            )
            for item in found.get("items", [])
            if item.get("_id") != self._config.bot_user_id
        ]
        return sorted(users, key=lambda user: user.display_name.lower())

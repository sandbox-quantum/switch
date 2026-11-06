"""Rocket.Chat as a messaging platform, through a bot user on the operator's server.

What arrives comes over the server's realtime API on one WebSocket, held by the
process that holds the bridge (`realtime.py`). What leaves goes over REST
(`client.py`), from whichever process needs to send it.

A dropped connection loses nothing: the bot's own read mark in each room is the
checkpoint, kept by the server and so shared by every process. It moves only
after a message has been handed over, and every (re)connect reads each room back
from it. Reading back overlaps what already arrived, which is safe because a
post is written once however often it is delivered.
"""

from __future__ import annotations

import logging
import re
import ssl
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar
from urllib.parse import quote, urlsplit

import httpx
from pydantic import Field, field_validator
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import InvalidHandshake

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
from switch_core.bridges.collaboration.rocketchat.chunking import (
    chunk_markdown,
    clamp_markdown,
)
from switch_core.bridges.collaboration.rocketchat.client import (
    FileTooLarge,
    RocketChatAPIError,
    RocketChatClient,
    UntrustedFileLink,
)
from switch_core.bridges.collaboration.rocketchat.realtime import (
    RealtimeConnection,
    RealtimeEvent,
    RealtimeLoginRefused,
    RoomMessage,
    SubscriptionAdded,
    websocket_url,
)
from switch_core.bridges.collaboration.session.renderers import offered_controls
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.outbound import guarded_async_client

logger = logging.getLogger(__name__)

# How far behind its read mark a room is read back: a message that arrived
# between a relay and the mark that followed it is older than the mark.
_READ_BACK_OVERLAP = timedelta(seconds=30)
# Nobody wants a week of old chat waking an agent after a long outage.
_READ_BACK_LIMIT = timedelta(hours=24)

_DEFAULT_RETRY_SECONDS = 5.0

# The server's whole answer to a post under `alias` without message-impersonate:
# a 400 with no error type of its own.
_NO_IMPERSONATION = "Not enough permission"

_COMMAND_PREFIX = "!"

_WORKING_EMOJI = ":eyes:"
_QUEUED_EMOJI = ":hourglass_flowing_sand:"

# What a person joining a room looks like in the message stream.
_USER_JOINED = "uj"
_USER_ADDED = "au"

# A message that has been edited, reacted to or replied under is delivered again
# with the same id, so these mark a delivery as old news.
_SEEN_FIELDS = ("editedAt", "reactions", "tcount")

_ROOM_PREFIXES = {"c": "channel", "p": "group", "d": "direct"}

# Names a channel may have on a default server.
_CHANNEL_NAME_FORBIDDEN = re.compile(r"[^0-9a-zA-Z._-]+")

# Rocket.Chat's own markup differs from Switch Markdown in one mark: a single
# `*` is bold there and italic here. Code spans and fences are left alone.
_CODE = re.compile(r"(```.*?```|`[^`\n]*`)", re.DOTALL)
_SINGLE_STAR = re.compile(r"(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])")

_MENTION = re.compile(r"(?<![\w@])@(?P<name>[\w][\w.\-]*)")


def _server_url(value: str) -> str:
    return value.strip().rstrip("/")


class RocketChatConnectionConfig(BridgeConnectionConfig):
    server_url: str = Field(
        title="Server address",
        description="The address you open Rocket.Chat at, for example https://chat.example.com.",
    )
    user_id: str = Field(
        title="Bot user ID",
        description="Shown with the token when you create it under Account → Personal Access Tokens.",
    )
    access_token: str = Field(
        title="Personal access token",
        description="The bot's personal access token. Rocket.Chat shows it once.",
    )

    @field_validator("server_url")
    @classmethod
    def _names_a_server(cls, value: str) -> str:
        url = _server_url(value)
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(
                "server_url must be the http(s) address of your Rocket.Chat server."
            )
        return url

    @field_validator("user_id", "access_token")
    @classmethod
    def _present(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ch.isspace() for ch in value):
            raise ValueError("Paste this exactly as Rocket.Chat showed it.")
        return value


def _new_http(policy: Any) -> httpx.AsyncClient:
    """The HTTP client every call goes through, held to the outbound policy.
    A seam for the tests, which swap the transport."""
    return guarded_async_client(policy)


class RocketChatAdapter(PlatformAdapter):
    """Rocket.Chat collaboration bridge adapter.

    One bot user speaks for every agent. Each post carries the agent's own name
    and icon (`alias`, `avatar`), so a reader sees the agent rather than the bot.

    What a bot user cannot do here, declared rather than discovered:

    - No slash commands and no callback from a button: both need an app
      installed on the server. A card's buttons post the typed answer as the
      person who pressed them, so they answer through the same path as typing.
    - No typing indicator over REST, so a reaction shows an agent is working.
    - Edits and deletes made in Rocket.Chat are not mirrored into the room,
      which has no way to take them. Those made by Switch show in Rocket.Chat.
    """

    display_name: ClassVar[str] = "Rocket.Chat"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = True
    # An edit notifies nobody, so a problem somebody has to act on is posted.
    separate_attention_slot: ClassVar[bool] = True
    # By default a channel notifies its members only of mentions of them.
    notifies_only_by_mention: ClassVar[bool] = True
    channel_mention: ClassVar[str | None] = "@all"
    # A card's buttons come off in an edit, so an answered card stays in the
    # channel as the record of what was asked and what was decided.
    removes_answered_cards: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True
    # One bot reacts for every agent, so the mark is shared.
    activity_reactions_per_agent: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    channel_on_delete = "archived"

    def __init__(self, *, config: RocketChatConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: RocketChatClient | None = None
        self._realtime: RealtimeConnection | None = None
        self._bot_username = ""
        # Set once the server refuses `alias`, so the name goes in the text.
        self._no_alias = False
        # user id -> username, so a person is looked up once.
        self._usernames: OrderedDict[str, str] = OrderedDict()
        # Ids already handled here. Saves refetching a file when a message is
        # delivered again; what stops a second write is `message_ref`.
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._cache_size = 2000

    # ── Configuration ────────────────────────────────────────────────────────

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [_server_url(str(connection_config["server_url"]))]

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        return f"Rocket.Chat server {_server_url(str(connection_config['server_url']))}"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask the server who the token belongs to.

        The address has already been checked against the outbound policy by
        the time this runs."""
        config = RocketChatConnectionConfig.model_validate(connection_config)
        client = RocketChatClient(
            _unguarded_http(),
            server_url=config.server_url,
            user_id=config.user_id,
            token=config.access_token,
        )
        try:
            me = await client.me()
        except RocketChatAPIError as exc:
            if exc.status == 401:
                raise BridgeCredentialError(
                    "Rocket.Chat rejected the bot user ID and token. Check both, "
                    "and that the token has not been removed."
                ) from exc
            raise BridgeCredentialError(
                f"Could not check the token with Rocket.Chat: {exc}."
            ) from exc
        except httpx.TransportError as exc:
            raise BridgeCredentialError(
                f"Could not reach Rocket.Chat at {config.server_url}: {exc}."
            ) from exc
        except ValueError as exc:
            raise BridgeCredentialError(
                f"{config.server_url} did not answer like a Rocket.Chat server."
            ) from exc
        finally:
            await client.aclose()
        if not me.get("active", True):
            raise BridgeCredentialError("That Rocket.Chat user is deactivated.")
        if "bot" not in (me.get("roles") or []):
            raise BridgeCredentialError(
                f"{me.get('username')} is a person's account. Give the account the "
                "bot role, so that nobody is impersonated by accident."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, RealtimeLoginRefused):
            return "auth_failed"
        if isinstance(exc, RocketChatAPIError):
            return "auth_failed" if exc.status == 401 else "platform_error"
        if isinstance(exc, httpx.TransportError | InvalidHandshake):
            return "network"
        return None

    def _require_client(self) -> RocketChatClient:
        if self._client is None:
            raise RuntimeError("Rocket.Chat adapter is not started")
        return self._client

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

        self._client = RocketChatClient(
            _new_http(self.outbound_policy),
            server_url=self._config.server_url,
            user_id=self._config.user_id,
            token=self._config.access_token,
        )
        me = await self._client.me()
        self._bot_username = str(me.get("username") or "")
        if not self._listening:
            logger.info(
                "Rocket.Chat adapter for %s running quietly: another process holds "
                "this bridge",
                self._bot_username,
            )
            return
        self._realtime = RealtimeConnection(
            url=websocket_url(self._config.server_url),
            token=self._config.access_token,
            bot_id=self._config.user_id,
            on_event=self._handle_event,
            on_connected=self._read_back,
            dial=self._dial,
        )
        await self._realtime.start()
        logger.info("Rocket.Chat adapter connected as %s", self._bot_username)

    async def _dial(self, url: str) -> ClientConnection:
        """Open the socket to an address the outbound policy has just allowed,
        so a name that changes what it resolves to cannot redirect the token."""
        parts = urlsplit(url)
        secure = parts.scheme == "wss"
        host = parts.hostname or ""
        port = parts.port or (443 if secure else 80)
        addresses = await self.outbound_policy.resolve(host, port)
        failure: OSError | None = None
        for address in addresses:
            try:
                return await connect(
                    url,
                    host=address,
                    port=port,
                    ssl=ssl.create_default_context() if secure else None,
                    server_hostname=host if secure else None,
                    ping_interval=None,
                    max_size=2**24,
                    proxy=None,
                )
            except OSError as exc:
                failure = exc
        assert failure is not None
        raise failure

    async def stop(self) -> None:
        if self._realtime is not None:
            await self._realtime.stop()
            self._realtime = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def _handle_event(self, event: RealtimeEvent) -> None:
        if isinstance(event, SubscriptionAdded):
            await self._handle_added_to_room(event.subscription)
            return
        await self._handle_live_message(event)

    async def _handle_added_to_room(self, subscription: dict[str, Any]) -> None:
        """The bot joined a room. A room it created itself is already bound,
        and a direct conversation starts with its first message."""
        room_type = subscription.get("t")
        room_id = subscription.get("rid")
        roles = subscription.get("roles") or []
        if not isinstance(room_id, str) or room_type == "d" or "owner" in roles:
            return
        if self._on_app_joined is not None:
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=room_id,
                    channel_type=_channel_type(room_type),
                    channel_name=_optional_str(subscription.get("name")),
                )
            )

    async def _handle_live_message(self, event: RoomMessage) -> None:
        message = event.message
        if any(message.get(field) for field in _SEEN_FIELDS):
            return
        sender = message.get("u")
        if isinstance(sender, dict) and sender.get("_id") == self._config.user_id:
            return
        room_id = str(message.get("rid") or "")
        await self._relay(message, _channel_type(event.room_type), event.room_name)
        if room_id:
            await self._require_client().mark_read(room_id)

    async def _read_back(self) -> None:
        """Relay what was said in every room since the bot last read it."""
        client = self._require_client()
        limit = datetime.now(UTC) - _READ_BACK_LIMIT
        for subscription in await client.subscriptions():
            room_id = subscription.get("rid")
            if not isinstance(room_id, str):
                continue
            mark = _timestamp(subscription.get("ls")) or _timestamp(
                subscription.get("ts")
            )
            if mark is None:
                continue
            if mark < limit and subscription.get("unread"):
                logger.warning(
                    "Rocket.Chat room %s has unread messages from more than a day "
                    "ago; only the last day is relayed",
                    room_id,
                )
            since = max(mark - _READ_BACK_OVERLAP, limit)
            try:
                await self._read_back_room(subscription, room_id, since)
            except (RocketChatAPIError, httpx.TransportError) as exc:
                logger.warning(
                    "Could not read Rocket.Chat room %s back after a reconnect: %s",
                    room_id,
                    exc,
                )

    async def _read_back_room(
        self, subscription: dict[str, Any], room_id: str, since: datetime
    ) -> None:
        client = self._require_client()
        found = await client.messages_since(room_id, _iso(since))
        fresh = [
            message
            for message in found
            if (_timestamp(message.get("ts")) or since) >= since
        ]
        fresh.sort(key=lambda message: str(message.get("ts")))
        channel_type = _channel_type(subscription.get("t"))
        name = _optional_str(subscription.get("name"))
        for message in fresh:
            await self._relay(message, channel_type, name)
        if fresh:
            await client.mark_read(room_id)

    async def _relay(
        self, message: dict[str, Any], channel_type: ChannelType, room_name: str | None
    ) -> None:
        """Hand one message to the room, as a command, a join or a message."""
        message_id = str(message.get("_id") or "")
        room_id = str(message.get("rid") or "")
        sender = message.get("u")
        if not message_id or not room_id or not isinstance(sender, dict):
            return
        sender_id = str(sender.get("_id") or "")
        sender_name = str(sender.get("username") or sender_id)
        if sender_id == self._config.user_id or message_id in self._seen:
            return
        self._remember_seen(message_id)

        kind = message.get("t")
        if kind:
            await self._handle_system_message(
                message, kind, room_id, channel_type, sender_id, sender_name
            )
            return

        content = self.translate_inbound(str(message.get("msg") or "")).strip()
        root_id = _optional_str(message.get("tmid"))
        is_integration = bool(message.get("bot"))
        parsed = None if is_integration else _parse_command(content)
        if parsed is not None and self._on_command is not None:
            name, args = parsed
            await self._on_command(
                InboundCommand(
                    channel_id=room_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    command=name,
                    args=args,
                    message_ref=message_id,
                    root_id=root_id,
                )
            )
            return

        if self._on_message is None:
            return
        attachments, failures = await self._fetch_attachments(message)
        if not content and not attachments and not failures:
            return
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=sender_name,
                content=content,
                message_ref=message_id,
                root_id=root_id,
                channel_name=room_name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self._self_mention(content),
                sender_is_app=is_integration,
            )
        )

    def _self_mention(self, content: str) -> str | None:
        """The bot's handle, where a message mentions it and names nobody else.

        `@bot why?` is then for the room's agent. `@bot @claude why?` says who
        it is for already."""
        names = {match.group("name") for match in _MENTION.finditer(content)}
        if self._bot_username in names and len(names) == 1:
            return self._bot_username
        return None

    async def _handle_system_message(
        self,
        message: dict[str, Any],
        kind: object,
        room_id: str,
        channel_type: ChannelType,
        sender_id: str,
        sender_name: str,
    ) -> None:
        if self._on_user_joined is None:
            return
        if kind == _USER_JOINED:
            user_id, username = sender_id, sender_name
        elif kind == _USER_ADDED:
            username = str(message.get("msg") or "")
            if username == self._bot_username:
                return
            user = await self._require_client().user_by_name(username)
            user_id = str(user.get("_id") or "")
        else:
            return
        if user_id:
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=room_id,
                    channel_type=channel_type,
                    external_user_id=user_id,
                    external_username=username,
                )
            )

    async def _fetch_attachments(
        self, message: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        listed = message.get("attachments")
        if not isinstance(listed, list):
            return [], []
        client = self._require_client()
        limit = self._max_attachment_bytes
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for item in listed:
            if not isinstance(item, dict) or not isinstance(
                item.get("title_link"), str
            ):
                continue
            label = str(item.get("title") or "file")
            size = item.get("size")
            if isinstance(size, int) and size > limit:
                failures.append(
                    AttachmentFailure(
                        filename=label,
                        reason=(
                            f"it is {size // (1024 * 1024)} MB and the limit is "
                            f"{limit // (1024 * 1024)} MB"
                        ),
                    )
                )
                continue
            try:
                info, data = await client.download(item["title_link"], max_bytes=limit)
            except FileTooLarge as exc:
                reason = f"it is larger than {exc.max_bytes // (1024 * 1024)} MB"
                failures.append(AttachmentFailure(filename=label, reason=reason))
                continue
            except UntrustedFileLink as exc:
                logger.warning("Refused a Rocket.Chat file link: %s", exc)
                failures.append(AttachmentFailure(filename=label, reason=str(exc)))
                continue
            except (RocketChatAPIError, httpx.TransportError) as exc:
                failures.append(
                    AttachmentFailure(
                        filename=label, reason=f"the download failed: {exc}"
                    )
                )
                continue
            attachments.append(
                Attachment(filename=label, mimetype=info.mimetype, data=data)
            )
        return attachments, failures

    def _remember_seen(self, message_id: str) -> None:
        self._seen[message_id] = None
        if len(self._seen) > self._cache_size:
            self._seen.popitem(last=False)

    # ── Outbound ─────────────────────────────────────────────────────────────

    async def _identity(self, sender_name: str) -> dict[str, str]:
        agent = await self.agent_rendering(sender_name)
        fields = {"alias": agent.body_label}
        if agent.icon_url:
            fields["avatar"] = agent.icon_url
        return fields

    async def _post(
        self,
        room_id: str,
        sender_name: str | None,
        text: str,
        thread_root_id: str | None,
        attachments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Post once as `sender_name`, or as the bot itself for None.

        `alias` needs `message-impersonate`, which the bot role has unless an
        admin took it away. The name then goes in the text, and a warning says
        why every message now reads differently."""
        client = self._require_client()
        message: dict[str, Any] = {"rid": room_id, "msg": text}
        if thread_root_id:
            message["tmid"] = thread_root_id
        if attachments:
            message["attachments"] = attachments
        if sender_name is None:
            return await client.send_message(message)
        identity = await self._identity(sender_name)
        if self._no_alias:
            return await client.send_message(
                {**message, "msg": _with_name(identity["alias"], text)}
            )
        try:
            return await client.send_message({**message, **identity})
        except RocketChatAPIError as exc:
            if exc.status != 400 or _NO_IMPERSONATION not in str(exc):
                raise
        logger.warning(
            "Rocket.Chat refused to post under an agent's name, so names go in "
            "the message text. Give the bot role the message-impersonate permission."
        )
        self._no_alias = True
        return await client.send_message(
            {**message, "msg": _with_name(identity["alias"], text)}
        )

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the agent. A reply too long for one message is split, every
        part in the same thread; the first part's id is the message's reference."""
        return await self._post_text(channel_id, sender_name, content, thread_root_id)

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        return await self._post_text(
            channel_id,
            None,
            self._admin_body(self.translate_outbound(content), drawn),
            thread_root_id,
        )

    async def _post_text(
        self,
        channel_id: str,
        sender_name: str | None,
        text: str,
        thread_root_id: str | None,
    ) -> str | None:
        first: str | None = None
        for chunk in chunk_markdown(text):
            try:
                sent = await self._post(
                    channel_id, sender_name, chunk, thread_root_id, []
                )
            except RocketChatAPIError as exc:
                logger.error(
                    "Rocket.Chat refused a message in room %s: %s", channel_id, exc
                )
                return first
            if first is None:
                first = _optional_str(sent.get("_id"))
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._require_client().update_text(
                channel_id, message_ref, clamp_markdown(new_content)
            )
        except RocketChatAPIError as exc:
            logger.error(
                "Failed to update Rocket.Chat message %s: %s", message_ref, exc
            )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._require_client().delete_message(channel_id, message_ref)
        except RocketChatAPIError as exc:
            logger.error(
                "Could not delete Rocket.Chat message %s (the bot role needs "
                "delete-own-message): %s",
                message_ref,
                exc,
            )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # No REST call for it; the reaction and the status show the work.
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
        emoji = _WORKING_EMOJI if mark == "working" else _QUEUED_EMOJI
        try:
            await self._require_client().react(message_ref, emoji, on=on)
        except RocketChatAPIError as exc:
            if exc.status == 429 or exc.status >= 500:
                raise
            raise ActivityMarkRefused(
                f"Rocket.Chat refused the {mark} reaction on {message_ref}: {exc}"
            ) from exc

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
        """Upload one file. The server ignores `alias` on an upload, so the
        caption names the agent. A file it refuses, for its size or its type,
        is said in the thread rather than lost."""
        identity = await self._identity(sender_name)
        text = self.translate_outbound(caption) if caption else ""
        fields: dict[str, Any] = {"msg": _with_name(identity["alias"], text)}
        if thread_root_id:
            fields["tmid"] = thread_root_id
        try:
            sent = await self._require_client().upload(
                channel_id,
                filename=filename,
                mimetype=mimetype,
                data=data,
                fields=fields,
            )
        except RocketChatAPIError as exc:
            logger.error(
                "Rocket.Chat refused the file %s in room %s: %s",
                filename,
                channel_id,
                exc,
            )
            return await self._post_text(
                channel_id,
                sender_name,
                self.translate_outbound(f"_couldn't send {filename}: {exc}_"),
                thread_root_id,
            )
        return _optional_str(sent.get("_id"))

    # ── Cards ────────────────────────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return 4000

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's status, or a request's card with a button per option.

        Raises `RichContentFailed` only for what the server definitely refused.
        A send whose outcome nobody knows raises its own error, so the caller
        keeps its reservation."""
        text, attachments = await self._draw(content)
        try:
            sent = await self._post(
                channel_id,
                agent_name,
                clamp_markdown(text),
                thread_root_id,
                attachments,
            )
        except RocketChatAPIError as exc:
            failure = _as_rich_failure(
                exc,
                description=f"Rocket.Chat refused the post in room {channel_id}",
                text=text,
            )
            if failure is None:
                raise
            raise failure from exc
        ref = _optional_str(sent.get("_id"))
        if ref is None:
            raise RichContentFailed(
                f"Rocket.Chat accepted the post in room {channel_id} but gave no id.",
                text=text,
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
        """Redraw a publication in place.

        A card is rewritten whole, because the REST edit keeps a message's
        attachments and an answered card must lose its buttons."""
        text, attachments = await self._draw(content)
        body = clamp_markdown(text)
        if self._no_alias:
            agent = await self.agent_rendering(agent_name)
            body = clamp_markdown(_with_name(agent.body_label, text))
        client = self._require_client()
        try:
            if isinstance(content, RequestCard):
                await client.rewrite_message(
                    channel_id, message_ref, text=body, attachments=attachments
                )
            else:
                await client.update_text(channel_id, message_ref, body)
        except RocketChatAPIError as exc:
            failure = _as_rich_failure(
                exc,
                description=f"Rocket.Chat refused the edit to {message_ref}",
                text=text,
            )
            if failure is None:
                raise
            raise failure from exc

    async def _draw(self, content: RichContent) -> tuple[str, list[dict[str, Any]]]:
        """The text of a publication, and the attachment carrying its buttons:
        none where there is nothing one press could answer."""
        mention = await self._mention(content.notify_external_id)
        limit = self.rich_fallback_limit()
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        if isinstance(content, TurnActivity):
            status = turn_status(
                content.items,
                content.turn,
                escape=self._rich_escape,
                limit=max(1, limit - len(tail)),
                markup=self.rich_markup(),
                elapsed_seconds=content.elapsed_seconds,
                mention=mention,
                error_summary=content.error_summary,
                tool_detail=True,
            )
            return f"{status}{tail}", []
        lead = f"{mention}\n" if mention else ""
        drawn = render_request(
            content.request,
            content.reference,
            escape=self._rich_escape,
            limit=max(1, limit - len(lead) - len(tail)),
            markup=self.rich_markup(),
            responder=await self._mention(content.responder_external_id),
            unavailable_reason=content.unavailable_reason,
            control_label_limit=None,
        )
        text = f"{lead}{drawn.text}{tail}"
        controls = offered_controls(content.request) if drawn.answerable else []
        if not controls:
            return text, []
        actions = [
            {
                "type": "button",
                "text": f"{control.position}. {control.label.strip()}"[:80],
                "msg": f"{content.reference.handle} {control.position}",
                "msg_in_chat_window": True,
                "msg_processing_type": "sendMessage",
            }
            for control in controls
        ]
        return text, [{"button_alignment": "vertical", "actions": actions}]

    async def _mention(self, user_id: str | None) -> str | None:
        """`@username`, or nothing for someone who cannot be looked up: a name
        that may belong to nobody is worse than no name."""
        if user_id is None:
            return None
        username = self._usernames.get(user_id)
        if username is None:
            try:
                user = await self._require_client().user(user_id)
            except (RocketChatAPIError, httpx.TransportError) as exc:
                logger.warning(
                    "Could not look up Rocket.Chat user %s: %s", user_id, exc
                )
                return None
            username = str(user.get("username") or "")
            if not username:
                return None
            self._usernames[user_id] = username
            if len(self._usernames) > self._cache_size:
                self._usernames.popitem(last=False)
        return f"@{username}"

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        try:
            replies = await self._require_client().thread_messages(root_ref, limit=1)
        except (RocketChatAPIError, httpx.TransportError) as exc:
            logger.warning(
                "Could not read the thread under %s: %s. Treating %s as not the "
                "first reply.",
                root_ref,
                exc,
                message_ref,
            )
            return False
        return bool(replies) and replies[0].get("_id") == message_ref

    # ── Rooms and people ─────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        client = self._require_client()
        private = channel_type != "channel_public"
        try:
            room = await client.create_room(_channel_name(name), private=private)
            room_id = str(room.get("_id") or "")
            if not room_id:
                raise BridgeOperationError(
                    "Rocket.Chat created the room but gave no id."
                )
            if topic.strip():
                await client.set_topic(room_id, topic, private=private)
        except RocketChatAPIError as exc:
            raise BridgeOperationError(
                f"Rocket.Chat refused to create the room: {exc}"
            ) from exc
        return room_id

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        client = self._require_client()
        try:
            user = await client.user(user_external_id)
            room = await client.open_direct(str(user.get("username") or user_name))
        except RocketChatAPIError as exc:
            raise BridgeOperationError(
                f"Rocket.Chat refused to open a conversation with {user_name}: {exc}"
            ) from exc
        room_id = str(room.get("rid") or room.get("_id") or "")
        if not room_id:
            raise BridgeOperationError(
                "Rocket.Chat opened the conversation but gave no id."
            )
        return room_id

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        client = self._require_client()
        try:
            room = await client.room(external_channel_id)
            await client.archive(external_channel_id, private=room.get("t") == "p")
        except RocketChatAPIError as exc:
            return RetireOutcome.failed(
                f"Rocket.Chat refused to archive the room: {exc}"
            )
        return RetireOutcome(outcome="archived")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        room = await self._require_client().room(channel_id)
        return _channel_type(room.get("t"))

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        room = await self._require_client().room(external_channel_id)
        prefix = _ROOM_PREFIXES.get(str(room.get("t")))
        name = room.get("name")
        if prefix is None or not isinstance(name, str):
            return None
        return f"{self._config.server_url}/{prefix}/{quote(name, safe='')}"

    async def home_deeplink(self) -> str | None:
        return f"{self._config.server_url}/home"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # One bot posts for every agent; there is nobody else to add.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        client = self._require_client()
        room = await client.room(channel_id)
        private = room.get("t") == "p"
        left_out: list[str] = []
        for name, user_id in zip(user_names, user_external_ids, strict=True):
            try:
                await client.invite(channel_id, user_id, private=private)
            except RocketChatAPIError as exc:
                logger.warning(
                    "Could not add %s to Rocket.Chat room %s: %s", name, channel_id, exc
                )
                left_out.append(user_id)
        return left_out

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        query = query.strip()
        if not query:
            return []
        people = await self._require_client().search_users(
            query, exclude=[self._bot_username]
        )
        found: list[DirectoryUser] = []
        for person in people:
            user_id = person.get("_id")
            username = person.get("username")
            if isinstance(user_id, str) and isinstance(username, str):
                found.append(
                    DirectoryUser(
                        external_user_id=user_id,
                        username=username,
                        display_name=str(person.get("name") or username),
                        email=None,
                    )
                )
        return found

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        return f"Send `!link-account {code}` in any Rocket.Chat room the bot is in."

    def render_app_mention(self, token: str) -> str:
        return f"@{token}"

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        """Switch's `*italic*` would be bold here, so it goes out as `_italic_`."""
        return _outside_code(
            content, lambda text: _SINGLE_STAR.sub(lambda m: f"_{m.group(1)}_", text)
        )

    def translate_inbound(self, raw_message: str) -> str:
        """Rocket.Chat's `*bold*` is Switch's `**bold**`."""
        return _outside_code(
            raw_message,
            lambda text: _SINGLE_STAR.sub(lambda m: f"**{m.group(1)}**", text),
        )


# ── Helpers ──────────────────────────────────────────────────────────────────


def _unguarded_http() -> httpx.AsyncClient:
    return httpx.AsyncClient(trust_env=False)


def _outside_code(text: str, change: Callable[[str], str]) -> str:
    parts = _CODE.split(text)
    return "".join(
        part if index % 2 else change(part) for index, part in enumerate(parts)
    )


def _with_name(name: str, text: str) -> str:
    return f"**{name}**\n{text}" if text else f"**{name}**"


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _channel_type(room_type: object) -> ChannelType:
    if room_type == "d":
        return "direct"
    return "channel_private" if room_type == "p" else "channel_public"


def _channel_name(name: str) -> str:
    return _CHANNEL_NAME_FORBIDDEN.sub("-", name.strip()).strip("-").lower() or "room"


def _parse_command(text: str) -> tuple[str, str] | None:
    if not text.startswith(_COMMAND_PREFIX):
        return None
    parts = text[1:].split(None, 1)
    if not parts or not parts[0]:
        return None
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def _as_rich_failure(
    exc: RocketChatAPIError, *, description: str, text: str
) -> RichContentFailed | None:
    """What a refused publication means to its caller, or None where nobody
    knows whether it happened: a 5xx can come after the server acted on the call."""
    if exc.status == 429:
        return RichContentThrottled(
            retry_after=exc.retry_after or _DEFAULT_RETRY_SECONDS, text=text
        )
    if exc.status >= 500:
        return None
    return RichContentFailed(f"{description}: {exc}", text=text)


def _timestamp(value: object) -> datetime | None:
    """A time as the server writes it: ISO over REST, `{"$date": ms}` over DDP."""
    if isinstance(value, dict) and isinstance(value.get("$date"), int | float):
        return datetime.fromtimestamp(value["$date"] / 1000, UTC)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _iso(moment: datetime) -> str:
    return (
        moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )

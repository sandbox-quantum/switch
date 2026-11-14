"""Lark (Feishu in China) as a messaging platform: one bot of the operator's app.

The operator creates a custom app in Lark's developer console, adds its Bot,
and gives Switch the App ID and App Secret. Every agent speaks through that
bot, with its name as the title of each message. A group chat is a room, a
chat with the bot is a direct room, and a reply in a thread stays in it.

Events arrive over Lark's long connection: Switch dials out to Lark, so a
server with no public address can take them, and there is no webhook to
secure. Only the pod holding the bridge opens it (`keeps_quiet_unless_listening`);
everything else is an API call, which any pod makes itself. Lark pushes an
event again until it is acknowledged, and each one is acknowledged only once
it is handled, so a restart loses nothing; a second delivery carries the same
message id, which drops it.

Lark's international site and Feishu are separate platforms with the same
API; the connection says which (`region`).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import mimetypes
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar, Literal

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    AgentIdentity,
    ChannelNotBindable,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
)
from switch_core.bridges.collaboration.lark.client import (
    ACK,
    HOSTS,
    LarkApi,
    LarkApiError,
    LarkCredentialsRefused,
    LarkDisconnected,
    LarkSocket,
    LarkTooLarge,
)
from switch_core.bridges.collaboration.lark.markup import (
    chunk,
    from_post,
    from_text,
    to_lark,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelRetirement,
    ChannelType,
    CreatedChannel,
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
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    Markup,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import request_summary
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

# What Lark takes: an image up to 10 MB, any other file up to 30 MB.
_IMAGE_LIMIT = 10 * 1024 * 1024
_FILE_LIMIT = 30 * 1024 * 1024
# How long a group's type and a person's name are trusted before Lark is
# asked again, so every pod agrees within a minute of a change.
_KNOWN_FOR = 60.0
# How far back a connection reads each bridged chat's messages when it opens:
# Lark does not push an event again to a new connection, so what was said while
# no process held the bridge is read back, and what was relayed already is
# dropped by its message id.
_READ_BACK = 3600.0
_READ_BACK_PAGES = 4
# The reaction that says an agent is working on a message.
_WORKING = "OnIt"
# A button's label beyond this is cut; the card's body carries it in full.
_BUTTON_LABEL = 40
_APP_ID = re.compile(r"^cli_[A-Za-z0-9]{8,40}$")
_CHAT_ID = re.compile(r"^oc_[A-Za-z0-9]{8,64}$")
# Lark's file types for an upload; anything else goes up as `stream`.
_FILE_TYPES = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt",
    "video/mp4": "mp4",
    "audio/opus": "opus",
}


class LarkConnectionConfig(BridgeConnectionConfig):
    region: Literal["lark", "feishu"] = Field(
        default="lark",
        title="Region",
        description=(
            "lark for an app made at open.larksuite.com, feishu for one made at "
            "open.feishu.cn."
        ),
    )
    app_id: str = Field(
        title="App ID",
        description="From the app's Credentials & Basic Info page. It starts with cli_.",
    )
    app_secret: str = Field(
        title="App Secret",
        description="From the same page.",
        repr=False,
    )

    @field_validator("app_id")
    @classmethod
    def _app_id(cls, value: str) -> str:
        value = value.strip()
        if not _APP_ID.fullmatch(value):
            raise ValueError("An App ID starts with cli_, like cli_a1b2c3d4e5f6")
        return value

    @field_validator("app_secret")
    @classmethod
    def _app_secret(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter the app's App Secret")
        return value

    @property
    def host(self) -> str:
        return HOSTS[self.region]

    @property
    def applink(self) -> str:
        return (
            "https://applink.feishu.cn"
            if self.region == "feishu"
            else "https://applink.larksuite.com"
        )


class _CardMarkup(Markup):
    """Card text: a Lark card's markdown has no code span, so a literal is
    quoted rather than left between backticks a reader would see."""

    def code(self, text: str) -> str:
        return f"“{text}”"

    def command(self, text: str) -> str:
        return self.code(text)


_CARD_MARKUP = _CardMarkup()


def _said(error: BaseException) -> str:
    return str(error) or type(error).__name__


class _Known:
    """Values Lark is asked for and trusted for `_KNOWN_FOR` seconds."""

    def __init__(self) -> None:
        self._values: dict[str, tuple[float, str]] = {}

    def get(self, key: str) -> str | None:
        held = self._values.get(key)
        if held is None or time.monotonic() - held[0] > _KNOWN_FOR:
            return None
        return held[1]

    def put(self, key: str, value: str) -> None:
        self._values[key] = (time.monotonic(), value)

    def forget(self, key: str) -> None:
        self._values.pop(key, None)


class LarkAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Lark"
    # Contact search needs a person's own sign-in, not the app's.
    supports_directory_search: ClassVar[bool] = False
    # Lark links http(s) only.
    renders_custom_url_schemes: ClassVar[bool] = False
    # Turns and request cards are Lark cards, redrawn in place, with a button
    # for each option and a stop button on a running turn.
    draws_session_activity: ClassVar[bool] = True
    supports_activity_reactions: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # Deleting a room takes the bot out of its group; the group and its
    # history stay in Lark.
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    def __init__(self, *, config: LarkConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._api = LarkApi(
            host=config.host, app_id=config.app_id, app_secret=config.app_secret
        )
        self._socket = LarkSocket(self._api, self._on_push, name=config.app_id)
        self._runner: asyncio.Task[None] | None = None
        self._reader: asyncio.Task[None] | None = None
        # Chats bridged to rooms, read back when a connection opens.
        self._chats: set[str] = set()
        self._read_chats: set[str] = set()
        self._read_from: float | None = None
        self._since: float | None = None
        self._pending: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        self._bot_open_id: str | None = None
        self._bot_name = "Switch"
        self._chat_types = _Known()
        self._chat_names = _Known()
        self._names = _Known()

    # ── Declarations ─────────────────────────────────────────────────────────

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, LarkCredentialsRefused):
            return "auth_failed"
        if isinstance(exc, LarkApiError):
            return "auth_failed" if exc.code in (10003, 10014) else "platform_error"
        if isinstance(exc, (LarkDisconnected, httpx.TransportError)):
            return "network"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """One bridge per app: Lark hands each event to one connection, so two
        bridges of one app would each miss what the other was given."""
        app_id = str(connection_config.get("app_id") or "").strip()
        region = str(connection_config.get("region") or "lark")
        return f"lark {region} {app_id}" if app_id else None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        region = str(connection_config.get("region") or "lark")
        return [HOSTS.get(region, HOSTS["lark"])]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Fetch the app's token and its bot, so a wrong ID or secret, or an
        app without a bot, is said before the connection is saved."""
        config = LarkConnectionConfig.model_validate(connection_config)
        api = LarkApi(
            host=config.host, app_id=config.app_id, app_secret=config.app_secret
        )
        try:
            await api.tenant_token()
            bot = await api.call("GET", "/bot/v3/info")
        except LarkCredentialsRefused as error:
            raise BridgeCredentialError(
                f"Lark doesn't accept this App ID and App Secret: {_said(error)}. "
                "Copy both again from the app's Credentials & Basic Info page, and "
                "check the region."
            ) from error
        except LarkApiError as error:
            raise BridgeCredentialError(
                f"Lark refused the app: {error.message}. Add the Bot feature to the "
                "app and publish a version."
            ) from error
        except httpx.TransportError as error:
            raise BridgeCredentialError(
                f"Could not reach {config.host}: {_said(error)}"
            ) from error
        finally:
            await api.close()
        if not _dict(bot.get("bot")).get("open_id"):
            raise BridgeCredentialError(
                "The app has no bot. Add the Bot feature in the developer console "
                "and publish a version."
            )

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
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        self._stopping.clear()
        if not self._listening:
            logger.info(
                "Lark bridge %s running quietly: another process holds the connection",
                self.config.app_id,
            )
            return
        # A refusal on the first start fails the start, so the operator sees
        # it at once; after that the socket retries.
        await self._learn_bot()
        self._runner = asyncio.create_task(
            self._socket.run(self._stopping), name=f"lark-{self.config.app_id}"
        )
        self._reader = asyncio.create_task(
            self._read_back_on_connect(), name=f"lark-read-back-{self.config.app_id}"
        )

    async def stop(self) -> None:
        self._stopping.set()
        for task in (self._pending, self._reader, self._runner):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._runner = self._reader = self._pending = None
        await self._api.close()

    async def _learn_bot(self) -> None:
        try:
            answer = await self._api.call("GET", "/bot/v3/info")
        except LarkCredentialsRefused as error:
            raise BridgeCredentialError(_said(error)) from error
        bot = _dict(answer.get("bot")) or answer
        self._bot_open_id = str(bot.get("open_id") or "") or None
        self._bot_name = str(bot.get("app_name") or self._bot_name)

    async def _ensure_bot(self) -> None:
        if self._bot_open_id is None:
            with contextlib.suppress(
                LarkApiError, LarkCredentialsRefused, httpx.HTTPError
            ):
                await self._learn_bot()

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """The chats bridged to rooms, on every start. Core hands them over
        once the bridge has started, so a connection already open reads them
        back now."""
        self._chats.update(channel_id for channel_id, _ in channels)
        if self._socket.connected.is_set() and self._since is not None:
            self._pending = asyncio.create_task(self._read_pending())

    # ── Missed messages ──────────────────────────────────────────────────────

    async def _read_back_on_connect(self) -> None:
        """Each time the connection opens, read back what each bridged chat
        was sent since the last connection here, or for `_READ_BACK` on a
        first one."""
        while not self._stopping.is_set():
            await self._socket.connected.wait()
            opened = time.time()
            self._since = (
                self._read_from if self._read_from is not None else opened - _READ_BACK
            )
            self._read_chats.clear()
            await self._read_pending()
            self._read_from = opened - 60
            while self._socket.connected.is_set() and not self._stopping.is_set():
                await asyncio.sleep(1.0)

    async def _read_pending(self) -> None:
        """Read back each bridged chat not yet read on this connection."""
        since = self._since
        if since is None:
            return
        chats = sorted(self._chats - self._read_chats)
        if chats:
            logger.info(
                "Lark bridge %s reading back %d chat(s) from %s",
                self.config.app_id,
                len(chats),
                time.strftime("%H:%M:%S", time.localtime(since)),
            )
        for chat_id in chats:
            self._read_chats.add(chat_id)
            try:
                await self._read_back(chat_id, since)
            except (LarkApiError, httpx.HTTPError) as error:
                logger.warning(
                    "Lark bridge %s could not read back chat %s: %s",
                    self.config.app_id,
                    chat_id,
                    _said(error),
                )

    async def _read_back(self, chat_id: str, since: float) -> None:
        page_token: str | None = None
        for _ in range(_READ_BACK_PAGES):
            params: dict[str, Any] = {
                "container_id_type": "chat",
                "container_id": chat_id,
                "start_time": str(int(since)),
                "sort_type": "ByCreateTimeAsc",
                "page_size": 50,
            }
            if page_token:
                params["page_token"] = page_token
            answer = await self._api.call("GET", "/im/v1/messages", params=params)
            for item in answer.get("items") or []:
                event = _event_from_history(_dict(item))
                if event is not None:
                    await self._on_lark_message(event)
            page_token = str(answer.get("page_token") or "") or None
            if not answer.get("has_more") or not page_token:
                return

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def _on_push(self, kind: str, body: dict[str, Any]) -> bytes:
        """Handle one event or card press, then acknowledge it. One that
        fails is logged and acknowledged, so it is not pushed forever."""
        header = _dict(body.get("header"))
        event_type = str(header.get("event_type") or body.get("type") or "")
        event = _dict(body["event"]) if "event" in body else body
        try:
            if event_type == "im.message.receive_v1":
                await self._on_lark_message(event)
            elif event_type == "card.action.trigger" or kind == "card":
                await self._on_card_press(event)
            elif event_type == "im.chat.member.bot.added_v1":
                await self._on_bot_added(event)
            elif event_type == "im.chat.member.user.added_v1":
                await self._on_users_added(event)
            elif event_type == "im.chat.updated_v1":
                self._chat_types.forget(str(event.get("chat_id") or ""))
            elif event_type == "im.message.recalled_v1":
                logger.debug(
                    "Lark bridge %s: a message was recalled in Lark (%s); Switch "
                    "keeps what it relayed",
                    self.config.app_id,
                    event.get("message_id"),
                )
        except Exception:
            logger.exception(
                "Lark bridge %s could not handle a %s event",
                self.config.app_id,
                event_type or kind,
            )
        return ACK

    async def _on_lark_message(self, event: dict[str, Any]) -> None:
        message = event.get("message") or {}
        sender = event.get("sender") or {}
        open_id = str((sender.get("sender_id") or {}).get("open_id") or "")
        await self._ensure_bot()
        if not open_id or open_id == self._bot_open_id:
            return
        chat_id = str(message.get("chat_id") or "")
        message_id = str(message.get("message_id") or "")
        if not chat_id or not message_id:
            return
        self._chats.add(chat_id)
        channel_type = await self._type_of(chat_id, str(message.get("chat_type") or ""))
        channel_name = self._chat_names.get(chat_id) or None
        mentions = [m for m in message.get("mentions") or [] if isinstance(m, dict)]
        named_bot = any(
            (m.get("id") or {}).get("open_id") == self._bot_open_id for m in mentions
        )
        content, files = self._read_content(message, mentions)
        attachments, failures = await self._download(message_id, files)
        if not content and not attachments and not failures:
            return
        sender_name = await self._name_of(open_id)
        root_id = str(message.get("root_id") or "") or None
        command = self._command_in(content, named_bot)
        if command is not None and self._on_command is not None:
            name, _, args = command.partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    sender_id=open_id,
                    sender_name=sender_name,
                    command=name,
                    args=args.strip(),
                    message_ref=message_id,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    sender_id=open_id,
                    sender_name=sender_name,
                    content=content,
                    message_ref=message_id,
                    root_id=root_id,
                    channel_name=channel_name,
                    attachments=attachments,
                    attachment_failures=failures,
                    self_mention_token=self._bot_open_id if named_bot else None,
                    sender_is_app=str(sender.get("sender_type") or "user") != "user",
                )
            )

    def _command_in(self, content: str, named_bot: bool) -> str | None:
        """`!command args` from a message, also after a mention of the bot."""
        text = content.strip()
        if named_bot:
            own = f"@{self._bot_name}"
            if text.startswith(own):
                text = text[len(own) :].strip()
        return text[1:] if text.startswith("!") and len(text) > 1 else None

    def _read_content(
        self, message: dict[str, Any], mentions: list[dict[str, Any]]
    ) -> tuple[str, list[tuple[str, str, str]]]:
        """The message as Markdown, and its files as (key, kind, filename)."""
        try:
            body = json.loads(message.get("content") or "{}")
        except ValueError:
            return "", []
        if not isinstance(body, dict):
            return "", []
        kind = str(message.get("message_type") or "")
        if kind == "text":
            return from_text(str(body.get("text") or ""), mentions), []
        if kind == "post":
            text, images = from_post(body, mentions)
            return text, [(key, "image", f"image-{key[-8:]}") for key in images]
        if kind == "image" and body.get("image_key"):
            key = str(body["image_key"])
            return "", [(key, "image", f"image-{key[-8:]}")]
        if kind in ("file", "media", "audio") and body.get("file_key"):
            key = str(body["file_key"])
            name = str(body.get("file_name") or f"{kind}-{key[-8:]}")
            if kind == "audio" and "." not in name:
                name += ".opus"
            return "", [(key, "file", name)]
        if kind == "sticker":
            return "_sent a sticker_", []
        return "", []

    async def _download(
        self, message_id: str, files: list[tuple[str, str, str]]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for key, kind, filename in files:
            try:
                data = await self._api.download(
                    f"/im/v1/messages/{message_id}/resources/{key}",
                    params={"type": kind},
                    limit=self._max_attachment_bytes,
                )
            except LarkTooLarge:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=(
                            "it is larger than the "
                            f"{self._max_attachment_bytes // (1024 * 1024)} MB "
                            "Switch takes"
                        ),
                    )
                )
                continue
            except (LarkApiError, httpx.HTTPError) as error:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"Lark would not send it ({_said(error)})",
                    )
                )
                continue
            mimetype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            if kind == "image":
                mimetype = _image_type(data)
                extension = mimetypes.guess_extension(mimetype) or ""
                filename = f"image-{key[-8:]}{extension}"
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
            )
        return attachments, failures

    async def _on_card_press(self, event: dict[str, Any]) -> None:
        action = event.get("action") or {}
        value = _dict(action.get("value"))
        action_id = str(value.get("switch_action") or "")
        token = str(value.get("switch_value") or "")
        operator = event.get("operator") or {}
        open_id = str(operator.get("open_id") or "")
        context = event.get("context") or {}
        chat_id = str(context.get("open_chat_id") or "")
        if not action_id or not open_id or not chat_id:
            return
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card in Lark chat %s has nowhere to go", chat_id
            )
            return
        # Lark names a person only by their name, which is both how Switch files
        # them and what a card says answered it.
        name = await self._name_of(open_id)
        await self._on_interaction(
            InboundInteraction(
                channel_id=chat_id,
                sender_id=open_id,
                sender_name=name,
                sender_display_name=name,
                action_id=action_id,
                value=token,
                message_ref=str(context.get("open_message_id") or "") or None,
            )
        )

    async def _on_bot_added(self, event: dict[str, Any]) -> None:
        chat_id = str(event.get("chat_id") or "")
        if not chat_id or self._on_app_joined is None:
            return
        self._chat_types.forget(chat_id)
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=chat_id,
                channel_type=await self._type_of(chat_id, ""),
                channel_name=str(event.get("name") or "") or None,
            )
        )

    async def _on_users_added(self, event: dict[str, Any]) -> None:
        chat_id = str(event.get("chat_id") or "")
        if not chat_id or self._on_user_joined is None:
            return
        channel_type = await self._type_of(chat_id, "")
        for user in event.get("users") or []:
            open_id = str((user.get("user_id") or {}).get("open_id") or "")
            if not open_id:
                continue
            name = str(user.get("name") or "") or await self._name_of(open_id)
            self._names.put(open_id, name)
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    external_user_id=open_id,
                    external_username=name,
                    channel_name=str(event.get("name") or "") or None,
                )
            )

    async def _type_of(self, chat_id: str, chat_type: str) -> ChannelType:
        if chat_type == "p2p":
            return "direct"
        return await self.get_channel_type(chat_id)

    async def _name_of(self, open_id: str) -> str:
        """A person's name in Lark, or a short form of their id when the app
        may not read it."""
        known = self._names.get(open_id)
        if known:
            return known
        try:
            answer = await self._api.call(
                "GET",
                f"/contact/v3/users/{open_id}",
                params={"user_id_type": "open_id"},
            )
            name = str((answer.get("user") or {}).get("name") or "")
        except (LarkApiError, httpx.HTTPError) as error:
            logger.warning(
                "Lark bridge %s could not read a sender's name (%s); add the "
                "contact:user.base:readonly scope",
                self.config.app_id,
                _said(error),
            )
            name = ""
        name = name or f"lark-{open_id[-6:]}"
        self._names.put(open_id, name)
        return name

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _post(self, title: str, text: str) -> str:
        return json.dumps(
            {"en_us": {"title": title, "content": [[{"tag": "md", "text": text}]]}},
            ensure_ascii=False,
        )

    async def _send(
        self,
        channel_id: str,
        msg_type: str,
        content: str,
        thread_root_id: str | None,
    ) -> str:
        """Post to a chat, or reply in the thread of `thread_root_id`."""
        if thread_root_id:
            answer = await self._api.call(
                "POST",
                f"/im/v1/messages/{thread_root_id}/reply",
                json_body={
                    "msg_type": msg_type,
                    "content": content,
                    "reply_in_thread": True,
                },
            )
        else:
            answer = await self._api.call(
                "POST",
                "/im/v1/messages",
                params={"receive_id_type": "chat_id"},
                json_body={
                    "receive_id": channel_id,
                    "msg_type": msg_type,
                    "content": content,
                },
            )
        return str(answer.get("message_id") or "")

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the agent: its name is the post's title. A long reply is
        split, and its parts follow the first in the same place."""
        first: str | None = None
        for part in chunk(content):
            try:
                ref = await self._send(
                    channel_id, "post", self._post(sender_name, part), thread_root_id
                )
            except LarkApiError as error:
                raise BridgeOperationError(
                    f"Lark refused the message in {channel_id}: {error.message}"
                ) from error
            first = first or ref
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Edit a post in place, keeping its title. Lark allows editing a
        message a limited number of times; past that the edit is logged."""
        try:
            current = await self._api.call("GET", f"/im/v1/messages/{message_ref}")
            items = current.get("items") or [{}]
            body = json.loads(
                ((items[0] or {}).get("body") or {}).get("content") or "{}"
            )
            title = str(body.get("title") or "") if isinstance(body, dict) else ""
            await self._api.call(
                "PUT",
                f"/im/v1/messages/{message_ref}",
                json_body={
                    "msg_type": "post",
                    "content": self._post(title, chunk(new_content)[0]),
                },
            )
        except (LarkApiError, httpx.HTTPError, ValueError) as error:
            logger.warning(
                "Lark bridge %s could not edit message %s: %s",
                self.config.app_id,
                message_ref,
                _said(error),
            )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._api.call("DELETE", f"/im/v1/messages/{message_ref}")
        except (LarkApiError, httpx.HTTPError) as error:
            logger.warning(
                "Lark bridge %s could not recall message %s: %s",
                self.config.app_id,
                message_ref,
                _said(error),
            )

    async def send_typing(self, *args: Any, **kwargs: Any) -> None:
        # Lark shows a bot no typing indicator; the working reaction says it.
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
        """The working reaction on the message an agent is working on. Its
        removal finds the bot's own reaction on the message, so any pod can
        take off what another put on."""
        if mark != "working":
            return
        path = f"/im/v1/messages/{message_ref}/reactions"
        try:
            if on:
                await self._api.call(
                    "POST", path, json_body={"reaction_type": {"emoji_type": _WORKING}}
                )
                return
            answer = await self._api.call(
                "GET", path, params={"reaction_type": _WORKING, "page_size": 50}
            )
            for reaction in answer.get("items") or []:
                operator = reaction.get("operator") or {}
                if operator.get("operator_type") == "app":
                    await self._api.call(
                        "DELETE", f"{path}/{reaction.get('reaction_id')}"
                    )
        except (LarkApiError, httpx.HTTPError) as error:
            logger.warning(
                "Lark bridge %s could not %s the working reaction on %s: %s",
                self.config.app_id,
                "add" if on else "remove",
                message_ref,
                _said(error),
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
        """Upload a file and post it. A caption goes first, as the agent, since
        a Lark file message carries no text. A file larger than Lark takes is
        refused in the chat, by name, rather than dropped."""
        image = mimetype.startswith("image/") and mimetype != "image/svg+xml"
        limit = _IMAGE_LIMIT if image else _FILE_LIMIT
        first: str | None = None
        if caption:
            first = await self.send_message(
                channel_id, sender_name, caption, thread_root_id
            )
        if len(data) > limit:
            note = (
                f"_couldn't send {filename}: it is {len(data) / (1024 * 1024):.1f} MB, "
                f"and Lark takes {'images' if image else 'files'} up to "
                f"{limit // (1024 * 1024)} MB_"
            )
            ref = await self.send_message(
                channel_id, sender_name, self.translate_outbound(note), thread_root_id
            )
            return first or ref
        try:
            if image:
                uploaded = await self._api.call(
                    "POST",
                    "/im/v1/images",
                    data={"image_type": "message"},
                    files={"image": (filename, data, mimetype)},
                )
                content = json.dumps({"image_key": uploaded.get("image_key")})
                ref = await self._send(channel_id, "image", content, thread_root_id)
            else:
                uploaded = await self._api.call(
                    "POST",
                    "/im/v1/files",
                    data={
                        "file_type": _FILE_TYPES.get(mimetype, "stream"),
                        "file_name": filename,
                    },
                    files={"file": (filename, data, mimetype)},
                )
                content = json.dumps({"file_key": uploaded.get("file_key")})
                ref = await self._send(channel_id, "file", content, thread_root_id)
        except LarkApiError as error:
            raise BridgeOperationError(
                f"Lark refused {filename} in {channel_id}: {error.message}"
            ) from error
        return first or ref

    # ── Cards ────────────────────────────────────────────────────────────────

    def _card(self, agent_name: str, content: RichContent) -> str:
        """A Lark card: the agent's name as its header, what is happening as
        its body, and a button for each option a request offers, or to stop a
        running turn."""
        elements: list[dict[str, Any]] = [
            {"tag": "markdown", "content": to_lark(self.rich_fallback_text(content))}
        ]
        buttons: list[dict[str, Any]] = []
        if isinstance(content, RequestCard):
            for control in offered_controls(content.request):
                label = f"{control.position}. {control.label}"
                if len(label) > _BUTTON_LABEL:
                    label = label[: _BUTTON_LABEL - 1] + "…"
                buttons.append(
                    _button(
                        label,
                        position_action(control.position),
                        content.reference.token,
                        "primary" if control.position == 1 else "default",
                    )
                )
        elif (
            content.interrupt_turn_id
            and self._on_interaction is not None
            and content.turn.status not in TURN_ENDED
        ):
            buttons.append(
                _button(
                    INTERRUPT_LABEL,
                    INTERRUPT_ACTION,
                    content.interrupt_turn_id,
                    "danger",
                )
            )
        if buttons:
            elements.append({"tag": "action", "actions": buttons})
        return json.dumps(
            {
                "config": {"wide_screen_mode": True, "update_multi": True},
                "header": {"title": {"tag": "plain_text", "content": agent_name}},
                "elements": elements,
            },
            ensure_ascii=False,
        )

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        try:
            ref = await self._send(
                channel_id,
                "interactive",
                self._card(agent_name, content),
                thread_root_id,
            )
        except (LarkApiError, httpx.HTTPError) as error:
            raise RichContentFailed(
                f"Lark could not post the card in {channel_id}: {_said(error)}",
                text=self.rich_fallback_text(content),
            ) from error
        if not ref:
            raise RichContentFailed(
                f"Lark did not accept the card in {channel_id}.",
                text=self.rich_fallback_text(content),
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
        try:
            await self._api.call(
                "PATCH",
                f"/im/v1/messages/{message_ref}",
                json_body={"content": self._card(agent_name, content)},
            )
        except (LarkApiError, httpx.HTTPError) as error:
            raise RichContentFailed(
                f"Lark could not redraw the card {message_ref}: {_said(error)}",
                text=self.rich_fallback_text(content),
            ) from error

    def rich_markup(self) -> Markup:
        return _CARD_MARKUP

    def rich_fallback_text(self, content: RichContent) -> str:
        """A card answered here names who answered by their Lark name, as
        the chat knows them, rather than by their Switch identity."""
        if not isinstance(content, RequestCard) or not content.responder_external_id:
            return super().rich_fallback_text(content)
        responder = content.responder_external_id
        return request_summary(
            content.request,
            content.reference,
            escape=self._rich_escape,
            limit=self.rich_fallback_limit(),
            markup=self.rich_markup(),
            responder=self._rich_escape(self._names.get(responder) or responder),
            unavailable_reason=content.unavailable_reason,
        )

    def render_app_mention(self, token: str) -> str:
        return f'<at user_id="{token}">{self._bot_name}</at>'

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        """A new group chat with the bot in it; a public room is a public group.
        Its name is the one Lark kept, which is cut to Lark's 60 characters."""
        try:
            answer = await self._api.call(
                "POST",
                "/im/v1/chats",
                params={"user_id_type": "open_id"},
                json_body={
                    "name": name[:60],
                    "description": topic[:100],
                    "chat_mode": "group",
                    "chat_type": "public"
                    if channel_type == "channel_public"
                    else "private",
                },
            )
        except LarkApiError as error:
            raise BridgeOperationError(
                f"Lark would not create the group chat {name!r}: {error.message}"
            ) from error
        chat_id = str(answer.get("chat_id") or "")
        if not chat_id:
            raise BridgeOperationError("Lark created a group chat but gave no id")
        self._chat_types.put(
            chat_id,
            "channel_public" if channel_type == "channel_public" else "channel_private",
        )
        return CreatedChannel(id=chat_id, name=str(answer.get("name") or name[:60]))

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """Add people by their Lark id; the ids Lark refuses are handed back."""
        ids = [user for user in user_external_ids if user.startswith("ou_")]
        left_out = [user for user in user_external_ids if not user.startswith("ou_")]
        if not ids:
            return left_out
        try:
            answer = await self._api.call(
                "POST",
                f"/im/v1/chats/{channel_id}/members",
                params={"member_id_type": "open_id"},
                json_body={"id_list": ids},
            )
        except LarkApiError as error:
            raise BridgeOperationError(
                f"Lark would not add people to {channel_id}: {error.message}"
            ) from error
        refused = [str(user) for user in answer.get("invalid_id_list") or []]
        refused += [str(user) for user in answer.get("not_existed_id_list") or []]
        return left_out + refused

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """The bot leaves the group: Lark removes an app from a chat by its
        App ID."""
        try:
            await self._api.call(
                "DELETE",
                f"/im/v1/chats/{external_channel_id}/members",
                params={"member_id_type": "app_id"},
                json_body={"id_list": [self.config.app_id]},
            )
        except (LarkApiError, httpx.HTTPError) as error:
            return RetireOutcome(
                outcome="failed",
                reason=f"Lark kept the bot in the group: {_said(error)}",
            )
        return RetireOutcome(outcome="left")

    async def require_bindable_channel(self, channel_id: str) -> None:
        if not _CHAT_ID.fullmatch(channel_id):
            raise ChannelNotBindable(
                f"{channel_id!r} is not a Lark chat id. It starts with oc_; find it "
                "in the group's settings, or add the bot to the group instead."
            )
        try:
            await self._api.call("GET", f"/im/v1/chats/{channel_id}")
        except LarkApiError as error:
            raise ChannelNotBindable(
                f"The bot can't see Lark chat {channel_id}: {error.message}. Add the "
                "bot to the group first."
            ) from error

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        known = self._chat_types.get(channel_id)
        if known in ("direct", "channel_public", "channel_private"):
            return known  # type: ignore[return-value]
        channel_type: ChannelType = "channel_private"
        try:
            chat = await self._api.call("GET", f"/im/v1/chats/{channel_id}")
            if chat.get("chat_mode") == "p2p":
                channel_type = "direct"
            elif chat.get("chat_type") == "public":
                channel_type = "channel_public"
            if chat.get("name"):
                self._chat_names.put(channel_id, str(chat["name"]))
        except (LarkApiError, httpx.HTTPError) as error:
            logger.warning(
                "Lark bridge %s could not read chat %s (%s); taking it as private",
                self.config.app_id,
                channel_id,
                _said(error),
            )
            return channel_type
        self._chat_types.put(channel_id, channel_type)
        return channel_type

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        return (
            f"{self.config.applink}/client/chat/open?openChatId={external_channel_id}"
        )

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents speak through the bot, which is already in the chat.
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # One bot speaks for every agent; there is no identity to create.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_lark(content)

    def translate_inbound(self, raw_message: str) -> str:
        # Text and posts are turned into Markdown as they are read.
        return raw_message


def _event_from_history(item: dict[str, Any]) -> dict[str, Any] | None:
    """A message read from a chat's history, in the shape of the event that
    would have brought it: a person's messages only, and none recalled."""
    sender = _dict(item.get("sender"))
    if sender.get("sender_type") != "user" or item.get("deleted"):
        return None
    mentions = [
        {**m, "id": {"open_id": m.get("id")}}
        for m in item.get("mentions") or []
        if isinstance(m, dict)
    ]
    return {
        "message": {
            "chat_id": item.get("chat_id"),
            "chat_type": item.get("chat_type") or "group",
            "message_id": item.get("message_id"),
            "message_type": item.get("msg_type"),
            "content": _dict(item.get("body")).get("content"),
            "mentions": mentions,
            "root_id": item.get("root_id"),
        },
        "sender": {"sender_id": {"open_id": sender.get("id")}, "sender_type": "user"},
    }


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _button(label: str, action: str, value: str, kind: str) -> dict[str, Any]:
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": label},
        "type": kind,
        "value": {"switch_action": action, "switch_value": value},
    }


def _image_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"

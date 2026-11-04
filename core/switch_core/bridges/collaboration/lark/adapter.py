"""Lark / Feishu as a messaging platform.

The operator creates a custom app on Lark's developer console, turns on its
bot, and enters the app's credentials here. Lark calls the bridge's own webhook
address for every event (messages, the bot or a person joining a chat, a press
on a card button), so any pod can take them and nothing is held open.

Every delivery must be encrypted with the app's Encrypt Key and is checked
against Lark's signature before a byte of it is decrypted, and again against
the app's Verification Token after. Lark's `event_id` is the delivery's id, so
a retry, or the same event reaching two pods, is handled once.

One bot speaks for every agent. Lark gives an app no per-message name or
avatar, so each message names its agent in its title, the way a post's title
is drawn above its body.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
)
from switch_core.bridges.collaboration.discord.chunking import chunk_message
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.lark.client import (
    HOSTS,
    FileTooLarge,
    LarkApiError,
    LarkClient,
    Region,
    new_send_key,
    open_envelope,
    signature,
    signature_matches,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelRetirement,
    ChannelType,
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
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
)

logger = logging.getLogger(__name__)

# A post is refused above 30 KB of request body. Characters outside ASCII take
# up to three bytes each, so a piece is cut well under that.
MAX_MESSAGE = 8000

# Lark's own limits on what a bot may upload: 10 MB for an image, 30 MB for
# any other file.
MAX_IMAGE_UPLOAD = 10 * 1024 * 1024
MAX_FILE_UPLOAD = 30 * 1024 * 1024

# How old a signed delivery may be. Lark retries a delivery it was not
# answered for over several hours with its original timestamp, so the window
# covers the retries; the receipt keyed on `event_id` is what makes a replay
# inside it harmless.
_MAX_DELIVERY_AGE = 8 * 3600
_MAX_CLOCK_SKEW = 300

# Lark's mention placeholders in a message's text, `@_user_1` and on.
_MENTION_KEY = re.compile(r"@_user_\d+")

# The longest label a card button can show without Lark truncating it.
_BUTTON_LABEL_LIMIT = 40

# Names and chat details looked up from Lark, kept to save a call per message.
# Safe to lose: a miss is one more lookup.
_CACHE_SIZE = 2048

# Lark's links that open a chat in its app, on desktop and mobile alike.
_APPLINK: dict[Region, str] = {
    "lark": "https://applink.larksuite.com",
    "feishu": "https://applink.feishu.cn",
}

# Lark's own `file_type` for an upload, by extension; anything else is "stream".
_FILE_TYPES = {
    ".pdf": "pdf",
    ".doc": "doc",
    ".docx": "doc",
    ".xls": "xls",
    ".xlsx": "xls",
    ".ppt": "ppt",
    ".pptx": "ppt",
    ".mp4": "mp4",
    ".opus": "opus",
}


class LarkConnectionConfig(BridgeConnectionConfig):
    region: Region = Field(
        default="lark",
        title="Region",
        description=(
            "Lark (open.larksuite.com) for tenants outside mainland China, "
            "Feishu (open.feishu.cn) for tenants inside it."
        ),
    )
    app_id: str = Field(
        title="App ID",
        description="From Credentials & Basic Info in the Lark developer console. Starts with cli_.",
    )
    app_secret: str = Field(
        title="App Secret",
        description="From Credentials & Basic Info in the Lark developer console.",
    )
    encrypt_key: str = Field(
        title="Encrypt Key",
        description=(
            "From Events & Callbacks > Encryption Strategy. Required: Switch "
            "accepts only encrypted, signed deliveries."
        ),
        json_schema_extra={"format": "password"},
    )
    verification_token: str = Field(
        title="Verification Token",
        description="From Events & Callbacks > Encryption Strategy.",
    )

    @field_validator("app_id", "app_secret", "encrypt_key", "verification_token")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be empty")
        return value

    @field_validator("app_id")
    @classmethod
    def _looks_like_app_id(cls, value: str) -> str:
        if not value.startswith("cli_"):
            raise ValueError(
                "is not a Lark App ID; it starts with cli_ (Credentials & Basic Info)"
            )
        return value


class LarkAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Lark"
    receives_webhooks: ClassVar[bool] = True
    # A bot can see only the people who have messaged it or share a chat with
    # it; Lark's user search needs a user's own token, which a bot does not have.
    supports_directory_search: ClassVar[bool] = False
    # Lark linkifies http(s) only.
    renders_custom_url_schemes: ClassVar[bool] = False
    # Turns are drawn as posts edited in place, and the cards a session waits
    # on as interactive cards answerable with a button.
    draws_session_activity: ClassVar[bool] = True
    # A bot can leave a chat; deleting one is for its owner.
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    def __init__(
        self,
        *,
        config: LarkConnectionConfig,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__()
        self.config = config
        self._client = LarkClient(
            region=config.region,
            app_id=config.app_id,
            app_secret=config.app_secret,
            transport=transport,
        )
        self._bot_open_id: str | None = None
        self._bot_name: str | None = None
        self._names: OrderedDict[str, str] = OrderedDict()
        self._chats: OrderedDict[str, tuple[ChannelType, str | None]] = OrderedDict()

    # ── Credentials and failures ──────────────────────────────────────────────

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, LarkApiError):
            return "auth_failed" if exc.auth else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        region = connection_config.get("region", "lark")
        return [HOSTS[region]] if region in HOSTS else []  # type: ignore[index]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = LarkConnectionConfig.model_validate(connection_config)
        client = LarkClient(
            region=config.region, app_id=config.app_id, app_secret=config.app_secret
        )
        try:
            await client.call("GET", "/open-apis/bot/v3/info")
        except LarkApiError as error:
            raise BridgeCredentialError(
                f"{error} Check the App ID and App Secret, that the app's bot "
                "is enabled, and that the region matches where the app was created."
            ) from error
        finally:
            await client.aclose()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        bot = await self._client.call("GET", "/open-apis/bot/v3/info")
        found = bot.get("bot")
        info: dict[str, Any] = found if isinstance(found, dict) else {}
        self._bot_open_id = str(info.get("open_id") or "") or None
        self._bot_name = str(info.get("app_name") or "") or None
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

    async def stop(self) -> None:
        await self._client.aclose()

    # ── Webhooks ──────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        """Signed and fresh, or the address check carrying our Verification Token.

        Lark signs every event and callback, but not the address check it sends
        when the operator saves the address. That one proves itself with the
        Verification Token sealed inside it, so it is accepted only if it
        decrypts under this app's Encrypt Key, is an address check, and carries
        the token.
        """
        if request.method != "POST":
            raise WebhookAuthenticityError("Lark delivers events by POST only")
        given = request.headers.get("x-lark-signature")
        if given is None:
            try:
                event = open_envelope(request.body, self.config.encrypt_key)
            except ValueError as error:
                raise WebhookAuthenticityError(
                    "unsigned delivery that does not decrypt under this app's key"
                ) from error
            if event.get("type") != "url_verification" or not self._token_ok(
                event.get("token")
            ):
                raise WebhookAuthenticityError(
                    "unsigned delivery that is not this app's address check"
                )
            return
        timestamp = request.headers.get("x-lark-request-timestamp", "")
        nonce = request.headers.get("x-lark-request-nonce", "")
        expected = signature(timestamp, nonce, self.config.encrypt_key, request.body)
        if not signature_matches(given, expected):
            raise WebhookAuthenticityError("signature does not match")
        if not timestamp.isdigit():
            raise WebhookAuthenticityError("signed delivery has no timestamp")
        age = time.time() - int(timestamp)
        if age > _MAX_DELIVERY_AGE or age < -_MAX_CLOCK_SKEW:
            raise WebhookAuthenticityError("signed delivery is outside its time window")

    def _token_ok(self, token: object) -> bool:
        return isinstance(token, str) and signature_matches(
            token, self.config.verification_token
        )

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            event = open_envelope(request.body, self.config.encrypt_key)
        except ValueError as error:
            raise WebhookPayloadError(f"not a Lark delivery: {error}") from error
        if event.get("type") == "url_verification":
            return InboundWebhook(
                envelope_type="url_verification",
                payload={},
                handshake=json.dumps({"challenge": str(event.get("challenge", ""))}),
                external_event_id=None,
                delivery_attempt=0,
                answers_inline=False,
            )
        header = event.get("header")
        if event.get("schema") != "2.0" or not isinstance(header, dict):
            raise WebhookPayloadError(
                "only version 2.0 events are read; subscribe the app to the v2.0 events"
            )
        if not self._token_ok(header.get("token")):
            raise WebhookPayloadError(
                "event does not carry this app's Verification Token"
            )
        event_id = header.get("event_id")
        event_type = header.get("event_type")
        body = event.get("event")
        if not event_id or not event_type or not isinstance(body, dict):
            raise WebhookPayloadError("event has no id, type or body")
        return InboundWebhook(
            envelope_type=str(event_type),
            payload=body,
            handshake=None,
            external_event_id=str(event_id),
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        if envelope_type == "im.message.receive_v1":
            await self._handle_message(payload)
        elif envelope_type == "im.chat.member.bot.added_v1":
            await self._handle_bot_added(payload)
        elif envelope_type == "im.chat.member.user.added_v1":
            await self._handle_users_added(payload)
        elif envelope_type == "card.action.trigger":
            await self._handle_card_action(payload)
        else:
            logger.debug("Ignoring Lark event %s", envelope_type)
        return None

    # ── Inbound ───────────────────────────────────────────────────────────────

    async def _handle_message(self, event: dict[str, Any]) -> None:
        message = event.get("message") or {}
        sender = event.get("sender") or {}
        sender_id = str((sender.get("sender_id") or {}).get("open_id") or "")
        chat_id = str(message.get("chat_id") or "")
        message_id = str(message.get("message_id") or "")
        if not chat_id or not message_id or not sender_id:
            logger.warning(
                "Lark message event without chat, message or sender, skipping"
            )
            return
        if self._bot_open_id and sender_id == self._bot_open_id:
            return
        mentions = [m for m in message.get("mentions") or [] if isinstance(m, dict)]
        for mention in mentions:
            open_id = str((mention.get("id") or {}).get("open_id") or "")
            if open_id and mention.get("name"):
                self._remember_name(open_id, str(mention["name"]))
        text, files = self._read_content(message, mentions)
        self_mention = any(
            str((m.get("id") or {}).get("open_id") or "") == self._bot_open_id
            for m in mentions
        )
        channel_type, channel_name = await self._chat(chat_id, message.get("chat_type"))
        sender_name = await self._user_name(sender_id)
        root = str(message.get("root_id") or "")
        root_id = root if root and root != message_id else None

        stripped = text.strip()
        if stripped.startswith("!") and self._on_command is not None and not files:
            parts = stripped.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=sender_name,
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
        attachments, failures = await self._fetch_attachments(message_id, files)
        await self._on_message(
            InboundMessage(
                channel_id=chat_id,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=sender_name,
                content=text,
                message_ref=message_id,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self._bot_open_id if self_mention else None,
                sender_is_app=sender.get("sender_type") == "app",
            )
        )

    def _read_content(
        self, message: dict[str, Any], mentions: list[dict[str, Any]]
    ) -> tuple[str, list[tuple[str, str, str]]]:
        """A message's words in Switch Markdown, and the files it carries.

        Files come back as (resource type, key, filename) for
        `_fetch_attachments`. A kind of message with nothing to relay but its
        kind (a sticker, a shared chat) is said as that, rather than arriving
        as an empty message.
        """
        kind = str(message.get("message_type") or "")
        try:
            content = json.loads(message.get("content") or "{}")
        except ValueError:
            content = {}
        if not isinstance(content, dict):
            content = {}
        names = {
            str(m.get("key")): str(m.get("name") or "")
            for m in mentions
            if m.get("key")
        }

        def named(text: str) -> str:
            return _MENTION_KEY.sub(
                lambda match: (
                    f"@{names[match.group(0)]}"
                    if names.get(match.group(0))
                    else match.group(0)
                ),
                text,
            )

        if kind == "text":
            return named(str(content.get("text", ""))), []
        if kind == "post":
            return self._read_post(content, named)
        if kind == "image" and content.get("image_key"):
            key = str(content["image_key"])
            return "", [("image", key, f"{key}.png")]
        if kind in ("file", "audio", "media") and content.get("file_key"):
            key = str(content["file_key"])
            return "", [("file", key, str(content.get("file_name") or key))]
        return f"_[{kind or 'unknown'} message]_", []

    def _read_post(
        self, content: dict[str, Any], named: Callable[[str], str]
    ) -> tuple[str, list[tuple[str, str, str]]]:
        # A received post is {title, content}; one sent by an app may still be
        # keyed by locale.
        if "content" not in content and content:
            first = next(iter(content.values()))
            content = first if isinstance(first, dict) else {}
        lines: list[str] = []
        files: list[tuple[str, str, str]] = []
        title = str(content.get("title") or "").strip()
        if title:
            lines.append(f"**{title}**")
        for paragraph in content.get("content") or []:
            if not isinstance(paragraph, list):
                continue
            parts: list[str] = []
            for element in paragraph:
                if not isinstance(element, dict):
                    continue
                tag = element.get("tag")
                if tag in ("text", "md"):
                    parts.append(named(str(element.get("text", ""))))
                elif tag == "a":
                    label = str(element.get("text") or element.get("href") or "")
                    href = str(element.get("href") or "")
                    parts.append(f"[{label}]({href})" if href else label)
                elif tag == "at":
                    parts.append(
                        f"@{element.get('user_name') or element.get('user_id')}"
                    )
                elif tag == "code_block":
                    parts.append(
                        f"\n```{element.get('language') or ''}\n{element.get('text', '')}\n```\n"
                    )
                elif tag == "img" and element.get("image_key"):
                    key = str(element["image_key"])
                    files.append(("image", key, f"{key}.png"))
                elif tag == "media" and element.get("file_key"):
                    key = str(element["file_key"])
                    files.append(("file", key, key))
                elif tag == "emotion":
                    parts.append(f":{element.get('emoji_type', '')}:")
            lines.append("".join(parts))
        return "\n".join(lines).strip(), files

    async def _fetch_attachments(
        self, message_id: str, files: list[tuple[str, str, str]]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for kind, key, filename in files:
            try:
                data = await self._client.download(
                    f"/open-apis/im/v1/messages/{message_id}/resources/{key}",
                    params={"type": kind},
                    limit=self._max_attachment_bytes,
                )
            except FileTooLarge as error:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"larger than the {self._max_attachment_bytes // (1024 * 1024)} MB limit "
                        f"({error.size // (1024 * 1024)} MB)",
                    )
                )
                continue
            except (LarkApiError, httpx.HTTPError) as error:
                logger.warning("Could not download Lark %s %s: %s", kind, key, error)
                failures.append(AttachmentFailure(filename=filename, reason=str(error)))
                continue
            mimetype = mimetypes.guess_type(filename)[0] or (
                "image/png" if kind == "image" else "application/octet-stream"
            )
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
            )
        return attachments, failures

    async def _handle_bot_added(self, event: dict[str, Any]) -> None:
        chat_id = str(event.get("chat_id") or "")
        if not chat_id or self._on_app_joined is None:
            return
        self._chats.pop(chat_id, None)
        channel_type, name = await self._chat(chat_id, None)
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=chat_id,
                channel_type=channel_type,
                channel_name=str(event.get("name") or "") or name,
            )
        )

    async def _handle_users_added(self, event: dict[str, Any]) -> None:
        chat_id = str(event.get("chat_id") or "")
        if not chat_id or self._on_user_joined is None:
            return
        channel_type, name = await self._chat(chat_id, None)
        for user in event.get("users") or []:
            if not isinstance(user, dict):
                continue
            open_id = str((user.get("user_id") or {}).get("open_id") or "")
            if not open_id:
                continue
            if user.get("name"):
                self._remember_name(open_id, str(user["name"]))
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    external_user_id=open_id,
                    external_username=await self._user_name(open_id),
                    channel_name=name,
                )
            )

    async def _handle_card_action(self, event: dict[str, Any]) -> None:
        """A press on one of this bridge's card buttons.

        The button's value is what this bridge put there: the request's token
        and the option's position. Who pressed comes from Lark's envelope,
        never from the value.
        """
        action = event.get("action") or {}
        value = action.get("value") if isinstance(action, dict) else None
        context = event.get("context") or {}
        operator = event.get("operator") or {}
        sender_id = str(operator.get("open_id") or "")
        chat_id = str(context.get("open_chat_id") or "")
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("switch_token"), str)
            or not isinstance(value.get("switch_position"), int)
            or not sender_id
            or not chat_id
        ):
            logger.debug("Ignoring a Lark card press that is not on a Switch card")
            return
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card in Lark chat %s has nowhere to go: "
                "this bridge handles no interactions.",
                chat_id,
            )
            return
        await self._on_interaction(
            InboundInteraction(
                channel_id=chat_id,
                sender_id=sender_id,
                sender_name=await self._user_name(sender_id),
                action_id=position_action(value["switch_position"]),
                value=value["switch_token"],
                message_ref=str(context.get("open_message_id") or "") or None,
            )
        )

    # ── Lookups ───────────────────────────────────────────────────────────────

    def _remember_name(self, open_id: str, name: str) -> None:
        self._names[open_id] = name
        self._names.move_to_end(open_id)
        while len(self._names) > _CACHE_SIZE:
            self._names.popitem(last=False)

    async def _user_name(self, open_id: str) -> str:
        """The person's name, or their open_id where Lark will not say.

        Reading a name needs the app's contact permission. Without it the id
        stands in, and the docs page says which permission to grant.
        """
        if open_id in self._names:
            return self._names[open_id]
        try:
            data = await self._client.call(
                "GET",
                f"/open-apis/contact/v3/users/{open_id}",
                params={"user_id_type": "open_id"},
            )
        except LarkApiError as error:
            logger.warning(
                "Lark would not give the name of %s (%s); using the id. Grant "
                "the app permission to read contact information to show names.",
                open_id,
                error,
            )
            return open_id
        name = str((data.get("user") or {}).get("name") or "") or open_id
        self._remember_name(open_id, name)
        return name

    async def _chat(
        self, chat_id: str, chat_type_hint: object
    ) -> tuple[ChannelType, str | None]:
        if chat_id in self._chats:
            return self._chats[chat_id]
        if chat_type_hint == "p2p":
            found: tuple[ChannelType, str | None] = ("direct", None)
        else:
            data = await self._client.call("GET", f"/open-apis/im/v1/chats/{chat_id}")
            if data.get("chat_mode") == "p2p":
                found = ("direct", None)
            else:
                kind: ChannelType = (
                    "channel_public"
                    if data.get("chat_type") == "public"
                    else "channel_private"
                )
                found = (kind, str(data.get("name") or "") or None)
        self._chats[chat_id] = found
        while len(self._chats) > _CACHE_SIZE:
            self._chats.popitem(last=False)
        return found

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return (await self._chat(channel_id, None))[0]

    # ── Outbound ──────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        # A post's `md` element reads Markdown as Switch writes it.
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return str(raw_message)

    @staticmethod
    def _post(title: str, text: str) -> str:
        return json.dumps(
            {"en_us": {"title": title, "content": [[{"tag": "md", "text": text}]]}},
            ensure_ascii=False,
        )

    async def _send(
        self, channel_id: str, msg_type: str, content: str, thread_root_id: str | None
    ) -> str:
        """Post one message, in a thread where there is one, and return its id.

        Sent with an idempotency key and retried once with the same key if the
        answer is lost, so a timeout costs a duplicate neither way.
        """
        key = new_send_key()
        if thread_root_id:
            method, path, params, body = (
                "POST",
                f"/open-apis/im/v1/messages/{thread_root_id}/reply",
                None,
                {
                    "msg_type": msg_type,
                    "content": content,
                    "reply_in_thread": True,
                    "uuid": key,
                },
            )
        else:
            method, path, params, body = (
                "POST",
                "/open-apis/im/v1/messages",
                {"receive_id_type": "chat_id"},
                {
                    "receive_id": channel_id,
                    "msg_type": msg_type,
                    "content": content,
                    "uuid": key,
                },
            )
        try:
            data = await self._client.call(method, path, json_body=body, params=params)
        except httpx.TransportError:
            data = await self._client.call(method, path, json_body=body, params=params)
        message_id = str(data.get("message_id") or "")
        if not message_id:
            raise LarkApiError(f"Lark answered {path} with no message id", code=-1)
        return message_id

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        title = (await self.agent_rendering(sender_name)).field_label
        first: str | None = None
        for piece in chunk_message(content, MAX_MESSAGE):
            try:
                ref = await self._send(
                    channel_id, "post", self._post(title, piece), thread_root_id
                )
            except (LarkApiError, httpx.HTTPError) as error:
                logger.error(
                    "Lark refused a message from %s in chat %s: %s",
                    sender_name,
                    channel_id,
                    error,
                )
                return first
            first = first or ref
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Edit a post in place, keeping the title that names its agent.

        An edit replaces the whole post, and nothing passed here names the
        agent, so the title is read back from Lark rather than from memory a
        restart would empty.
        """
        try:
            current = await self._client.call(
                "GET", f"/open-apis/im/v1/messages/{message_ref}"
            )
            await self._client.call(
                "PUT",
                f"/open-apis/im/v1/messages/{message_ref}",
                json_body={
                    "msg_type": "post",
                    "content": self._post(_post_title(current), new_content),
                },
            )
        except (LarkApiError, httpx.HTTPError) as error:
            logger.warning("Lark refused an edit to %s: %s", message_ref, error)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._client.call(
                "DELETE", f"/open-apis/im/v1/messages/{message_ref}"
            )
        except (LarkApiError, httpx.HTTPError) as error:
            logger.warning("Lark refused to delete %s: %s", message_ref, error)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Lark has no typing indicator for bots.
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
        """Upload the file and post it under a line naming the agent.

        Lark draws a file or image message with no title, so the post above it
        is what says whose it is. A file over Lark's upload limit is refused
        out loud in the chat rather than dropped.
        """
        is_image = mimetype.startswith("image/") and len(data) <= MAX_IMAGE_UPLOAD
        if not is_image and len(data) > MAX_FILE_UPLOAD:
            refusal = (
                f"_Could not send {filename}: Lark accepts files up to "
                f"{MAX_FILE_UPLOAD // (1024 * 1024)} MB._"
            )
            return await self.send_message(
                channel_id,
                sender_name,
                f"{caption}\n{refusal}" if caption else refusal,
                thread_root_id,
            )
        ref = await self.send_message(
            channel_id, sender_name, caption or f"_sent {filename}_", thread_root_id
        )
        try:
            if is_image:
                uploaded = await self._client.call(
                    "POST",
                    "/open-apis/im/v1/images",
                    data={"image_type": "message"},
                    files={"image": (filename, data, mimetype)},
                )
                msg_type = "image"
                content = json.dumps({"image_key": uploaded.get("image_key")})
            else:
                extension = (
                    ("." + filename.rsplit(".", 1)[-1].lower())
                    if "." in filename
                    else ""
                )
                uploaded = await self._client.call(
                    "POST",
                    "/open-apis/im/v1/files",
                    data={
                        "file_type": _FILE_TYPES.get(extension, "stream"),
                        "file_name": filename,
                    },
                    files={"file": (filename, data, mimetype)},
                )
                msg_type = "file"
                content = json.dumps({"file_key": uploaded.get("file_key")})
            await self._send(channel_id, msg_type, content, thread_root_id)
        except (LarkApiError, httpx.HTTPError) as error:
            logger.error("Lark refused the upload of %s: %s", filename, error)
            await self.send_message(
                channel_id,
                sender_name,
                f"_Could not send {filename}: {error}_",
                thread_root_id,
            )
        return ref

    # ── Request cards ─────────────────────────────────────────────────────────

    def _card(self, content: RequestCard, title: str) -> str:
        """A request as an interactive card: the question, and a button per option.

        Buttons only where `render_request` says this drawing can be answered
        from what is on the screen. A settled request has no options left, so a
        redraw takes its buttons off the moment it stops being answerable.
        """
        drawn = render_request(
            content.request,
            content.reference,
            escape=self._rich_escape,
            limit=self.rich_fallback_limit(),
            markup=MARKDOWN,
            responder=None,
            unavailable_reason=content.unavailable_reason,
            control_label_limit=_BUTTON_LABEL_LIMIT,
        )
        elements: list[dict[str, Any]] = [{"tag": "markdown", "content": drawn.text}]
        if drawn.answerable:
            buttons = [
                {
                    "tag": "button",
                    "text": {
                        "tag": "plain_text",
                        "content": _button_label(c.position, c.label),
                    },
                    "type": "primary" if c.position == 1 else "default",
                    "value": {
                        "switch_token": content.reference.token,
                        "switch_position": c.position,
                    },
                }
                for c in offered_controls(content.request)
            ]
            if buttons:
                elements.append({"tag": "action", "actions": buttons})
        return json.dumps(
            {
                # Shared, so an update reaches everyone in the chat and not
                # only whoever pressed.
                "config": {"wide_screen_mode": True, "update_multi": True},
                "header": {"title": {"tag": "plain_text", "content": title}},
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
        if not isinstance(content, RequestCard):
            return await super().post_rich(
                channel_id, agent_name, content, thread_root_id
            )
        title = (await self.agent_rendering(agent_name)).field_label
        try:
            return await self._send(
                channel_id, "interactive", self._card(content, title), thread_root_id
            )
        except LarkApiError as error:
            raise RichContentFailed(
                f"Lark refused the card in chat {channel_id}: {error}",
                text=self.rich_fallback_text(content),
            ) from error

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        title = (await self.agent_rendering(agent_name)).field_label
        if not isinstance(content, RequestCard):
            text = self.rich_fallback_text(content)
            try:
                await self._client.call(
                    "PUT",
                    f"/open-apis/im/v1/messages/{message_ref}",
                    json_body={"msg_type": "post", "content": self._post(title, text)},
                )
            except LarkApiError as error:
                raise RichContentFailed(
                    f"Lark refused the update to {message_ref}: {error}", text=text
                ) from error
            return
        try:
            await self._client.call(
                "PATCH",
                f"/open-apis/im/v1/messages/{message_ref}",
                json_body={"content": self._card(content, title)},
            )
        except LarkApiError as error:
            raise RichContentFailed(
                f"Lark refused the update to card {message_ref}: {error}",
                text=self.rich_fallback_text(content),
            ) from error

    # ── Chats and membership ──────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        if channel_type == "direct":
            raise ChannelCreationUnsupported(
                "A Lark bot cannot open a direct chat; the person messages the bot first."
            )
        try:
            data = await self._client.call(
                "POST",
                "/open-apis/im/v1/chats",
                json_body={
                    "name": name,
                    "description": topic,
                    "chat_mode": "group",
                    "chat_type": "public"
                    if channel_type == "channel_public"
                    else "private",
                },
            )
        except LarkApiError as error:
            raise BridgeOperationError(str(error)) from error
        chat_id = str(data.get("chat_id") or "")
        if not chat_id:
            raise BridgeOperationError("Lark created the chat but did not say its id")
        kind: ChannelType = (
            "channel_public" if channel_type == "channel_public" else "channel_private"
        )
        self._chats[chat_id] = (kind, name)
        return chat_id

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents speak through the bot, which is already in the chat.
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
            data = await self._client.call(
                "POST",
                f"/open-apis/im/v1/chats/{channel_id}/members",
                params={"member_id_type": "open_id"},
                json_body={"id_list": user_external_ids},
            )
        except LarkApiError as error:
            logger.warning(
                "Lark refused to add people to chat %s: %s", channel_id, error
            )
            return list(user_external_ids)
        invalid = data.get("invalid_id_list") or []
        return [str(i) for i in invalid if str(i) in user_external_ids]

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """Take the bot out of the chat, which a bot does by removing its own app."""
        try:
            await self._client.call(
                "DELETE",
                f"/open-apis/im/v1/chats/{external_channel_id}/members",
                params={"member_id_type": "app_id"},
                json_body={"id_list": [self.config.app_id]},
            )
        except (LarkApiError, httpx.HTTPError) as error:
            return RetireOutcome.failed(
                f"Lark did not let the bot leave the chat: {error}"
            )
        return RetireOutcome(outcome="left")

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        if not external_channel_id:
            return None
        return f"{_APPLINK[self.config.region]}/client/chat/open?openChatId={external_channel_id}"

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []


def _post_title(message: dict[str, Any]) -> str:
    """The title of the post `GET /im/v1/messages/{id}` answered with, or ""."""
    items = message.get("items") or []
    body = items[0].get("body") if items and isinstance(items[0], dict) else None
    try:
        content = json.loads((body or {}).get("content") or "{}")
    except ValueError:
        return ""
    if isinstance(content, dict) and "title" not in content and content:
        first = next(iter(content.values()))
        content = first if isinstance(first, dict) else {}
    return str(content.get("title") or "") if isinstance(content, dict) else ""


def _button_label(position: int, label: str) -> str:
    """The option's number and as much of its label as a button shows.

    Numbered because the card's body numbers the options, so a reader can match
    a button to the option it answers with.
    """
    text = f"{position}. {label.strip() or f'Option {position}'}"
    if len(text) <= _BUTTON_LABEL_LIMIT:
        return text
    return text[: _BUTTON_LABEL_LIMIT - 1].rstrip() + "…"

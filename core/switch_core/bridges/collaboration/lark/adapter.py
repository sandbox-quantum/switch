"""Lark / Feishu collaboration bridge adapter.

A bot app the operator creates in the Lark or Feishu developer console.
Inbound events arrive over Lark's WebSocket long connection, handled by
the official lark-oapi SDK in a background thread; outbound messages go
through the OpenAPI REST endpoints with a tenant access token. Group
chats are bridged; 1:1 chats with the bot are not. Threads are Lark's
own: a reply in Switch is a threaded reply on Lark.
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar, override
from urllib.parse import urlparse

import httpx
import lark_oapi as lark
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)

logger = logging.getLogger(__name__)


class LarkApiError(RuntimeError):
    """The Lark OpenAPI answered with a non-zero code."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class LarkConnectionConfig(BridgeConnectionConfig):
    """Configuration for a Lark / Feishu bridge connection."""

    app_id: str = Field(description="The bot app's App ID (cli_...)")
    app_secret: str = Field(description="The bot app's App Secret")
    api_base_url: str = Field(
        default="https://open.feishu.cn",
        description=(
            "The OpenAPI domain: https://open.feishu.cn for Feishu (China), "
            "https://open.larksuite.com for Lark (international)"
        ),
    )

    @field_validator("app_id")
    @classmethod
    def _validate_app_id(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("app_id is required")
        return v

    @field_validator("app_secret")
    @classmethod
    def _validate_app_secret(cls, v: str) -> str:
        if not v:
            raise ValueError("app_secret is required")
        return v

    @field_validator("api_base_url")
    @classmethod
    def _validate_api_base_url(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if not v:
            raise ValueError("api_base_url is required")
        parsed = urlparse(v)
        if parsed.scheme != "https":
            raise ValueError("api_base_url must use https")
        if not parsed.netloc:
            raise ValueError("api_base_url must have a valid hostname")
        if parsed.path not in ("", "/"):
            raise ValueError("api_base_url must be the domain root, with no path")
        return v


class LarkAdapter(PlatformAdapter):
    """Lark / Feishu bridge: SDK long connection in, OpenAPI REST out."""

    display_name: ClassVar[str] = "Lark"
    docs_slug: ClassVar[str | None] = "lark"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    channel_on_delete = "deleted"
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    notifies_only_by_mention: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True
    separate_attention_slot: ClassVar[bool] = True
    redraws_for_elapsed_time: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = False
    supports_queue_reaction: ClassVar[bool] = False
    activity_reactions_per_agent: ClassVar[bool] = False
    recovers_uncertain_posts: ClassVar[bool] = False
    carries_publication_marker: ClassVar[bool] = False
    discloses_unconfirmed_posts: ClassVar[bool] = False
    removes_answered_cards: ClassVar[bool] = False
    channel_mention: ClassVar[str | None] = None

    def __init__(
        self,
        *,
        config: LarkConnectionConfig,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__()
        self._config = config
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._tenant_token: str | None = None
        self._token_expires_at = 0.0
        self._bot_open_id: str | None = None
        self._bot_name: str | None = None
        self._seen_messages: OrderedDict[str, None] = OrderedDict()
        self._user_names: dict[str, str] = {}
        self._ws_thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop_event = asyncio.Event()

    # -- Failure classification and registration hooks --------------------

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.ConnectError | httpx.TimeoutException):
            return "network"
        if isinstance(exc, httpx.HTTPStatusError):
            if exc.response.status_code in (401, 403):
                return "auth_failed"
            if exc.response.status_code == 404:
                return "config_invalid"
            return "platform_error"
        if isinstance(exc, LarkApiError | json.JSONDecodeError):
            return "platform_error"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        config = LarkConnectionConfig.model_validate(connection_config)
        return f"{config.api_base_url} app {config.app_id}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        config = LarkConnectionConfig.model_validate(connection_config)
        return [config.api_base_url]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = LarkConnectionConfig.model_validate(connection_config)
        await cls._fetch_app_token(config, None)

    @classmethod
    async def _fetch_app_token(
        cls,
        config: LarkConnectionConfig,
        transport: httpx.AsyncBaseTransport | None,
    ) -> str:
        url = (
            config.api_base_url.rstrip("/")
            + "/open-apis/auth/v3/app_access_token/internal"
        )
        try:
            async with httpx.AsyncClient(
                transport=transport, timeout=15.0, trust_env=False
            ) as client:
                resp = await client.post(
                    url,
                    json={"app_id": config.app_id, "app_secret": config.app_secret},
                )
        except httpx.ConnectError as e:
            raise BridgeCredentialError(
                f"Could not reach the Lark server at {config.api_base_url}: {e}"
            ) from e
        except httpx.TimeoutException as e:
            raise BridgeCredentialError(
                f"Timed out connecting to the Lark server at {config.api_base_url}: {e}"
            ) from e
        if resp.status_code in (401, 403):
            raise BridgeCredentialError(
                f"The Lark server at {config.api_base_url} rejected the credentials "
                f"(HTTP {resp.status_code}). Check the app's App ID and App Secret."
            )
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError) as e:
            raise BridgeCredentialError(
                f"The Lark server at {config.api_base_url} answered with an "
                f"unparseable response: {e}"
            ) from e
        if not isinstance(data, dict) or data.get("code") != 0:
            code = data.get("code") if isinstance(data, dict) else None
            message = data.get("msg") if isinstance(data, dict) else None
            raise BridgeCredentialError(
                f"The Lark server at {config.api_base_url} rejected the "
                f"credentials (code {code}: {message}). Check the app's App ID "
                "and App Secret."
            )
        token = data.get("app_access_token")
        if not token:
            raise BridgeCredentialError(
                f"The Lark server at {config.api_base_url} did not return an "
                "app access token"
            )
        return str(token)

    # -- Lifecycle --------------------------------------------------------

    @override
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

        if not self._listening:
            logger.info("Lark adapter started in quiet mode (no long connection)")
            return

        self._loop = asyncio.get_running_loop()
        await self._ensure_token()
        await self._fetch_bot_info()
        self._stop_event.clear()
        handler = (
            lark.EventDispatcherHandler.builder("", "")
            .register_p2_im_message_receive_v1(self._on_sdk_event)
            .build()
        )
        ws_client = lark.ws.Client(
            self._config.app_id,
            self._config.app_secret,
            event_handler=handler,
            domain=self._sdk_domain(),
            log_level=lark.LogLevel.WARNING,
        )
        self._ws_thread = threading.Thread(
            target=ws_client.start, name="lark-long-connection", daemon=True
        )
        self._ws_thread.start()
        logger.info("Lark adapter started with long-connection WebSocket")

    @override
    async def stop(self) -> None:
        self._stop_event.set()
        self._ws_thread = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _sdk_domain(self) -> str:
        if "larksuite" in self._config.api_base_url:
            return str(lark.LARK_DOMAIN)
        return str(lark.FEISHU_DOMAIN)

    def _on_sdk_event(self, data: Any) -> None:
        if self._stop_event.is_set() or self._loop is None:
            return
        try:
            payload = json.loads(lark.JSON.marshal(data))
        except (ValueError, TypeError):
            logger.warning("Could not serialize Lark event")
            return
        future = asyncio.run_coroutine_threadsafe(
            self._process_event(payload), self._loop
        )

        def _done(done: Any) -> None:
            exc = done.exception()
            if exc is not None:
                logger.error("Error processing Lark event", exc_info=exc)

        future.add_done_callback(_done)

    # -- REST transport ---------------------------------------------------

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            transport = self._transport
            if transport is None:
                transport = httpx.AsyncHTTPTransport(verify=True, trust_env=False)
            self._client = httpx.AsyncClient(
                transport=transport,
                timeout=httpx.Timeout(connect=10.0, read=30.0, write=60.0, pool=10.0),
                follow_redirects=False,
            )
        return self._client

    async def _ensure_token(self) -> str:
        if self._tenant_token and self._token_expires_at > time.monotonic() + 60:
            return self._tenant_token
        client = await self._get_client()
        resp = await client.post(
            self._config.api_base_url.rstrip("/")
            + "/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": self._config.app_id, "app_secret": self._config.app_secret},
            timeout=15.0,
        )
        data = self._parse_api_response(resp)
        token = data.get("tenant_access_token")
        if not token:
            raise BridgeCredentialError(
                "The Lark server did not return a tenant access token"
            )
        self._tenant_token = str(token)
        try:
            expire = int(data.get("expire") or 7200)
        except (TypeError, ValueError):
            expire = 7200
        self._token_expires_at = time.monotonic() + expire
        return self._tenant_token

    @staticmethod
    def _parse_api_response(resp: httpx.Response) -> dict[str, Any]:
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError):
            resp.raise_for_status()
            raise LarkApiError(0, "Lark returned an unparseable response")
        if isinstance(data, dict) and data.get("code") not in (0, None):
            raise LarkApiError(
                int(data.get("code") or 0), str(data.get("msg") or "unknown error")
            )
        resp.raise_for_status()
        if isinstance(data, dict):
            inner = data.get("data")
            return inner if isinstance(inner, dict) else data
        raise LarkApiError(0, "Lark returned an unexpected response")

    async def _api(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = await self._ensure_token()
        client = await self._get_client()
        resp = await client.request(
            method,
            self._config.api_base_url.rstrip("/") + path,
            headers={"Authorization": f"Bearer {token}"},
            json=json_body,
            params=params,
            timeout=30.0,
        )
        return self._parse_api_response(resp)

    async def _fetch_bot_info(self) -> None:
        data = await self._api("GET", "/open-apis/bot/v3/info")
        bot = data.get("bot")
        if isinstance(bot, dict):
            if bot.get("open_id"):
                self._bot_open_id = str(bot["open_id"])
            if bot.get("app_name"):
                self._bot_name = str(bot["app_name"])

    async def _user_name(self, open_id: str) -> str:
        cached = self._user_names.get(open_id)
        if cached:
            return cached
        try:
            data = await self._api(
                "GET",
                f"/open-apis/contact/v3/users/{open_id}",
                params={"user_id_type": "open_id"},
            )
            name = data.get("name") if isinstance(data, dict) else None
        except Exception:
            logger.warning(
                "Lark sender name lookup failed for %s", open_id, exc_info=True
            )
            name = None
        resolved = str(name) if name else open_id
        self._user_names[open_id] = resolved
        return resolved

    # -- Inbound ------------------------------------------------------------

    async def _process_event(self, payload: dict[str, Any]) -> None:
        event = payload.get("event") or {}
        message = event.get("message") or {}
        sender = event.get("sender") or {}
        if sender.get("sender_type") == "app":
            return
        if message.get("chat_type") != "group":
            return
        message_id = str(message.get("message_id") or "")
        chat_id = str(message.get("chat_id") or "")
        if not message_id or not chat_id:
            return
        if message_id in self._seen_messages:
            return
        self._seen_messages[message_id] = None
        if len(self._seen_messages) > 1000:
            self._seen_messages.popitem(last=False)

        sender_id = sender.get("sender_id") or {}
        open_id = str(sender_id.get("open_id") or sender_id.get("user_id") or "")
        sender_name = await self._user_name(open_id) if open_id else "unknown"

        content, attachments, failures = await self._extract_content(
            message, message_id
        )
        root_id = message.get("root_id") or message.get("parent_id") or None
        root_id = str(root_id) if root_id else None

        if content.strip().startswith("!"):
            if self._on_command is None:
                return
            parts = content.strip().split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=chat_id,
                    channel_type="channel_private",
                    sender_id=open_id,
                    sender_name=sender_name,
                    command=parts[0][1:],
                    args=parts[1] if len(parts) > 1 else "",
                    message_ref=message_id,
                    root_id=root_id,
                )
            )
            return

        self_mention_token: str | None = None
        for mention in message.get("mentions") or []:
            mention_id = (mention.get("id") or {}) if isinstance(mention, dict) else {}
            if (
                self._bot_open_id
                and str(mention_id.get("open_id") or "") == self._bot_open_id
            ):
                self_mention_token = self._bot_name or self._bot_open_id
                break

        if not content and not attachments and not failures:
            return
        if self._on_message is None:
            return
        await self._on_message(
            InboundMessage(
                channel_id=chat_id,
                channel_type="channel_private",
                sender_id=open_id,
                sender_name=sender_name,
                content=content,
                message_ref=message_id,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self_mention_token,
                sender_is_app=False,
            )
        )

    async def _extract_content(
        self, message: dict[str, Any], message_id: str
    ) -> tuple[str, list[Attachment], list[AttachmentFailure]]:
        message_type = message.get("message_type")
        raw_content = message.get("content")
        content: dict[str, Any] = {}
        if isinstance(raw_content, dict):
            content = raw_content
        elif isinstance(raw_content, str) and raw_content:
            try:
                parsed = json.loads(raw_content)
                content = parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                content = {}
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []

        if message_type == "text":
            return str(content.get("text") or ""), attachments, failures
        if message_type == "post":
            return self._post_text(content), attachments, failures
        if message_type in ("image", "file", "audio", "media"):
            key_field = "image_key" if message_type == "image" else "file_key"
            key = content.get(key_field)
            if not key:
                return "", attachments, failures
            resource_type = "image" if message_type == "image" else "file"
            filename = str(
                content.get("file_name") or self._default_filename(message_type)
            )
            try:
                data_bytes, mimetype = await self._download_resource(
                    message_id, str(key), resource_type
                )
                if not filename or filename == self._default_filename(message_type):
                    ext = mimetypes.guess_extension(mimetype) or ""
                    filename = f"{filename}{ext}" if ext else filename
                attachments.append(
                    Attachment(filename=filename, mimetype=mimetype, data=data_bytes)
                )
            except Exception as e:
                logger.warning("Failed to download Lark attachment %s: %s", key, e)
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"failed to download: {e}"
                    )
                )
            return "", attachments, failures
        logger.debug("Skipping Lark message of type %s", message_type)
        return "", attachments, failures

    @staticmethod
    def _default_filename(message_type: str) -> str:
        return {
            "image": "image",
            "audio": "audio.opus",
            "media": "video.mp4",
        }.get(message_type, "file")

    @staticmethod
    def _post_text(content: dict[str, Any]) -> str:
        parts: list[str] = []
        title = content.get("title")
        if title:
            parts.append(str(title))
        for paragraph in content.get("content") or []:
            if not isinstance(paragraph, list):
                continue
            line = ""
            for segment in paragraph:
                if not isinstance(segment, dict):
                    continue
                tag = segment.get("tag")
                if tag == "at":
                    line += (
                        f"@{segment.get('user_name') or segment.get('user_id') or ''}"
                    )
                elif segment.get("text"):
                    line += str(segment["text"])
            parts.append(line)
        return "\n".join(part for part in parts if part)

    async def _download_resource(
        self, message_id: str, file_key: str, resource_type: str
    ) -> tuple[bytes, str]:
        token = await self._ensure_token()
        client = await self._get_client()
        url = (
            self._config.api_base_url.rstrip("/")
            + f"/open-apis/im/v1/messages/{message_id}/resources/{file_key}"
        )
        async with client.stream(
            "GET",
            url,
            headers={"Authorization": f"Bearer {token}"},
            params={"type": resource_type},
        ) as resp:
            resp.raise_for_status()
            declared = resp.headers.get("content-length")
            if declared and int(declared) > self._max_attachment_bytes:
                raise ValueError(
                    f"attachment exceeds maximum size of "
                    f"{self._max_attachment_bytes} bytes"
                )
            chunks = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > self._max_attachment_bytes:
                    raise ValueError(
                        f"attachment exceeds maximum size of "
                        f"{self._max_attachment_bytes} bytes"
                    )
                chunks.append(chunk)
            return b"".join(chunks), resp.headers.get("content-type", "").split(";")[
                0
            ] or "application/octet-stream"

    # -- Outbound ----------------------------------------------------------

    def _format_attributed(self, content: str, label: str) -> str:
        label = self.escape_label_for_body(label)
        if "\n" in content:
            return f"{label}:\n{content}"
        return f"{label}: {content}"

    def _chunk_message(self, text: str, limit: int = 4000) -> list[str]:
        if len(text) <= limit:
            return [text]
        chunks = []
        remaining = text
        while remaining:
            cut = remaining.rfind("\n\n", 0, limit)
            if cut == -1:
                cut = remaining.rfind("\n", 0, limit)
            if cut == -1:
                cut = remaining.rfind(" ", 0, limit)
            if cut == -1:
                cut = limit
            chunks.append(remaining[: cut + 1])
            remaining = remaining[cut + 1 :]
        return chunks

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    @staticmethod
    def _text_body(body: str) -> str:
        return json.dumps({"text": body}, ensure_ascii=False)

    @override
    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        try:
            body = self._format_attributed(content, sender_name)
            first_ref: str | None = None
            for index, chunk in enumerate(self._chunk_message(body)):
                rendered = self._text_body(self._render_outbound(chunk))
                if thread_root_id and index == 0:
                    data = await self._api(
                        "POST",
                        f"/open-apis/im/v1/messages/{thread_root_id}/reply",
                        json_body={
                            "content": rendered,
                            "msg_type": "text",
                            "reply_in_thread": True,
                        },
                    )
                else:
                    data = await self._api(
                        "POST",
                        "/open-apis/im/v1/messages",
                        json_body={
                            "receive_id_type": "chat_id",
                            "receive_id": channel_id,
                            "content": rendered,
                            "msg_type": "text",
                        },
                    )
                message_id = data.get("message_id")
                if not message_id:
                    logger.error("Lark send response missing message_id: %s", data)
                    return None
                if first_ref is None:
                    first_ref = str(message_id)
            return first_ref
        except LarkApiError as e:
            logger.error("Lark send failed: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error sending Lark message")
            return None

    @override
    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._api(
                "PATCH",
                f"/open-apis/im/v1/messages/{message_ref}",
                json_body={
                    "content": self._text_body(self._render_outbound(new_content))
                },
            )
        except LarkApiError as e:
            logger.error("Lark edit failed: %s", e)
            raise BridgeOperationError(f"Failed to edit message: {e}") from e

    @override
    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._api("DELETE", f"/open-apis/im/v1/messages/{message_ref}")
        except LarkApiError as e:
            logger.error("Lark delete failed: %s", e)
            raise BridgeOperationError(f"Failed to delete message: {e}") from e

    @override
    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        logger.debug("Lark has no typing indicator to send")

    @override
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
        if len(data) > self._max_attachment_bytes:
            logger.error(
                "Lark attachment %s exceeds maximum size of %d bytes",
                filename,
                self._max_attachment_bytes,
            )
            return None
        try:
            if caption:
                await self.send_message(
                    channel_id,
                    sender_name,
                    caption,
                    thread_root_id=thread_root_id,
                )
            token = await self._ensure_token()
            client = await self._get_client()
            headers = {"Authorization": f"Bearer {token}"}
            if mimetype.startswith("image/"):
                resp = await client.post(
                    self._config.api_base_url.rstrip("/") + "/open-apis/im/v1/images",
                    headers=headers,
                    files={"image": (filename, data, mimetype)},
                    data={"image_type": "message"},
                    timeout=60.0,
                )
                uploaded = self._parse_api_response(resp)
                content = json.dumps({"image_key": uploaded.get("image_key")})
                msg_type = "image"
            else:
                resp = await client.post(
                    self._config.api_base_url.rstrip("/") + "/open-apis/im/v1/files",
                    headers=headers,
                    files={"file": (filename, data, mimetype)},
                    data={"file_type": "stream", "file_name": filename},
                    timeout=60.0,
                )
                uploaded = self._parse_api_response(resp)
                content = json.dumps({"file_key": uploaded.get("file_key")})
                msg_type = "file"
            if thread_root_id:
                sent = await self._api(
                    "POST",
                    f"/open-apis/im/v1/messages/{thread_root_id}/reply",
                    json_body={
                        "content": content,
                        "msg_type": msg_type,
                        "reply_in_thread": True,
                    },
                )
            else:
                sent = await self._api(
                    "POST",
                    "/open-apis/im/v1/messages",
                    json_body={
                        "receive_id_type": "chat_id",
                        "receive_id": channel_id,
                        "content": content,
                        "msg_type": msg_type,
                    },
                )
            message_id = sent.get("message_id")
            return str(message_id) if message_id else None
        except LarkApiError as e:
            logger.error("Lark send attachment failed: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error sending Lark attachment")
            return None

    @override
    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        try:
            data = await self._api(
                "POST",
                "/open-apis/im/v1/chats",
                json_body={"name": name, "chat_mode": "group"},
            )
        except LarkApiError as e:
            raise BridgeOperationError(f"Failed to create chat: {e}") from e
        chat_id = data.get("chat_id")
        if not chat_id:
            raise BridgeOperationError("Lark create chat returned no chat id")
        return str(chat_id)

    @override
    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            await self._api("DELETE", f"/open-apis/im/v1/chats/{external_channel_id}")
            return RetireOutcome(outcome="deleted")
        except LarkApiError as e:
            logger.warning("Lark chat delete failed for %s: %s", external_channel_id, e)
            return RetireOutcome.failed(str(e))

    @override
    async def get_channel_type(self, channel_id: str) -> ChannelType:
        try:
            data = await self._api("GET", f"/open-apis/im/v1/chats/{channel_id}")
        except LarkApiError as e:
            raise BridgeOperationError(f"Failed to read chat type: {e}") from e
        chat_mode = data.get("chat_mode")
        if chat_mode == "p2p":
            return "direct"
        if chat_mode in ("group", "topic"):
            return "channel_private"
        raise BridgeOperationError(f"Unknown Lark chat mode: {chat_mode!r}")

    @override
    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        if not user_external_ids:
            return []
        try:
            await self._api(
                "PATCH",
                f"/open-apis/im/v1/chats/{channel_id}/members",
                json_body={
                    "id_list": user_external_ids,
                    "member_id_type": "open_id",
                },
            )
            return []
        except LarkApiError as e:
            logger.warning("Lark add members failed for %s: %s", channel_id, e)
            return list(user_external_ids)

    @override
    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    @override
    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    @override
    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    @override
    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    @override
    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        return None

    @override
    async def home_deeplink(self) -> str | None:
        return None

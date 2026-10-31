from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import re
import time
from collections.abc import Awaitable, Callable
from html.parser import HTMLParser
from typing import Any, ClassVar, Literal
from urllib.parse import urlsplit

import httpx
import markdown
from pydantic import Field

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

_API_HOSTS = {
    "lark": "https://open.larksuite.com",
    "feishu": "https://open.feishu.cn",
}
_MAX_MESSAGE = 4000
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024


class LarkConnectionConfig(BridgeConnectionConfig):
    app_id: str = Field(min_length=1, description="Custom app App ID")
    app_secret: str = Field(min_length=1, description="Custom app App Secret")
    verification_token: str = Field(
        min_length=1,
        description="Verification Token from the app's event subscription settings",
    )
    encrypt_key: str | None = Field(
        default=None,
        description="Optional Encrypt Key when encrypted event delivery is enabled",
        json_schema_extra={"format": "password"},
    )
    region: Literal["lark", "feishu"] = Field(
        default="lark", description="Use Lark or Feishu Open Platform endpoints"
    )


def _json_object(body: bytes) -> dict[str, Any]:
    try:
        result = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WebhookPayloadError("Lark sent an unreadable JSON event") from exc
    if not isinstance(result, dict):
        raise WebhookPayloadError("Lark event must be a JSON object")
    return result


def _decrypt_event(value: str, encrypt_key: str) -> dict[str, Any]:
    """Decrypt the AES-CBC event envelope used by Lark's webhook delivery."""
    try:
        from cryptography.hazmat.primitives import padding
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        ciphertext = base64.b64decode(value, validate=True)
        key = hashlib.sha256(encrypt_key.encode("utf-8")).digest()
        decryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).decryptor()
        padded = decryptor.update(ciphertext) + decryptor.finalize()
        unpadder = padding.PKCS7(algorithms.AES.block_size).unpadder()
        plaintext = unpadder.update(padded) + unpadder.finalize()
        # The first 16 bytes are random bytes added by Lark before encryption.
        return _json_object(plaintext[16:])
    except (ValueError, TypeError) as exc:
        raise WebhookAuthenticityError("Lark event could not be decrypted") from exc


def _body(config: LarkConnectionConfig, raw: bytes) -> dict[str, Any]:
    envelope = _json_object(raw)
    encrypted = envelope.get("encrypt")
    if encrypted is None:
        return envelope
    if not config.encrypt_key:
        raise WebhookAuthenticityError(
            "Lark sent an encrypted event but no Encrypt Key is configured"
        )
    if not isinstance(encrypted, str):
        raise WebhookPayloadError("Lark encrypted event has an invalid envelope")
    return _decrypt_event(encrypted, config.encrypt_key)


def _text_content(message: dict[str, Any]) -> str:
    raw = message.get("content")
    if not isinstance(raw, str):
        return ""
    try:
        content = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if not isinstance(content, dict):
        return ""
    msg_type = message.get("message_type") or message.get("msg_type")
    if msg_type == "text":
        text = str(content.get("text", ""))
        return re.sub(r"<at\b[^>]*>(.*?)</at>", r"@\1", text, flags=re.IGNORECASE)
    if msg_type == "post":
        # Lark rich text is nested paragraphs containing text and mention nodes.
        def walk(node: Any) -> str:
            if isinstance(node, dict):
                if node.get("tag") == "text":
                    return str(node.get("text", ""))
                elif node.get("tag") == "at":
                    return "@" + str(node.get("user_name", ""))
                return "".join(walk(item) for item in node.values())
            if isinstance(node, list):
                return "".join(walk(item) for item in node)
            return ""

        rows = content.get("content")
        if isinstance(rows, list):
            return "\n".join(walk(row) for row in rows)
        return walk(content)
    if msg_type in {"image", "file", "audio", "media", "sticker"}:
        return f"[{msg_type} attachment]"
    return str(content.get("text", ""))


class _PostParser(HTMLParser):
    """Turn the small Markdown subset into Lark rich-text post elements."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[dict[str, Any]]] = [[]]
        self.styles: list[str] = []
        self.href: str | None = None

    def _break(self) -> None:
        if self.rows[-1]:
            self.rows.append([])

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"p", "li", "h1", "h2", "h3", "pre"}:
            self._break()
        if tag in {"strong", "b"}:
            self.styles.append("bold")
        elif tag in {"em", "i"}:
            self.styles.append("italic")
        elif tag == "code":
            self.styles.append("inline_code")
        elif tag == "a":
            candidate = dict(attrs).get("href")
            parsed = urlsplit(candidate or "")
            self.href = candidate if parsed.scheme in {"http", "https"} else None

    def handle_endtag(self, tag: str) -> None:
        if tag in {"p", "li", "h1", "h2", "h3", "pre", "br"}:
            self._break()
        elif tag in {"strong", "b"}:
            self._pop_style("bold")
        elif tag in {"em", "i"}:
            self._pop_style("italic")
        elif tag == "code":
            self._pop_style("inline_code")
        elif tag == "a":
            self.href = None

    def _pop_style(self, style: str) -> None:
        if style in self.styles:
            self.styles.remove(style)

    def handle_data(self, data: str) -> None:
        if not data:
            return
        if self.href:
            self.rows[-1].append({"tag": "a", "text": data, "href": self.href})
        else:
            element: dict[str, Any] = {"tag": "text", "text": data}
            if self.styles:
                element["style"] = list(self.styles)
            self.rows[-1].append(element)


def _post_content(text: str) -> str:
    parser = _PostParser()
    parser.feed(markdown.markdown(text, extensions=["fenced_code"]))
    rows = [row for row in parser.rows if row]
    if not rows:
        rows = [[{"tag": "text", "text": ""}]]
    return json.dumps({"zh_cn": {"title": "", "content": rows}}, ensure_ascii=False)


class LarkAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Lark / Feishu"
    docs_slug: ClassVar[str | None] = "lark"
    receives_webhooks: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True

    def __init__(self, *, config: LarkConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._http = httpx.AsyncClient(base_url=_API_HOSTS[config.region], timeout=15)
        self._tenant_token: str | None = None
        self._tenant_token_expires_at = 0.0

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = LarkConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(
            base_url=_API_HOSTS[config.region], timeout=15
        ) as client:
            try:
                response = await client.post(
                    "/open-apis/auth/v3/tenant_access_token/internal",
                    json={"app_id": config.app_id, "app_secret": config.app_secret},
                )
                response.raise_for_status()
                result = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise BridgeCredentialError(
                    f"Could not verify Lark app credentials: {exc}"
                ) from exc
        if result.get("code") != 0 or not result.get("tenant_access_token"):
            raise BridgeCredentialError(
                f"Lark rejected the App ID or App Secret: {result.get('msg', 'unknown error')}"
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.TimeoutException | httpx.NetworkError):
            return "network"
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in {
            401,
            403,
        }:
            return "auth_failed"
        if isinstance(exc, httpx.HTTPError | BridgeOperationError):
            return "platform_error"
        return None

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        base_headers = dict(kwargs.pop("headers", {}))
        for attempt in range(2):
            headers = {
                **base_headers,
                "Authorization": f"Bearer {await self._ensure_token()}",
            }
            try:
                response = await self._http.request(
                    method, path, headers=headers, **kwargs
                )
                if response.status_code == 401 and attempt == 0:
                    self._tenant_token = None
                    self._tenant_token_expires_at = 0
                    continue
                response.raise_for_status()
                result = response.json()
                break
            except (httpx.HTTPError, ValueError):
                raise
        if result.get("code") != 0:
            raise BridgeOperationError(
                f"Lark API refused the request: {result.get('msg', result.get('code'))}"
            )
        return result.get("data") or {}

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
        # Verify on each pod, but webhooks are served by every pod and all
        # delivery state is kept in the shared event receipt store.
        if self._listening:
            await self._request("GET", "/open-apis/bot/v3/info")

    async def stop(self) -> None:
        await self._http.aclose()

    async def verify_webhook(self, request: WebhookRequest) -> None:
        try:
            envelope = _body(self._config, request.body)
        except WebhookAuthenticityError:
            raise
        token = envelope.get("token")
        header = envelope.get("header")
        if isinstance(header, dict):
            token = header.get("token", token)
        if not isinstance(token, str) or not hmac.compare_digest(
            token, self._config.verification_token
        ):
            raise WebhookAuthenticityError("Lark verification token did not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        envelope = _body(self._config, request.body)
        challenge = envelope.get("challenge")
        if isinstance(challenge, str):
            # The route echoes handshake as plain text. Lark's URL validation
            # expects a JSON object, so the event route recognizes this special
            # case in its own envelope payload at dispatch time is not viable.
            # Return the raw challenge; documented setup can validate via URL.
            return InboundWebhook(
                envelope_type="url_verification",
                payload={"challenge": challenge},
                handshake=json.dumps({"challenge": challenge}),
                external_event_id=None,
                delivery_attempt=0,
                answers_inline=False,
            )
        header = envelope.get("header") or {}
        event_id = header.get("event_id") if isinstance(header, dict) else None
        legacy_id = envelope.get("uuid")
        event_type = (
            header.get("event_type")
            if isinstance(header, dict)
            else envelope.get("type")
        )
        return InboundWebhook(
            envelope_type=str(event_type or "unknown"),
            payload=envelope,
            handshake=None,
            external_event_id=str(event_id or legacy_id)
            if event_id or legacy_id
            else None,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        event = payload.get("event") or {}
        if envelope_type in {"im.message.recalled_v1", "im.message.deleted_v1"}:
            # Lark can notify recalls, but the common bridge does not have a
            # reversible mapping for every message type. Visible refusal is
            # documented until recall callbacks are available here.
            return
        if envelope_type not in {"im.message.receive_v1", "event_callback"}:
            return
        message = event.get("message") or {}
        sender = event.get("sender") or {}
        sender_ids = sender.get("sender_id") or {}
        sender_id = (
            sender_ids.get("open_id")
            or sender_ids.get("user_id")
            or sender_ids.get("app_id")
            or sender_ids.get("union_id")
        )
        if not isinstance(message, dict) or not isinstance(sender_id, str):
            return
        if sender.get("sender_type") == "app":
            return
        chat_id = message.get("chat_id")
        message_id = message.get("message_id")
        if not chat_id or not message_id:
            return
        text = _text_content(message)
        if message.get("deleted"):
            return
        if not text.strip():
            text = (
                "This message has no readable content. If this room uses "
                "end-to-end encryption, the Lark bot API cannot decrypt it. "
                "Use an unencrypted room for messages Switch needs to read."
            )
        chat_type = "direct" if message.get("chat_type") == "p2p" else "channel_public"
        thread = message.get("root_id") or message.get("parent_id")
        sender_name = str(sender.get("name") or sender_id)
        if text.startswith("!"):
            match = re.match(r"^!([\w-]+)(?:\s+(.*))?$", text, re.DOTALL)
            if match and self._on_command is not None:
                await self._on_command(
                    InboundCommand(
                        channel_id=str(chat_id),
                        channel_type=chat_type,
                        sender_id=str(sender_id),
                        sender_name=sender_name,
                        command=match.group(1),
                        args=match.group(2) or "",
                        message_ref=str(message_id),
                        root_id=str(thread) if thread else None,
                    )
                )
                return
        if self._on_message is not None:
            attachments: list[Attachment] = []
            failures: list[AttachmentFailure] = []
            raw_content: dict[str, Any] = {}
            try:
                decoded = json.loads(message.get("content") or "{}")
                if isinstance(decoded, dict):
                    raw_content = decoded
            except (TypeError, json.JSONDecodeError):
                pass
            key_name = (
                "image_key" if message.get("message_type") == "image" else "file_key"
            )
            resource_key = raw_content.get(key_name)
            if isinstance(resource_key, str):
                file_name = str(raw_content.get("file_name") or f"lark-{resource_key}")
                try:
                    attachments.append(
                        await self._download_attachment(
                            str(message_id),
                            resource_key,
                            file_name,
                            "image" if key_name == "image_key" else "file",
                        )
                    )
                except (BridgeCredentialError, BridgeOperationError, ValueError) as exc:
                    failures.append(
                        AttachmentFailure(filename=file_name, reason=str(exc))
                    )
            await self._on_message(
                InboundMessage(
                    channel_id=str(chat_id),
                    channel_type=chat_type,
                    sender_id=str(sender_id),
                    sender_name=sender_name,
                    content=text,
                    message_ref=str(message_id),
                    root_id=str(thread) if thread else None,
                    channel_name=str(message.get("chat_name") or "") or None,
                    attachments=attachments,
                    attachment_failures=failures,
                )
            )

    async def _ensure_token(self) -> str:
        if (
            self._tenant_token is None
            or time.monotonic() >= self._tenant_token_expires_at
        ):
            try:
                response = await self._http.post(
                    "/open-apis/auth/v3/tenant_access_token/internal",
                    json={
                        "app_id": self._config.app_id,
                        "app_secret": self._config.app_secret,
                    },
                )
                response.raise_for_status()
                result = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise BridgeCredentialError(
                    f"Lark authentication failed: {exc}"
                ) from exc
            if result.get("code") != 0 or not result.get("tenant_access_token"):
                raise BridgeCredentialError(
                    f"Lark rejected the app credentials: {result.get('msg', 'unknown error')}"
                )
            self._tenant_token = str(result["tenant_access_token"])
            try:
                lifetime = max(60, int(result.get("expire", 7200)))
            except (TypeError, ValueError):
                lifetime = 7200
            self._tenant_token_expires_at = time.monotonic() + lifetime - 60
        return self._tenant_token

    async def _download_attachment(
        self, message_id: str, file_key: str, filename: str, resource_type: str
    ) -> Attachment:
        token = await self._ensure_token()
        path = f"/open-apis/im/v1/messages/{message_id}/resources/{file_key}"
        chunks: list[bytes] = []
        total = 0
        try:
            async with self._http.stream(
                "GET",
                path,
                params={"type": resource_type},
                headers={"Authorization": f"Bearer {token}"},
            ) as response:
                response.raise_for_status()
                async for part in response.aiter_bytes():
                    total += len(part)
                    if total > self._max_attachment_bytes:
                        raise ValueError("file exceeds Switch's attachment size limit")
                    chunks.append(part)
                mime = response.headers.get("content-type")
        except httpx.HTTPError as exc:
            raise ValueError(f"could not download from Lark: {exc}") from exc
        if not mime:
            mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return Attachment(filename=filename, mimetype=mime, data=b"".join(chunks))

    async def _send(
        self, channel_id: str, content: str, thread_root_id: str | None = None
    ) -> str | None:
        chunks = _chunks(content)
        first_ref: str | None = None
        for chunk in chunks:
            content_json = _post_content(chunk)
            if thread_root_id:
                data = await self._request(
                    "POST",
                    f"/open-apis/im/v1/messages/{thread_root_id}/reply",
                    json={
                        "msg_type": "post",
                        "content": content_json,
                        "reply_in_thread": True,
                    },
                )
            else:
                data = await self._request(
                    "POST",
                    "/open-apis/im/v1/messages",
                    params={"receive_id_type": "chat_id"},
                    json={
                        "receive_id": channel_id,
                        "msg_type": "post",
                        "content": content_json,
                    },
                )
            message = data.get("message") or {}
            ref = message.get("message_id")
            if first_ref is None and ref:
                first_ref = str(ref)
        return first_ref

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        agent = await self.agent_rendering(sender_name)
        return await self._send(
            channel_id, f"**{agent.body_label}**\n{content}", thread_root_id
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
        return await self._send(
            channel_id, self.translate_outbound(content), thread_root_id
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._request(
            "PATCH",
            f"/open-apis/im/v1/messages/{message_ref}",
            json={"msg_type": "post", "content": _post_content(new_content)},
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._request("DELETE", f"/open-apis/im/v1/messages/{message_ref}")

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def _render_outbound(self, content: str) -> str:
        return content

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        if channel_type not in {"channel_public", "channel_private"}:
            raise ChannelCreationUnsupported(
                "Lark only supports creating group chats from Switch."
            )
        data = await self._request(
            "POST",
            "/open-apis/im/v1/chats",
            params={"user_id_type": "open_id"},
            json={
                "name": name,
                "description": topic,
                "chat_mode": "group",
                "chat_type": "public"
                if channel_type == "channel_public"
                else "private",
                "group_message_type": "chat",
            },
        )
        chat_id = data.get("chat_id")
        if not chat_id:
            raise BridgeOperationError(
                "Lark created a group without returning its chat ID."
            )
        return str(chat_id)

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        data = await self._request("GET", f"/open-apis/im/v1/chats/{channel_id}")
        chat_type = (data.get("chat") or {}).get("chat_type")
        return "channel_public" if chat_type == "public" else "channel_private"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        if not user_external_ids:
            return []
        try:
            data = await self._request(
                "POST",
                f"/open-apis/im/v1/chats/{channel_id}/members",
                params={"member_id_type": "open_id"},
                json={"id_list": user_external_ids},
            )
        except BridgeOperationError:
            return list(user_external_ids)
        invalid_ids = (
            data.get("invalid_user_id_list") or data.get("invalid_id_list") or []
        )
        return [str(user_id) for user_id in invalid_ids]

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        *,
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        upload_limit = min(self._max_attachment_bytes, _MAX_UPLOAD_BYTES)
        if len(data) > upload_limit:
            agent = await self.agent_rendering(sender_name)
            return await self._send(
                channel_id,
                f"**{agent.body_label}** could not upload {filename}: Lark attachments "
                f"are limited to {upload_limit} bytes by this Switch deployment.",
                thread_root_id,
            )
        uploaded = await self._request(
            "POST",
            "/open-apis/im/v1/files",
            data={"file_type": "stream", "file_name": filename},
            files={"file": (filename, data, mimetype)},
        )
        file_key = uploaded.get("file_key")
        if not file_key:
            raise BridgeOperationError(
                "Lark uploaded the attachment without returning a file key."
            )
        content = json.dumps({"file_key": file_key}, ensure_ascii=False)
        if thread_root_id:
            result = await self._request(
                "POST",
                f"/open-apis/im/v1/messages/{thread_root_id}/reply",
                json={"msg_type": "file", "content": content, "reply_in_thread": True},
            )
        else:
            result = await self._request(
                "POST",
                "/open-apis/im/v1/messages",
                params={"receive_id_type": "chat_id"},
                json={"receive_id": channel_id, "msg_type": "file", "content": content},
            )
        message = result.get("message") or {}
        agent = await self.agent_rendering(sender_name)
        description = f"**{agent.body_label}** shared {filename}"
        if caption:
            description = f"{description}: {caption}"
        await self._send(channel_id, description, thread_root_id)
        return str(message.get("message_id")) if message.get("message_id") else None


def _chunks(text: str, limit: int = _MAX_MESSAGE) -> list[str]:
    """Split at paragraph/word boundaries while respecting the API limit."""
    chunks: list[str] = []
    while len(text) > limit:
        boundary = text.rfind("\n", 0, limit)
        if boundary < limit // 2:
            boundary = text.rfind(" ", 0, limit)
        if boundary < limit // 2:
            boundary = limit - 1
        split_at = boundary + 1
        chunks.append(text[:split_at])
        text = text[split_at:]
    if text or not chunks:
        chunks.append(text)
    return chunks

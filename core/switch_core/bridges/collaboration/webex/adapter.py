"""Cisco Webex collaboration bridge adapter."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
)
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
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.webex.chunking import chunk_message

logger = logging.getLogger(__name__)

WEBEX_API_BASE = "https://webexapis.com/v1"
MAX_FILE_BYTES = 100 * 1024 * 1024  # 100 MB
_WEBEX_FILE_DOMAINS = ("webex.com", "webexapis.com", "ciscospark.com", "wbx2.com")


class WebexConnectionConfig(BridgeConnectionConfig):
    bot_token: str = Field(
        title="Bot Access Token",
        description="The Webex Bot Access Token from developer.webex.com",
        json_schema_extra={"format": "password"},
    )
    webhook_secret: str = Field(
        title="Webhook Secret",
        description="Secret string used to verify incoming Webex webhook HMAC signatures",
        json_schema_extra={"format": "password"},
    )
    bot_email: str | None = Field(
        default=None,
        title="Bot Email",
        description="Optional bot email address for explicit mention stripping",
    )


class WebexAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Cisco Webex"
    docs_slug: ClassVar[str | None] = "webex"
    receives_webhooks: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = False
    draws_session_activity: ClassVar[bool] = False

    def __init__(self, *, config: WebexConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self.bot_id: str | None = None
        self.bot_email: str | None = config.bot_email
        self.bot_name: str | None = None
        self._client: httpx.AsyncClient | None = None

        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self._on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]] | None = (
            None
        )
        self._on_user_joined: Callable[[InboundUserJoin], Awaitable[None]] | None = None
        self._on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=WEBEX_API_BASE,
                headers={
                    "Authorization": f"Bearer {self.config.bot_token}",
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
        return self._client

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, BridgeCredentialError):
            return "auth_failed"
        if isinstance(exc, BridgeOperationError):
            return "platform_error"
        if isinstance(exc, httpx.HTTPStatusError):
            if exc.response.status_code in (401, 403):
                return "auth_failed"
            if exc.response.status_code == 429:
                return "network"
            if 400 <= exc.response.status_code < 500:
                return "config_invalid"
            return "platform_error"
        if isinstance(exc, httpx.RequestError):
            return "network"
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        token = str(connection_config.get("bot_token", "")).strip()
        if not token:
            raise BridgeCredentialError("Missing Webex Bot Access Token")
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(base_url=WEBEX_API_BASE) as client:
            try:
                resp = await client.get("/people/me", headers=headers)
                if resp.status_code in (401, 403):
                    raise BridgeCredentialError("Invalid Webex Bot Access Token")
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code in (401, 403):
                    raise BridgeCredentialError(
                        "Invalid Webex Bot Access Token"
                    ) from exc
                raise BridgeCredentialError(
                    f"Webex API verification failed: {exc}"
                ) from exc
            except httpx.RequestError as exc:
                raise BridgeCredentialError(
                    f"Cannot connect to Webex API: {exc}"
                ) from exc

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

        try:
            resp = await self.client.get("/people/me")
            if resp.status_code in (401, 403):
                raise BridgeCredentialError("Invalid Webex Bot Access Token")
            resp.raise_for_status()
            me = resp.json()
            self.bot_id = me.get("id")
            if not self.bot_email and me.get("emails"):
                self.bot_email = me["emails"][0]
            self.bot_name = me.get("displayName")
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (401, 403):
                raise BridgeCredentialError("Invalid Webex Bot Access Token") from exc
            raise BridgeOperationError(
                f"Webex API error during startup: {exc}"
            ) from exc
        except httpx.RequestError as exc:
            raise BridgeOperationError(f"Cannot connect to Webex API: {exc}") from exc

    async def stop(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def verify_webhook(self, request: WebhookRequest) -> None:
        """Verify HMAC signature against unmodified request bytes using Webex or Spark headers."""
        headers_lower = {k.lower(): v for k, v in request.headers.items()}
        webex_sig = headers_lower.get("x-webex-signature")
        spark_sig = headers_lower.get("x-spark-signature")

        if not webex_sig and not spark_sig:
            raise WebhookAuthenticityError("Missing Webex signature header")

        secret_bytes = self.config.webhook_secret.encode("utf-8")

        # 1. Check modern X-Webex-Signature (SHA-256 or SHA-512)
        if webex_sig:
            sig_val = webex_sig.strip()
            algo = hashlib.sha256
            if "=" in sig_val:
                algo_prefix, raw_hex = sig_val.split("=", 1)
                algo_prefix = algo_prefix.lower()
                if algo_prefix == "sha512":
                    algo = hashlib.sha512
                elif algo_prefix == "sha256":
                    algo = hashlib.sha256
                sig_val = raw_hex

            expected_hex = hmac.new(secret_bytes, request.body, algo).hexdigest()
            if hmac.compare_digest(sig_val.lower(), expected_hex.lower()):
                return

        # 2. Check legacy X-Spark-Signature (SHA-1)
        if spark_sig:
            expected_spark = hmac.new(
                secret_bytes, request.body, hashlib.sha1
            ).hexdigest()
            if hmac.compare_digest(spark_sig.strip().lower(), expected_spark.lower()):
                return

        raise WebhookAuthenticityError("Invalid Webex webhook signature")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            payload = json.loads(request.body)
        except ValueError as exc:
            raise WebhookPayloadError("Webex webhook body is not valid JSON") from exc

        if not isinstance(payload, dict):
            raise WebhookPayloadError("Webex webhook payload must be a JSON object")

        resource = str(payload.get("resource", "unknown"))
        event = str(payload.get("event", "unknown"))
        data = payload.get("data")
        data_id = str(data["id"]) if isinstance(data, dict) and "id" in data else None

        # Build stable event identity for deduplication (avoid top-level payload['id'] which is webhook subscription ID)
        event_time = (
            payload.get("created")
            or (data.get("updated") if isinstance(data, dict) else None)
            or ""
        )
        if event == "updated" and data_id and event_time:
            external_event_id = f"{resource}:{event}:{data_id}:{event_time}"
        elif data_id:
            external_event_id = f"{resource}:{event}:{data_id}"
        else:
            external_event_id = None

        return InboundWebhook(
            envelope_type=resource,
            payload=payload,
            handshake=None,
            external_event_id=external_event_id,
            delivery_attempt=0,
            answers_inline=False,
        )

    def _strip_bot_mentions(self, text: str) -> str:
        """Strip Webex mention tags targeting the bot."""
        cleaned = text
        if self.bot_id:
            cleaned = re.sub(
                rf"<@personId:{re.escape(self.bot_id)}(\|[^>]*)?>", "", cleaned
            )
        if self.bot_email:
            cleaned = re.sub(
                rf"<@personEmail:{re.escape(self.bot_email)}(\|[^>]*)?>", "", cleaned
            )
        if self.bot_name:
            cleaned = re.sub(rf"@{re.escape(self.bot_name)}\b", "", cleaned)
        return cleaned.strip()

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        resource = payload.get("resource")
        event = payload.get("event")
        data = payload.get("data", {})
        actor_id = payload.get("actorId")

        # Skip actions originated by the bot itself
        if actor_id == self.bot_id or (
            isinstance(data, dict) and data.get("personId") == self.bot_id
        ):
            return None

        if resource == "messages" and event == "created" and isinstance(data, dict):
            msg_id = data.get("id")
            if not msg_id:
                return None
            try:
                resp = await self.client.get(f"/messages/{msg_id}")
                resp.raise_for_status()
                msg = resp.json()
            except Exception as exc:
                logger.warning("Failed to fetch Webex message %s: %s", msg_id, exc)
                return None

            if msg.get("personId") == self.bot_id:
                return None

            raw_text = msg.get("markdown") or msg.get("text") or ""
            content = self._strip_bot_mentions(raw_text)

            channel_id = msg.get("roomId", "")
            channel_type: ChannelType = (
                "direct"
                if msg.get("roomType") == "direct"
                else "channel_public"
            )
            sender_id = msg.get("personId", "")
            sender_name = msg.get("personEmail", "").split("@")[0] or sender_id
            thread_root_id = msg.get("parentId")

            # Parse file attachments
            inbound_attachments: list[Attachment] = []
            attachment_failures: list[AttachmentFailure] = []
            for file_url in msg.get("files", []):
                # SSRF prevention: ensure host belongs to Webex domains
                parts = urlsplit(file_url)
                host = (parts.hostname or "").lower()
                if parts.scheme != "https" or not any(
                    host == domain or host.endswith(f".{domain}")
                    for domain in _WEBEX_FILE_DOMAINS
                ):
                    attachment_failures.append(
                        AttachmentFailure(
                            filename=file_url.split("/")[-1].split("?")[0]
                            or "attachment",
                            reason=f"Rejected untrusted file URL host: {host}",
                        )
                    )
                    continue

                try:
                    file_resp = await self.client.get(file_url)
                    file_resp.raise_for_status()
                    data_bytes = file_resp.content
                    if len(data_bytes) > MAX_FILE_BYTES:
                        attachment_failures.append(
                            AttachmentFailure(
                                filename=file_url.split("/")[-1].split("?")[0]
                                or "attachment",
                                reason=f"{len(data_bytes)} bytes exceeds limit",
                            )
                        )
                        continue
                    cd = file_resp.headers.get("content-disposition", "")
                    filename = "attachment"
                    if "filename=" in cd:
                        filename = cd.split("filename=")[-1].strip("\"'")
                    else:
                        filename = file_url.split("/")[-1].split("?")[0] or "attachment"
                    mimetype = file_resp.headers.get(
                        "content-type", "application/octet-stream"
                    )
                    inbound_attachments.append(
                        Attachment(
                            filename=filename,
                            mimetype=mimetype,
                            data=data_bytes,
                        )
                    )
                except Exception as exc:
                    attachment_failures.append(
                        AttachmentFailure(
                            filename=file_url.split("/")[-1].split("?")[0]
                            or "attachment",
                            reason=f"Download failed: {exc}",
                        )
                    )

            # Check if this is a command
            if content.startswith("!") and self._on_command:
                parts = content[1:].split(None, 1)
                cmd_name = parts[0] if parts else ""
                cmd_args = parts[1] if len(parts) > 1 else ""
                await self._on_command(
                    InboundCommand(
                        channel_id=channel_id,
                        channel_type=channel_type,
                        sender_id=sender_id,
                        sender_name=sender_name,
                        command=cmd_name,
                        args=cmd_args,
                        message_ref=msg_id,
                        root_id=thread_root_id,
                    )
                )
            elif self._on_message:
                await self._on_message(
                    InboundMessage(
                        channel_id=channel_id,
                        channel_type=channel_type,
                        sender_id=sender_id,
                        sender_name=sender_name,
                        content=content,
                        message_ref=msg_id,
                        root_id=thread_root_id,
                        attachments=inbound_attachments,
                        attachment_failures=attachment_failures,
                    )
                )

        elif (
            resource == "attachmentActions"
            and event == "created"
            and isinstance(data, dict)
        ):
            action_id = data.get("id")
            if not action_id:
                return None
            try:
                # Verified Webex API endpoint: /v1/attachment/actions/{id}
                resp = await self.client.get(f"/attachment/actions/{action_id}")
                resp.raise_for_status()
                action = resp.json()
            except Exception as exc:
                logger.warning(
                    "Failed to fetch Webex attachment/action %s: %s", action_id, exc
                )
                return None

            inputs = action.get("inputs", {})
            channel_id = action.get("roomId", "")
            sender_id = action.get("personId", "")
            message_id = action.get("messageId", "")

            action_name = inputs.get("action_id") or inputs.get("action")
            action_value = inputs.get("value") or json.dumps(inputs)
            if self._on_interaction:
                await self._on_interaction(
                    InboundInteraction(
                        channel_id=channel_id,
                        sender_id=sender_id,
                        sender_name=sender_id,
                        action_id=str(action_name or "submit"),
                        value=str(action_value),
                        message_ref=message_id,
                    )
                )
            elif action_name and self._on_command:
                await self._on_command(
                    InboundCommand(
                        channel_id=channel_id,
                        channel_type="channel_public",
                        sender_id=sender_id,
                        sender_name=sender_id,
                        command=str(action_name),
                        args=json.dumps(inputs),
                        message_ref=message_id,
                    )
                )

        elif (
            resource == "memberships" and event == "created" and isinstance(data, dict)
        ):
            channel_id = data.get("roomId", "")
            person_id = data.get("personId", "")
            person_email = data.get("personEmail", "")
            membership_channel_type: ChannelType = (
                "direct"
                if data.get("roomType") == "direct"
                else "channel_public"
            )
            if person_id == self.bot_id and self._on_app_joined:
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=channel_id,
                        channel_type=membership_channel_type,
                    )
                )
            elif self._on_user_joined:
                await self._on_user_joined(
                    InboundUserJoin(
                        channel_id=channel_id,
                        channel_type=membership_channel_type,
                        external_user_id=person_id,
                        external_username=person_email.split("@")[0] or person_id,
                    )
                )

        return None

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        chunks = chunk_message(content)
        first_msg_id: str | None = None

        for idx, chunk in enumerate(chunks):
            text_body = f"**[{sender_name}]** {chunk}" if idx == 0 else chunk
            payload: dict[str, Any] = {
                "roomId": channel_id,
                "markdown": text_body,
            }
            if thread_root_id:
                payload["parentId"] = thread_root_id

            resp = await self.client.post("/messages", json=payload)
            resp.raise_for_status()
            res_json = resp.json()
            if first_msg_id is None:
                first_msg_id = res_json.get("id")

        return first_msg_id

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
        if len(data) > MAX_FILE_BYTES:
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption=caption,
                thread_root_id=thread_root_id,
            )

        form_data: dict[str, Any] = {"roomId": channel_id}
        text_body = (
            f"**[{sender_name}]** {caption}" if caption else f"**[{sender_name}]**"
        )
        form_data["markdown"] = text_body
        if thread_root_id:
            form_data["parentId"] = thread_root_id

        files = {
            "files": (filename, data, mimetype),
        }
        resp = await self.client.post("/messages", data=form_data, files=files)
        resp.raise_for_status()
        res_json = resp.json()
        msg_id = res_json.get("id")
        return str(msg_id) if msg_id is not None else None

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        # Webex API does not support editing standard bot text messages.
        logger.debug(
            "Webex plain text message edit unsupported by platform (ref: %s)",
            message_ref,
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        resp = await self.client.delete(f"/messages/{message_ref}")
        if resp.status_code != 404:
            resp.raise_for_status()

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        payload = {"title": name}
        resp = await self.client.post("/rooms", json=payload)
        resp.raise_for_status()
        room = resp.json()
        return str(room["id"])

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        resp = await self.client.get(f"/rooms/{channel_id}")
        resp.raise_for_status()
        room = resp.json()
        return "direct" if room.get("type") == "direct" else "channel_public"

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
        failed_ids: list[str] = []
        for ext_id in user_external_ids:
            payload: dict[str, Any] = {"roomId": channel_id}
            if "@" in ext_id:
                payload["personEmail"] = ext_id
            else:
                payload["personId"] = ext_id
            try:
                resp = await self.client.post("/memberships", json=payload)
                resp.raise_for_status()
            except Exception as exc:
                logger.warning(
                    "Failed to add user %s to Webex room %s: %s",
                    ext_id,
                    channel_id,
                    exc,
                )
                failed_ids.append(ext_id)
        return failed_ids

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw: Any) -> str:
        return str(raw)

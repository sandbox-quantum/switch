from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import re
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field, ValidationError, field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RichContent,
    RichContentFailed,
    TurnActivity,
    outbound_delivery_state,
)
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    CreatedChannel,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers import MARKDOWN
from switch_core.bridges.collaboration.session.renderers.neutral import (
    request_summary,
    turn_status,
)
from switch_core.outbound import OutboundPolicy, guarded_async_client

from .protocol import (
    MAX_BODY_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    Acknowledgment,
    File,
    Incoming,
    Outgoing,
    signature,
    split_text,
)


class WebhookConnectionConfig(BridgeConnectionConfig):
    outbound_url: str = Field(
        title="Your app's receiver URL",
        description="HTTPS endpoint that implements the webhook v1 contract. HTTP is allowed only on loopback for local development.",
    )
    inbound_token: SkipJsonSchema[str] = Field(default="", repr=False)
    signing_secret: SkipJsonSchema[str] = Field(default="", repr=False)

    @field_validator("outbound_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if (
            not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise ValueError(
                "Receiver URL needs a host and cannot contain credentials, a query or a fragment"
            )
        if parts.scheme != "https" and not (
            parts.scheme == "http"
            and parts.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError(
                "Receiver URL must use HTTPS (or HTTP on loopback for development)"
            )
        return value

    @field_validator("inbound_token", "signing_secret")
    @classmethod
    def valid_secret(cls, value: str) -> str:
        if value and (
            len(value) < 32
            or len(value) > 200
            or not value.isascii()
            or not value.isprintable()
            or any(c.isspace() for c in value)
        ):
            raise ValueError(
                "A webhook secret must be 32–200 ASCII characters without whitespace"
            )
        return value


class WebhookAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Custom app (webhook)"
    receives_webhooks: ClassVar[bool] = True
    confirms_webhook_delivery: ClassVar[bool] = True
    webhook_body_limit: ClassVar[int] = MAX_BODY_BYTES
    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    draws_session_activity: ClassVar[bool] = True
    recovers_uncertain_posts: ClassVar[bool] = True
    carries_publication_marker: ClassVar[bool] = True

    def __init__(self, *, config: WebhookConnectionConfig) -> None:
        super().__init__()
        if not config.inbound_token or not config.signing_secret:
            raise ValueError(
                "Webhook connection is missing its persisted secrets; reconnect it"
            )
        self.config = config
        self._client: httpx.AsyncClient | None = None

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        config = dict(connection_config)
        for key in ("inbound_token", "signing_secret"):
            if not config.get(key):
                config[key] = secrets.token_urlsafe(32)
        return config

    @classmethod
    def setup_values(cls, connection_config: dict[str, object]) -> dict[str, str]:
        return {
            key: str(connection_config[key])
            for key in ("inbound_token", "signing_secret")
        }

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [str(connection_config["outbound_url"])]

    @classmethod
    async def verify_connection(
        cls, connection_config: dict[str, object], policy: OutboundPolicy
    ) -> None:
        adapter = cls(config=WebhookConnectionConfig.model_validate(connection_config))
        try:
            async with guarded_async_client(
                policy, timeout=15, follow_redirects=False
            ) as client:
                await adapter._deliver(
                    client,
                    Outgoing(event_id=uuid.uuid4().hex, type="connection.check"),
                    attempts=1,
                )
        except BridgeOperationError as error:
            raise BridgeCredentialError(str(error)) from error

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        if self.webhook_url is None:
            raise BridgeOperationError(
                "Set MESSAGING_PUBLIC_URL so this app has an inbound webhook address"
            )
        self._on_message, self._on_command = on_message, on_command
        self._on_app_joined = on_app_joined
        self._client = guarded_async_client(
            self.outbound_policy, timeout=15, follow_redirects=False
        )

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _id(self, label: str) -> str:
        return hmac.new(
            self.config.signing_secret.encode(), label.encode(), hashlib.sha256
        ).hexdigest()

    async def _deliver(
        self, client: httpx.AsyncClient, event: Outgoing, *, attempts: int
    ) -> Acknowledgment:
        body = event.model_dump_json().encode()
        for attempt in range(attempts):
            timestamp = str(int(time.time()))
            try:
                async with client.stream(
                    "POST",
                    self.config.outbound_url,
                    content=body,
                    headers={
                        "content-type": "application/json",
                        "x-switch-timestamp": timestamp,
                        "x-switch-signature": signature(
                            self.config.signing_secret, timestamp, body
                        ),
                    },
                ) as response:
                    if response.status_code in (401, 403):
                        raise BridgeOperationError(
                            "The receiver rejected the webhook signature; check its signing secret"
                        )
                    if response.status_code >= 500 or response.status_code == 429:
                        if attempt < attempts - 1:
                            await asyncio.sleep(0.1 * 2**attempt)
                            continue
                    if response.status_code != 200:
                        raise BridgeOperationError(
                            f"The webhook receiver returned HTTP {response.status_code}"
                        )
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 4096:
                            raise BridgeOperationError(
                                "The receiver's acknowledgment exceeds 4096 bytes"
                            )
                    try:
                        ack = Acknowledgment.model_validate_json(bytes(data))
                    except ValidationError:
                        raise BridgeOperationError(
                            "The receiver did not return a webhook v1 acknowledgment"
                        ) from None
                    if ack.event_id != event.event_id:
                        raise BridgeOperationError(
                            "The receiver acknowledged a different event"
                        )
                    return ack
            except httpx.TransportError:
                if attempt == attempts - 1:
                    raise BridgeOperationError(
                        "Could not reach the webhook receiver; check its availability"
                    ) from None
                await asyncio.sleep(0.1 * 2**attempt)
        raise BridgeOperationError("The webhook receiver did not confirm delivery")

    async def _post(
        self, kind: str, *, delivery_id: str | None = None, **fields: Any
    ) -> str:
        if self._client is None:
            raise BridgeOperationError("The webhook connection is stopped")
        scope = outbound_delivery_state()
        if delivery_id is None and scope is not None:
            ordinal = scope[1][0]
            scope[1][0] += 1
            delivery_id = f"{scope[0]}:{ordinal}"
        reference = self._id(delivery_id) if delivery_id else uuid.uuid4().hex
        fields.setdefault("message_id", reference)
        event = Outgoing.model_validate({"event_id": reference, "type": kind, **fields})
        event = event.model_copy(
            update={"event_id": self._id("event:" + event.model_dump_json())}
        )
        await self._deliver(self._client, event, attempts=3)
        assert event.message_id is not None
        return event.message_id

    async def verify_webhook(self, request: WebhookRequest) -> None:
        given = request.headers.get("authorization", "")
        if request.method != "POST" or not hmac.compare_digest(
            given.encode(), f"Bearer {self.config.inbound_token}".encode()
        ):
            raise WebhookAuthenticityError("Webhook token does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if len(request.body) > MAX_BODY_BYTES:
            raise WebhookPayloadError("Webhook exceeds the 8 MiB limit")
        try:
            event = Incoming.model_validate_json(request.body)
        except ValidationError:
            # Validation errors include input values, which may contain private text.
            raise WebhookPayloadError(
                "Invalid webhook v1 event; check its schema and file limits"
            ) from None
        return InboundWebhook(
            envelope_type=event.type,
            payload=event.model_dump(),
            handshake=None,
            external_event_id=event.event_id,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        event = Incoming.model_validate(payload)
        if event.sender.kind == "switch":
            return
        if event.type == "channel.join":
            if self._on_app_joined is None:
                raise BridgeOperationError("The webhook connection is not ready")
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    channel_name=event.channel_name,
                )
            )
            return
        text = event.text.strip()
        typed_command = (
            event.type == "message"
            and not event.attachments
            and re.match(r"^![A-Za-z][A-Za-z0-9_-]{0,63}(?:\s|$)", text) is not None
        )
        if event.type == "command" or typed_command:
            if self._on_command is None:
                raise BridgeOperationError("The webhook connection is not ready")
            words = text[1:].split(maxsplit=1)
            command, args = words[0], words[1] if len(words) > 1 else ""
            await self._on_command(
                InboundCommand(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    sender_id=event.sender.id,
                    sender_name=event.sender.name,
                    command=command,
                    args=args,
                    message_ref=event.message_id,
                    root_id=event.thread_id,
                    channel_name=event.channel_name,
                )
            )
            return
        if self._on_message is None:
            raise BridgeOperationError("The webhook connection is not ready")
        await self._on_message(
            InboundMessage(
                channel_id=event.channel_id,
                channel_type=event.channel_type,
                sender_id=event.sender.id,
                sender_name=event.sender.name,
                content=event.text,
                message_ref=event.message_id,
                root_id=event.thread_id,
                channel_name=event.channel_name,
                sender_is_app=event.sender.kind == "app",
                attachments=[
                    Attachment(
                        filename=file.name, mimetype=file.mime_type, data=file.decode()
                    )
                    for file in event.attachments
                ],
            )
        )

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str:
        first: str | None = None
        for part in split_text(content):
            ref = await self._post(
                "message.create",
                channel_id=channel_id,
                sender_name=sender_name,
                text=part,
                thread_id=thread_root_id,
                group_id=first,
            )
            if first is None:
                first = ref
            thread_root_id = thread_root_id or first
        assert first is not None
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._post(
            "message.update",
            channel_id=channel_id,
            message_id=message_ref,
            text=new_content,
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._post(
            "message.delete", channel_id=channel_id, message_id=message_ref
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        await self._post(
            "typing",
            channel_id=channel_id,
            sender_name=sender_name,
            is_typing=is_typing,
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
    ) -> str:
        return await self.send_attachments(
            channel_id,
            sender_name,
            [OutboundAttachment(filename=filename, mimetype=mimetype, data=data)],
            caption,
            thread_root_id,
        )

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str:
        if (
            len(files) > MAX_FILES
            or sum(len(file.data) for file in files) > MAX_FILE_BYTES
        ):
            return await self.send_message(
                channel_id,
                sender_name,
                "Attachment not relayed: at most five files totaling 5 MiB are supported.",
                thread_root_id,
            )
        return await self._post(
            "message.create",
            channel_id=channel_id,
            sender_name=sender_name,
            text=caption or "",
            thread_id=thread_root_id,
            attachments=[
                File(
                    name=file.filename,
                    mime_type=file.mimetype,
                    data_base64=base64.b64encode(file.data).decode(),
                )
                for file in files
            ],
        )

    def rich_fallback_text(self, content: RichContent) -> str:
        if isinstance(content, TurnActivity):
            return turn_status(
                content.items,
                content.turn,
                escape=self.escape_label_for_body,
                limit=4000,
                markup=MARKDOWN,
                elapsed_seconds=content.elapsed_seconds,
                tool_detail=True,
                error_summary=content.error_summary,
            )
        return request_summary(
            content.request,
            content.reference,
            escape=self.escape_label_for_body,
            limit=4000,
            markup=MARKDOWN,
            unavailable_reason=content.unavailable_reason,
        )

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        marker = (
            content.publication_token
            if isinstance(content, TurnActivity)
            else content.reference.token
        )
        text = self.rich_fallback_text(content)
        try:
            return await self._post(
                "activity" if isinstance(content, TurnActivity) else "request",
                delivery_id=f"publication:{marker}" if marker else None,
                channel_id=channel_id,
                sender_name=agent_name,
                text=text,
                thread_id=thread_root_id,
                marker=marker,
            )
        except BridgeOperationError as error:
            raise RichContentFailed(str(error), text=text) from error

    def channel_ids_refused(self) -> str:
        return "Create the chat in your app and send channel.join or a message to connect its room."

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        if self._client is None:
            raise BridgeOperationError("The webhook connection is stopped")
        ref = self._id(f"publication:{token}")
        ack = await self._deliver(
            self._client,
            Outgoing(
                type="publication.lookup",
                event_id=uuid.uuid4().hex,
                channel_id=channel_id,
                message_id=ref,
                marker=token,
            ),
            attempts=3,
        )
        if ack.found is None:
            raise BridgeOperationError(
                "The receiver did not answer the publication lookup"
            )
        return ref if ack.found else None

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        raise ChannelCreationUnsupported(
            "Create the chat in your app, then send a channel.join event"
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        raise BridgeOperationError(
            "Send a channel.join event with the chat's type before connecting its room"
        )

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        raise BridgeOperationError("Manage chat membership in your app")

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

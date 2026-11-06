from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, ClassVar, Self
from urllib.parse import urlsplit

import httpx
from pydantic import Field, field_validator, model_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
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
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.outbound import OutboundPolicy, guarded_async_client

from .protocol import (
    MAX_BODY_BYTES,
    MAX_FILE_BYTES,
    File,
    Incoming,
    Outgoing,
    encode,
    parse_incoming,
    signature,
)

TEXT_CHUNK = 8000


class WebhookConnectionConfig(BridgeConnectionConfig):
    outbound_url: str = Field(
        title="Application webhook URL",
        description="HTTPS endpoint receiving signed Switch events; redirects are refused.",
    )
    inbound_token: str = Field(
        min_length=32,
        max_length=256,
        repr=False,
        description="Generate a random token (at least 32 characters). Your app uses it as a Bearer token.",
    )
    signing_secret: str = Field(
        min_length=32,
        max_length=256,
        repr=False,
        description="A different random secret (at least 32 characters). Configure it in your receiver before connecting.",
    )

    @field_validator("outbound_url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if (
            len(value) > 2048
            or parts.scheme != "https"
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
            or parts.fragment
            or parts.query
            or any(c.isspace() for c in value)
        ):
            raise ValueError("Use an HTTPS URL without credentials, query or fragment")
        try:
            _ = parts.port
        except ValueError as exc:
            raise ValueError("Invalid webhook URL port") from exc
        return value

    @field_validator("inbound_token", "signing_secret")
    @classmethod
    def validate_secret(cls, value: str) -> str:
        if not value.isascii() or not all(33 <= ord(c) <= 126 for c in value):
            raise ValueError("Secrets must be printable ASCII without spaces")
        return value

    @model_validator(mode="after")
    def distinct_secrets(self) -> Self:
        if hmac.compare_digest(self.inbound_token, self.signing_secret):
            raise ValueError("Inbound token and signing secret must be different")
        return self


class WebhookAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Custom app (webhook)"
    receives_webhooks: ClassVar[bool] = True
    confirms_webhook_delivery: ClassVar[bool] = True
    webhook_body_limit: ClassVar[int | None] = MAX_BODY_BYTES
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = False
    supports_queue_reaction: ClassVar[bool] = False
    recovers_uncertain_posts: ClassVar[bool] = False
    carries_publication_marker: ClassVar[bool] = False
    discloses_unconfirmed_posts: ClassVar[bool] = True
    renders_custom_url_schemes: ClassVar[bool] = False
    draws_session_activity: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True

    def __init__(self, *, config: WebhookConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._client: httpx.AsyncClient | None = None
        # Task-local identity only. Never stores deduplication or routing state.
        self._source: ContextVar[tuple[str, list[int]] | None] = ContextVar(
            "webhook_delivery", default=None
        )
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self._on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [WebhookConnectionConfig.model_validate(connection_config).outbound_url]

    @classmethod
    async def verify_connection(
        cls, connection_config: dict[str, object], policy: OutboundPolicy
    ) -> None:
        adapter = cls(config=WebhookConnectionConfig.model_validate(connection_config))
        challenge = secrets.token_urlsafe(32)
        event = Outgoing(
            event_id=uuid.uuid4().hex, type="connection.check", challenge=challenge
        )
        try:
            async with guarded_async_client(
                policy, timeout=httpx.Timeout(10, connect=3), follow_redirects=False
            ) as client:
                proof = await adapter._post(client, event, attempts=1)
            expected = hmac.new(
                adapter.config.signing_secret.encode(),
                b"switch-webhook-check-v1." + challenge.encode(),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(expected.encode(), proof):
                raise BridgeCredentialError(
                    "Receiver did not prove the signing secret. Configure the same "
                    "signing_secret in the application and implement connection.check."
                )
        except (BridgeOperationError, httpx.HTTPError) as exc:
            raise BridgeCredentialError(
                "Webhook receiver verification failed. Check its URL, signing secret, "
                "TLS certificate and availability."
            ) from exc

    @contextmanager
    def delivery_scope(self, source_id: str) -> Iterator[None]:
        token = self._source.set((source_id, [0]))
        try:
            yield
        finally:
            self._source.reset(token)

    def _new_message_id(self) -> str:
        source = self._source.get()
        if source is None:
            return uuid.uuid4().hex
        ordinal = source[1][0]
        source[1][0] += 1
        # Separate connections have separate namespaces even for a shared room.
        return hmac.new(
            self.config.signing_secret.encode(),
            f"message:{source[0]}:{ordinal}".encode(),
            hashlib.sha256,
        ).hexdigest()

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message, self._on_command = on_message, on_command
        self._on_app_joined = on_app_joined
        self._client = guarded_async_client(
            self.outbound_policy,
            timeout=httpx.Timeout(10, connect=3),
            follow_redirects=False,
        )

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _post(
        self, client: httpx.AsyncClient, event: Outgoing, *, attempts: int = 3
    ) -> bytes:
        body = encode(event)
        if len(body) > MAX_BODY_BYTES:
            raise BridgeOperationError("Webhook payload exceeds the 6 MiB limit")
        for attempt in range(attempts):
            timestamp = str(int(time.time()))
            try:
                # Bound the entire attempt as well as each socket operation.
                async with asyncio.timeout(12):
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
                            "idempotency-key": event.event_id,
                        },
                    ) as response:
                        if response.status_code in (401, 403):
                            raise BridgeCredentialError(
                                "Webhook receiver refused the signing credentials"
                            )
                        if 200 <= response.status_code < 300:
                            if event.type != "connection.check":
                                return b""
                            proof = bytearray()
                            async for chunk in response.aiter_raw():
                                if len(proof) + len(chunk) > 64:
                                    raise BridgeOperationError(
                                        "Receiver sent an invalid connection proof"
                                    )
                                proof.extend(chunk)
                            return bytes(proof)
                        if response.status_code != 429 and response.status_code < 500:
                            raise BridgeOperationError(
                                f"Webhook receiver refused the event (HTTP {response.status_code})"
                            )
            except (httpx.TransportError, TimeoutError):
                pass
            if attempt + 1 < attempts:
                await asyncio.sleep(0.25 * (2**attempt))
        raise BridgeOperationError(
            "Webhook receiver unavailable after bounded delivery attempts"
        )

    async def _emit(self, kind: str, **fields: Any) -> None:
        if self._client is None:
            raise BridgeOperationError("Webhook connection is stopped")
        # Content-address the operation on its stable message id; a retry
        # changes the authenticated timestamp but never the event or body.
        fields["event_id"] = "pending"
        event = Outgoing.model_validate({"type": kind, **fields})
        # Identical text can recur (A -> B -> A). A redraw outside a durable
        # source needs a new operation id, while each HTTP retry reuses it.
        operation = (
            self._new_message_id().encode()
            if kind in ("message.updated", "message.deleted")
            else b""
        )
        event = event.model_copy(
            update={"event_id": hashlib.sha256(encode(event) + operation).hexdigest()}
        )
        await self._post(self._client, event)

    async def verify_webhook(self, request: WebhookRequest) -> None:
        supplied = request.headers.get("authorization", "").encode("utf-8")
        expected = f"Bearer {self.config.inbound_token}".encode()
        if request.method != "POST" or not hmac.compare_digest(supplied, expected):
            raise WebhookAuthenticityError("Invalid webhook credentials")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if (
            request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            != "application/json"
        ):
            raise WebhookPayloadError("Expected application/json")
        try:
            event = parse_incoming(request.body)
        except (ValueError, RecursionError) as exc:
            # Never include pydantic's input-containing error in logs.
            raise WebhookPayloadError(
                "Invalid v1 envelope or payload/file limit exceeded"
            ) from exc
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
        if (
            self._on_message is None
            or self._on_command is None
            or self._on_app_joined is None
        ):
            raise BridgeOperationError("Webhook connection is stopped")
        if event.type == "channel.connected":
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    channel_name=event.channel_name,
                )
            )
            return
        text = event.text
        root_id = event.thread_id
        reference = event.message_id
        if event.type != "message.created":
            # Switch rooms are append-only. Preserve the correction and target
            # instead of silently accepting a mutation the room cannot perform.
            root_id = event.thread_id or event.message_id
            reference = event.event_id
            text = (
                f"Message {event.message_id} was deleted."
                if event.type == "message.deleted"
                else f"Message {event.message_id} was edited:\n{event.text}"
            )
        if (
            event.type == "message.created"
            and text.startswith("!")
            and not event.attachments
        ):
            command, _, args = text[1:].partition(" ")
            if command:
                await self._on_command(
                    InboundCommand(
                        channel_id=event.channel_id,
                        channel_type=event.channel_type,
                        sender_id=event.sender_id,
                        sender_name=event.sender_name,
                        message_ref=reference,
                        root_id=root_id,
                        command=command,
                        args=args,
                        channel_name=event.channel_name,
                    )
                )
                return
        await self._on_message(
            InboundMessage(
                channel_id=event.channel_id,
                channel_type=event.channel_type,
                sender_id=event.sender_id,
                sender_name=event.sender_name,
                content=text,
                message_ref=reference,
                root_id=root_id,
                channel_name=event.channel_name,
                attachments=[
                    Attachment(
                        filename=f.filename, mimetype=f.mimetype, data=f.decoded()
                    )
                    for f in event.attachments
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
        message_id = self._new_message_id()
        # Parts are one logical message. Receivers assemble by message_id/part,
        # keeping thread references stable even if only some parts are retried.
        chunks = [
            content[i : i + TEXT_CHUNK] for i in range(0, len(content), TEXT_CHUNK)
        ] or [""]
        for part, chunk in enumerate(chunks, 1):
            await self._emit(
                "message.created",
                channel_id=channel_id,
                sender_name=sender_name,
                message_id=message_id,
                text=chunk,
                thread_id=thread_root_id,
                part=part,
                parts=len(chunks),
            )
        return message_id

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._emit(
            "message.updated",
            channel_id=channel_id,
            message_id=message_ref,
            text=new_content,
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._emit(
            "message.deleted", channel_id=channel_id, message_id=message_ref
        )

    async def send_typing(
        self, channel_id: str, agent_name: str, is_typing: bool
    ) -> None:
        await self._emit(
            "activity",
            channel_id=channel_id,
            sender_name=agent_name,
            is_typing=is_typing,
            message_id=self._new_message_id(),
        )

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        await self._emit(
            "activity",
            channel_id=channel_id,
            sender_name=agent_name,
            is_typing=True,
            thread_id=thread_root_id,
            message_id=self._new_message_id(),
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
        if len(files) > 4 or any(len(f.data) > MAX_FILE_BYTES for f in files):
            # A visible fallback matches the shared adapter's degradation
            # contract, rather than losing a file in a background exception.
            return await self.send_message(
                channel_id,
                sender_name,
                (caption + "\n" if caption else "")
                + "Attachment not relayed: maximum 4 files, 1 MiB each.",
                thread_root_id,
            )
        message_id = self._new_message_id()
        await self._emit(
            "message.created",
            channel_id=channel_id,
            sender_name=sender_name,
            message_id=message_id,
            thread_id=thread_root_id,
            text=caption or "",
            attachments=[
                File(
                    filename=f.filename,
                    mimetype=f.mimetype,
                    data_base64=base64.b64encode(f.data).decode(),
                ).model_dump()
                for f in files
            ],
        )
        return message_id

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Create the channel in your app, then send channel.connected"
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        raise ChannelCreationUnsupported(
            "Channel discovery is unsupported; send channel.connected with its channel_type"
        )

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        raise ChannelCreationUnsupported(
            "Manage channel membership in your application"
        )

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, content: str) -> str:
        return content

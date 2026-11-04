"""A messaging platform for any chat app Switch doesn't ship an adapter for.

The app posts JSON events to the connection's own address, proving itself with
a bearer token. Switch posts room messages to the app's URL, signed with the
connection's signing secret. `schema.py` defines both payloads.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field, ValidationError, field_validator, model_validator

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
    OutboundAttachment,
)
from switch_core.bridges.collaboration.webhook import schema
from switch_core.bridges.collaboration.webhook.chunking import split_text
from switch_core.outbound import guarded_async_client

logger = logging.getLogger(__name__)

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal"}
_MIN_SECRET_LENGTH = 24
_MIN_MESSAGE_LENGTH = 100
_ATTEMPTS = 3
_BACKOFF_SECONDS = (0.5, 1.5)
_REQUEST_TIMEOUT = 10.0

_CHANNEL_TYPES: dict[str, ChannelType] = {
    "channel": "channel_public",
    "private": "channel_private",
    "group": "group",
    "direct": "direct",
}


class WebhookConnectionConfig(BridgeConnectionConfig):
    outbound_url: str
    signing_secret: str
    inbound_token: str
    max_message_length: int = Field(
        default=0,
        title="Longest message (characters)",
        description=(
            "Split longer replies into parts of at most this many characters. "
            "0 sends every message whole."
        ),
    )

    @field_validator("outbound_url")
    @classmethod
    def _url_is_usable(cls, value: str) -> str:
        parts = urlsplit(value.strip())
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ValueError("outbound_url must be an http(s) URL with a host")
        if parts.scheme == "http" and parts.hostname not in _LOOPBACK_HOSTS:
            raise ValueError(
                "outbound_url must use https unless it points at localhost"
            )
        return value.strip()

    @field_validator("signing_secret", "inbound_token")
    @classmethod
    def _secret_is_long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(
                f"must be at least {_MIN_SECRET_LENGTH} characters, "
                "for example the output of `openssl rand -hex 32`"
            )
        return value

    @field_validator("max_message_length")
    @classmethod
    def _length_is_zero_or_workable(cls, value: int) -> int:
        if value != 0 and value < _MIN_MESSAGE_LENGTH:
            raise ValueError(f"must be 0 or at least {_MIN_MESSAGE_LENGTH}")
        return value

    @model_validator(mode="after")
    def _secrets_differ(self) -> WebhookConnectionConfig:
        if self.signing_secret == self.inbound_token:
            raise ValueError("signing_secret and inbound_token must be different")
        return self


class _AppUnreachable(BridgeOperationError):
    pass


class WebhookAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Custom app (webhook)"
    receives_webhooks: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False

    def __init__(self, *, config: WebhookConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._http: httpx.AsyncClient | None = None
        self._unhealthy: str | None = None

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, _AppUnreachable):
            return "network"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [str(connection_config["outbound_url"])]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Send the app a signed ping. `outbound_url` has been through the
        outbound policy before this is called."""
        config = WebhookConnectionConfig.model_validate(connection_config)
        event = schema.OutboundEvent(type="ping", sent_at=int(time.time()))
        async with _plain_client() as client:
            try:
                response = await _post(client, config, event)
            except httpx.TransportError as exc:
                raise BridgeCredentialError(
                    f"Could not reach {config.outbound_url} to check it: {exc}"
                ) from exc
        problem = _refusal(response, config.outbound_url)
        if problem:
            raise BridgeCredentialError(problem)

    async def attention(self) -> str | None:
        return self._unhealthy

    # ── Receiving ────────────────────────────────────────────────────────────

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
                "This deployment has no public address (MESSAGING_PUBLIC_URL), "
                "so your app has nowhere to send events."
            )
        self._on_message = on_message
        self._on_command = on_command
        self._on_app_joined = on_app_joined
        self._http = guarded_async_client(
            self.outbound_policy, follow_redirects=False, timeout=_REQUEST_TIMEOUT
        )

    async def stop(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def verify_webhook(self, request: WebhookRequest) -> None:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        given = token.strip() if scheme.lower() == "bearer" else ""
        if not hmac.compare_digest(given.encode(), self.config.inbound_token.encode()):
            raise WebhookAuthenticityError("bad or missing bearer token")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if request.method != "POST":
            raise WebhookPayloadError("events are sent with POST")
        try:
            event = schema.InboundEvent.model_validate_json(request.body)
        except ValidationError as exc:
            raise WebhookPayloadError(_describe(exc)) from exc
        return InboundWebhook(
            envelope_type=event.type,
            payload=event.model_dump(mode="json"),
            handshake=None,
            external_event_id=event.id,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        event = schema.InboundEvent.model_validate(payload)
        channel_type = _CHANNEL_TYPES[event.channel.type]
        if event.type == "channel.joined":
            if self._on_app_joined is not None:
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=event.channel.id,
                        channel_type=channel_type,
                        channel_name=event.channel.name,
                    )
                )
            return
        assert event.sender is not None and event.message is not None
        text = event.message.text
        common = {
            "channel_id": event.channel.id,
            "channel_type": channel_type,
            "sender_id": event.sender.id,
            "sender_name": event.sender.name,
            "channel_name": event.channel.name,
        }
        ref = event.message.id or event.id
        if text.strip().startswith("!") and self._on_command is not None:
            command, _, args = text.strip().partition(" ")
            await self._on_command(
                InboundCommand(
                    **common,
                    command=command.lstrip("!"),
                    args=args.strip(),
                    message_ref=ref,
                    root_id=event.message.thread_id,
                )
            )
            return
        attachments, failures = self._read_files(event.message.files)
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    **common,
                    content=self.translate_inbound(text),
                    message_ref=ref,
                    root_id=event.message.thread_id,
                    attachments=attachments,
                    attachment_failures=failures,
                    sender_is_app=event.sender.is_app,
                )
            )

    def _read_files(
        self, files: list[schema.InboundFile]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for file in files:
            data = schema.decode_file(file.data)
            if data is None:
                failures.append(
                    AttachmentFailure(
                        filename=file.filename,
                        reason="the file data is not valid base64",
                    )
                )
            elif len(data) > self._max_attachment_bytes:
                limit = self._max_attachment_bytes // (1024 * 1024)
                failures.append(
                    AttachmentFailure(
                        filename=file.filename,
                        reason=f"larger than the {limit} MB limit",
                    )
                )
            else:
                attachments.append(
                    Attachment(
                        filename=file.filename, mimetype=file.mimetype, data=data
                    )
                )
        return attachments, failures

    # ── Sending ──────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        return await self._create(channel_id, sender_name, content, thread_root_id, [])

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
        file = OutboundAttachment(filename=filename, mimetype=mimetype, data=data)
        return await self.send_attachments(
            channel_id, sender_name, [file], caption, thread_root_id
        )

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        sendable = [f for f in files if len(f.data) <= self._max_attachment_bytes]
        skipped = [
            f.filename for f in files if len(f.data) > self._max_attachment_bytes
        ]
        text = caption or ""
        if skipped:
            note = "_not sent, too large: " + ", ".join(skipped) + "_"
            text = f"{text}\n{note}" if text else note
        return await self._create(
            channel_id, sender_name, text, thread_root_id, sendable
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._deliver(
            schema.OutboundEvent(
                type="message.updated",
                sent_at=int(time.time()),
                channel_id=channel_id,
                message_id=message_ref,
                text=self.translate_outbound(new_content),
            )
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._deliver(
            schema.OutboundEvent(
                type="message.deleted",
                sent_at=int(time.time()),
                channel_id=channel_id,
                message_id=message_ref,
            )
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        event = schema.OutboundEvent(
            type="typing",
            sent_at=int(time.time()),
            channel_id=channel_id,
            sender=schema.SenderRef(name=sender_name),
            is_typing=is_typing,
        )
        try:
            await self._deliver(event)
        except BridgeOperationError:
            logger.debug("typing indicator not delivered", exc_info=True)

    async def _create(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None,
        files: list[OutboundAttachment],
    ) -> str:
        sender = schema.SenderRef(
            name=sender_name, icon_url=await self.agent_icon_url(sender_name)
        )
        parts = split_text(
            self.translate_outbound(content), self.config.max_message_length
        )
        first_id: str | None = None
        for index, part in enumerate(parts):
            message_id = f"msg_{uuid.uuid4().hex}"
            await self._deliver(
                schema.OutboundEvent(
                    type="message.created",
                    sent_at=int(time.time()),
                    channel_id=channel_id,
                    message_id=message_id,
                    sender=sender,
                    text=part,
                    thread_id=thread_root_id,
                    files=[self._outbound_file(f) for f in files] if index == 0 else [],
                )
            )
            first_id = first_id or message_id
        assert first_id is not None
        return first_id

    @staticmethod
    def _outbound_file(file: OutboundAttachment) -> schema.OutboundFile:
        return schema.OutboundFile(
            filename=file.filename,
            mimetype=file.mimetype,
            size=len(file.data),
            data=schema.encode_file(file.data),
        )

    async def _deliver(self, event: schema.OutboundEvent) -> None:
        if self._http is None:
            raise BridgeOperationError("The webhook bridge is not running")
        failure: Exception | None = None
        for attempt in range(_ATTEMPTS):
            try:
                response = await _post(self._http, self.config, event)
            except httpx.TransportError as exc:
                failure = exc
            else:
                problem = _refusal(response, self.config.outbound_url)
                if problem is None:
                    self._unhealthy = None
                    return
                if response.status_code in (401, 403):
                    self._unhealthy = problem
                    raise BridgeCredentialError(problem)
                if response.status_code < 500 and response.status_code != 429:
                    raise BridgeOperationError(problem)
                failure = BridgeOperationError(problem)
            if attempt < len(_BACKOFF_SECONDS):
                await asyncio.sleep(_BACKOFF_SECONDS[attempt])
        self._unhealthy = (
            f"Switch cannot deliver messages to {self.config.outbound_url}."
        )
        if isinstance(failure, httpx.TransportError):
            raise _AppUnreachable(
                f"Could not reach {self.config.outbound_url}: {failure}"
            ) from failure
        raise BridgeOperationError(str(failure))

    # ── Channels and identities ──────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Switch cannot create channels in a custom app. Send a "
            "`channel.joined` event from your app for the channel, and Switch "
            f"adopts it as a room named '{name}'."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public"

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
        return list(user_external_ids)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


def _plain_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        follow_redirects=False, timeout=_REQUEST_TIMEOUT, trust_env=False
    )


async def _post(
    client: httpx.AsyncClient,
    config: WebhookConnectionConfig,
    event: schema.OutboundEvent,
) -> httpx.Response:
    body = event.model_dump_json(exclude_none=True).encode()
    timestamp = str(int(time.time()))
    return await client.post(
        config.outbound_url,
        content=body,
        headers={
            "content-type": "application/json",
            "x-switch-event": event.type,
            "x-switch-delivery": uuid.uuid4().hex,
            "x-switch-timestamp": timestamp,
            "x-switch-signature": schema.sign(config.signing_secret, timestamp, body),
        },
    )


def _refusal(response: httpx.Response, url: str) -> str | None:
    if response.is_success:
        return None
    if response.status_code in (401, 403):
        return (
            f"{url} rejected the request (HTTP {response.status_code}). "
            "Check that your app verifies the signature with the same signing secret."
        )
    return f"{url} answered HTTP {response.status_code}."


def _describe(exc: ValidationError) -> str:
    first = exc.errors()[0]
    where = ".".join(str(part) for part in first["loc"]) or "body"
    return f"{where}: {first['msg']}"

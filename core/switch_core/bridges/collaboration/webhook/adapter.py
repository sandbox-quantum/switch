"""Bring-your-own messaging app: any chat that can speak signed JSON over HTTP.

Switch POSTs each event to the connection's `outbound_url`, signed with its
`signing_secret`, and the chat app POSTs its own events to the connection's
webhook address (`/messaging/bridges/<id>/events`), proved with the
`inbound_token` or the same signature scheme. Both directions carry
`schema_version: 1`; `docs/messaging-platforms/webhook.md` is the contract.

Nothing here is kept in the process. A message's id is minted per send (or
returned by the receiver) and is the only handle later edits and deletes need,
and retried inbound deliveries are recognised by `event_id`, so any pod can
send or receive for the bridge.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Any, ClassVar, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
    TurnActivity,
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
    ChannelCreationUnsupported,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    activity_log,
    in_activity_log,
    render_request,
    turn_status,
)
from switch_core.bridges.collaboration.webhook.chunking import split_markdown
from switch_core.outbound import (
    OutboundPolicy,
    OutboundURLRefused,
    guarded_async_client,
)
from switch_core.sessions.contract import TURN_ENDED, ApprovalContent

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

SIGNATURE_HEADER = "x-switch-signature-256"
TIMESTAMP_HEADER = "x-switch-timestamp"
TOKEN_HEADER = "x-webhook-token"

# How far an inbound signature's timestamp may be from now. A captured signed
# request is replayable for no longer than this, and a retried delivery is
# caught by its `event_id` regardless.
_SIGNATURE_TOLERANCE_SECONDS = 300

_TIMEOUT_SECONDS = 10.0

_MAX_TIMESTAMP_DIGITS = 16

_ALLOWED_HOSTS_ENV = "OUTBOUND_ALLOWED_PRIVATE_HOSTS"

# What a receiver is asked to hold in one message. A longer post is split; a
# turn's status is edited in place, so it is cut to fit instead.
_MAX_MESSAGE_CHARS = 8000

_BANG_COMMAND = re.compile(r"!([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*))?", re.DOTALL)

NonEmpty = Annotated[str, StringConstraints(min_length=1)]


def sign(secret: str, timestamp: str, body: bytes) -> str:
    """The `X-Switch-Signature-256` value for a body sent at `timestamp`.

    The timestamp is part of what is signed, so a captured request cannot be
    replayed under a fresh one.
    """
    digest = hmac.new(
        secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    return f"sha256={digest}"


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


class WebhookConnectionConfig(BridgeConnectionConfig):
    outbound_url: str = Field(
        title="Outbound URL",
        description=(
            "Where Switch POSTs each event, as signed JSON. Must be https, "
            "except for localhost during development."
        ),
    )
    signing_secret: str = Field(
        min_length=16,
        title="Signing secret",
        description=(
            "Signs every request Switch sends (X-Switch-Signature-256) and "
            "every signed request it accepts. At least 16 characters."
        ),
        json_schema_extra={"format": "password"},
    )
    inbound_token: str = Field(
        min_length=16,
        title="Inbound token",
        description=(
            "The bearer token your chat app sends to Switch's webhook address "
            "(Authorization: Bearer <token> or X-Webhook-Token). At least 16 "
            "characters."
        ),
        json_schema_extra={"format": "password"},
    )

    @field_validator("outbound_url")
    @classmethod
    def _checked_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ValueError("outbound_url must be an http(s) URL with a host")
        if parts.username or parts.password:
            raise ValueError(
                "outbound_url must not carry credentials; use signing_secret"
            )
        if parts.scheme == "http" and not _is_loopback(parts.hostname):
            raise ValueError(
                "outbound_url must be https. Plain http is allowed only for "
                "localhost, for development"
            )
        return value


class _Event(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)

    schema_version: Literal[1]
    event_id: NonEmpty


class _Channel(_Event):
    channel_id: NonEmpty
    channel_type: ChannelType = "channel_public"
    channel_name: str | None = None


class _Sender(_Channel):
    sender_id: NonEmpty
    sender_name: NonEmpty


class _InboundAttachment(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)

    filename: NonEmpty
    mimetype: str = "application/octet-stream"
    data_base64: str | None = None
    url: str | None = None

    @model_validator(mode="after")
    def _one_source(self) -> _InboundAttachment:
        if (self.data_base64 is None) == (self.url is None):
            raise ValueError("an attachment carries exactly one of data_base64, url")
        return self


class _MessageEvent(_Sender):
    type: Literal["message"]
    text: str = ""
    message_id: NonEmpty | None = None
    thread_root_id: NonEmpty | None = None
    attachments: list[_InboundAttachment] = []

    @model_validator(mode="after")
    def _says_something(self) -> _MessageEvent:
        if not self.text.strip() and not self.attachments:
            raise ValueError("a message carries text, attachments, or both")
        return self


class _CommandEvent(_Sender):
    type: Literal["command"]
    command: Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_-]*$")]
    args: str = ""
    message_id: NonEmpty | None = None
    thread_root_id: NonEmpty | None = None


class _InteractionEvent(_Event):
    type: Literal["interaction"]
    channel_id: NonEmpty
    sender_id: NonEmpty
    sender_name: NonEmpty
    action_id: NonEmpty
    value: NonEmpty
    message_id: NonEmpty
    thread_root_id: NonEmpty | None = None


class _ChannelJoinedEvent(_Channel):
    type: Literal["channel.joined"]


class _AgentJoinedEvent(_Channel):
    type: Literal["agent.joined"]
    agent_name: NonEmpty


class _UserJoinedEvent(_Channel):
    type: Literal["user.joined"]
    user_id: NonEmpty
    user_name: NonEmpty


_EVENT_MODELS: dict[str, type[_Event]] = {
    "message": _MessageEvent,
    "command": _CommandEvent,
    "interaction": _InteractionEvent,
    "channel.joined": _ChannelJoinedEvent,
    "agent.joined": _AgentJoinedEvent,
    "user.joined": _UserJoinedEvent,
}

_NOT_RELAYED = frozenset({"message.edited", "message.deleted", "reaction"})


def _describe(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(part) for part in error['loc']) or 'body'}: {error['msg']}"
        for error in exc.errors(include_input=False, include_url=False)
    )


def _same(given: str, expected: str) -> bool:
    return hmac.compare_digest(given.encode(), expected.encode())


async def _post_event(
    client: httpx.AsyncClient,
    config: WebhookConnectionConfig,
    event: str,
    data: dict[str, Any],
) -> dict[str, Any] | None:
    """Send one signed event and return the receiver's JSON answer, if it gave one.

    Raises `BridgeCredentialError` when the receiver rejects the signature and
    `BridgeOperationError` for any other refusal or a receiver that cannot be
    reached. Redirects are not followed: the signed body goes only where the
    operator pointed it.
    """
    body = json.dumps(
        {
            "schema_version": SCHEMA_VERSION,
            "event_id": uuid.uuid4().hex,
            "event": event,
            "created_at": datetime.now(UTC).isoformat(),
            "data": data,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    timestamp = str(int(time.time()))
    host = urlsplit(config.outbound_url).hostname
    try:
        response = await client.post(
            config.outbound_url,
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Switch-Event": event,
                "X-Switch-Timestamp": timestamp,
                "X-Switch-Signature-256": sign(config.signing_secret, timestamp, body),
            },
        )
    except (httpx.HTTPError, OutboundURLRefused) as exc:
        raise BridgeOperationError(
            f"Could not deliver {event} to {host}: {exc}"
        ) from exc
    if response.status_code in {401, 403}:
        raise BridgeCredentialError(
            f"{host} rejected {event} with {response.status_code}. Check that "
            "it verifies X-Switch-Signature-256 with this connection's signing "
            "secret."
        )
    if not response.is_success:
        raise BridgeOperationError(
            f"{host} answered {event} with {response.status_code}"
        )
    if not response.content:
        return None
    try:
        answer = response.json()
    except ValueError:
        return None
    return answer if isinstance(answer, dict) else None


class WebhookAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Webhook"
    receives_webhooks: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    # A receiver is arbitrary software, and a custom scheme in Markdown is
    # usually stripped; Console links go out as https.
    renders_custom_url_schemes: ClassVar[bool] = False

    def __init__(self, *, config: WebhookConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: httpx.AsyncClient | None = None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [WebhookConnectionConfig.model_validate(connection_config).outbound_url]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Send `health.check` as `start` will send everything else.

        A receiver that cannot be reached, or rejects the signature, fails the
        connection here instead of at the first message.
        """
        config = WebhookConnectionConfig.model_validate(connection_config)
        # A classmethod has no adapter to hand it the policy, so it is read the
        # way `SwitchConfig.outbound_allowed_private_hosts` is: from the
        # environment. The connection is then checked as it is made, which the
        # registration-time URL check cannot do.
        policy = OutboundPolicy.parse(os.environ.get(_ALLOWED_HOSTS_ENV, ""))
        async with guarded_async_client(
            policy, follow_redirects=False, timeout=_TIMEOUT_SECONDS
        ) as client:
            await _post_event(client, config, "health.check", {})

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

    async def stop(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        bearer = request.headers.get("authorization", "")
        scheme, _, bearer_token = bearer.partition(" ")
        presented = [
            bearer_token if scheme.lower() == "bearer" else "",
            request.headers.get(TOKEN_HEADER, ""),
        ]
        if request.method == "GET":
            # An address check cannot set headers on some platforms.
            presented.append(request.query.get("token", ""))
        if any(
            token and _same(token, self._config.inbound_token) for token in presented
        ):
            return
        if self._signature_matches(request):
            return
        raise WebhookAuthenticityError("no valid inbound token or signature")

    def _signature_matches(self, request: WebhookRequest) -> bool:
        given = request.headers.get(SIGNATURE_HEADER, "")
        timestamp = request.headers.get(TIMESTAMP_HEADER, "")
        # The length bound keeps `int` from refusing an absurdly long number.
        if (
            not given
            or len(timestamp) > _MAX_TIMESTAMP_DIGITS
            or not timestamp.isascii()
            or not timestamp.isdecimal()
        ):
            return False
        if abs(time.time() - int(timestamp)) > _SIGNATURE_TOLERANCE_SECONDS:
            return False
        return _same(given, sign(self._config.signing_secret, timestamp, request.body))

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if request.method == "GET":
            challenge = request.query.get("challenge", "")
            if not challenge:
                raise WebhookPayloadError("address check without a challenge")
            return InboundWebhook(
                envelope_type="address_check",
                payload={},
                handshake=challenge,
                external_event_id=None,
                delivery_attempt=0,
                answers_inline=False,
            )
        try:
            payload = json.loads(request.body)
        except ValueError as exc:
            raise WebhookPayloadError("body is not JSON") from exc
        if not isinstance(payload, dict):
            raise WebhookPayloadError("body is not a JSON object")
        if payload.get("schema_version") != SCHEMA_VERSION:
            raise WebhookPayloadError(
                f"schema_version must be {SCHEMA_VERSION}, got "
                f"{payload.get('schema_version')!r}"
            )
        event_type = payload.get("type")
        model = _EVENT_MODELS.get(event_type) if isinstance(event_type, str) else None
        if model is None:
            if isinstance(event_type, str) and event_type in _NOT_RELAYED:
                raise WebhookPayloadError(
                    f"{event_type} cannot be relayed into a room yet"
                )
            raise WebhookPayloadError(
                f"unsupported event type {event_type!r}; supported: "
                f"{', '.join(sorted(_EVENT_MODELS))}"
            )
        try:
            event = model.model_validate(payload)
        except ValidationError as exc:
            raise WebhookPayloadError(_describe(exc)) from exc
        return InboundWebhook(
            envelope_type=str(event_type),
            payload=payload,
            handshake=None,
            external_event_id=event.event_id,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        event = _EVENT_MODELS[envelope_type].model_validate(payload)
        if isinstance(event, _MessageEvent):
            await self._dispatch_message(event)
        elif isinstance(event, _CommandEvent):
            await self._require(self._on_command)(
                InboundCommand(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    sender_id=event.sender_id,
                    sender_name=event.sender_name,
                    command=event.command,
                    args=event.args.strip(),
                    message_ref=event.message_id or event.event_id,
                    root_id=event.thread_root_id,
                    channel_name=event.channel_name,
                )
            )
        elif isinstance(event, _InteractionEvent):
            await self._require(self._on_interaction)(
                InboundInteraction(
                    channel_id=event.channel_id,
                    sender_id=event.sender_id,
                    sender_name=event.sender_name,
                    action_id=event.action_id,
                    value=event.value,
                    message_ref=event.message_id,
                    thread_ref=event.thread_root_id,
                )
            )
        elif isinstance(event, _ChannelJoinedEvent):
            await self._require(self._on_app_joined)(
                InboundAppJoin(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    channel_name=event.channel_name,
                )
            )
        elif isinstance(event, _AgentJoinedEvent):
            await self._require(self._on_agent_joined)(
                InboundAgentJoin(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    agent_name=event.agent_name,
                    channel_name=event.channel_name,
                )
            )
        elif isinstance(event, _UserJoinedEvent):
            await self._require(self._on_user_joined)(
                InboundUserJoin(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    external_user_id=event.user_id,
                    external_username=event.user_name,
                    channel_name=event.channel_name,
                )
            )

    def _require[F](self, callback: F | None) -> F:
        if callback is None:
            raise BridgeOperationError(
                "A webhook event arrived before this bridge was started"
            )
        return callback

    async def _dispatch_message(self, event: _MessageEvent) -> None:
        text = event.text.strip()
        command = None if event.attachments else _BANG_COMMAND.fullmatch(text)
        if command is not None:
            await self._require(self._on_command)(
                InboundCommand(
                    channel_id=event.channel_id,
                    channel_type=event.channel_type,
                    sender_id=event.sender_id,
                    sender_name=event.sender_name,
                    command=command.group(1),
                    args=(command.group(2) or "").strip(),
                    message_ref=event.message_id or event.event_id,
                    root_id=event.thread_root_id,
                    channel_name=event.channel_name,
                )
            )
            return
        attachments, failures = await self._read_attachments(event.attachments)
        await self._require(self._on_message)(
            InboundMessage(
                channel_id=event.channel_id,
                channel_type=event.channel_type,
                sender_id=event.sender_id,
                sender_name=event.sender_name,
                content=self.translate_inbound(event.text),
                message_ref=event.message_id or event.event_id,
                root_id=event.thread_root_id,
                channel_name=event.channel_name,
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    async def _read_attachments(
        self, offered: list[_InboundAttachment]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Decode or download each attachment. One that cannot be relayed is
        reported as a failure so the room says so, never dropped."""
        cap = self._max_attachment_bytes
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for item in offered:
            try:
                data = (
                    _decode(item.data_base64, cap)
                    if item.data_base64 is not None
                    else await self._download(str(item.url), cap)
                )
            except _AttachmentRefused as refused:
                logger.warning(
                    "Refused webhook attachment %s: %s", item.filename, refused
                )
                failures.append(
                    AttachmentFailure(filename=item.filename, reason=str(refused))
                )
                continue
            attachments.append(
                Attachment(filename=item.filename, mimetype=item.mimetype, data=data)
            )
        return attachments, failures

    async def _download(self, url: str, cap: int) -> bytes:
        chunks: list[bytes] = []
        size = 0
        try:
            async with guarded_async_client(
                self.outbound_policy, follow_redirects=False, timeout=30.0
            ) as client:
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > cap:
                            raise _AttachmentRefused(
                                f"larger than the {cap} byte limit"
                            )
                        chunks.append(chunk)
        except (httpx.HTTPError, OutboundURLRefused) as exc:
            raise _AttachmentRefused(f"download failed: {exc}") from exc
        return b"".join(chunks)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def _render_outbound(self, content: str) -> str:
        return content

    # ── Outbound ─────────────────────────────────────────────────────────────

    async def _send(self, event: str, data: dict[str, Any]) -> dict[str, Any] | None:
        if self._client is None:
            self._client = guarded_async_client(
                self.outbound_policy, follow_redirects=False, timeout=_TIMEOUT_SECONDS
            )
        return await _post_event(self._client, self._config, event, data)

    async def _create_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None,
        *,
        sender_type: str,
        room_wide_mention: bool,
        attachments: list[OutboundAttachment],
    ) -> str:
        """Post `message.created` and return the id the message is known by.

        Minted here so no state is needed to find the message again; a receiver
        that has ids of its own returns `{"message_id": ...}` and that is used.
        A body over `_MAX_MESSAGE_CHARS` goes out as several messages; the
        first carries the files and the room-wide mention and is the one whose
        id is returned. The rest are replies under it, or in the thread it was
        already in.
        """
        rendering = await self.agent_rendering(sender_name)
        first_id: str | None = None
        for position, piece in enumerate(split_markdown(content, _MAX_MESSAGE_CHARS)):
            first = position == 0
            message_id = uuid.uuid4().hex
            answer = await self._send(
                "message.created",
                {
                    "channel_id": channel_id,
                    "message_id": message_id,
                    "thread_root_id": thread_root_id,
                    "sender_name": sender_name,
                    "sender_display_name": rendering.field_label,
                    "sender_icon_url": rendering.icon_url,
                    "sender_type": sender_type,
                    "content": piece,
                    "room_wide_mention": room_wide_mention and first,
                    "attachments": [
                        {
                            "filename": file.filename,
                            "mimetype": file.mimetype,
                            "size": len(file.data),
                            "data_base64": base64.b64encode(file.data).decode(),
                        }
                        for file in (attachments if first else [])
                    ],
                },
            )
            if first:
                returned = answer.get("message_id") if answer else None
                first_id = (
                    returned if isinstance(returned, str) and returned else message_id
                )
                thread_root_id = thread_root_id or first_id
        assert first_id is not None
        return first_id

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        return await self._create_message(
            channel_id,
            sender_name,
            content,
            thread_root_id,
            sender_type="agent",
            room_wide_mention=room_wide_mention,
            attachments=[],
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
        return await self._create_message(
            channel_id,
            self._bridge_display_name(),
            self._admin_body(self.translate_outbound(content), drawn),
            thread_root_id,
            sender_type="admin",
            room_wide_mention=False,
            attachments=[],
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
            caption=caption,
            thread_root_id=thread_root_id,
        )

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        return await self._create_message(
            channel_id,
            sender_name,
            self.translate_outbound(caption) if caption else "",
            thread_root_id,
            sender_type="agent",
            room_wide_mention=False,
            attachments=files,
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._send(
            "message.updated",
            {
                "channel_id": channel_id,
                "message_id": message_ref,
                "content": new_content,
                "thread_root_id": None,
            },
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._send(
            "message.deleted", {"channel_id": channel_id, "message_id": message_ref}
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        try:
            await self._send(
                "typing.updated",
                {
                    "channel_id": channel_id,
                    "sender_name": sender_name,
                    "is_typing": is_typing,
                },
            )
        except (BridgeOperationError, BridgeCredentialError):
            # Typing is a hint that expires on its own; a receiver that is down
            # is reported by the sends that matter.
            logger.warning(
                "Could not send a typing indicator to %s", channel_id, exc_info=True
            )

    # ── Session activity and request cards ───────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return _MAX_MESSAGE_CHARS

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        message_id = uuid.uuid4().hex
        try:
            answer = await self._send_rich(
                channel_id, agent_name, message_id, content, thread_root_id, opened=True
            )
        except (BridgeOperationError, BridgeCredentialError) as error:
            raise RichContentFailed(
                f"The webhook receiver did not take the message in {channel_id}: "
                f"{error}",
                text=self.rich_fallback_text(content),
            ) from error
        returned = answer.get("message_id") if answer else None
        return returned if isinstance(returned, str) and returned else message_id

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        try:
            await self._send_rich(
                channel_id,
                agent_name,
                message_ref,
                content,
                thread_root_id,
                opened=False,
            )
        except (BridgeOperationError, BridgeCredentialError) as error:
            raise RichContentFailed(
                f"The webhook receiver did not take the edit to {message_ref} in "
                f"{channel_id}: {error}",
                text=self.rich_fallback_text(content),
            ) from error

    async def _send_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_id: str,
        content: RichContent,
        thread_root_id: str | None,
        *,
        opened: bool,
    ) -> dict[str, Any] | None:
        rendering = await self.agent_rendering(agent_name)
        common = {
            "channel_id": channel_id,
            "message_id": message_id,
            "thread_root_id": thread_root_id,
            "agent_name": agent_name,
            "sender_display_name": rendering.field_label,
            "sender_icon_url": rendering.icon_url,
        }
        if isinstance(content, TurnActivity):
            return await self._send(
                "activity.updated", {**common, **self._activity(content)}
            )
        return await self._send(
            "request.opened" if opened else "request.updated",
            {**common, **self._request(content)},
        )

    def _activity(self, content: TurnActivity) -> dict[str, Any]:
        """A turn's status, its log once it has ended, and the stop control.

        `text` is the same compact status other chats draw, so a receiver that
        renders nothing richer can show it as a message.
        """
        turn = content.turn
        text = turn_status(
            content.items,
            turn,
            escape=self._rich_escape,
            limit=_MAX_MESSAGE_CHARS,
            markup=self.rich_markup(),
            elapsed_seconds=content.elapsed_seconds,
            error_summary=content.error_summary,
            tool_detail=True,
        )
        ended = turn.status in TURN_ENDED
        log = ""
        if ended and any(in_activity_log(item) for item in content.items):
            log = activity_log(
                content.items,
                turn,
                escape=self._rich_escape,
                limit=_MAX_MESSAGE_CHARS,
                markup=self.rich_markup(),
                elapsed_seconds=content.elapsed_seconds,
                heading=False,
            )
        interrupt = None
        if (
            self._on_interaction is not None
            and not ended
            and content.interrupt_turn_id is not None
        ):
            interrupt = {
                "action_id": INTERRUPT_ACTION,
                "value": content.interrupt_turn_id,
                "label": INTERRUPT_LABEL,
            }
        return {
            "turn_id": turn.turn_id,
            "status": turn.status,
            "elapsed_seconds": content.elapsed_seconds,
            "text": text,
            "log": log,
            "error_summary": content.error_summary,
            "interrupt": interrupt,
        }

    def _request(self, content: RequestCard) -> dict[str, Any]:
        """An approval or question card: structured controls and a text form.

        `text` always says how to answer by typing (`R42 1`); `controls` is
        present only where a press is accepted, so a receiver can draw buttons
        and post each one back as an `interaction`.
        """
        request = content.request
        drawn = render_request(
            request,
            content.reference,
            escape=self._rich_escape,
            limit=_MAX_MESSAGE_CHARS,
            markup=self.rich_markup(),
            responder=None,
            unavailable_reason=content.unavailable_reason,
            control_label_limit=None,
        )
        controls: list[dict[str, Any]] = []
        if self._on_interaction is not None and drawn.answerable:
            controls = [
                {
                    "position": control.position,
                    "label": control.label,
                    "action_id": position_action(control.position),
                    "value": content.reference.token,
                }
                for control in offered_controls(request)
            ]
        return {
            "request_id": request.request_id,
            "handle": content.reference.handle,
            "state": request.state,
            "kind": (
                "approval"
                if isinstance(request.content, ApprovalContent)
                else "questions"
            ),
            "text": drawn.text,
            "answerable": drawn.answerable,
            "controls": controls,
            "responder_external_id": content.responder_external_id,
        }

    # ── Channels and identities: none are managed on a webhook platform ──────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "A webhook connection cannot create chats. Create the channel in "
            "your chat app and bind the room to its channel id."
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
        if not user_names:
            return []
        logger.warning(
            "Cannot add %s to webhook channel %s: membership is managed by the "
            "chat app",
            ", ".join(user_names),
            channel_id,
        )
        return list(user_external_ids)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None


class _AttachmentRefused(Exception):
    """An inbound attachment that cannot be relayed; its text is shown in the room."""


def _decode(encoded: str, cap: int) -> bytes:
    # Base64 carries 3 bytes in 4 characters, so an oversize file is refused
    # before it is decoded into memory.
    if len(encoded) * 3 // 4 > cap + 3:
        raise _AttachmentRefused(f"larger than the {cap} byte limit")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _AttachmentRefused("data_base64 is not valid base64") from exc
    if len(data) > cap:
        raise _AttachmentRefused(f"{len(data)} bytes exceeds the {cap} byte limit")
    return data

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import re
from collections.abc import Awaitable, Callable, Mapping
from pathlib import PurePath
from typing import Any, ClassVar, cast
from urllib.parse import parse_qsl, urlsplit

import httpx
from markdown import markdown
from pydantic import Field, field_validator

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
    ChannelRetirement,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.sms.chunking import chunk_sms
from switch_core.bridges.collaboration.sms.client import TwilioApiError, TwilioClient
from switch_core.outbound import guarded_async_client

_E164 = re.compile(r"^\+[1-9][0-9]{7,14}$")
_ACCOUNT_SID = re.compile(r"^AC[0-9a-fA-F]{32}$")
_COMMAND = re.compile(r"^!([a-z][a-z0-9_-]*)(?:\s+(.*))?$", re.DOTALL)
_TAG = re.compile(r"<[^>]+>")


def _phone(value: str) -> str:
    value = value.strip()
    if not _E164.fullmatch(value):
        raise ValueError("phone numbers must use E.164 form, for example +14155550123")
    return value


class SmsConnectionConfig(BridgeConnectionConfig):
    account_sid: str = Field(title="Twilio Account SID")
    auth_token: str = Field(title="Twilio Auth Token", min_length=1)
    phone_number: str = Field(title="Twilio phone number")
    allowed_numbers: list[str] = Field(
        title="Allowed sender numbers",
        description="Only these E.164 numbers can create messages and receive replies.",
        min_length=1,
    )
    max_segments_per_reply: int = Field(default=6, ge=1, le=20)

    @field_validator("account_sid")
    @classmethod
    def _valid_sid(cls, value: str) -> str:
        value = value.strip()
        if not _ACCOUNT_SID.fullmatch(value):
            raise ValueError(
                "account_sid must be a Twilio Account SID starting with AC"
            )
        return value

    @field_validator("phone_number")
    @classmethod
    def _valid_number(cls, value: str) -> str:
        return _phone(value)

    @field_validator("allowed_numbers")
    @classmethod
    def _valid_allowed(cls, values: list[str]) -> list[str]:
        normalised = [_phone(value) for value in values]
        if len(normalised) != len(set(normalised)):
            raise ValueError("allowed_numbers must not contain duplicates")
        return normalised


class SmsAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "SMS (Twilio)"
    docs_slug: ClassVar[str | None] = "sms"
    receives_webhooks: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True
    channel_on_delete: ClassVar[ChannelRetirement] = "kept"

    def __init__(self, *, config: SmsConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._allowed = frozenset(config.allowed_numbers)
        self._client: TwilioClient | None = None
        self._http: httpx.AsyncClient | None = None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        SmsConnectionConfig.model_validate(connection_config)
        return [TwilioClient.API, "https://media.twiliocdn.com"]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = SmsConnectionConfig.model_validate(connection_config)
        client = TwilioClient(
            account_sid=config.account_sid, auth_token=config.auth_token
        )
        try:
            await client.verify_account()
            await client.phone_number_sid(config.phone_number)
        except TwilioApiError as exc:
            raise BridgeCredentialError(
                f"Twilio rejected this connection: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise BridgeCredentialError("Could not reach the Twilio API.") from exc
        finally:
            await client.close()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, TwilioApiError):
            return "auth_failed" if exc.status in {401, 403} else "platform_error"
        if isinstance(exc, httpx.HTTPError):
            return "network"
        return None

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        if not self.webhook_url:
            raise BridgeOperationError(
                "SMS requires MESSAGING_PUBLIC_URL so Twilio can reach its webhook."
            )
        self._on_message = on_message
        self._on_command = on_command
        self._on_user_joined = on_user_joined
        self._http = guarded_async_client(
            self.outbound_policy,
            auth=httpx.BasicAuth(self._config.account_sid, self._config.auth_token),
            timeout=20,
        )
        self._client = TwilioClient(
            account_sid=self._config.account_sid,
            auth_token=self._config.auth_token,
            http=self._http,
        )
        phone_sid = await self._client.phone_number_sid(self._config.phone_number)
        await self._client.set_sms_webhook(phone_sid, self.webhook_url)

    async def stop(self) -> None:
        self._client = None
        http, self._http = self._http, None
        if http is not None:
            await http.aclose()

    async def verify_webhook(self, request: WebhookRequest) -> None:
        signature = request.headers.get("x-twilio-signature")
        if not signature or not self.webhook_url or request.method != "POST":
            raise WebhookAuthenticityError("missing Twilio request proof")
        try:
            pairs = parse_qsl(request.body.decode("utf-8"), keep_blank_values=True)
        except UnicodeDecodeError as exc:
            raise WebhookAuthenticityError("Twilio form is not UTF-8") from exc
        signed = self.webhook_url + "".join(
            key + value for key, value in sorted(pairs, key=lambda pair: pair[0])
        )
        expected = base64.b64encode(
            hmac.new(
                self._config.auth_token.encode(), signed.encode(), hashlib.sha1
            ).digest()
        ).decode()
        if not hmac.compare_digest(signature, expected):
            raise WebhookAuthenticityError("Twilio request signature did not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            values = dict(
                parse_qsl(request.body.decode("utf-8"), keep_blank_values=True)
            )
        except UnicodeDecodeError as exc:
            raise WebhookPayloadError("Twilio form is not UTF-8") from exc
        sid = values.get("MessageSid")
        sender = values.get("From")
        recipient = values.get("To")
        if not sid or not sender or not recipient:
            raise WebhookPayloadError(
                "Twilio message is missing MessageSid, From, or To"
            )
        return InboundWebhook(
            envelope_type="message",
            payload=values,
            handshake=None,
            external_event_id=sid,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        if envelope_type != "message":
            return None
        sender = str(payload.get("From") or "")
        if (
            sender not in self._allowed
            or payload.get("To") != self._config.phone_number
        ):
            return None
        sid = str(payload.get("MessageSid") or "")
        body = str(payload.get("Body") or "")
        attachments, failures = await self._media(payload)
        command = _COMMAND.match(body.strip())
        if command and self._on_command is not None:
            await self._on_command(
                InboundCommand(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=sender,
                    command=command.group(1),
                    args=command.group(2) or "",
                    message_ref=sid,
                )
            )
        elif self._on_message is not None and (body or attachments or failures):
            await self._on_message(
                InboundMessage(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=sender,
                    content=body,
                    message_ref=sid,
                    attachments=attachments,
                    attachment_failures=failures,
                )
            )
        return None

    async def _media(
        self, payload: Mapping[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        try:
            count = min(int(payload.get("NumMedia") or 0), 10)
        except (TypeError, ValueError):
            count = 0
        for index in range(count):
            url = payload.get(f"MediaUrl{index}")
            filename = PurePath(urlsplit(str(url)).path).name or f"media-{index + 1}"
            if not isinstance(url, str) or not url.startswith("https://"):
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason="invalid Twilio media URL"
                    )
                )
                continue
            try:
                data, content_type = await self._require_client().download(url)
                if len(data) > self._max_attachment_bytes:
                    raise ValueError(
                        f"file is larger than {self._max_attachment_bytes} bytes"
                    )
                mimetype = str(
                    payload.get(f"MediaContentType{index}")
                    or content_type
                    or "application/octet-stream"
                )
                attachments.append(
                    Attachment(filename=filename, mimetype=mimetype, data=data)
                )
            except (TwilioApiError, httpx.HTTPError, ValueError) as exc:
                failures.append(AttachmentFailure(filename=filename, reason=str(exc)))
        return attachments, failures

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        if channel_id not in self._allowed:
            raise BridgeOperationError(
                "SMS recipient is not in this connection's allow-list"
            )
        chunks, _truncated = chunk_sms(
            f"{sender_name}: {content}",
            max_segments=self._config.max_segments_per_reply,
        )
        first: str | None = None
        for chunk in chunks:
            ref = await self._require_client().send_sms(
                sender=self._config.phone_number, recipient=channel_id, body=chunk
            )
            if first is None:
                first = ref
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        raise BridgeOperationError("SMS messages cannot be edited")

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        raise BridgeOperationError("SMS messages cannot be deleted after sending")

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
        raise ChannelCreationUnsupported(
            "SMS conversations begin when an allow-listed number texts the Twilio number"
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

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

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        return RetireOutcome(outcome="kept")

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        return None

    async def home_deeplink(self) -> str | None:
        return "https://console.twilio.com/"

    def _render_outbound(self, content: str) -> str:
        rendered = cast(str, markdown(content, extensions=[]))
        return html.unescape(_TAG.sub("", rendered)).strip()

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def _require_client(self) -> TwilioClient:
        if self._client is None:
            raise RuntimeError("SMS adapter is not started")
        return self._client

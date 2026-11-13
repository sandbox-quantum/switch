"""Twilio SMS collaboration bridge adapter."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import parse_qsl, quote_plus

import httpx
from pydantic import Field, field_validator

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
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.sms.chunking import render_bounded_sms

logger = logging.getLogger(__name__)

TWILIO_API_BASE = "https://api.twilio.com/2010-04-01"
_E164_PATTERN = re.compile(r"^\+[1-9]\d{1,14}$")


try:
    from twilio.request_validator import (  # type: ignore[import-not-found,import-untyped]
        RequestValidator as _TwilioRequestValidator,
    )
except ImportError:
    _TwilioRequestValidator = None


def normalize_phone_number(number: str) -> str:
    """Normalize phone number to E.164 representation by stripping whitespace and punctuation."""
    cleaned = re.sub(r"[\s\-\(\)\.]", "", number.strip())
    if not cleaned.startswith("+") and cleaned.isdigit():
        cleaned = f"+{cleaned}"
    return cleaned


def validate_twilio_signature(
    auth_token: str,
    url: str,
    params: dict[str, Any] | list[tuple[str, str]],
    signature: str,
) -> bool:
    """Validate Twilio webhook signature using official RequestValidator if available,
    otherwise standard Twilio HMAC-SHA1 algorithm with repeated param support."""
    if not signature:
        return False

    if _TwilioRequestValidator is not None:
        validator = _TwilioRequestValidator(auth_token)
        if isinstance(params, list):
            dict_params: dict[str, Any] = {}
            for k, v in params:
                if k in dict_params:
                    curr = dict_params[k]
                    if isinstance(curr, list):
                        curr.append(v)
                    else:
                        dict_params[k] = [curr, v]
                else:
                    dict_params[k] = v
            return bool(validator.validate(url, dict_params, signature))
        return bool(validator.validate(url, params, signature))

    # Standard Twilio algorithm fallback:
    items: list[tuple[str, str]] = []
    if isinstance(params, dict):
        for k, v in params.items():
            if isinstance(v, (list, tuple)):
                for sub_v in v:
                    items.append((k, str(sub_v)))
            else:
                items.append((k, str(v)))
    else:
        items = list(params)

    # Sort parameters alphabetically by key, then value
    items.sort(key=lambda pair: (pair[0], pair[1]))

    # Twilio canonical data = URL + key1 + val1 + key2 + val2 ...
    data = url + "".join(f"{k}{v}" for k, v in items)
    expected = base64.b64encode(
        hmac.new(
            auth_token.encode("utf-8"), data.encode("utf-8"), hashlib.sha1
        ).digest()
    ).decode("utf-8")
    return hmac.compare_digest(expected, signature)


class SmsConnectionConfig(BridgeConnectionConfig):
    account_sid: str = Field(
        title="Account SID",
        description="Twilio Account SID (starts with AC)",
        json_schema_extra={"format": "password"},
    )
    auth_token: str = Field(
        title="Auth Token",
        description="Twilio Auth Token from your Twilio Console",
        json_schema_extra={"format": "password"},
    )
    phone_number: str = Field(
        title="Twilio Phone Number",
        description="Twilio SMS phone number in E.164 format (e.g. +1234567890)",
    )
    allowed_numbers: str = Field(
        title="Allowed Phone Numbers (Allow-list)",
        description=(
            "Required comma- or newline-separated list of sender phone numbers "
            "permitted to interact in E.164 format (e.g. +1234567890). "
            "Unlisted numbers are dropped to prevent unauthorized costs."
        ),
    )
    max_segments: int = Field(
        default=3,
        ge=1,
        le=10,
        title="Max Reply Segments",
        description="Maximum SMS segments per reply (1-10, default 3). Bounds costs per reply.",
    )

    @field_validator("account_sid")
    @classmethod
    def _validate_account_sid(cls, v: str) -> str:
        s = v.strip()
        if not s.startswith("AC") or len(s) != 34:
            raise ValueError(
                "Twilio Account SID must start with 'AC' and be 34 characters long."
            )
        return s

    @field_validator("phone_number")
    @classmethod
    def _validate_phone_number(cls, v: str) -> str:
        s = normalize_phone_number(v)
        if not _E164_PATTERN.match(s):
            raise ValueError(f"Phone number '{v}' is not a valid E.164 phone number.")
        return s

    @field_validator("allowed_numbers")
    @classmethod
    def _validate_allowed_numbers(cls, v: str) -> str:
        raw_list = [n.strip() for n in re.split(r"[\n,;]+", v) if n.strip()]
        if not raw_list:
            raise ValueError(
                "At least one allowed phone number in E.164 format must be provided."
            )
        normalized = []
        for num in raw_list:
            norm = normalize_phone_number(num)
            if not _E164_PATTERN.match(norm):
                raise ValueError(
                    f"Allowed number '{num}' is not a valid E.164 phone number."
                )
            normalized.append(norm)
        return ", ".join(normalized)

    @property
    def allowed_numbers_set(self) -> set[str]:
        return {
            normalize_phone_number(n)
            for n in re.split(r"[\n,;]+", self.allowed_numbers)
            if n.strip()
        }


class SmsAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "SMS"
    docs_slug: ClassVar[str | None] = "sms"
    receives_webhooks: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    draws_session_activity: ClassVar[bool] = False

    def __init__(self, *, config: SmsConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=TWILIO_API_BASE,
                auth=(self.config.account_sid, self.config.auth_token),
                timeout=20.0,
            )
        return self._client

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return ["https://api.twilio.com"]

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
        if isinstance(exc, (httpx.RequestError, httpx.TimeoutException)):
            return "network"
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        account_sid = str(connection_config.get("account_sid", "")).strip()
        auth_token = str(connection_config.get("auth_token", "")).strip()
        raw_number = str(connection_config.get("phone_number", "")).strip()
        phone_number = normalize_phone_number(raw_number)

        if not account_sid or not auth_token or not phone_number:
            raise BridgeCredentialError(
                "Missing Twilio Account SID, Auth Token, or Phone Number"
            )

        async with httpx.AsyncClient(
            base_url=TWILIO_API_BASE,
            auth=(account_sid, auth_token),
            timeout=15.0,
        ) as client:
            try:
                # 1. Verify account credentials
                resp = await client.get(f"/Accounts/{account_sid}.json")
                if resp.status_code in (401, 403):
                    raise BridgeCredentialError(
                        "Twilio credentials rejected: invalid Account SID or Auth Token."
                    )
                resp.raise_for_status()

                # 2. Verify phone number ownership and SMS capability
                number_query = quote_plus(phone_number)
                num_resp = await client.get(
                    f"/Accounts/{account_sid}/IncomingPhoneNumbers.json?PhoneNumber={number_query}"
                )
                num_resp.raise_for_status()
                data = num_resp.json()
                numbers = data.get("incoming_phone_numbers", [])
                if not numbers:
                    raise BridgeCredentialError(
                        f"Phone number '{phone_number}' not found in Twilio account {account_sid}."
                    )
                matched = numbers[0]
                caps = matched.get("capabilities", {})
                if not caps.get("sms"):
                    raise BridgeCredentialError(
                        f"Twilio phone number '{phone_number}' does not have SMS capability enabled."
                    )
            except BridgeCredentialError:
                raise
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code in (401, 403):
                    raise BridgeCredentialError(
                        "Twilio authentication failed."
                    ) from exc
                raise BridgeOperationError(
                    f"Twilio API error: HTTP {exc.response.status_code}"
                ) from exc
            except (httpx.RequestError, httpx.TimeoutException) as exc:
                raise BridgeOperationError(
                    f"Could not connect to Twilio API: {exc}"
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

    async def stop(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def verify_webhook(self, request: WebhookRequest) -> None:
        given_signature = request.headers.get("x-twilio-signature", "")
        if not given_signature:
            raise WebhookAuthenticityError("Missing X-Twilio-Signature header")

        canonical_url = self.webhook_url
        if not canonical_url:
            raise WebhookAuthenticityError(
                "Webhook canonical URL not configured on adapter"
            )

        # Parse urlencoded body parameters
        try:
            raw_body = request.body.decode("utf-8")
            params = parse_qsl(raw_body, keep_blank_values=True)
        except Exception as exc:
            raise WebhookAuthenticityError(
                "Could not decode webhook body for signature check"
            ) from exc

        # Also include query parameters in canonical URL if present
        target_url = canonical_url
        if request.query:
            query_str = "&".join(
                f"{quote_plus(k)}={quote_plus(v)}" for k, v in request.query.items()
            )
            target_url = (
                f"{canonical_url}?{query_str}"
                if "?" not in canonical_url
                else f"{canonical_url}&{query_str}"
            )

        valid = validate_twilio_signature(
            auth_token=self.config.auth_token,
            url=target_url,
            params=params,
            signature=given_signature,
        )
        if not valid:
            raise WebhookAuthenticityError("Twilio signature validation failed")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            raw_body = request.body.decode("utf-8")
            parsed = dict(parse_qsl(raw_body, keep_blank_values=True))
        except Exception as exc:
            raise WebhookPayloadError(
                "Webhook body is not valid application/x-www-form-urlencoded"
            ) from exc

        message_sid = parsed.get("MessageSid") or parsed.get("SmsSid")
        if not message_sid:
            raise WebhookPayloadError("Twilio webhook missing MessageSid or SmsSid")

        return InboundWebhook(
            envelope_type="sms_message",
            payload=parsed,
            handshake=None,
            external_event_id=str(message_sid),
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        # Validate Account SID and destination number
        account_sid = payload.get("AccountSid", "")
        if account_sid and account_sid != self.config.account_sid:
            logger.warning(
                "Ignoring SMS webhook with mismatched AccountSid %r", account_sid
            )
            return None

        to_number = normalize_phone_number(payload.get("To", ""))
        if to_number and to_number != self.config.phone_number:
            logger.warning(
                "Ignoring SMS webhook addressed to %r (configured: %r)",
                to_number,
                self.config.phone_number,
            )
            return None

        from_number = normalize_phone_number(payload.get("From", ""))
        if not from_number:
            logger.warning("Ignoring SMS webhook missing 'From' parameter")
            return None

        # Mandatory allow-list check: drop unapproved numbers to prevent costs
        if from_number not in self.config.allowed_numbers_set:
            logger.warning(
                "Ignoring incoming SMS from non-allowlisted number: %s", from_number
            )
            return None

        body = payload.get("Body", "").strip()
        message_sid = payload.get("MessageSid") or payload.get("SmsSid") or ""

        # Handle inbound MMS attachments
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        num_media = int(payload.get("NumMedia", 0) or 0)
        for i in range(num_media):
            media_url = payload.get(f"MediaUrl{i}")
            content_type = payload.get(
                f"MediaContentType{i}", "application/octet-stream"
            )
            if not media_url:
                continue

            # Stream download attachment with size limit
            try:
                async with httpx.AsyncClient(
                    auth=(self.config.account_sid, self.config.auth_token),
                    timeout=25.0,
                ) as media_client:
                    async with media_client.stream("GET", media_url) as resp:
                        resp.raise_for_status()
                        chunks: list[bytes] = []
                        total = 0
                        async for chunk in resp.aiter_bytes():
                            total += len(chunk)
                            if total > self._max_attachment_bytes:
                                failures.append(
                                    AttachmentFailure(
                                        filename=f"media_{i}",
                                        reason="file_too_large",
                                    )
                                )
                                break
                            chunks.append(chunk)
                        else:
                            attachments.append(
                                Attachment(
                                    filename=f"media_{i}",
                                    mimetype=content_type,
                                    data=b"".join(chunks),
                                )
                            )
            except Exception as exc:
                logger.error(
                    "Failed to download inbound MMS media from %s: %s", media_url, exc
                )
                failures.append(
                    AttachmentFailure(
                        filename=f"media_{i}",
                        reason="download_failed",
                    )
                )

        # Route commands vs standard messages
        if body.startswith("!"):
            if self._on_command is not None:
                parts = body[1:].split(None, 1)
                cmd_name = parts[0]
                args = parts[1] if len(parts) > 1 else ""
                await self._on_command(
                    InboundCommand(
                        channel_id=from_number,
                        channel_type="direct",
                        sender_id=from_number,
                        sender_name=from_number,
                        command=cmd_name,
                        args=args,
                        message_ref=str(message_sid),
                    )
                )
            return None

        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=from_number,
                    channel_type="direct",
                    sender_id=from_number,
                    sender_name=from_number,
                    content=body,
                    message_ref=str(message_sid),
                    attachments=attachments,
                    attachment_failures=failures,
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
        destination = normalize_phone_number(channel_id)
        bounded_body = render_bounded_sms(
            sender_name=sender_name,
            content=content,
            max_segments=self.config.max_segments,
        )

        data = {
            "From": self.config.phone_number,
            "To": destination,
            "Body": bounded_body,
        }

        try:
            resp = await self.client.post(
                f"/Accounts/{self.config.account_sid}/Messages.json",
                data=data,
            )
            resp.raise_for_status()
            res_data = resp.json()
            return res_data.get("sid")
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Twilio send_message failed HTTP %d: %s",
                exc.response.status_code,
                exc.response.text,
            )
            raise
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            logger.error(
                "Twilio send_message connection timeout/error to %s: %s",
                destination,
                exc,
            )
            # Do NOT retry blindly on ambiguous timeout to prevent duplicate SMS fees
            raise

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
        # Check if caption contains an accessible media URL for Twilio MediaUrl
        destination = normalize_phone_number(channel_id)
        url_match = re.search(r"https?://[^\s]+", caption or "")
        if url_match:
            media_url = url_match.group(0)
            bounded_body = render_bounded_sms(
                sender_name, caption or "", max_segments=self.config.max_segments
            )
            payload = {
                "From": self.config.phone_number,
                "To": destination,
                "Body": bounded_body,
                "MediaUrl": media_url,
            }
            resp = await self.client.post(
                f"/Accounts/{self.config.account_sid}/Messages.json",
                data=payload,
            )
            resp.raise_for_status()
            return resp.json().get("sid")

        # Disclosed degradation for local bytes without public URL
        return await super().send_attachment(
            channel_id=channel_id,
            sender_name=sender_name,
            filename=filename,
            mimetype=mimetype,
            data=data,
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
        last_sid = None
        for f in files:
            last_sid = await self.send_attachment(
                channel_id=channel_id,
                sender_name=sender_name,
                filename=f.filename,
                mimetype=f.mimetype,
                data=f.data,
                caption=caption,
                thread_root_id=thread_root_id,
            )
        return last_sid

    async def update_message(self, *args: Any, **kwargs: Any) -> Any:
        # Cellular SMS does not support message edits
        return None

    async def delete_message(self, *args: Any, **kwargs: Any) -> Any:
        # Cellular SMS does not support message deletion
        return None

    async def send_typing(self, *args: Any, **kwargs: Any) -> Any:
        # Typing indicators are omitted to prevent spurious billed SMS messages
        return None

    async def create_channel(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError("SMS platform does not support channel creation")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

    async def add_agents_to_channel(self, *args: Any, **kwargs: Any) -> Any:
        return None

    async def add_users_to_channel(self, *args: Any, **kwargs: Any) -> Any:
        return None

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, *args: Any, **kwargs: Any) -> Any:
        return []

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw: Any) -> str:
        return str(raw)

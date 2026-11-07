"""SMS as a messaging platform, through the operator's own Twilio number.

The operator gives Switch their Twilio Account SID, Auth Token and one of
their Twilio phone numbers. Each phone number that texts it is a direct room
of its own: SMS has no groups, threads, edits or deletes. Every agent replies
from the one number, with its name at the start of the text.

Twilio calls the bridge's own webhook address for every incoming text, signed
with the account's Auth Token (`X-Twilio-Signature`); on start the adapter
points the number's incoming-message URL at that address itself. Replies go
out through Twilio's REST API.

Texts cost money per segment, so a reply is plain text, cut to the
connection's `max_segments` (three by default) with a note saying how much was
left out, and only the numbers in `allowed_numbers`, when it is set, reach a
room at all.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import parse_qsl

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
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

logger = logging.getLogger(__name__)

API = "https://api.twilio.com/2010-04-01"
SIGNATURE_HEADER = "x-twilio-signature"
# A segment of a concatenated text: 153 GSM characters (67 in UCS-2).
_SEGMENT = 153
_SEGMENT_UNICODE = 67
_E164 = re.compile(r"^\+[1-9][0-9]{6,14}$")
_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class SmsConnectionConfig(BridgeConnectionConfig):
    account_sid: str = Field(
        title="Account SID",
        description="From the Twilio Console's home page. It starts with AC.",
    )
    auth_token: str = Field(
        title="Auth Token",
        description="From the same page. Twilio signs every incoming text with it.",
        repr=False,
    )
    phone_number: str = Field(
        title="Twilio phone number",
        description="One of your Twilio numbers that can send and receive SMS, like +14155550100.",
    )
    max_segments: int = Field(
        default=3,
        ge=1,
        le=10,
        title="Most segments per reply",
        description=(
            "Twilio bills each 153-character segment. A longer reply is cut, with "
            "a note saying how much was left out."
        ),
    )
    allowed_numbers: str = Field(
        default="",
        title="Numbers that may text the agents",
        description=(
            "Phone numbers separated by commas. Leave empty to take texts from "
            "anyone, which anyone who learns the number can then cost you."
        ),
    )

    @field_validator("account_sid")
    @classmethod
    def _sid(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"AC[0-9a-f]{32}", value):
            raise ValueError("An Account SID is AC followed by 32 hex characters")
        return value

    @field_validator("auth_token")
    @classmethod
    def _token(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[0-9a-f]{32}", value):
            raise ValueError("An Auth Token is 32 hex characters")
        return value

    @field_validator("phone_number")
    @classmethod
    def _number(cls, value: str) -> str:
        value = re.sub(r"[\s().-]", "", value)
        if not _E164.fullmatch(value):
            raise ValueError("Give the number in international form, like +14155550100")
        return value

    @field_validator("allowed_numbers")
    @classmethod
    def _allowed(cls, value: str) -> str:
        numbers = [re.sub(r"[\s().-]", "", n) for n in value.split(",") if n.strip()]
        for number in numbers:
            if not _E164.fullmatch(number):
                raise ValueError(f"{number!r} is not a number in international form")
        return ", ".join(numbers)

    def allowed(self) -> set[str]:
        return {n.strip() for n in self.allowed_numbers.split(",") if n.strip()}


def signature(auth_token: str, url: str, params: dict[str, str]) -> str:
    """What Twilio puts in `X-Twilio-Signature`: HMAC-SHA1 of the address
    followed by each parameter's name and value, sorted by name, in base64."""
    data = url + "".join(f"{key}{params[key]}" for key in sorted(params))
    digest = hmac.new(auth_token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


class TwilioError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{message} (HTTP {status})")
        self.status = status
        self.message = message


class SmsAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "SMS (Twilio)"
    receives_webhooks: ClassVar[bool] = True
    # A text goes to one number: there is nothing to create or search.
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False

    def __init__(self, *, config: SmsConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._http = httpx.AsyncClient(
            timeout=_TIMEOUT, auth=(config.account_sid, config.auth_token)
        )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, TwilioError):
            return "auth_failed" if exc.status in (401, 403) else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """One bridge per number: Twilio sends a number's texts to one address."""
        number = str(connection_config.get("phone_number") or "").strip()
        return f"sms {number}" if number else None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [API]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = SmsConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(
            timeout=_TIMEOUT, auth=(config.account_sid, config.auth_token)
        ) as http:
            try:
                numbers = await _numbers(http, config)
            except TwilioError as error:
                if error.status == 401:
                    raise BridgeCredentialError(
                        "Twilio doesn't accept this Account SID and Auth Token. Copy "
                        "both again from the Twilio Console."
                    ) from error
                raise BridgeCredentialError(
                    f"Twilio refused: {error.message}"
                ) from error
            except httpx.TransportError as error:
                raise BridgeCredentialError(
                    f"Could not reach Twilio: {error}"
                ) from error
        if not numbers:
            raise BridgeCredentialError(
                f"{config.phone_number} is not one of this account's Twilio numbers."
            )

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
        if self.webhook_url is None:
            raise BridgeOperationError(
                "Twilio calls Switch for every text, so the server needs "
                "MESSAGING_PUBLIC_URL, an https address Twilio can reach"
            )
        if not self._listening:
            return
        numbers = await _numbers(self._http, self.config)
        if not numbers:
            raise BridgeCredentialError(
                f"{self.config.phone_number} is not one of this account's Twilio numbers"
            )
        await self._post(
            f"/Accounts/{self.config.account_sid}/IncomingPhoneNumbers/{numbers[0]['sid']}.json",
            {"SmsUrl": self.webhook_url, "SmsMethod": "POST"},
        )

    async def stop(self) -> None:
        await self._http.aclose()

    async def _post(self, path: str, data: dict[str, str]) -> dict[str, Any]:
        response = await self._http.post(f"{API}{path}", data=data)
        if response.status_code >= 300:
            raise TwilioError(response.status_code, _reason(response))
        body = response.json()
        return body if isinstance(body, dict) else {}

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if self.webhook_url is None:
            raise WebhookAuthenticityError("this bridge has no public address")
        params = dict(
            parse_qsl(request.body.decode(errors="replace"), keep_blank_values=True)
        )
        expected = signature(self.config.auth_token, self.webhook_url, params)
        if not hmac.compare_digest(request.headers.get(SIGNATURE_HEADER, ""), expected):
            raise WebhookAuthenticityError("the Twilio signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        params = dict(
            parse_qsl(request.body.decode(errors="replace"), keep_blank_values=True)
        )
        if not params.get("MessageSid") or not params.get("From"):
            raise WebhookPayloadError("the request is not an incoming text")
        return InboundWebhook(
            envelope_type="sms",
            payload=params,
            handshake=None,
            external_event_id=params["MessageSid"],
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        sender = str(payload.get("From") or "")
        allowed = self.config.allowed()
        if allowed and sender not in allowed:
            logger.info("SMS bridge dropped a text from a number not on its list")
            return
        text = str(payload.get("Body") or "").strip()
        if not text:
            return
        if text.startswith("!") and self._on_command is not None:
            command, _, args = text[1:].partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=sender,
                    command=command,
                    args=args.strip(),
                    message_ref=str(payload["MessageSid"]),
                )
            )
            return
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=sender,
                    content=text,
                    message_ref=str(payload["MessageSid"]),
                    channel_name=sender,
                )
            )

    # ── Outbound ─────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        body = bounded(f"{sender_name}: {content}", self.config.max_segments)
        try:
            sent = await self._post(
                f"/Accounts/{self.config.account_sid}/Messages.json",
                {"To": channel_id, "From": self.config.phone_number, "Body": body},
            )
        except TwilioError as error:
            raise BridgeOperationError(
                f"Twilio refused the text to {channel_id}: {error.message}"
            ) from error
        return str(sent.get("sid") or "")

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        logger.debug("A text cannot be changed once sent (%s)", message_ref)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.debug("A text cannot be taken back once sent (%s)", message_ref)

    async def send_typing(self, *args: Any, **kwargs: Any) -> None:
        return None

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        raise ChannelCreationUnsupported("SMS has no groups to create")

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        return list(user_external_ids)

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def _render_outbound(self, content: str) -> str:
        return plain(content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


def plain(markdown: str) -> str:
    """Markdown as a text reads: no asterisks, fences or link syntax."""
    text = re.sub(r"```[a-z]*\n?", "", markdown)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1 (\2)", text)
    text = re.sub(r"(\*\*|__|~~|`)", "", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.M)
    return text.strip()


def bounded(text: str, max_segments: int) -> str:
    """`text` within `max_segments` segments, with a note of what was cut."""
    per = _SEGMENT if all(ord(c) < 128 for c in text) else _SEGMENT_UNICODE
    budget = per * max_segments
    if len(text) <= budget:
        return text
    note = " [cut: {} more characters]"
    keep = budget - len(note.format(len(text)))
    return text[:keep].rstrip() + note.format(len(text) - keep)


async def _numbers(
    http: httpx.AsyncClient, config: SmsConnectionConfig
) -> list[dict[str, Any]]:
    response = await http.get(
        f"{API}/Accounts/{config.account_sid}/IncomingPhoneNumbers.json",
        params={"PhoneNumber": config.phone_number},
    )
    if response.status_code >= 300:
        raise TwilioError(response.status_code, _reason(response))
    found = response.json().get("incoming_phone_numbers") or []
    return [n for n in found if isinstance(n, dict)]


def _reason(response: httpx.Response) -> str:
    try:
        return str(response.json().get("message") or f"HTTP {response.status_code}")
    except ValueError:
        return f"HTTP {response.status_code}"

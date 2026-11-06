"""SMS through the operator's own Twilio account and phone number.

Twilio calls this connection's webhook address for every text that arrives and
Switch answers through Twilio's REST API. A conversation is one phone number:
each allowed number gets its own direct room, and nothing else can reach an
agent. SMS costs money per segment and has no threads, edits or reactions, so
the adapter bounds what it sends (`segments.py`) and declares what it cannot do.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import time
from collections import defaultdict, deque
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
    AttachmentFailure,
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
)
from switch_core.bridges.collaboration.sms.segments import (
    plan_reply,
    segment_count,
    to_plain_text,
)

logger = logging.getLogger(__name__)

TWILIO_API = "https://api.twilio.com"
_API_VERSION = "2010-04-01"
_SIGNATURE_HEADER = "x-twilio-signature"
#: A text is at most 1600 characters and a webhook adds a handful of fields, so
#: a body this large is not Twilio's. Refused before anything parses it.
_MAX_WEBHOOK_BYTES = 64 * 1024
_HOUR = 3600.0

_E164 = re.compile(r"^\+[1-9]\d{6,14}$")
_ACCOUNT_SID = re.compile(r"^AC[0-9a-fA-F]{32}$")
_NUMBER_FORMATTING = re.compile(r"[\s().-]")
_NUMBER_SEPARATORS = re.compile(r"[,;\n]+")


def _http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=TWILIO_API, timeout=httpx.Timeout(15.0))


def _now() -> float:
    return time.monotonic()


def _normalise_number(raw: str) -> str | None:
    """`raw` as an E.164 number, or None when it cannot be one."""
    candidate = _NUMBER_FORMATTING.sub("", raw)
    return candidate if _E164.fullmatch(candidate) else None


class SmsConnectionConfig(BridgeConnectionConfig):
    account_sid: str = Field(
        title="Account SID",
        description="Starts with AC. Found on the Twilio Console home page.",
    )
    auth_token: str = Field(
        min_length=1,
        title="Auth Token",
        description=(
            "Found next to the Account SID. Switch uses it to send texts and to "
            "check that every incoming request really comes from Twilio."
        ),
    )
    phone_number: str = Field(
        title="Twilio phone number",
        description=(
            "The number texts are sent from and received on, in E.164 form, "
            "for example +15551234567."
        ),
    )
    allowed_numbers: str = Field(
        title="Allowed phone numbers",
        description=(
            "Who may text Switch, in E.164 form, separated by commas. A text "
            "from any other number is dropped and never answered, so a stranger "
            "cannot run up your Twilio bill."
        ),
    )
    max_segments_per_reply: int = Field(
        default=8,
        ge=4,
        le=20,
        title="Segments per reply",
        description=(
            "The most SMS segments one agent reply may use. Longer replies are "
            "cut, with a note pointing to Switch Console."
        ),
    )
    max_segments_per_hour: int = Field(
        default=200,
        ge=1,
        title="Segments per hour, per number",
        description=(
            "The most SMS segments Switch will send to one number in any hour. "
            "Past it nothing is sent until the hour moves on."
        ),
    )

    @field_validator("account_sid")
    @classmethod
    def _check_account_sid(cls, value: str) -> str:
        if not _ACCOUNT_SID.fullmatch(value):
            raise ValueError(
                "The Account SID must be 'AC' followed by 32 hexadecimal "
                "characters; copy it from the Twilio Console home page."
            )
        return value

    @field_validator("phone_number")
    @classmethod
    def _check_phone_number(cls, value: str) -> str:
        number = _normalise_number(value)
        if number is None:
            raise ValueError(
                "The Twilio phone number must be in E.164 form: a plus sign, the "
                "country code and the number, for example +15551234567."
            )
        return number

    @field_validator("allowed_numbers")
    @classmethod
    def _check_allowed_numbers(cls, value: str) -> str:
        entries = [e.strip() for e in _NUMBER_SEPARATORS.split(value) if e.strip()]
        if not entries:
            raise ValueError(
                "Name at least one allowed phone number: with none, nobody could "
                "text an agent."
            )
        numbers: list[str] = []
        for entry in entries:
            number = _normalise_number(entry)
            if number is None:
                raise ValueError(
                    f"{entry} is not a valid phone number in E.164 form (a plus "
                    "sign, the country code and the number)."
                )
            numbers.append(number)
        return ",".join(numbers)

    @property
    def allowed(self) -> frozenset[str]:
        return frozenset(self.allowed_numbers.split(","))


def _twilio_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if isinstance(body, dict) and "message" in body:
        return f"{body['message']} (code {body.get('code', 'unknown')})"
    return response.text[:200]


class SmsAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "SMS"
    receives_webhooks: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True

    def __init__(self, *, config: SmsConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._allowed = config.allowed
        # (monotonic time, segments) for what was sent to each number lately.
        # Per process: losing it on a move to another pod only resets a cost
        # guard, and each pod's own total stays bounded.
        self._sent: dict[str, deque[tuple[float, int]]] = defaultdict(deque)

    # ── Credentials ──────────────────────────────────────────────────────────

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Fetch the account, then confirm the account owns the phone number."""
        config = SmsConnectionConfig.model_validate(connection_config)
        auth = (config.account_sid, config.auth_token)
        base = f"/{_API_VERSION}/Accounts/{config.account_sid}"
        try:
            async with _http_client() as client:
                account = await client.get(f"{base}.json", auth=auth)
                if account.status_code != 200:
                    raise BridgeCredentialError(
                        "Twilio rejected the Account SID and Auth Token "
                        f"(HTTP {account.status_code}: {_twilio_message(account)}). "
                        "Copy both from the Twilio Console home page."
                    )
                status = account.json().get("status")
                if status != "active":
                    raise BridgeCredentialError(
                        f"The Twilio account is {status}, so it cannot send texts."
                    )
                numbers = await client.get(
                    f"{base}/IncomingPhoneNumbers.json",
                    params={"PhoneNumber": config.phone_number},
                    auth=auth,
                )
                if numbers.status_code != 200:
                    raise BridgeCredentialError(
                        "Twilio would not list the account's phone numbers "
                        f"(HTTP {numbers.status_code}: {_twilio_message(numbers)})."
                    )
                if not numbers.json().get("incoming_phone_numbers"):
                    raise BridgeCredentialError(
                        f"This Twilio account does not own {config.phone_number}. "
                        "Use a number from Phone Numbers > Manage > Active numbers."
                    )
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(
                f"Could not reach Twilio to check the credentials: {exc}. Try again."
            ) from exc

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
                "SMS needs a public address for Twilio to call, and this server "
                "has none. Set MESSAGING_PUBLIC_URL to the server's public https "
                "origin and restart it."
            )
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

    async def stop(self) -> None:
        return None

    def _expected_signature(self, url: str, form: list[tuple[str, str]]) -> bytes:
        signed = url + "".join(f"{name}{value}" for name, value in sorted(form))
        digest = hmac.new(
            self._config.auth_token.encode(), signed.encode(), hashlib.sha1
        ).digest()
        return base64.b64encode(digest)

    async def verify_webhook(self, request: WebhookRequest) -> None:
        """Check `X-Twilio-Signature`: the base64 HMAC-SHA1, keyed with the Auth
        Token, of this connection's public address followed by every POST
        parameter's name and value in name order.

        The address is the one Switch was told to publish, never one rebuilt
        from request headers, which a proxy or a caller could change. The form
        is read here only to compute that signature, never to act on it.
        """
        if request.method != "POST":
            raise WebhookAuthenticityError("Twilio delivers texts by POST")
        if self.webhook_url is None:
            raise WebhookAuthenticityError(
                "this connection has no public address to check a signature against"
            )
        if len(request.body) > _MAX_WEBHOOK_BYTES:
            raise WebhookAuthenticityError("request too large to be Twilio's")
        given = request.headers.get(_SIGNATURE_HEADER, "")
        if not given:
            raise WebhookAuthenticityError("no X-Twilio-Signature header")
        try:
            form = parse_qsl(request.body.decode("utf-8"), keep_blank_values=True)
        except UnicodeDecodeError as exc:
            raise WebhookAuthenticityError("body is not UTF-8 form data") from exc
        expected = self._expected_signature(self.webhook_url, form)
        if not hmac.compare_digest(given.encode(), expected):
            raise WebhookAuthenticityError("signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        form = dict(parse_qsl(request.body.decode("utf-8"), keep_blank_values=True))
        message_sid = form.get("MessageSid")
        sender = form.get("From")
        if not message_sid or not sender:
            raise WebhookPayloadError("an SMS webhook without MessageSid and From")
        return InboundWebhook(
            envelope_type="sms",
            payload=form,
            handshake=None,
            external_event_id=message_sid,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        if envelope_type != "sms":
            logger.warning("Ignoring an unknown SMS event type %r", envelope_type)
            return
        if self._on_message is None:
            raise RuntimeError(
                "The SMS bridge has not started, so it cannot take texts"
            )
        sender = _normalise_number(str(payload.get("From", "")))
        if sender is None or sender not in self._allowed:
            logger.warning(
                "Dropped a text from a number that is not on the allow-list "
                "(ending %s)",
                str(payload.get("From", ""))[-4:],
            )
            return
        if _normalise_number(str(payload.get("To", ""))) != self._config.phone_number:
            logger.warning("Dropped a text addressed to a number that is not ours")
            return
        if payload.get("AccountSid") != self._config.account_sid:
            logger.warning("Dropped a text that names another Twilio account")
            return

        body = str(payload.get("Body", "")).strip()
        try:
            media = int(str(payload.get("NumMedia", "0")))
        except ValueError:
            media = 0
        failures = [
            AttachmentFailure(
                filename=f"attachment {index}",
                reason="picture and media messages are not supported over SMS",
            )
            for index in range(1, media + 1)
        ]
        if not body and not failures:
            return
        await self._on_message(
            InboundMessage(
                channel_id=sender,
                channel_type="direct",
                sender_id=sender,
                sender_name=sender,
                content=body,
                message_ref=str(payload["MessageSid"]),
                attachment_failures=failures,
            )
        )

    # ── Sending ──────────────────────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        # What a card or approval prompt may spend, so the typed-answer
        # instructions at its end survive the segment cap.
        return 400

    def _within_hourly_cap(self, number: str, segments: int) -> bool:
        window = self._sent[number]
        cutoff = _now() - _HOUR
        while window and window[0][0] <= cutoff:
            window.popleft()
        used = sum(count for _, count in window)
        return used + segments <= self._config.max_segments_per_hour

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        number = _normalise_number(channel_id)
        if number is None or number not in self._allowed:
            logger.error(
                "Not texting %s: it is not on this connection's allow-list",
                channel_id[-4:] if channel_id else "an empty number",
            )
            return None
        agent = await self.agent_rendering(sender_name)
        plan = plan_reply(
            f"{agent.body_label}: {self.translate_outbound(content)}",
            max_segments=self._config.max_segments_per_reply,
        )
        cost = sum(segment_count(part) for part in plan.parts)
        if not self._within_hourly_cap(number, cost):
            logger.warning(
                "Not texting the number ending %s: sending %d more segments "
                "would pass the hourly limit of %d",
                number[-4:],
                cost,
                self._config.max_segments_per_hour,
            )
            return None
        first_ref: str | None = None
        try:
            async with _http_client() as client:
                for part in plan.parts:
                    sid = await self._post_part(client, number, part)
                    if sid is None:
                        return first_ref
                    self._sent[number].append((_now(), segment_count(part)))
                    if first_ref is None:
                        first_ref = sid
        except httpx.HTTPError as exc:
            logger.error("Could not reach Twilio to send a text: %s", exc)
        return first_ref

    async def _post_part(
        self, client: httpx.AsyncClient, number: str, part: str
    ) -> str | None:
        response = await client.post(
            f"/{_API_VERSION}/Accounts/{self._config.account_sid}/Messages.json",
            data={"To": number, "From": self._config.phone_number, "Body": part},
            auth=(self._config.account_sid, self._config.auth_token),
        )
        if response.status_code not in (200, 201):
            logger.error(
                "Twilio refused a text to the number ending %s: HTTP %d, %s",
                number[-4:],
                response.status_code,
                _twilio_message(response),
            )
            return None
        sid = response.json().get("sid")
        return str(sid) if sid else None

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
        note = f"[attachment not sent over SMS: {filename}]"
        body = f"{caption}\n{note}" if caption else note
        return await self.send_message(channel_id, sender_name, body)

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        logger.debug("SMS cannot edit a sent text (%s); not editing", message_ref)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.debug("SMS cannot unsend a text (%s); not deleting", message_ref)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    # ── Channels and people ──────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "SMS has no channels to create: a conversation is a phone number. "
            f"Add the number for '{name}' to this connection's allowed numbers "
            "and text the Twilio number from it; Switch opens the room when the "
            "first text arrives."
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
        if user_names:
            logger.warning(
                "Cannot add %s to an SMS conversation: it is one phone number, "
                "and more people are allowed by listing their numbers on the "
                "connection",
                ", ".join(user_names),
            )
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_plain_text(content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

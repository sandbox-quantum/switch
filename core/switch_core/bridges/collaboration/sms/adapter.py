"""SMS, through the operator's own Twilio account and phone number.

Twilio calls this connection's webhook address for every text the number
receives, and Switch replies through Twilio's REST API. Each phone number that
texts in is a conversation of its own, so each becomes a direct room.

SMS is unlike the chat platforms next to this one in two ways that shape the
adapter:

- **Every message costs money.** Only the numbers on the connection's
  allow-list can reach Switch, Switch only ever texts those numbers, and a
  reply longer than the connection's segment cap is cut short with a pointer
  to Switch Console rather than sent in full.
- **It has none of a chat app's furniture.** No threads, edits, deletes,
  reactions, typing indicator, channels or directory, so each of those is
  switched off below and approval cards fall back to the plain-text form the
  person answers by texting back the handle the card prints.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import math
import mimetypes
import re
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, ClassVar
from urllib.parse import parse_qsl, urlsplit

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

logger = logging.getLogger(__name__)

TWILIO_API = "https://api.twilio.com/2010-04-01"

#: Where Twilio puts its request signature (lowercased, as `WebhookRequest`
#: carries header names).
SIGNATURE_HEADER = "x-twilio-signature"

_E164 = re.compile(r"^\+[1-9][0-9]{6,14}$")
_ACCOUNT_SID = re.compile(r"^AC[0-9a-fA-F]{32}$")

#: Twilio refuses a message body longer than this.
MAX_BODY = 1600

#: How a reply over the segment cap ends.
TRUNCATION_NOTE = " [reply cut short to limit SMS cost; read it in full in Switch]"

# The GSM 03.38 default alphabet. A text made only of these is sent as GSM-7
# (160 characters in one segment, 153 per segment once split); anything else
# makes Twilio send the whole message as UCS-2 (70, then 67).
_GSM7_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
# The extension table: each costs two GSM-7 characters (an escape and itself).
_GSM7_EXTENDED = set("^{}\\[~]|€\f")


def is_gsm7(text: str) -> bool:
    """Whether Twilio can send `text` in the GSM-7 alphabet."""
    return all(c in _GSM7_BASIC or c in _GSM7_EXTENDED for c in text)


def segment_count(text: str) -> int:
    """How many SMS segments `text` is billed as, sent as one message."""
    if not text:
        return 1
    if is_gsm7(text):
        units = sum(2 if c in _GSM7_EXTENDED else 1 for c in text)
        single, multi = 160, 153
    else:
        # UCS-2 counts UTF-16 code units: an emoji is two.
        units = len(text.encode("utf-16-le")) // 2
        single, multi = 70, 67
    return 1 if units <= single else math.ceil(units / multi)


def twilio_signature(
    auth_token: str, url: str, params: Iterable[tuple[str, str]]
) -> str:
    """The `X-Twilio-Signature` Twilio sends for a form POST to `url`.

    Base64 of the HMAC-SHA1, keyed with the account's Auth Token, of the full
    URL Twilio called followed by every POST parameter's name and value, sorted
    by name (and, for a repeated name, by value).
    """
    data = url + "".join(name + value for name, value in sorted(params))
    digest = hmac.new(auth_token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def _numbers(raw: str) -> list[str]:
    return [n for n in (part.strip() for part in re.split(r"[,\s]+", raw)) if n]


class SmsConnectionConfig(BridgeConnectionConfig):
    account_sid: str = Field(
        title="Account SID",
        description="From the Twilio Console home page. Starts with AC.",
    )
    #: Masked by Console: the name contains `token`.
    auth_token: str = Field(
        title="Auth Token",
        description="From the Twilio Console home page, beside the Account SID.",
    )
    phone_number: str = Field(
        title="Twilio phone number",
        description="The number people text, in E.164 form, e.g. +15005550006.",
    )
    allowed_senders: str = Field(
        title="Allowed phone numbers",
        description=(
            "Who may text in, comma separated, in E.164 form. Texts from any "
            "other number are dropped, and Switch never texts anyone else, so "
            "a stranger cannot run up your SMS bill."
        ),
    )
    default_agent: str | None = Field(
        default=None,
        title="Agent that answers",
        description=(
            "The agent added to each new conversation. Leave empty to add "
            "agents yourself with !invite-agent."
        ),
    )
    max_segments_per_reply: int = Field(
        default=6,
        ge=1,
        le=30,
        title="Most SMS segments per reply",
        description=(
            "A longer reply is cut short with a note to read it in Switch. One "
            "segment is 160 plain characters, or 70 with emoji or non-Latin text."
        ),
    )

    @field_validator("account_sid")
    @classmethod
    def _account_sid(cls, value: str) -> str:
        value = value.strip()
        if not _ACCOUNT_SID.fullmatch(value):
            raise ValueError("an Account SID is AC followed by 32 hex characters")
        return value

    @field_validator("auth_token")
    @classmethod
    def _auth_token(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("the Auth Token is required")
        return value

    @field_validator("phone_number")
    @classmethod
    def _phone_number(cls, value: str) -> str:
        value = value.strip()
        if not _E164.fullmatch(value):
            raise ValueError("write the number in E.164 form, e.g. +15005550006")
        return value

    @field_validator("allowed_senders")
    @classmethod
    def _allowed_senders(cls, value: str) -> str:
        numbers = _numbers(value)
        if not numbers:
            raise ValueError("list at least one phone number that may text in")
        bad = [n for n in numbers if not _E164.fullmatch(n)]
        if bad:
            raise ValueError(
                f"not in E.164 form: {', '.join(bad)} (write e.g. +919812345678)"
            )
        return ", ".join(numbers)

    @field_validator("default_agent")
    @classmethod
    def _default_agent(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lstrip("@")
        return value or None

    @property
    def allowed(self) -> frozenset[str]:
        return frozenset(_numbers(self.allowed_senders))


def _plain_text(markdown: str) -> str:
    """Switch Markdown as plain text: SMS renders no markup at all."""
    text = re.sub(r"^```[^\n]*\n?", "", markdown, flags=re.MULTILINE)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!?\[([^\]]+)\]\((\S+?)\)", r"\1 (\2)", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"\1", text)
    text = re.sub(r"(?<!\w)_([^_\n]+)_(?!\w)", r"\1", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def cap_to_segments(text: str, max_segments: int) -> str:
    """`text` cut, at a word boundary, to fit in `max_segments` segments.

    Unchanged when it already fits. Otherwise ends with `TRUNCATION_NOTE`, so
    the person knows there is more and where to find it.
    """
    if segment_count(text) <= max_segments:
        return text
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if segment_count(text[:mid].rstrip() + TRUNCATION_NOTE) <= max_segments:
            low = mid
        else:
            high = mid - 1
    cut = text[:low]
    space = cut.rfind(" ")
    if space > low // 2:
        cut = cut[:space]
    return cut.rstrip() + TRUNCATION_NOTE


def split_body(text: str, limit: int = MAX_BODY) -> list[str]:
    """`text` in pieces Twilio accepts, cut at the latest paragraph, line,
    sentence or word boundary that keeps each piece within `limit`."""
    pieces: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = -1
        for boundary in ("\n\n", "\n", ". ", " "):
            found = window.rfind(boundary)
            if found > limit // 2:
                cut = found + len(boundary)
                break
        if cut <= 0:
            cut = limit
        pieces.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        pieces.append(rest)
    return pieces


class SmsAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "SMS (Twilio)"
    receives_webhooks: ClassVar[bool] = True

    # SMS has no channels to create and no directory: the only people Switch
    # can name are the allowed numbers that have texted in.
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    # A phone renders no custom scheme, so Console links are rewritten to https.
    renders_custom_url_schemes: ClassVar[bool] = False
    # Each conversation is one person: the room is theirs alone.
    every_message_notifies_members: ClassVar[bool] = True

    #: Swapped for an `httpx.MockTransport` in tests.
    _transport: ClassVar[httpx.AsyncBaseTransport | None] = None

    def __init__(self, *, config: SmsConnectionConfig) -> None:
        super().__init__()
        self.config = config

    # ── Twilio's REST API ───────────────────────────────────────────────────

    @classmethod
    def _client(cls, config: SmsConnectionConfig) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=f"{TWILIO_API}/Accounts/{config.account_sid}",
            auth=(config.account_sid, config.auth_token),
            timeout=15.0,
            transport=cls._transport,
        )

    @classmethod
    async def _call(
        cls,
        config: SmsConnectionConfig,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        data: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """One Twilio API call, its refusals raised as the bridge's own errors."""
        async with cls._client(config) as client:
            response = await client.request(method, path, params=params, data=data)
        if response.status_code in (401, 403):
            raise BridgeCredentialError(
                "Twilio refused the Account SID and Auth Token. Copy both again "
                "from the Twilio Console home page."
            )
        if response.status_code >= 400:
            try:
                detail = response.json().get("message") or response.text
            except ValueError:
                detail = response.text
            raise BridgeOperationError(
                f"Twilio refused the request ({response.status_code}): {detail}"
            )
        body: dict[str, Any] = response.json()
        return body

    @classmethod
    async def _number_sid(cls, config: SmsConnectionConfig) -> str:
        """The account's id for `config.phone_number`, proving it owns it."""
        found = await cls._call(
            config,
            "GET",
            "/IncomingPhoneNumbers.json",
            params={"PhoneNumber": config.phone_number},
        )
        numbers = found.get("incoming_phone_numbers") or []
        if not numbers:
            raise BridgeCredentialError(
                f"{config.phone_number} is not a phone number on this Twilio "
                "account. Check it under Phone Numbers > Active numbers."
            )
        return str(numbers[0]["sid"])

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = SmsConnectionConfig.model_validate(connection_config)
        await cls._number_sid(config)

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    # ── Lifecycle ───────────────────────────────────────────────────────────

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
                "SMS needs Switch reachable from the internet: set "
                "MESSAGING_PUBLIC_URL so Twilio has an address to send texts to."
            )
        self._on_message = on_message
        self._on_command = on_command
        # Point the number's incoming messages at this connection, the way
        # Telegram's adapter calls setWebhook. The same address on every pod,
        # so it is safe wherever the bridge starts.
        number_sid = await self._number_sid(self.config)
        await self._call(
            self.config,
            "POST",
            f"/IncomingPhoneNumbers/{number_sid}.json",
            data={"SmsUrl": self.webhook_url, "SmsMethod": "POST"},
        )

    async def stop(self) -> None:
        return None

    async def withdraw(self) -> None:
        """Stop the number delivering texts to an address nobody reads."""
        number_sid = await self._number_sid(self.config)
        current = await self._call(
            self.config, "GET", f"/IncomingPhoneNumbers/{number_sid}.json"
        )
        if current.get("sms_url") == self.webhook_url:
            await self._call(
                self.config,
                "POST",
                f"/IncomingPhoneNumbers/{number_sid}.json",
                data={"SmsUrl": ""},
            )

    # ── Inbound: Twilio's webhook ───────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method != "POST":
            raise WebhookAuthenticityError("Twilio posts its messages")
        if not self.webhook_url:
            raise WebhookAuthenticityError("this connection has no public address")
        given = request.headers.get(SIGNATURE_HEADER, "")
        try:
            params = parse_qsl(
                request.body.decode(), keep_blank_values=True, strict_parsing=False
            )
        except UnicodeDecodeError as exc:
            raise WebhookAuthenticityError("body is not text") from exc
        # Signed over the address Twilio was given, which is this connection's
        # own: never rebuilt from headers a proxy could change.
        expected = twilio_signature(self.config.auth_token, self.webhook_url, params)
        if not given or not hmac.compare_digest(given, expected):
            raise WebhookAuthenticityError("Twilio signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            payload = dict(parse_qsl(request.body.decode(), keep_blank_values=True))
        except UnicodeDecodeError as exc:
            raise WebhookPayloadError("body is not form data") from exc
        sid = payload.get("MessageSid") or payload.get("SmsSid")
        if not sid or not payload.get("From"):
            raise WebhookPayloadError("not a Twilio message: no MessageSid or From")
        return InboundWebhook(
            envelope_type="message",
            payload=payload,
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
        sender = str(payload.get("From", ""))
        if payload.get("AccountSid") not in (None, self.config.account_sid):
            logger.warning("Dropped an SMS addressed to another Twilio account")
            return None
        if sender not in self.config.allowed:
            # Not answered either: a reply to a stranger is a cost too.
            logger.info("Dropped an SMS from a number not on the allow-list")
            return None
        sid = str(payload.get("MessageSid") or payload.get("SmsSid"))
        content = str(payload.get("Body", ""))

        stripped = content.strip()
        if stripped.startswith("!") and self._on_command is not None:
            parts = stripped.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=sender,
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=sid,
                )
            )
            return None

        if self._on_message is None:
            return None
        attachments, failures = await self._fetch_media(payload)
        await self._on_message(
            InboundMessage(
                channel_id=sender,
                channel_type="direct",
                sender_id=sender,
                sender_name=sender,
                content=content,
                message_ref=sid,
                attachments=attachments,
                attachment_failures=failures,
            )
        )
        return None

    async def _fetch_media(
        self, payload: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """The files of an MMS, downloaded from Twilio as the account.

        Twilio names each file by a `MediaUrl<n>` under this account's own API
        path; any other address is refused rather than fetched, so a payload
        cannot point Switch at a host of its choosing.
        """
        fetched: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        own_prefix = f"/2010-04-01/Accounts/{self.config.account_sid}/"
        for index in range(_media_count(payload)):
            url = str(payload.get(f"MediaUrl{index}") or "")
            mimetype = str(
                payload.get(f"MediaContentType{index}") or "application/octet-stream"
            )
            name = f"picture-{index + 1}{mimetypes.guess_extension(mimetype) or ''}"
            parts = urlsplit(url)
            if (
                parts.scheme != "https"
                or parts.hostname != "api.twilio.com"
                or not parts.path.startswith(own_prefix)
            ):
                failures.append(
                    AttachmentFailure(
                        filename=name, reason="Twilio gave no address for it."
                    )
                )
                continue
            try:
                async with self._client(self.config) as client:
                    response = await client.get(url, follow_redirects=True)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                failures.append(
                    AttachmentFailure(
                        filename=name,
                        reason=f"Could not download it from Twilio: {exc}",
                    )
                )
                continue
            if len(response.content) > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=name, reason="It is larger than Switch accepts."
                    )
                )
                continue
            fetched.append(
                Attachment(filename=name, mimetype=mimetype, data=response.content)
            )
        return fetched, failures

    # ── Outbound ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Text `content` to the conversation's number, as `sender_name`.

        SMS has one sender, the Twilio number, so the agent's name opens the
        text. The reply is capped at the connection's segment limit and split
        into pieces Twilio accepts; the ref is the first piece's MessageSid.
        """
        if channel_id not in self.config.allowed:
            raise BridgeOperationError(
                "Switch only texts the numbers on this connection's allow-list."
            )
        body = f"{sender_name}: {content}" if sender_name else content
        body = cap_to_segments(body, self.config.max_segments_per_reply)
        first: str | None = None
        for piece in split_body(body):
            sent = await self._call(
                self.config,
                "POST",
                "/Messages.json",
                data={
                    "From": self.config.phone_number,
                    "To": channel_id,
                    "Body": piece,
                },
            )
            first = first or str(sent.get("sid"))
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        # A sent SMS cannot be changed, and texting a correction costs again.
        return None

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        # A delivered SMS cannot be taken back from the phone.
        return None

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # SMS has no typing indicator, and a "working on it" text would cost a
        # message on every turn.
        return None

    # ── Conversations ───────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "SMS cannot create conversations: a room appears when someone on "
            "the allow-list texts the number."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents share the one Twilio number; there is no membership to change.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        # A conversation is one phone number: nobody else can be added to it,
        # so everyone asked for is handed back for the caller to disclose.
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # One number for every agent: replies are labelled with the name instead.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        """The agent a new conversation starts with: the connection's default."""
        return [self.config.default_agent] if self.config.default_agent else []

    # ── Markup ──────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return _plain_text(content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


def _media_count(payload: dict[str, Any]) -> int:
    try:
        return max(int(payload.get("NumMedia") or 0), 0)
    except (TypeError, ValueError):
        return 0

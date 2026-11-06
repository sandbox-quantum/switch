from __future__ import annotations

import logging
import mimetypes
import re
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, ClassVar

import httpx

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    ChannelNotBindable,
    PlatformAdapter,
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
from switch_core.bridges.collaboration.session.renderers import Markup
from switch_core.bridges.collaboration.session.renderers.neutral import turn_status
from switch_core.bridges.collaboration.sms.budget import HourlyBudget
from switch_core.bridges.collaboration.sms.client import (
    DELIVERY_ERRORS,
    OPTED_OUT,
    MediaRefused,
    MediaTooLarge,
    TwilioClient,
    TwilioError,
    error_page,
)
from switch_core.bridges.collaboration.sms.config import (
    SmsConnectionConfig,
    normalize_number,
)
from switch_core.bridges.collaboration.sms.formatting import to_gsm_friendly, to_sms
from switch_core.bridges.collaboration.sms.segments import count_segments, fit_reply
from switch_core.bridges.collaboration.sms.signature import (
    SIGNATURE_HEADER,
    parse_form,
    verify_signature,
)
from switch_core.clients.admin_messages import AdminMessageType

logger = logging.getLogger(__name__)

_MAX_MEDIA = 10

# Twilio answers these words itself and changes whether the person can be
# messaged. They are an instruction to Twilio, not a message to an agent. "yes"
# also opts back in, and is left out because a person says it to agents.
_TWILIO_KEYWORDS = frozenset(
    {
        "stop",
        "stopall",
        "unsubscribe",
        "cancel",
        "end",
        "quit",
        "revoke",
        "optout",
        "start",
        "unstop",
        "help",
        "info",
    }
)

# Delivery failed for good; every other status is progress.
_FAILED_STATUSES = frozenset({"failed", "undelivered"})

# A notice core opens with an emoji would otherwise cost UCS-2 for the whole text.
_NOTICE_EMOJI = re.compile("[\U0001f000-\U0001faff☀-➿️]+ ?")

# A notice nobody on a phone needs, and a paid text every time an agent restarts.
_ADMIN_TYPES_NOT_SENT = frozenset({AdminMessageType.AGENT_LIFECYCLE.value})

_BUDGET_SPENT = (
    "Switch has paused texts to this number for up to an hour, because the "
    "connection's hourly limit was reached. See the room in Switch Console."
)

# How long a card's text may be. A card is sent whole, since one cut short can't
# be answered, so this is what keeps a card's cost bounded.
_CARD_LIMIT = 600

_NOT_SENT_PREFIX = "not-sent:"
_TURN_REF_PREFIX = "turn:"


def _tail(number: str) -> str:
    """A number as a log or a display name may show it."""
    return f"...{number[-4:]}"


class _PlainMarkup(Markup):
    """SMS has no marks, so a card's bold and code are the words alone."""

    def bold(self, text: str) -> str:
        return text

    def code(self, text: str) -> str:
        return text


PLAIN_MARKUP = _PlainMarkup()


class SmsAdapter(PlatformAdapter):
    """SMS collaboration bridge adapter, on the operator's own Twilio number.

    Every chat is one person and the number, named by the person's phone
    number. A person starts a chat by texting, and an agent can start one by
    binding a room to an allowed number. Only allowed numbers are read or
    texted, so a stranger can't run up costs.

    Single identity: every agent texts from the one number, so the agent's name
    opens each message.

    Inbound arrives by webhook on this connection's own address, proved by
    Twilio's signature under the Auth Token. Outbound goes through the REST API.
    The address is not set on the number from here: the number may already be
    serving another application, so the operator pastes it in deliberately.

    What SMS cannot do, and what happens instead:

    - No threads. Everything is one flat conversation.
    - No edits or deletes, so a turn is not drawn at all and a card is posted
      once. A card is answered by texting the handle it prints.
    - No typing or reactions, and a "working" text would cost money, so the
      person sees nothing until the reply.
    - No sending files. Twilio fetches outbound media from a public address,
      which an adapter cannot offer, so a text names the file instead.
    """

    display_name: ClassVar[str] = "SMS (Twilio)"
    receives_webhooks: ClassVar[bool] = True
    # Holds no connection open: every event arrives at the webhook address.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    # A number is known only once it has texted.
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    # Without this no request card is shown, and an agent's approval waits forever.
    draws_session_activity: ClassVar[bool] = True
    # A problem somebody has to act on gets its own text, because no text here
    # can be edited to say so.
    separate_attention_slot: ClassVar[bool] = True
    every_message_notifies_members: ClassVar[bool] = True

    def __init__(self, *, config: SmsConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._http = httpx.AsyncClient(timeout=30)
        self._client = TwilioClient(
            http=self._http,
            account_sid=config.account_sid,
            auth_token=config.auth_token,
        )
        self._budget = HourlyBudget(config.max_segments_per_hour)
        self._told_budget_spent: set[str] = set()
        self._told_opted_out: set[str] = set()
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None

    # ── Declarations ─────────────────────────────────────────────────────────

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """A number has one webhook address, so it serves one connection."""
        return (
            f"Twilio number {normalize_number(str(connection_config['phone_number']))}"
        )

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Check the Auth Token opens this account, and that the account owns
        the number and the number can text."""
        config = SmsConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(timeout=30) as http:
            client = TwilioClient(
                http=http,
                account_sid=config.account_sid,
                auth_token=config.auth_token,
            )
            try:
                account = await client.account()
                if account.get("status") != "active":
                    raise BridgeCredentialError(
                        f"This Twilio account is {account.get('status')}, not "
                        "active, so it can't send or receive messages."
                    )
                number = await client.incoming_number(config.phone_number)
            except TwilioError as exc:
                if exc.status in (401, 403):
                    raise BridgeCredentialError(
                        f"Twilio refused these credentials: {exc.message}. Check the "
                        "Account SID and the primary Auth Token in the Twilio Console."
                    ) from exc
                raise BridgeOperationError(
                    f"Twilio could not check the credentials: {exc}. Try again."
                ) from exc
            except httpx.RequestError as exc:
                raise BridgeCredentialError(
                    "Could not reach Twilio to check the credentials: "
                    f"{type(exc).__name__}. Try again."
                ) from exc
        if number is None:
            raise BridgeCredentialError(
                f"{config.phone_number} is not a phone number on this Twilio "
                "account. Use one listed under Phone Numbers → Active Numbers."
            )
        if not (number.get("capabilities") or {}).get("sms"):
            raise BridgeCredentialError(
                f"{config.phone_number} can't send or receive SMS. Twilio lists "
                "each number's capabilities under Phone Numbers → Active Numbers."
            )

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        number = normalize_number(str(connection_config["phone_number"]))
        return f"Text `!link-account {code}` from that phone to {number}."

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, TwilioError):
            return "auth_failed" if exc.status in (401, 403) else "platform_error"
        if isinstance(exc, httpx.RequestError):
            return "network"
        return None

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        """Opens nothing: Twilio delivers every event to the webhook address."""
        if self.webhook_url is None:
            # The lifecycle doesn't call `stop` on a bridge that failed to start.
            await self._http.aclose()
            raise BridgeOperationError(
                "This deployment has no public https address "
                "(MESSAGING_PUBLIC_URL), so Twilio has nowhere to deliver texts "
                "and none could ever arrive. Set it, then start the connection "
                "again."
            )
        self._on_message = on_message
        self._on_command = on_command

    async def stop(self) -> None:
        await self._http.aclose()

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method != "POST":
            raise WebhookAuthenticityError(
                f"Twilio delivers by POST, not {request.method}"
            )
        if self.webhook_url is None:
            raise WebhookAuthenticityError(
                "This connection has no public address to check a signature against"
            )
        verify_signature(
            self._config.auth_token,
            self.webhook_url,
            request.body,
            request.headers.get(SIGNATURE_HEADER, ""),
        )
        account = dict(parse_form(request.body)).get("AccountSid")
        if account != self._config.account_sid:
            raise WebhookAuthenticityError(
                "The request is not for this connection's Twilio account"
            )

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        try:
            fields = dict(parse_form(request.body))
        except ValueError as exc:
            raise WebhookPayloadError("The webhook body is not a form") from exc
        sid = fields.get("MessageSid")
        if not sid:
            raise WebhookPayloadError("The webhook carries no MessageSid")
        status = fields.get("MessageStatus")
        return InboundWebhook(
            envelope_type="status" if status else "message",
            payload=fields,
            handshake=None,
            # One message reports several statuses, each its own event.
            external_event_id=f"{sid}:{status}" if status else sid,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        if envelope_type == "status":
            self._log_status(payload)
            return
        await self._dispatch_message(payload)

    def _log_status(self, fields: dict[str, Any]) -> None:
        status = fields.get("MessageStatus")
        if status not in _FAILED_STATUSES:
            logger.debug("SMS %s is %s", fields.get("MessageSid"), status)
            return
        code = fields.get("ErrorCode")
        logger.error(
            "Twilio could not deliver SMS %s to %s: %s, error %s (%s). See %s",
            fields.get("MessageSid"),
            _tail(str(fields.get("To", ""))),
            status,
            code,
            DELIVERY_ERRORS.get(str(code), "see the page for what it means"),
            error_page(code),
        )

    async def _dispatch_message(self, fields: dict[str, Any]) -> None:
        sid = str(fields["MessageSid"])
        sender = str(fields.get("From", ""))
        if fields.get("To") != self._config.phone_number:
            logger.warning(
                "Ignoring SMS %s sent to another number than this connection's.",
                sid,
            )
            return
        if sender not in self._config.allowed_numbers:
            logger.warning(
                "Ignoring SMS %s from %s, which is not an allowed number. Add it "
                "to the connection's allowed numbers to let it in.",
                sid,
                _tail(sender),
            )
            return
        text = str(fields.get("Body", ""))
        if fields.get("OptOutType") == "START" or text.strip().lower() in {
            "start",
            "unstop",
        }:
            self._told_opted_out.discard(sender)
        if fields.get("OptOutType") or text.strip().lower() in _TWILIO_KEYWORDS:
            logger.info(
                "Not relaying SMS %s from %s: Twilio handles this keyword itself.",
                sid,
                _tail(sender),
            )
            return
        if self._on_message is None or self._on_command is None:
            logger.error("SMS %s arrived before the bridge started; not relayed.", sid)
            return
        name = f"sms-{sender[-4:]}"
        parsed = _parse_command(text)
        if parsed is not None and not _media_count(fields):
            command, args = parsed
            await self._on_command(
                InboundCommand(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=name,
                    command=command,
                    args=args,
                    message_ref=sid,
                    root_id=None,
                    channel_name=f"SMS {_tail(sender)}",
                )
            )
            return
        attachments, failures = await self._fetch_attachments(fields, sid)
        await self._on_message(
            InboundMessage(
                channel_id=sender,
                channel_type="direct",
                sender_id=sender,
                sender_name=name,
                content=text,
                message_ref=sid,
                root_id=None,
                channel_name=f"SMS {_tail(sender)}",
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    async def _fetch_attachments(
        self, fields: dict[str, Any], sid: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for index in range(_media_count(fields)):
            mimetype = str(
                fields.get(f"MediaContentType{index}") or "application/octet-stream"
            )
            extension = mimetypes.guess_extension(mimetype.split(";")[0]) or ""
            filename = f"mms_{sid}_{index}{extension}"
            url = fields.get(f"MediaUrl{index}")
            if not url:
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason="Twilio sent no address for it"
                    )
                )
                continue
            try:
                data = await self._client.download_media(
                    str(url), max_bytes=self._max_attachment_bytes
                )
            except MediaTooLarge as exc:
                logger.warning("SMS attachment %s is too large: %s", filename, exc)
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"over the {self._max_attachment_bytes} byte limit",
                    )
                )
                continue
            except (TwilioError, MediaRefused, httpx.HTTPError) as exc:
                logger.exception("Failed to download SMS attachment %s", filename)
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"download failed: {exc}"
                    )
                )
                continue
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
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
        """Text the person, with the agent's name first, within both limits.

        A reply over the per-reply limit is cut with a note saying so. Past the
        hourly limit nothing is sent but one notice saying that, until the
        window frees up again. A text that isn't sent still returns a reference:
        the message was handled, and another attempt would meet the same limit.
        """
        if not self._may_text(channel_id):
            return _not_sent()
        agent = await self.agent_rendering(sender_name)
        body = to_gsm_friendly(f"{agent.body_label}: {content}")
        remaining = self._budget.remaining(channel_id)
        if remaining <= 0:
            return await self._tell_budget_spent(channel_id)
        self._told_budget_spent.discard(channel_id)
        return await self._send_pieces(
            channel_id,
            fit_reply(body, min(self._config.max_segments_per_reply, remaining)),
        )

    def _may_text(self, number: str) -> bool:
        if number in self._config.allowed_numbers:
            return True
        logger.error(
            "Not texting %s: it is not one of this connection's allowed numbers.",
            _tail(number),
        )
        return False

    async def _tell_budget_spent(self, number: str) -> str:
        logger.error(
            "Not texting %s: the connection's limit of %d segments an hour is "
            "reached, and the message is dropped from SMS. It is still in the room.",
            _tail(number),
            self._config.max_segments_per_hour,
        )
        if number in self._told_budget_spent:
            return _not_sent()
        ref = await self._send_pieces(number, [_BUDGET_SPENT])
        self._told_budget_spent.add(number)
        return ref

    async def _send_pieces(self, number: str, pieces: list[str]) -> str:
        """Send each piece in order and return the first one's SID.

        Twilio refusing the first piece raises, so the message can be tried
        again. Refusing a later one is logged instead, since trying again would
        repeat what the person already has.
        """
        assert self.webhook_url is not None  # `start` refuses to run without it
        first: str | None = None
        for piece in pieces:
            # Counted before the send, so concurrent replies can't overrun the hour.
            self._budget.spend(number, count_segments(piece))
            try:
                sid = await self._client.send_message(
                    from_number=self._config.phone_number,
                    to=number,
                    body=piece,
                    status_callback=self.webhook_url,
                )
            except TwilioError as exc:
                if exc.code == OPTED_OUT:
                    log = (
                        logger.warning
                        if number in self._told_opted_out
                        else logger.error
                    )
                    log(
                        "Not texting %s: they opted out by texting STOP, and "
                        "Twilio won't message them until they text START. The "
                        "message is still in the room.",
                        _tail(number),
                    )
                    self._told_opted_out.add(number)
                    return first or _not_sent()
                if first is None:
                    raise
                logger.error(
                    "Twilio refused part of a reply to %s after the first part "
                    "went out, so the rest is missing from SMS: %s",
                    _tail(number),
                    exc,
                )
                return first
            except httpx.HTTPError as exc:
                if first is None:
                    raise
                logger.error(
                    "Lost Twilio partway through a reply to %s, so the rest is "
                    "missing from SMS: %s",
                    _tail(number),
                    type(exc).__name__,
                )
                return first
            first = first or sid
        assert first is not None
        return first

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        if message_type in _ADMIN_TYPES_NOT_SENT:
            logger.debug("Not texting a %s notice", message_type)
            return _not_sent()
        return await super().admin_message(
            channel_id,
            _NOTICE_EMOJI.sub("", content),
            thread_root_id,
            message_type=message_type,
            drawn=drawn,
        )

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """One text naming every file, not a paid text for each of them."""
        names = ", ".join(file.filename for file in files)
        note = f"_sent files that can't be relayed by SMS: {names}_"
        body = f"{caption}\n{note}" if caption else note
        return await self.send_message(
            channel_id, sender_name, self.translate_outbound(body), thread_root_id
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """A sent SMS can't be edited, so the original stands."""
        logger.warning("Not editing SMS %s: a sent SMS can't be edited.", message_ref)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        """A sent SMS can't be deleted, so it stays on the person's phone."""
        logger.warning("Not deleting SMS %s: a sent SMS can't be deleted.", message_ref)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Nothing: SMS has no typing indicator."""

    # ── Session activity ─────────────────────────────────────────────────────

    def rich_markup(self) -> Markup:
        return PLAIN_MARKUP

    def rich_fallback_limit(self) -> int:
        return _CARD_LIMIT

    def rich_fallback_text(self, content: RichContent) -> str:
        """The base text, except that a problem somebody has to act on says what
        the problem is, where the base would say "Working…"."""
        if isinstance(content, TurnActivity) and content.error_summary:
            return turn_status(
                content.items,
                content.turn,
                escape=self._rich_escape,
                limit=self.rich_fallback_limit(),
                markup=self.rich_markup(),
                error_summary=content.error_summary,
                tool_detail=False,
            )
        return super().rich_fallback_text(content)

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Text a request card or an attention message; a turn is not posted.

        A turn's message would be redrawn as it moves, and it would repeat the
        reply, each at a cost. The reference returned for one names the turn,
        never a text. A card is sent whole, and the hourly limit holds for cards
        and attention messages too, since an agent stuck asking would otherwise
        spend without bound. Past it the person gets the one paused notice and
        the card stays answerable in the room.
        """
        if isinstance(content, TurnActivity) and not content.status_only:
            return f"{_TURN_REF_PREFIX}{content.turn.turn_id}"
        if not self._may_text(channel_id):
            return _not_sent()
        text = self.rich_fallback_text(content)
        try:
            if self._budget.remaining(channel_id) <= 0:
                return await self._tell_budget_spent(channel_id)
            agent = await self.agent_rendering(agent_name)
            body = to_gsm_friendly(f"{agent.body_label}: {text}")
            return await self._send_pieces(channel_id, [body])
        except (TwilioError, httpx.HTTPError) as error:
            raise RichContentFailed(
                f"Twilio could not send the text to {_tail(channel_id)}: {error}",
                text=text,
            ) from error

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Nothing is redrawn: a sent SMS can't be edited. Texting it again
        would cost money on every redraw and after every restart."""
        logger.debug("Not redrawing %s: a sent SMS can't be edited", message_ref)

    # ── Channels and identity ────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "SMS has no channels to create. A room is made when an allowed number "
            "first texts, or by binding a room to an allowed number."
        )

    async def require_bindable_channel(self, channel_id: str) -> None:
        """Binding a room to a number is how agents text someone first, so the
        allow-list has to hold for it as well."""
        if channel_id not in self._config.allowed_numbers:
            raise ChannelNotBindable(
                f"{_tail(channel_id)} is not one of this connection's allowed "
                "numbers. Add it there first, in E.164 format."
            )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        """Nothing: every agent texts from the one number."""

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """An SMS chat is one person and the number, so nobody can be added."""
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        """Nothing: agents have no identity of their own on SMS."""

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        """Nothing: agents have no identity of their own on SMS."""

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        """The configured agent. A first text would otherwise make a room with
        no agents in it, and a paid notice saying so."""
        return [self._config.default_agent]

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_sms(content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


def _not_sent() -> str:
    """A reference for a message that was handled by not texting it."""
    return f"{_NOT_SENT_PREFIX}{uuid.uuid4().hex}"


def _media_count(fields: dict[str, Any]) -> int:
    """How many files a message carries, within what Twilio can send."""
    raw = str(fields.get("NumMedia", "0"))
    return min(int(raw), _MAX_MEDIA) if raw.isdecimal() else 0


def _parse_command(text: str) -> tuple[str, str] | None:
    """A `!name args` text as its name and arguments, or None if it isn't one."""
    stripped = text.strip()
    if not stripped.startswith("!"):
        return None
    parts = stripped[1:].split(None, 1)
    if not parts:
        return None
    return parts[0], parts[1] if len(parts) > 1 else ""

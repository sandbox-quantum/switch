from __future__ import annotations

import hashlib
import hmac
import json
import logging
import mimetypes
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

import httpx
from pydantic import Field, ValidationInfo, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
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
from switch_core.bridges.collaboration.session.renderers import Markup
from switch_core.bridges.collaboration.session.renderers.neutral import turn_status
from switch_core.bridges.collaboration.whatsapp.chunking import (
    MAX_CAPTION,
    MAX_MESSAGE,
    chunk_message,
)
from switch_core.bridges.collaboration.whatsapp.client import (
    REENGAGEMENT_REQUIRED,
    TOKEN_INVALID,
    MediaTooLarge,
    WhatsAppGraphClient,
    WhatsAppGraphError,
)
from switch_core.bridges.collaboration.whatsapp.formatting import (
    to_markdown,
    to_whatsapp,
)

logger = logging.getLogger(__name__)

SIGNATURE_HEADER = "x-hub-signature-256"

#: Said wherever a reply is refused for the 24-hour customer-service window.
WINDOW_CLOSED = (
    "WhatsApp refused this reply: a business can only send free-form messages "
    "within 24 hours of the person's last message to it, and their last "
    "message is older than that. It will go through once they write again. "
    "Switch does not send WhatsApp template messages, which are the only thing "
    "WhatsApp allows outside that window."
)

# The Cloud API's media limits, by the message type a file is sent as. A type
# WhatsApp does not play inline is sent as a document, which carries any file.
_IMAGE_TYPES = frozenset({"image/jpeg", "image/png"})
_AUDIO_TYPES = frozenset(
    {"audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"}
)
_VIDEO_TYPES = frozenset({"video/mp4", "video/3gpp"})
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_AUDIO_BYTES = 16 * 1024 * 1024
MAX_VIDEO_BYTES = 16 * 1024 * 1024
MAX_DOCUMENT_BYTES = 100 * 1024 * 1024

_MEDIA_TYPES = ("image", "video", "audio", "document", "sticker")

# Marks the message an agent is working on, as Slack and Telegram do.
_WORKING_REACTION = "\U0001f440"

_TURN_REF_PREFIX = "turn:"


def _media_kind(mimetype: str) -> tuple[str, int]:
    """The message type a file goes out as, and WhatsApp's size limit for it."""
    if mimetype in _IMAGE_TYPES:
        return "image", MAX_IMAGE_BYTES
    if mimetype in _AUDIO_TYPES:
        return "audio", MAX_AUDIO_BYTES
    if mimetype in _VIDEO_TYPES:
        return "video", MAX_VIDEO_BYTES
    return "document", MAX_DOCUMENT_BYTES


def _megabytes(size: int) -> str:
    return f"{size / (1024 * 1024):.1f} MB"


def sign(app_secret: str, body: bytes) -> str:
    """What Meta puts in `SIGNATURE_HEADER` for a webhook body."""
    digest = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def appsecret_proof(app_secret: str, access_token: str) -> str:
    """The access token signed with the app secret, as Graph checks it."""
    return hmac.new(
        app_secret.encode(), access_token.encode(), hashlib.sha256
    ).hexdigest()


class _WhatsAppMarkup(Markup):
    """WhatsApp's spelling of the marks a card makes: one star for bold, and a
    code span that cannot be fenced longer, so a literal holding a backtick
    goes out as plain text."""

    def bold(self, text: str) -> str:
        return f"*{text}*"

    def code(self, text: str) -> str:
        return text if "`" in text else f"`{text}`"


WHATSAPP_MARKUP = _WhatsAppMarkup()


class WhatsAppConnectionConfig(BridgeConnectionConfig):
    access_token: str = Field(
        title="Access token",
        description=(
            "A permanent token for a system user of your Meta business, with "
            "the whatsapp_business_messaging and whatsapp_business_management "
            "permissions. Business settings → Users → System users → Generate "
            "new token. The temporary token on the app's API Setup page also "
            "works, but expires after 24 hours."
        ),
    )
    phone_number_id: str = Field(
        title="Phone number ID",
        description=(
            "The numeric ID of the business phone number, not the number "
            "itself. App dashboard → WhatsApp → API Setup, under the 'From' "
            "number."
        ),
    )
    app_secret: str = Field(
        title="App secret",
        description=(
            "Meta signs every webhook with it, and Switch refuses a webhook "
            "that is not signed with it. App dashboard → App settings → Basic "
            "→ App secret."
        ),
    )
    verify_token: str = Field(
        title="Verify token",
        description=(
            "Any string you choose. Enter the same string as the Verify token "
            "in the app's WhatsApp → Configuration → Webhook settings; Meta "
            "sends it back when it checks the webhook address."
        ),
    )

    @field_validator("access_token", "phone_number_id", "app_secret", "verify_token")
    @classmethod
    def _not_blank(cls, value: str, info: ValidationInfo) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError(f"{info.field_name} is empty.")
        return stripped

    @field_validator("phone_number_id")
    @classmethod
    def _numeric_id(cls, value: str) -> str:
        if not value.isdigit():
            raise ValueError(
                "phone_number_id is the numeric ID shown under the 'From' "
                "number on the app's WhatsApp → API Setup page, not the phone "
                "number itself."
            )
        return value


class WhatsAppAdapter(PlatformAdapter):
    """WhatsApp collaboration bridge adapter, on the WhatsApp Business Cloud API.

    One business phone number, on the operator's own Meta app. Every chat is
    one person writing to that number: WhatsApp gives a business no way to
    start a chat or create a group from the API, so a chat's room is made when
    the person first writes. Group messages are not bridged.

    Single identity: every agent posts as the business number, which WhatsApp
    shows under the business profile's name, so the agent's name is written at
    the head of each message as Telegram's adapter does.

    Inbound arrives by webhook on this connection's own address, proved by an
    HMAC of the body under the app secret; Meta first checks the address with
    a GET carrying the verify token. Outbound goes through the Graph API.

    What WhatsApp cannot do, and what happens instead:

    - No threads. A reply sent under a thread quotes the message it answers,
      and a person's quote-reply arrives with the quoted message as its root.
    - No edits or deletes of a sent message, so a turn is not drawn as a
      message at all: the person sees a 👀 reaction and the typing indicator
      on their message while the agent works, then the agent's reply. A
      request card is posted once and not redrawn when it is answered.
    - Free-form replies only within 24 hours of the person's last message.
      Outside it WhatsApp refuses the send, and the refusal says why.
    """

    display_name: ClassVar[str] = "WhatsApp"
    docs_slug: ClassVar[str | None] = None
    receives_webhooks: ClassVar[bool] = True
    # The person starts the chat; a business cannot.
    supports_channel_creation: ClassVar[bool] = False
    # The business only knows the people who have written to it.
    supports_directory_search: ClassVar[bool] = False
    # WhatsApp links only a bare http(s) URL.
    renders_custom_url_schemes: ClassVar[bool] = False

    draws_session_activity: ClassVar[bool] = True

    #: A problem somebody has to act on gets its own message, because no
    #: message here can be edited to say so.
    separate_attention_slot: ClassVar[bool] = True

    #: Every chat is one person and the business, and every message notifies.
    notifies_only_by_mention: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True

    supports_activity_reactions: ClassVar[bool] = True

    #: Every agent reacts as the one business number.
    activity_reactions_per_agent: ClassVar[bool] = False

    def __init__(self, *, config: WhatsAppConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._http = httpx.AsyncClient(timeout=30)
        self._client = WhatsAppGraphClient(
            http=self._http,
            access_token=config.access_token,
            phone_number_id=config.phone_number_id,
        )

    # ── Declarations ─────────────────────────────────────────────────────────

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """One business number is connected at most once: Meta delivers its
        events to one address, so a second bridge on it would hear nothing."""
        return f"WhatsApp phone number {connection_config['phone_number_id']}"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Read the phone number back with the token, proved with the app secret.

        One call checks three of the four fields: the token is accepted, it
        reaches this phone number, and the app secret is the app's own. The
        verify token is checked by Meta itself, when the address is saved.
        """
        config = WhatsAppConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(timeout=30) as http:
            client = WhatsAppGraphClient(
                http=http,
                access_token=config.access_token,
                phone_number_id=config.phone_number_id,
            )
            try:
                await client.phone_number(
                    appsecret_proof=appsecret_proof(
                        config.app_secret, config.access_token
                    )
                )
            except WhatsAppGraphError as exc:
                raise BridgeCredentialError(
                    f"WhatsApp refused these credentials: {exc}. Check the "
                    "access token, the phone number ID and the app secret "
                    "against your Meta app."
                ) from exc
            except httpx.RequestError as exc:
                raise BridgeCredentialError(
                    "Could not reach the WhatsApp Graph API to check the "
                    f"credentials: {exc!r}. Try again."
                ) from exc

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WhatsAppGraphError):
            if exc.code == TOKEN_INVALID or exc.status == 401:
                return "auth_failed"
            return "platform_error"
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
        """Opens nothing: WhatsApp delivers every event to the webhook address."""
        if self.webhook_url is None:
            raise BridgeOperationError(
                "This deployment has no public https address "
                "(MESSAGING_PUBLIC_URL), so Meta has nowhere to deliver "
                "WhatsApp messages and none could ever arrive. Set it, then "
                "start the connection again."
            )
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

    async def stop(self) -> None:
        await self._http.aclose()

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method == "GET":
            mode = request.query.get("hub.mode", "")
            token = request.query.get("hub.verify_token", "")
            if mode != "subscribe" or not hmac.compare_digest(
                token.encode(), self._config.verify_token.encode()
            ):
                raise WebhookAuthenticityError(
                    "The address check did not carry this connection's verify token"
                )
            return
        if request.method != "POST":
            raise WebhookAuthenticityError(
                f"WhatsApp delivers by GET and POST, not {request.method}"
            )
        given = request.headers.get(SIGNATURE_HEADER, "")
        if not given.startswith("sha256="):
            raise WebhookAuthenticityError("The request carries no sha256 signature")
        expected = sign(self._config.app_secret, request.body)
        if not hmac.compare_digest(given.encode(), expected.encode()):
            raise WebhookAuthenticityError(
                "The signature does not match this connection's app secret"
            )

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if request.method == "GET":
            challenge = request.query.get("hub.challenge")
            if not challenge:
                raise WebhookPayloadError("The address check carries no hub.challenge")
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
            raise WebhookPayloadError("The webhook body is not JSON") from exc
        values = _change_values(payload)
        messages = [m for v in values for m in v.get("messages") or []]
        statuses = [s for v in values for s in v.get("statuses") or []]
        errors = [e for v in values for e in v.get("errors") or []]
        if messages:
            envelope_type = "message"
            event_id = _required_str(messages[0], "id", "message")
        elif statuses:
            envelope_type = "status"
            event_id = (
                f"{_required_str(statuses[0], 'id', 'status')}:"
                f"{_required_str(statuses[0], 'status', 'status')}"
            )
        elif errors:
            envelope_type = "error"
            event_id = None
        else:
            envelope_type = "unhandled"
            event_id = None
        return InboundWebhook(
            envelope_type=envelope_type,
            payload=payload,
            handshake=None,
            external_event_id=event_id,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        """Relay the messages a webhook carries and log its statuses and errors.

        A webhook for a field this bridge does not read is answered and
        ignored with a warning rather than refused: Meta retries a refused
        delivery for days, and the retries would say nothing new.
        """
        if envelope_type == "unhandled":
            logger.warning(
                "Ignoring a WhatsApp webhook with no messages, statuses or "
                "errors (fields: %s). Switch reads only the 'messages' webhook "
                "field; unsubscribe the Meta app from any other.",
                ", ".join(_change_fields(payload)),
            )
            return
        for value in _change_values(payload):
            metadata = value.get("metadata") or {}
            if str(metadata.get("phone_number_id")) != self._config.phone_number_id:
                logger.warning(
                    "Ignoring a WhatsApp event for phone number %s on the "
                    "connection for %s. The Meta app delivers several numbers' "
                    "events to this address; connect each on its own app.",
                    metadata.get("phone_number_id"),
                    self._config.phone_number_id,
                )
                continue
            for error in value.get("errors") or []:
                logger.error("WhatsApp reported an error: %s", _describe_error(error))
            for status in value.get("statuses") or []:
                self._log_status(status)
            business_number = _digits(str(metadata.get("display_phone_number", "")))
            contacts = value.get("contacts") or []
            for message in value.get("messages") or []:
                await self._dispatch_message(message, contacts, business_number)

    def _log_status(self, status: dict[str, Any]) -> None:
        """Say when WhatsApp could not deliver something this bridge sent.

        WhatsApp often accepts a send and refuses it afterwards, in a status
        callback. The room has no message to attach that to, so it is said
        here, at error, with WhatsApp's reason.
        """
        if status.get("status") != "failed":
            logger.debug(
                "WhatsApp message %s is %s", status.get("id"), status.get("status")
            )
            return
        recipient = status.get("recipient_user_id") or status.get("recipient_id")
        for error in status.get("errors") or [{}]:
            if error.get("code") == REENGAGEMENT_REQUIRED:
                logger.error(
                    "WhatsApp message %s to %s was not delivered. %s",
                    status.get("id"),
                    recipient,
                    WINDOW_CLOSED,
                )
                continue
            logger.error(
                "WhatsApp message %s to %s was not delivered: %s",
                status.get("id"),
                recipient,
                _describe_error(error),
            )

    async def _dispatch_message(
        self,
        message: dict[str, Any],
        contacts: list[dict[str, Any]],
        business_number: str,
    ) -> None:
        sender = message.get("from_user_id") or message.get("from")
        wamid = message.get("id")
        if not sender or not wamid:
            logger.warning(
                "Ignoring a WhatsApp message with no sender or id (type %s)",
                message.get("type"),
            )
            return
        sender = str(sender)
        if message.get("group_id"):
            logger.warning(
                "Ignoring WhatsApp message %s from a group: this bridge relays "
                "one-to-one chats with the business number only.",
                wamid,
            )
            return
        if business_number and _digits(str(message.get("from", ""))) == (
            business_number
        ):
            return
        kind = str(message.get("type", ""))
        if kind in ("reaction", "system", "request_welcome"):
            logger.debug("Not relaying WhatsApp %s message %s", kind, wamid)
            return

        profile_name = _profile_name(contacts, message)
        sender_name = _handle(profile_name, sender)
        root_id = (message.get("context") or {}).get("id")
        text = self._text_of(message, kind)

        if kind == "text" and text.strip().startswith("!"):
            parsed = _parse_command(text.strip())
            if parsed is not None and self._on_command is not None:
                name, args = parsed
                await self._on_command(
                    InboundCommand(
                        channel_id=sender,
                        channel_type="direct",
                        sender_id=sender,
                        sender_name=sender_name,
                        command=name,
                        args=args,
                        message_ref=str(wamid),
                        root_id=str(root_id) if root_id else None,
                        channel_name=profile_name,
                    )
                )
                await self._mark_read(str(wamid), typing=False)
                return

        if self._on_message is None:
            logger.error(
                "WhatsApp message %s arrived before the bridge started; it is "
                "not relayed.",
                wamid,
            )
            return
        attachments, failures = await self._fetch_attachments(message, kind)
        await self._on_message(
            InboundMessage(
                channel_id=sender,
                channel_type="direct",
                sender_id=sender,
                sender_name=sender_name,
                content=text,
                message_ref=str(wamid),
                root_id=str(root_id) if root_id else None,
                channel_name=profile_name,
                attachments=attachments,
                attachment_failures=failures,
            )
        )
        await self._mark_read(str(wamid), typing=False)

    def _text_of(self, message: dict[str, Any], kind: str) -> str:
        """What a message says, in WhatsApp's markup as the person wrote it;
        the bridge core reads it as Markdown with `translate_inbound`.

        A kind with no text of its own is described in words rather than
        dropped, so the room always sees that the person sent something.
        """
        if kind == "text":
            return str((message.get("text") or {}).get("body", ""))
        if kind in _MEDIA_TYPES:
            return str((message.get(kind) or {}).get("caption", ""))
        if kind == "location":
            location = message.get("location") or {}
            place = ", ".join(
                str(part)
                for part in (location.get("name"), location.get("address"))
                if part
            )
            coordinates = f"{location.get('latitude')},{location.get('longitude')}"
            return (
                f"_shared a location: {place + ' ' if place else ''}"
                f"https://maps.google.com/?q={coordinates}_"
            )
        if kind == "contacts":
            names = [
                str((card.get("name") or {}).get("formatted_name", "a contact"))
                for card in message.get("contacts") or []
            ]
            return f"_shared contact cards: {', '.join(names) or 'none readable'}_"
        if kind == "interactive":
            interactive = message.get("interactive") or {}
            reply = interactive.get("button_reply") or interactive.get("list_reply")
            if isinstance(reply, dict) and reply.get("title"):
                return str(reply["title"])
        if kind == "button":
            button = message.get("button") or {}
            if button.get("text"):
                return str(button["text"])
        if kind == "unsupported":
            reason = "; ".join(
                _describe_error(error) for error in message.get("errors") or []
            )
            return (
                "_sent a message WhatsApp does not deliver to businesses"
                f"{': ' + reason if reason else ''}_"
            )
        logger.warning(
            "WhatsApp message %s is a %r message, which this bridge cannot read",
            message.get("id"),
            kind,
        )
        return f"_sent a WhatsApp {kind or 'unknown'} message that Switch cannot show_"

    async def _fetch_attachments(
        self, message: dict[str, Any], kind: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download a message's file, or say why it could not be relayed.

        Two steps, as the Cloud API has it: the media id gives a short-lived
        URL, and the URL gives the bytes, both with the access token."""
        if kind not in _MEDIA_TYPES:
            return [], []
        media = message.get(kind) or {}
        media_id = media.get("id")
        mimetype = str(media.get("mime_type") or "application/octet-stream")
        filename = str(
            media.get("filename")
            or f"{kind}_{media_id}{mimetypes.guess_extension(mimetype.split(';')[0]) or ''}"
        )
        if not media_id:
            return [], [
                AttachmentFailure(filename=filename, reason="WhatsApp sent no media id")
            ]
        cap = self._max_attachment_bytes
        try:
            info = await self._client.media_info(str(media_id))
            size = info.get("file_size")
            if isinstance(size, int) and size > cap:
                logger.warning(
                    "WhatsApp attachment %s is %d bytes, over the %d cap",
                    filename,
                    size,
                    cap,
                )
                return [], [
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{size} bytes exceeds the {cap} byte limit",
                    )
                ]
            data = await self._client.download(str(info["url"]), max_bytes=cap)
        except MediaTooLarge as exc:
            logger.warning("WhatsApp attachment %s: %s", filename, exc)
            return [], [AttachmentFailure(filename=filename, reason=str(exc))]
        except (WhatsAppGraphError, httpx.HTTPError, KeyError) as exc:
            logger.exception("Failed to download WhatsApp attachment %s", filename)
            return [], [
                AttachmentFailure(filename=filename, reason=f"download failed: {exc}")
            ]
        return [Attachment(filename=filename, mimetype=mimetype, data=data)], []

    async def _mark_read(self, message_id: str, *, typing: bool) -> None:
        """Best effort: a read receipt that fails costs the person a blue tick,
        not the message, so it is logged and the turn goes on."""
        try:
            await self._client.mark_read(message_id, typing=typing)
        except (WhatsAppGraphError, httpx.HTTPError) as exc:
            logger.warning(
                "Could not mark WhatsApp message %s read: %s", message_id, exc
            )

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the business number with the agent's name at the head.

        WhatsApp shows the business profile's name on every message, and has
        no per-message identity, so the agent's name is part of the body. A
        body over WhatsApp's limit is sent as several messages in order; the
        first one's id is returned, and is the one a quote-reply threads to.
        """
        agent = await self.agent_rendering(sender_name)
        return await self._send_text(
            channel_id, _attribute(agent.body_label, content), thread_root_id
        )

    async def _send_text(
        self, channel_id: str, body: str, thread_root_id: str | None
    ) -> str:
        first: str | None = None
        for chunk in chunk_message(body):
            payload: dict[str, Any] = {
                "type": "text",
                "text": {"body": chunk, "preview_url": False},
            }
            ref = await self._send(
                channel_id, payload, thread_root_id if first is None else None
            )
            first = first or ref
        assert first is not None
        return first

    async def _send(
        self,
        channel_id: str,
        payload: dict[str, Any],
        thread_root_id: str | None,
    ) -> str:
        """Send one message to a chat, quoting `thread_root_id` when it is a
        WhatsApp message. Raises `BridgeOperationError` with the reason when
        the 24-hour window is closed, and `WhatsAppGraphError` for any other
        refusal."""
        addressed = {**_address(channel_id), **payload}
        if thread_root_id and thread_root_id.startswith("wamid."):
            addressed["context"] = {"message_id": thread_root_id}
        try:
            return await self._client.send(addressed)
        except WhatsAppGraphError as exc:
            if exc.code == REENGAGEMENT_REQUIRED:
                raise BridgeOperationError(WINDOW_CLOSED) from exc
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
        """Upload a file and send it as WhatsApp's own media message.

        A file over WhatsApp's limit for its kind, or one WhatsApp refuses, is
        replaced by a message in the chat saying which file and why, so it is
        never dropped silently. A caption WhatsApp cannot carry — over its
        limit, or on audio, which takes none — is sent as a message of its own
        just before the file.
        """
        kind, limit = _media_kind(mimetype)
        if len(data) > limit:
            logger.warning(
                "Not sending %s to WhatsApp chat %s: %d bytes is over WhatsApp's "
                "%d byte limit for %s files",
                filename,
                channel_id,
                len(data),
                limit,
                kind,
            )
            return await self._refuse_attachment(
                channel_id,
                sender_name,
                filename,
                caption,
                thread_root_id,
                f"{_megabytes(len(data))} is over WhatsApp's {_megabytes(limit)} "
                f"limit for {kind} files",
            )

        agent = await self.agent_rendering(sender_name)
        attributed = _attribute(
            agent.body_label, self.translate_outbound(caption or "")
        )
        overflow_ref: str | None = None
        if kind == "audio" or len(attributed) > MAX_CAPTION:
            overflow_ref = await self._send_text(channel_id, attributed, thread_root_id)
            attributed = ""
        try:
            media_id = await self._client.upload_media(
                filename=filename, mimetype=mimetype, data=data
            )
            media: dict[str, Any] = {"id": media_id}
            if attributed:
                media["caption"] = attributed
            if kind == "document":
                media["filename"] = filename
            ref = await self._send(
                channel_id,
                {"type": kind, kind: media},
                None if overflow_ref else thread_root_id,
            )
        except WhatsAppGraphError as exc:
            logger.error(
                "WhatsApp refused attachment %s for chat %s: %s",
                filename,
                channel_id,
                exc,
            )
            return await self._refuse_attachment(
                channel_id,
                sender_name,
                filename,
                None if overflow_ref else caption,
                thread_root_id,
                f"WhatsApp refused it: {exc.message}",
            )
        return overflow_ref or ref

    async def _refuse_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        caption: str | None,
        thread_root_id: str | None,
        reason: str,
    ) -> str | None:
        note = f"_sent an attachment that couldn't be relayed: {filename} ({reason})_"
        body = f"{caption}\n{note}" if caption else note
        return await self.send_message(
            channel_id, sender_name, self.translate_outbound(body), thread_root_id
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """The Cloud API cannot edit a sent message, so the original stands."""
        logger.warning(
            "Not editing WhatsApp message %s in %s: WhatsApp cannot edit a sent "
            "message, so the original stays as it was.",
            message_ref,
            channel_id,
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        """The Cloud API cannot delete a sent message, so it stays."""
        logger.warning(
            "Not deleting WhatsApp message %s in %s: WhatsApp cannot delete a "
            "sent message, so it stays in the chat.",
            message_ref,
            channel_id,
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Nothing: WhatsApp ties its typing indicator to the received message
        being answered, which this call does not name. The indicator is shown
        with the working mark instead (`mark_activity`)."""

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: ActivityMark,
        on: bool,
        force: bool = False,
    ) -> None:
        """React 👀 to the message being worked on, and take it off after.

        Putting it on also marks the message read and shows the typing
        indicator, which WhatsApp clears by itself on the reply or after 25
        seconds.
        """
        try:
            await self._send(
                channel_id,
                {
                    "type": "reaction",
                    "reaction": {
                        "message_id": message_ref,
                        "emoji": _WORKING_REACTION if on else "",
                    },
                },
                None,
            )
        except BridgeOperationError as exc:
            raise ActivityMarkRefused(
                f"WhatsApp will not react to {message_ref}: {exc}"
            ) from exc
        if on:
            await self._mark_read(message_ref, typing=True)

    # ── Session activity ─────────────────────────────────────────────────────

    def rich_markup(self) -> Markup:
        return WHATSAPP_MARKUP

    def rich_fallback_limit(self) -> int:
        return MAX_MESSAGE

    def rich_fallback_text(self, content: RichContent) -> str:
        """The base text, except that a problem somebody has to act on says
        what the problem is. The base draws a turn as its state alone, and an
        agent host gone offline mid-turn would be announced as "Working…"."""
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
        """Post a request card or an attention message; a turn is not posted.

        A turn's message would be redrawn as the turn moves, and nothing sent
        on WhatsApp can be. Its working state is the reaction and typing
        indicator on the asking message (`mark_activity`), and the agent's
        reply arrives as a message of its own. The reference returned for a
        turn names the turn, never a WhatsApp message, and nothing is quoted
        or reacted to with it.
        """
        if isinstance(content, TurnActivity) and not content.status_only:
            return f"{_TURN_REF_PREFIX}{content.turn.turn_id}"
        text = self.rich_fallback_text(content)
        agent = await self.agent_rendering(agent_name)
        try:
            return await self._send_text(
                channel_id, _attribute(agent.body_label, text), thread_root_id
            )
        except (WhatsAppGraphError, BridgeOperationError, httpx.HTTPError) as error:
            raise RichContentFailed(
                f"WhatsApp could not send the message in chat {channel_id}: {error}",
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
        """Nothing is redrawn: WhatsApp cannot edit a sent message.

        A request card stays as it was posted. An answer typed to it after it
        was decided is refused with a reply saying so, which is the honest
        signal a stale card can give. Reposting it instead would post it again
        on every redraw, and after every restart.
        """
        logger.debug(
            "Not redrawing %s in WhatsApp chat %s: WhatsApp cannot edit it",
            message_ref,
            channel_id,
        )

    # ── Channels and identity ────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "WhatsApp cannot create a chat: a person starts one by writing to the "
            "business number, and its room is made then."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        """Nothing: every agent speaks as the one business number."""

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """A WhatsApp chat is one person and the business, so nobody else can be
        added to it."""
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        """Nothing: agents have no identity of their own on WhatsApp."""

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        """Nothing: agents have no identity of their own on WhatsApp."""

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_whatsapp(content)

    def translate_inbound(self, raw_message: str) -> str:
        return to_markdown(raw_message)


def _attribute(label: str, content: str) -> str:
    """Put the agent's name at the head of the body, as Telegram's adapter
    does: one number posts for every agent, so without it a reader cannot tell
    them apart. `label` is the escaped body label."""
    name = f"*{label}*"
    if not content:
        return name
    return f"{name}\n{content}" if "\n" in content else f"{name}: {content}"


def _address(channel_id: str) -> dict[str, str]:
    """Who a message goes to. A chat is named by the person's phone number,
    or by the business-scoped user id WhatsApp sends instead for someone who
    has a username, and the API takes the two in different fields."""
    if channel_id.isdigit():
        return {"recipient_type": "individual", "to": channel_id}
    return {"recipient_type": "individual", "recipient": channel_id}


def _change_values(payload: Any) -> list[dict[str, Any]]:
    """Every `entry[].changes[].value` of a webhook body, or
    `WebhookPayloadError` if it is not a WhatsApp Business Account webhook."""
    if not isinstance(payload, dict) or payload.get("object") != (
        "whatsapp_business_account"
    ):
        raise WebhookPayloadError("Not a WhatsApp Business Account webhook")
    entries = payload.get("entry")
    if not isinstance(entries, list) or not entries:
        raise WebhookPayloadError("The webhook carries no entry")
    values: list[dict[str, Any]] = []
    for entry in entries:
        changes = entry.get("changes") if isinstance(entry, dict) else None
        if not isinstance(changes, list) or not changes:
            raise WebhookPayloadError("A webhook entry carries no changes")
        for change in changes:
            value = change.get("value") if isinstance(change, dict) else None
            if not isinstance(value, dict):
                raise WebhookPayloadError("A webhook change carries no value")
            values.append(value)
    return values


def _change_fields(payload: dict[str, Any]) -> list[str]:
    """The webhook field each change of a body read by `_change_values` is for."""
    return [
        str(change.get("field"))
        for entry in payload["entry"]
        for change in entry["changes"]
    ]


def _required_str(item: Any, key: str, what: str) -> str:
    value = item.get(key) if isinstance(item, dict) else None
    if not value:
        raise WebhookPayloadError(f"A WhatsApp {what} carries no {key}")
    return str(value)


def _describe_error(error: dict[str, Any]) -> str:
    details = (error.get("error_data") or {}).get("details")
    words = error.get("message") or error.get("title") or "no reason given"
    return f"{words} (code {error.get('code')})" + (f": {details}" if details else "")


def _digits(text: str) -> str:
    return "".join(c for c in text if c.isdigit())


def _profile_name(
    contacts: list[dict[str, Any]], message: dict[str, Any]
) -> str | None:
    """The name the person gave their WhatsApp profile, if WhatsApp sent it."""
    ids = {message.get("from"), message.get("from_user_id")} - {None}
    for contact in contacts:
        if contact.get("wa_id") in ids or contact.get("user_id") in ids:
            profile = contact.get("profile") or {}
            name = profile.get("name") or profile.get("username")
            return str(name).lstrip("@") if name else None
    return None


def _handle(profile_name: str | None, sender: str) -> str:
    """The handle Switch addresses this person by.

    A profile name is free text and not unique, so it is joined up to survive
    being written as `@name` and the sender's id is appended, as Telegram's
    adapter does: two people sharing a handle would share a room identity.
    """
    joined = "".join((profile_name or "").split())
    return f"{joined}_{sender}" if joined else sender


def _parse_command(text: str) -> tuple[str, str] | None:
    """Split a `!command args` message, the way Switch's own prefix reads."""
    parts = text.split(None, 1)
    name = parts[0][1:]
    if not name:
        return None
    return name, parts[1].strip() if len(parts) > 1 else ""

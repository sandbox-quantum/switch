"""WhatsApp, through the Business Cloud API and the operator's own Meta app.

Meta delivers every event by webhook to the connection's own address, so this
adapter keeps no connection open and any pod can take a delivery. A delivery
proves itself with `X-Hub-Signature-256`, an HMAC of the raw body keyed by the
app secret, and a retry carries the same message ids, which is what makes it
recognisable.

What WhatsApp is, and what that costs:

- Every chat is one person talking to the business number, and only they can
  start it. A business may answer for 24 hours after their last message; after
  that WhatsApp allows only pre-approved templates, which Switch does not
  send, so a reply is refused, saying why.
- One bot speaks for every agent, so an agent's name heads each message.
- A sent message cannot be edited or deleted. A card's buttons stay where they
  are once answered, the person's tap showing in the chat as their reply; a
  turn's live status is not drawn at all, and the working reaction and typing
  indicator stand in for it.
- Nothing is kept in one process: any pod can take a delivery, and the pod
  holding the bridge needs nothing another pod saw.
- A Meta app has one webhook address, so it is one connection: a second
  connection on the same app would never hear from Meta.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import mimetypes
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any, ClassVar, Literal

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    ChannelNotBindable,
    PlatformAdapter,
    PrivateNoticeRefused,
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
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    PrivateNoticeDelivery,
)
from switch_core.bridges.collaboration.session.renderers import (
    Control,
    Drawn,
    Markup,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.bridges.collaboration.whatsapp.client import (
    WINDOW_CLOSED_CODE,
    CloudApi,
    MediaTooLarge,
    WhatsAppApiError,
    inspect_token,
    new_http,
)
from switch_core.bridges.collaboration.whatsapp.markup import (
    MAX_TEXT,
    chunk_text,
    to_switch_markdown,
    to_whatsapp,
)
from switch_core.db.stores.messaging_event_store import RECEIPT_RETENTION
from switch_core.sessions.attachments import normalise_mime_type

logger = logging.getLogger(__name__)

_SIGNATURE_HEADER = "x-hub-signature-256"
_MESSAGING_PERMISSION = "whatsapp_business_messaging"
_WAMID_PREFIX = "wamid."

# What a card's reply button carries back: `sw:<token>:<position>`.
_PRESS_PREFIX = "sw"
# The ref of a turn's status that was not posted, because WhatsApp could not
# have kept it current.
_UNPOSTED_PREFIX = "unposted:"

# Meta's limits on interactive messages.
_MAX_BUTTONS = 3
_MAX_LIST_ROWS = 10
_BUTTON_TITLE = 20
_ROW_TITLE = 24
_ROW_DESCRIPTION = 72
_BUTTON_ID = 256
_ROW_ID = 200
_BUTTON_BODY = 1024
_LIST_MENU = "Choose an answer"
_CAPTION = 1024
# Room in a control's title for the option's number, "10. " at the most.
_NUMBERING = 4

_WORKING = "\U0001f440"

_MB = 1024 * 1024
_INLINE_MEDIA: dict[str, frozenset[str]] = {
    "image": frozenset({"image/jpeg", "image/png"}),
    "video": frozenset({"video/mp4", "video/3gpp"}),
    "audio": frozenset(
        {"audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"}
    ),
}
_MEDIA_LIMITS = {
    "image": 5 * _MB,
    "video": 16 * _MB,
    "audio": 16 * _MB,
    "document": 100 * _MB,
}
# The document types the Cloud API takes. Other text goes as plain text under
# its own filename; anything else is refused, saying so.
_DOCUMENT_TYPES = frozenset(
    {
        "text/plain",
        "application/pdf",
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
)
_TEXT_LIKE = frozenset(
    {"application/json", "application/xml", "application/yaml", "application/x-yaml"}
)
_INBOUND_MEDIA = ("image", "video", "audio", "document", "sticker")
# Events in the messages field that nobody wrote: a reaction to a message, a
# change to the person's number, opening the chat for the first time.
_NOT_MESSAGES = frozenset({"reaction", "system", "request_welcome"})

# Meta's "parameter value is not valid". On a reaction it is the message that
# is wrong for one (too old, deleted, itself a reaction), and asking again
# changes nothing, so the mark is refused for good.
_INVALID_PARAMETER_CODE = 131009

# Commands that reach every agent on the server rather than the room's own.
# Anyone who knows a business number can write to it, so these are not taken
# from a WhatsApp chat, except `!invite-agent` for an agent the connection
# already puts in every new chat (`_may_run_here`).
_SERVER_WIDE_COMMANDS = frozenset({"invite-agent", "list-switch-agents"})
_SERVER_WIDE_REFUSED = (
    "!{command} is not available on WhatsApp: anyone who knows this number can "
    "write to it, and the command reaches every agent on the server. Here "
    "!invite-agent adds only the agents this connection puts in new chats."
)

_WINDOW_CLOSED = (
    "WhatsApp lets a business message someone only within 24 hours of their "
    "last message to it, and {number} last wrote longer ago than that, so the "
    "reply was not delivered. Replies reach them again once they write; "
    "templates, WhatsApp's way to message outside that window, are not "
    "supported."
)
_NOT_BINDABLE = (
    "A WhatsApp chat starts when someone messages your business number, and a "
    "business can only write to them within 24 hours of their last message, so "
    "Switch cannot open a chat with a number on its own."
)

CardLayout = Literal["buttons", "list"]


class _WhatsAppMarkup(Markup):
    """The neutral renderer's marks in WhatsApp's spelling."""

    def bold(self, text: str) -> str:
        return f"*{text}*"

    def code(self, text: str) -> str:
        if "`" in text or "\n" in text:
            return f"```{text}```"
        return f"`{text}`"


WHATSAPP_MARKUP = _WhatsAppMarkup()


class WhatsAppConnectionConfig(BridgeConnectionConfig):
    app_id: str = Field(
        title="App ID",
        description="Your Meta app's ID, at the top of its dashboard.",
    )
    phone_number_id: str = Field(
        title="Phone number ID",
        description=(
            "From WhatsApp → API Setup in your Meta app. It is Meta's id for "
            "the number, not the phone number itself."
        ),
    )
    access_token: str = Field(
        title="Access token",
        description=(
            "A permanent token for a system user of your Meta business, with "
            "the whatsapp_business_messaging permission."
        ),
    )
    app_secret: str = Field(
        title="App secret",
        description=(
            "From App settings → Basic. Proves that webhook deliveries come from "
            "Meta, and signs every call Switch makes."
        ),
    )
    verify_token: str = Field(
        title="Verify token",
        description=(
            "A phrase you choose. Enter the same phrase as the Verify token in "
            "WhatsApp → Configuration, so Meta can confirm the webhook address "
            "is yours."
        ),
    )
    new_chat_agents: str = Field(
        "",
        title="Agents in new chats",
        description=(
            "The agents to put in a chat when someone first messages the number, "
            "separated by commas. A chat that started before an agent was named "
            "here gets it with !invite-agent sent in the chat."
        ),
    )

    @field_validator("access_token", "app_secret", "verify_token")
    @classmethod
    def _required(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("is required")
        return value

    @field_validator("new_chat_agents")
    @classmethod
    def _agent_list(cls, value: str) -> str:
        return ", ".join(name.strip() for name in value.split(",") if name.strip())

    @field_validator("app_id", "phone_number_id")
    @classmethod
    def _numeric(cls, value: str) -> str:
        value = value.strip()
        if not value.isascii() or not value.isdigit():
            raise ValueError("must be Meta's numeric id, digits only")
        return value

    @property
    def agents_for_new_chats(self) -> list[str]:
        return [name for name in self.new_chat_agents.split(", ") if name]


def _addressed(person: str) -> dict[str, str]:
    """Who a message goes to: a phone number, or a username's scoped id."""
    is_number = person.isascii() and person.isdigit()
    return {"to": person} if is_number else {"recipient": person}


def _handle(profile: str | None, person: str) -> str:
    """The name Switch addresses this person by.

    The profile name with its spaces taken out, so it survives being written as
    `@name`, and a short digest of their id after it: profile names are not
    unique and are anyone's to choose, including an agent's name. The digest
    keeps the phone number out of a name every agent in the room is shown.
    """
    digest = hashlib.sha256(person.encode()).hexdigest()[:6]
    joined = "".join((profile or "").split())
    return f"{joined}_{digest}" if joined else f"whatsapp_{digest}"


def _object(value: dict[str, Any], key: str) -> dict[str, Any]:
    """The object under `key`, or an empty one where Meta sent something else."""
    found = value.get(key)
    return found if isinstance(found, dict) else {}


def _records(value: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """The objects under `key` in a change's value, skipping anything else."""
    found = value.get(key)
    return (
        [item for item in found if isinstance(item, dict)]
        if isinstance(found, list)
        else []
    )


def card_layout(controls: list[Control], *, token: str) -> CardLayout | None:
    """How a card's options can be offered: reply buttons, a list, or neither.

    Up to three options fit WhatsApp's reply buttons and up to ten its list
    message. Past that, or where the reply id would outgrow Meta's limit, the
    card is sent as text and answered by typing its number, as on a platform
    with no buttons at all.
    """
    if not controls or len(controls) > _MAX_LIST_ROWS:
        return None
    longest = max(len(_press_id(token, control.position)) for control in controls)
    if len(controls) <= _MAX_BUTTONS:
        return "buttons" if longest <= _BUTTON_ID else None
    return "list" if longest <= _ROW_ID else None


def _press_id(token: str, position: int) -> str:
    return f"{_PRESS_PREFIX}:{token}:{position}"


def _parse_press(reply_id: str) -> tuple[str, int] | None:
    """The card and option a press names, or None if this bridge did not mint it."""
    parts = reply_id.split(":")
    if len(parts) != 3 or parts[0] != _PRESS_PREFIX or not parts[1]:
        return None
    digits = parts[2]
    if not digits.isascii() or not digits.isdecimal():
        return None
    position = int(digits)
    return (parts[1], position) if position > 0 else None


def _title(control: Control, limit: int) -> str:
    label = control.label.strip() or f"Option {control.position}"
    title = f"{control.position}. {label}"
    return title if len(title) <= limit else title[: limit - 1].rstrip() + "…"


def _quoting(ref: str | None) -> dict[str, Any]:
    """Quote `ref` in a message, where it is a WhatsApp message to quote."""
    if ref is None or not ref.startswith(_WAMID_PREFIX):
        return {}
    return {"context": {"message_id": ref}}


def _attributed(label: str, body: str) -> str:
    return f"*{label}*\n{body}" if body else f"*{label}*"


def _media_kind(mimetype: str, size: int) -> tuple[str, str] | None:
    """How WhatsApp can take a file, as (message type, upload type), or None.

    Media too large to play inline still goes as a document, which takes more.
    """
    base = normalise_mime_type(mimetype)
    for kind, accepted in _INLINE_MEDIA.items():
        if base in accepted and size <= _MEDIA_LIMITS[kind]:
            return kind, base
    if base in _DOCUMENT_TYPES or any(
        base in accepted for accepted in _INLINE_MEDIA.values()
    ):
        return "document", base
    if base.startswith("text/") or base in _TEXT_LIKE:
        return "document", "text/plain"
    return None


def _size(count: int) -> str:
    if count >= _MB:
        megabytes = count / _MB
        return (
            f"{megabytes:.0f} MB" if megabytes.is_integer() else f"{megabytes:.1f} MB"
        )
    return f"{max(1, round(count / 1024))} KB"


def _masked(number: str) -> str:
    """A phone number as logs show it: enough to tell chats apart, no more."""
    return f"…{number[-4:]}" if len(number) > 4 else "…"


def _is_stale(message: dict[str, Any]) -> bool:
    """Whether a message is older than any delivery Switch still remembers.

    Meta retries a delivery for up to 36 hours, and Switch keeps the receipt that
    recognises a retry for `RECEIPT_RETENTION`. A message older than that can
    only be a signed delivery played back, which would otherwise be taken as new.
    """
    sent = str(message.get("timestamp") or "")
    return (
        sent.isdigit() and time.time() - int(sent) > RECEIPT_RETENTION.total_seconds()
    )


def _label_room(layout: CardLayout | None) -> int | None:
    """How much of an option's label a control shows, after its number."""
    if layout is None:
        return None
    return (_BUTTON_TITLE if layout == "buttons" else _ROW_TITLE) - _NUMBERING


def _describe_location(body: dict[str, Any]) -> str:
    where = f"{body.get('latitude')}, {body.get('longitude')}"
    place = ", ".join(
        str(part) for part in (body.get("name"), body.get("address")) if part
    )
    return (
        f"_Shared a location: {place} ({where})_"
        if place
        else f"_Shared a location: {where}_"
    )


def _interactive(
    body: str, controls: list[Control], card: RequestCard, layout: CardLayout
) -> dict[str, Any]:
    """A card's interactive message: one reply button per option, or a list."""
    token = card.reference.token
    if layout == "buttons":
        return {
            "type": "button",
            "body": {"text": body},
            "action": {
                "buttons": [
                    {
                        "type": "reply",
                        "reply": {
                            "id": _press_id(token, control.position),
                            "title": _title(control, _BUTTON_TITLE),
                        },
                    }
                    for control in controls
                ]
            },
        }
    rows: list[dict[str, str]] = []
    for control in controls:
        row = {
            "id": _press_id(token, control.position),
            "title": _title(control, _ROW_TITLE),
        }
        if row["title"].endswith("…"):
            row["description"] = control.label.strip()[:_ROW_DESCRIPTION]
        rows.append(row)
    return {
        "type": "list",
        "body": {"text": body},
        "action": {
            "button": _LIST_MENU,
            "sections": [{"title": "Answers", "rows": rows}],
        },
    }


def _needs_saying(activity: TurnActivity) -> bool:
    """Whether a turn's status says something the chat must be told.

    The status itself is not drawn, because it could never be kept current.
    What arrives in the attention slot is the exception: a failure, or an
    agent whose host has gone, which nothing else would say.
    """
    return activity.error_summary is not None or activity.notify_unreachable


class WhatsAppAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "WhatsApp"
    receives_webhooks: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = True
    activity_reactions_per_agent: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True
    separate_attention_slot: ClassVar[bool] = True
    private_notice_delivery: ClassVar[PrivateNoticeDelivery] = "direct_message"

    def __init__(self, *, config: WhatsAppConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._api = CloudApi(
            http=new_http(),
            access_token=config.access_token,
            app_secret=config.app_secret,
            phone_number_id=config.phone_number_id,
        )

    # ── The connection ───────────────────────────────────────────────────────

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        return f"Meta app {connection_config['app_id']}"

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WhatsAppApiError):
            return "auth_failed" if exc.credentials_rejected else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WhatsAppConnectionConfig.model_validate(connection_config)
        http = new_http()
        try:
            token = await cls._checked_token(http, config)
            if not token.get("is_valid"):
                reason = _object(token, "error").get("message") or (
                    "it has expired or been revoked"
                )
                raise BridgeCredentialError(
                    f"Meta says this access token is not valid: {reason}. "
                    "Generate a permanent token for a system user."
                )
            issuer = str(token.get("app_id", ""))
            if issuer != config.app_id:
                raise BridgeCredentialError(
                    f"This access token was issued for Meta app {issuer}, not app "
                    f"{config.app_id}. Use a token from the same app as the app "
                    "secret."
                )
            if _MESSAGING_PERMISSION not in (token.get("scopes") or []):
                raise BridgeCredentialError(
                    f"This access token lacks the {_MESSAGING_PERMISSION} "
                    "permission, so it cannot send messages. Grant it to the "
                    "system user and generate the token again."
                )
            api = CloudApi(
                http=http,
                access_token=config.access_token,
                app_secret=config.app_secret,
                phone_number_id=config.phone_number_id,
            )
            try:
                await api.phone_number()
            except WhatsAppApiError as error:
                raise BridgeCredentialError(
                    f"This access token cannot reach phone number ID "
                    f"{config.phone_number_id}: {error}. Check the ID under "
                    "WhatsApp → API Setup, and that the system user has the "
                    "WhatsApp account assigned."
                ) from error
        except httpx.HTTPError as error:
            raise BridgeCredentialError(
                f"Could not reach Meta to check the credentials: {error}. Try again "
                "in a moment."
            ) from error
        finally:
            await http.aclose()

    @staticmethod
    async def _checked_token(
        http: httpx.AsyncClient, config: WhatsAppConnectionConfig
    ) -> dict[str, Any]:
        try:
            return await inspect_token(
                http,
                access_token=config.access_token,
                app_id=config.app_id,
                app_secret=config.app_secret,
            )
        except WhatsAppApiError as error:
            raise BridgeCredentialError(
                f"Meta refused the app ID and app secret: {error}"
            ) from error

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
                "WhatsApp delivers messages by webhook, and this deployment has no "
                "public address for one. Set MESSAGING_PUBLIC_URL to Switch's "
                "public https origin."
            )
        self._on_message = on_message
        self._on_command = on_command

    async def stop(self) -> None:
        await self._api.aclose()

    # ── The webhook address ──────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method == "GET":
            given = request.query.get("hub.verify_token", "")
            if request.query.get("hub.mode") != "subscribe" or not hmac.compare_digest(
                given.encode(), self._config.verify_token.encode()
            ):
                raise WebhookAuthenticityError("wrong verify token")
            return
        header = request.headers.get(_SIGNATURE_HEADER, "")
        if not header.startswith("sha256="):
            raise WebhookAuthenticityError("no signature")
        expected = hmac.new(
            self._config.app_secret.encode(), request.body, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(
            header.removeprefix("sha256=").encode(), expected.encode()
        ):
            raise WebhookAuthenticityError("signature does not match")

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if request.method == "GET":
            return InboundWebhook(
                envelope_type="address_check",
                payload={},
                handshake=request.query.get("hub.challenge", ""),
                external_event_id=None,
                delivery_attempt=0,
                answers_inline=False,
            )
        values = self._our_changes(request.body)
        ids = sorted(
            [str(m.get("id")) for v in values for m in _records(v, "messages")]
            + [
                f"{s.get('id')}:{s.get('status')}"
                for v in values
                for s in _records(v, "statuses")
            ]
        )
        return InboundWebhook(
            envelope_type="messages",
            payload={"values": values},
            handshake=None,
            external_event_id=(
                "whatsapp:" + hashlib.sha256("\n".join(ids).encode()).hexdigest()
                if ids
                else None
            ),
            delivery_attempt=0,
            answers_inline=False,
        )

    def _our_changes(self, body: bytes) -> list[dict[str, Any]]:
        """The changes in a delivery that are about this connection's number.

        Meta sends one app's events for every number on it to the one address,
        so a change for another number is someone else's and is left alone.
        """
        try:
            payload = json.loads(body)
        except ValueError as error:
            raise WebhookPayloadError("body is not JSON") from error
        if (
            not isinstance(payload, dict)
            or payload.get("object") != "whatsapp_business_account"
            or not isinstance(payload.get("entry"), list)
        ):
            raise WebhookPayloadError("not a WhatsApp Business Account delivery")
        values: list[dict[str, Any]] = []
        for entry in payload["entry"]:
            changes = entry.get("changes") if isinstance(entry, dict) else None
            if not isinstance(changes, list):
                raise WebhookPayloadError("an entry carries no list of changes")
            for change in changes:
                if not isinstance(change, dict) or change.get("field") != "messages":
                    continue
                value = change.get("value")
                if not isinstance(value, dict):
                    continue
                metadata = value.get("metadata")
                if (
                    isinstance(metadata, dict)
                    and metadata.get("phone_number_id") == self._config.phone_number_id
                ):
                    values.append(value)
        return values

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        for value in payload["values"]:
            names = {
                person: str(profile.get("name") or "")
                for contact in _records(value, "contacts")
                if isinstance(profile := contact.get("profile"), dict)
                for person in (contact.get("user_id"), contact.get("wa_id"))
                if person
            }
            business = str(value["metadata"].get("display_phone_number", ""))
            for error in _records(value, "errors"):
                logger.error(
                    "WhatsApp reported a problem with this number's account: %s",
                    error.get("message") or error.get("title") or error.get("code"),
                )
            for message in _records(value, "messages"):
                await self._receive(message, names, business)
            for status in _records(value, "statuses"):
                self._report_status(status)
        return None

    # ── What arrives ─────────────────────────────────────────────────────────

    async def _receive(
        self, message: dict[str, Any], names: dict[str, str], business: str
    ) -> None:
        # A chat is its number wherever Meta gives one: a test number's
        # allowed recipients are numbers, and a reply addressed to the
        # business-scoped id is refused there even when the number is allowed.
        # A person who hides their number behind a username has only that id.
        sender = str(message.get("from") or message.get("from_user_id") or "")
        wamid = str(message.get("id") or "")
        kind = str(message.get("type") or "")
        if not sender or not wamid or message.get("from") == business:
            return
        if kind in _NOT_MESSAGES:
            logger.debug("Ignoring a WhatsApp %s event (%s)", kind, wamid)
            return
        if message.get("group_id"):
            logger.warning(
                "A WhatsApp group message (%s) was not relayed: group chats are "
                "not supported, only chats with the business number.",
                wamid,
            )
            return
        if _is_stale(message):
            logger.warning(
                "Dropped WhatsApp message %s: it was sent before any delivery "
                "Switch still remembers, so it can only be a replay.",
                wamid,
            )
            return
        profile = names.get(sender) or names.get(str(message.get("from") or ""))
        name = _handle(profile, sender)
        room_title = profile or _masked(sender)
        if kind == "interactive":
            await self._press(message, sender, name)
            return
        await self._mark_read(wamid)
        context = _object(message, "context")
        root = None if context.get("forwarded") else context.get("id")
        if kind == "text":
            body = str(_object(message, "text").get("body") or "")
            if body.lstrip().startswith("!") and self._on_command is not None:
                parts = body.strip().split(None, 1)
                if parts[0][1:] in _SERVER_WIDE_COMMANDS and not self._may_run_here(
                    parts[0][1:], parts[1] if len(parts) > 1 else ""
                ):
                    await self.admin_message(
                        sender,
                        _SERVER_WIDE_REFUSED.format(command=parts[0][1:]),
                        wamid,
                    )
                    return
                await self._on_command(
                    InboundCommand(
                        channel_id=sender,
                        channel_type="direct",
                        sender_id=sender,
                        sender_name=name,
                        command=parts[0][1:],
                        args=parts[1].strip() if len(parts) > 1 else "",
                        message_ref=wamid,
                        root_id=root,
                        channel_name=room_title,
                    )
                )
                return
        content, attachments, failures = await self._contents(kind, message)
        if self._on_message is None:
            logger.warning(
                "WhatsApp message %s arrived before the bridge started", wamid
            )
            return
        await self._on_message(
            InboundMessage(
                channel_id=sender,
                channel_type="direct",
                sender_id=sender,
                sender_name=name,
                content=content,
                message_ref=wamid,
                root_id=root,
                channel_name=room_title,
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    async def _contents(
        self, kind: str, message: dict[str, Any]
    ) -> tuple[str, list[Attachment], list[AttachmentFailure]]:
        body = _object(message, kind)
        if kind == "text":
            return str(body.get("body") or ""), [], []
        if kind == "button":
            return str(body.get("text") or ""), [], []
        if kind in _INBOUND_MEDIA:
            attachment, failure = await self._fetch(kind, body)
            caption = str(body.get("caption") or "")
            return (
                caption,
                [attachment] if attachment else [],
                [failure] if failure else [],
            )
        if kind == "location":
            return _describe_location(body), [], []
        if kind == "contacts":
            shared = ", ".join(
                str(_object(contact, "name").get("formatted_name") or "a contact")
                for contact in _records(message, "contacts")
            )
            return f"_Shared a contact: {shared}_", [], []
        return (
            "_Sent a kind of message the WhatsApp Cloud API does not pass on to "
            "business apps, so it could not be shown here._",
            [],
            [],
        )

    async def _fetch(
        self, kind: str, body: dict[str, Any]
    ) -> tuple[Attachment | None, AttachmentFailure | None]:
        media_id = str(body.get("id") or "")
        declared = normalise_mime_type(str(body.get("mime_type") or ""))
        extension = mimetypes.guess_extension(declared) or ""
        filename = str(body.get("filename") or f"{kind}-{media_id[-8:]}{extension}")
        limit = self._max_attachment_bytes
        too_big = f"it is over this server's {_size(limit)} limit for attachments"
        if not media_id.isascii() or not media_id.isdigit():
            return None, AttachmentFailure(
                filename=filename, reason="WhatsApp gave no usable media id"
            )
        try:
            media = await self._api.media(media_id)
            if media.size is not None and media.size > limit:
                return None, AttachmentFailure(filename=filename, reason=too_big)
            data = await self._api.download(media.url, limit=limit)
        except MediaTooLarge:
            return None, AttachmentFailure(filename=filename, reason=too_big)
        except (WhatsAppApiError, httpx.HTTPError) as error:
            logger.warning("Could not fetch WhatsApp media %s: %s", media_id, error)
            return None, AttachmentFailure(
                filename=filename, reason=f"WhatsApp would not hand it over: {error}"
            )
        mimetype = media.mimetype or declared or "application/octet-stream"
        return Attachment(filename=filename, mimetype=mimetype, data=data), None

    def _may_run_here(self, command: str, args: str) -> bool:
        """Whether a server-wide command may be taken from a WhatsApp chat.

        A chat is a direct conversation, so its agents change only through
        commands sent in it. `!invite-agent` may therefore bring in one agent
        the connection already puts in every new chat, which a chat that began
        before it was named has no other way to get. Nothing else is taken.
        """
        names = args.split()
        offered = {name.lower() for name in self._config.agents_for_new_chats}
        return (
            command == "invite-agent"
            and len(names) == 1
            and names[0].removeprefix("@").lower() in offered
        )

    async def _press(self, message: dict[str, Any], sender: str, name: str) -> None:
        reply = _object(message, "interactive")
        chosen = _object(reply, "button_reply") or _object(reply, "list_reply")
        press = _parse_press(str(chosen.get("id") or ""))
        if press is None:
            logger.debug("Ignoring a WhatsApp press on a control Switch did not draw")
            return
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card from %s has nowhere to go: this bridge "
                "handles no interactions.",
                _masked(sender),
            )
            return
        token, position = press
        card = _object(message, "context").get("id")
        await self._on_interaction(
            InboundInteraction(
                channel_id=sender,
                sender_id=sender,
                sender_name=name,
                action_id=position_action(position),
                value=token,
                message_ref=card,
                thread_ref=card,
            )
        )

    async def _mark_read(self, wamid: str) -> None:
        try:
            await self._api.mark_read(wamid, typing=False)
        except (WhatsAppApiError, httpx.HTTPError) as error:
            logger.warning("Could not mark WhatsApp message %s read: %s", wamid, error)

    def _report_status(self, status: dict[str, Any]) -> None:
        if status.get("status") != "failed":
            return
        errors = _records(status, "errors")
        recipient = _masked(str(status.get("recipient_id") or ""))
        if any(error.get("code") == WINDOW_CLOSED_CODE for error in errors):
            reason = _WINDOW_CLOSED.format(number=recipient)
        else:
            reason = (
                "; ".join(
                    str(error.get("message") or error.get("title") or error.get("code"))
                    for error in errors
                )
                or "WhatsApp gave no reason"
            )
        logger.error(
            "WhatsApp did not deliver message %s to %s: %s",
            status.get("id"),
            recipient,
            reason,
        )

    # ── Messages ─────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        agent = await self.agent_rendering(sender_name)
        return await self._send_text(
            channel_id, _attributed(agent.body_label, content), thread_root_id
        )

    async def _send_text(
        self, channel_id: str, body: str, thread_root_id: str | None
    ) -> str:
        """Send `body`, split where WhatsApp's cap demands, quoting on the first part.

        Returns the first part's ref, so a reply to the message lands under its
        head.
        """
        chunks = chunk_text(body, MAX_TEXT)
        if not chunks:
            raise ValueError("There is no text to send.")
        head, *rest = chunks
        first = await self._send(
            channel_id,
            {"type": "text", "text": {"body": head}, **_quoting(thread_root_id)},
        )
        for chunk in rest:
            await self._send(channel_id, {"type": "text", "text": {"body": chunk}})
        return first

    async def _send(self, channel_id: str, message: dict[str, Any]) -> str:
        try:
            return await self._api.send({**message, **_addressed(channel_id)})
        except WhatsAppApiError as error:
            raise self._refusal(error, channel_id) from error

    def _refusal(self, error: WhatsAppApiError, channel_id: str) -> Exception:
        if error.credentials_rejected:
            return BridgeCredentialError(
                f"Meta rejected this connection's access token: {error}"
            )
        if error.window_closed:
            return BridgeOperationError(
                _WINDOW_CLOSED.format(number=_masked(channel_id))
            )
        return BridgeOperationError(
            f"WhatsApp refused the message to {_masked(channel_id)}: {error}"
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        logger.warning(
            "WhatsApp cannot edit a sent message, so the edit to %s in %s stays "
            "in Switch only.",
            message_ref,
            _masked(channel_id),
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.warning(
            "WhatsApp cannot delete a sent message, so %s stays in the chat with "
            "%s though it was deleted in Switch.",
            message_ref,
            _masked(channel_id),
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
        """Upload a file and send it as the agent, refusing visibly what WhatsApp
        will not take.

        Images, video and audio WhatsApp can play go inline; anything else goes
        as a document. An oversized file is not uploaded: a message naming it and
        the limit is sent in its place.
        """
        label = (await self.agent_rendering(sender_name)).body_label
        taken = _media_kind(mimetype, len(data))
        refusal = None
        if taken is None:
            refusal = f"WhatsApp does not take {normalise_mime_type(mimetype)} files"
        elif len(data) > _MEDIA_LIMITS[taken[0]]:
            refusal = (
                f"it is {_size(len(data))}, and WhatsApp takes files up to "
                f"{_size(_MEDIA_LIMITS[taken[0]])}"
            )
        if taken is None or refusal is not None:
            notice = f"_{filename} was not sent: {refusal}._"
            return await self._send_text(
                channel_id, _attributed(label, notice), thread_root_id
            )
        kind, upload_type = taken
        try:
            media_id = await self._api.upload_media(
                filename=filename, mimetype=upload_type, data=data
            )
        except WhatsAppApiError as error:
            raise self._refusal(error, channel_id) from error
        body: dict[str, Any] = {"id": media_id}
        if kind == "document":
            body["filename"] = filename
        said = _attributed(label, self.translate_outbound(caption) if caption else "")
        trailing: str | None = None
        if kind == "audio":
            trailing = said if caption else None
        elif len(said) <= _CAPTION:
            body["caption"] = said
        else:
            trailing = said
        ref = await self._send(
            channel_id,
            {"type": kind, kind: body, **_quoting(thread_root_id)},
        )
        if trailing is not None:
            await self._send_text(channel_id, trailing, ref)
        return ref

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Nothing here: WhatsApp's indicator names the message being answered,
        and `mark_activity` is the call that knows it."""

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Nothing here, for the same reason as `send_typing`."""

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
        """The 👀 reaction on the message that asked, and while it is on,
        WhatsApp's typing indicator against that same message.

        The indicator lasts 25 seconds or until the reply, and is best effort:
        the reaction is what stays.
        """
        if mark != "working":
            return
        if on:
            try:
                await self._api.mark_read(message_ref, typing=True)
            except (WhatsAppApiError, httpx.HTTPError) as error:
                logger.warning(
                    "Could not show typing to %s: %s", _masked(channel_id), error
                )
        reaction = {
            "type": "reaction",
            "reaction": {"message_id": message_ref, "emoji": _WORKING if on else ""},
            **_addressed(channel_id),
        }
        try:
            await self._api.send(reaction)
        except WhatsAppApiError as error:
            if error.code == _INVALID_PARAMETER_CODE:
                raise ActivityMarkRefused(str(error)) from error
            raise

    # ── Cards and a turn's status ────────────────────────────────────────────

    def rich_markup(self) -> Markup:
        return WHATSAPP_MARKUP

    def rich_fallback_limit(self) -> int:
        return MAX_TEXT

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        if isinstance(content, TurnActivity):
            if not _needs_saying(content):
                return f"{_UNPOSTED_PREFIX}{uuid.uuid4().hex}"
            return await self._publish_text(
                channel_id, agent_name, self._turn_text(content), thread_root_id
            )
        return await self._post_card(channel_id, agent_name, content, thread_root_id)

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Say what the chat must hear about a change, since WhatsApp cannot redraw.

        Only an attention post has anything to say on a redraw, and the
        publisher redraws one only when what needs attention has changed, so
        each change is said once without this adapter remembering anything. A
        card's own redraw says nothing: the person's tap already shows in the
        chat as their reply.
        """
        if isinstance(content, TurnActivity) and _needs_saying(content):
            await self._publish_text(
                channel_id, agent_name, self._turn_text(content), thread_root_id
            )

    def _turn_text(self, activity: TurnActivity) -> str:
        """A turn's status as a message, with the reason it failed."""
        tail = f"\n{self.unnotified_notice()}" if activity.notify_unreachable else ""
        status = turn_status(
            activity.items,
            activity.turn,
            escape=self._rich_escape,
            limit=max(1, MAX_TEXT - len(tail)),
            markup=WHATSAPP_MARKUP,
            elapsed_seconds=activity.elapsed_seconds,
            error_summary=activity.error_summary,
            tool_detail=False,
        )
        return f"{status}{tail}"

    async def _publish_text(
        self, channel_id: str, agent_name: str, text: str, quoting: str | None
    ) -> str:
        agent = await self.agent_rendering(agent_name)
        try:
            return await self._send_text(
                channel_id, _attributed(agent.body_label, text), quoting
            )
        except (
            BridgeOperationError,
            BridgeCredentialError,
            httpx.ConnectError,
            httpx.ConnectTimeout,
        ) as error:
            raise RichContentFailed(str(error), text=text) from error

    async def _post_card(
        self,
        channel_id: str,
        agent_name: str,
        card: RequestCard,
        thread_root_id: str | None,
    ) -> str:
        agent = await self.agent_rendering(agent_name)
        prefix = f"*{agent.body_label}*\n"
        controls = offered_controls(card.request)
        layout, drawn = self._fitted_card(card, prefix, controls)
        if layout is None:
            message: dict[str, Any] = {"type": "text", "text": {"body": drawn.text}}
        else:
            message = {
                "type": "interactive",
                "interactive": _interactive(drawn.text, controls, card, layout),
            }
        message.update({**_addressed(channel_id), **_quoting(thread_root_id)})
        try:
            return await self._api.send(message)
        except (httpx.ConnectError, httpx.ConnectTimeout) as error:
            raise RichContentFailed(
                f"Could not reach WhatsApp to post the card: {error}",
                text=self.rich_fallback_text(card),
            ) from error
        except WhatsAppApiError as error:
            raise RichContentFailed(
                f"WhatsApp refused the card in the chat with {_masked(channel_id)}: "
                f"{error}",
                text=self.rich_fallback_text(card),
            ) from error

    def _fitted_card(
        self, card: RequestCard, prefix: str, controls: list[Control]
    ) -> tuple[CardLayout | None, Drawn]:
        """The richest way to draw a card that still lets it be answered.

        Reply buttons allow the shortest body, so a card too long for them is
        tried as a list, then as text answered by typing. The text form is the
        last resort and is sent even if the card cannot be answered from it.
        """
        layouts: list[CardLayout] = []
        preferred = card_layout(controls, token=card.reference.token)
        if preferred is not None:
            layouts.append(preferred)
        if preferred == "buttons" and all(
            len(_press_id(card.reference.token, c.position)) <= _ROW_ID
            for c in controls
        ):
            layouts.append("list")
        for layout in layouts:
            drawn = self._draw_card(card, prefix, layout)
            if drawn.answerable:
                return layout, drawn
        return None, self._draw_card(card, prefix, None)

    def _draw_card(
        self, card: RequestCard, prefix: str, layout: CardLayout | None
    ) -> Drawn:
        tail = f"\n{self.unnotified_notice()}" if card.notify_unreachable else ""
        budget = _BUTTON_BODY if layout == "buttons" else MAX_TEXT
        drawn = render_request(
            card.request,
            card.reference,
            escape=self._rich_escape,
            limit=max(1, budget - len(prefix) - len(tail)),
            markup=WHATSAPP_MARKUP,
            responder=None,
            unavailable_reason=card.unavailable_reason,
            control_label_limit=_label_room(layout),
        )
        return replace(drawn, text=f"{prefix}{drawn.text}{tail}")

    # ── Telling one person ───────────────────────────────────────────────────

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Say it in the chat, which is already theirs alone.

        Every WhatsApp chat here is one person and the business number, so the
        chat is the private reply the base has to do without. Quoting the card
        keeps the notice beside what it is about.
        """
        try:
            await self.admin_message(
                channel_id, self.escape_label_for_body(text), thread_ref
            )
        except Exception as error:
            logger.warning(
                "Could not tell %s that their answer did not land: %s. The notice "
                "was: %s",
                _masked(actor_ref),
                error,
                text,
            )

    async def notify_privately(
        self,
        *,
        channel_id: str,
        channel_name: str | None,
        user_id: str,
        content: str,
        thread_root_id: str | None,
    ) -> None:
        if user_id != channel_id:
            raise PrivateNoticeRefused(
                f"{_masked(user_id)} is not the person in the WhatsApp chat "
                f"{_masked(channel_id)}."
            )
        await self.admin_message(channel_id, content, thread_root_id)

    # ── Channels and membership ──────────────────────────────────────────────

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        raise ChannelCreationUnsupported(_NOT_BINDABLE)

    def channel_ids_refused(self) -> str | None:
        return _NOT_BINDABLE

    async def require_bindable_channel(self, channel_id: str) -> None:
        raise ChannelNotBindable(_NOT_BINDABLE)

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
        if not user_names:
            return []
        logger.warning(
            "Cannot add %s to the WhatsApp chat with %s: a WhatsApp chat is one "
            "person and the business number.",
            ", ".join(user_names),
            _masked(channel_id),
        )
        return list(user_external_ids)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        """The agents a chat starts with, as the connection names them."""
        return self._config.agents_for_new_chats

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_whatsapp(content)

    def translate_inbound(self, raw_message: str) -> str:
        return to_switch_markdown(raw_message)

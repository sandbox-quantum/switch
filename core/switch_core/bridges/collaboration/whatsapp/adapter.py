"""WhatsApp as a messaging platform, through the operator's own Business app.

The operator creates a Meta app with the WhatsApp product, adds a business
phone number, and gives Switch its phone number id, an access token, the app
secret and a verify token of their choosing. Each WhatsApp user who writes to
the number is a direct room of their own; every agent replies from the one
number, with its name in bold at the start of the message.

The Cloud API delivers messages by webhook, on the bridge's own address. The
address is verified with a GET carrying the verify token, and every event is
signed with the app secret (`X-Hub-Signature-256`, HMAC-SHA256 over the body).

WhatsApp has no threads: a reply in a thread is sent as a quote-reply of the
thread's root, and a quote-reply in WhatsApp arrives in the root's thread. A
business may send free-form messages only within 24 hours of the user's last
message. WhatsApp refuses one outside it (131047), either when it is sent or
later in a `failed` status; both are said plainly. Cloud API numbers are 1:1
only: there are no group chats to bridge, and a sent message cannot be edited
or deleted.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import mimetypes
import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
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
)
from switch_core.bridges.collaboration.session.renderers import (
    offered_controls,
    position_action,
)

logger = logging.getLogger(__name__)

GRAPH = "https://graph.facebook.com/v21.0"
SIGNATURE_HEADER = "x-hub-signature-256"
# A text message's body takes 4096 characters; a media caption 1024.
MAX_MESSAGE = 4096
_MAX_CAPTION = 1024
# Reply buttons: at most three, each title at most 20 characters.
_MAX_BUTTONS = 3
_BUTTON_TITLE = 20
# A list message: at most ten rows, titles of 24, descriptions of 72, and a
# button label of 20.
_MAX_ROWS = 10
_ROW_TITLE = 24
_ROW_DESCRIPTION = 72
# WhatsApp's code for a free-form message outside the 24-hour window.
_OUTSIDE_WINDOW = 131047
_OUTSIDE_WINDOW_TEXT = (
    "WhatsApp allows a free-form reply only within 24 hours of the person's "
    "last message; they have to write again first"
)
# Meta serves downloaded media only from its own hosts.
_MEDIA_HOSTS = (".fbsbx.com", ".facebook.com", ".whatsapp.net")
# What WhatsApp sends as each media type, and the most it takes of each
# (Cloud API media limits). Anything else goes as a document.
_MB = 1024 * 1024
_MEDIA_TYPES: dict[str, tuple[str, int]] = {
    "image/jpeg": ("image", 5 * _MB),
    "image/png": ("image", 5 * _MB),
    "video/mp4": ("video", 16 * _MB),
    "video/3gpp": ("video", 16 * _MB),
    "audio/aac": ("audio", 16 * _MB),
    "audio/amr": ("audio", 16 * _MB),
    "audio/mpeg": ("audio", 16 * _MB),
    "audio/mp4": ("audio", 16 * _MB),
    "audio/ogg": ("audio", 16 * _MB),
}
_DOCUMENT_LIMIT = 100 * _MB
_INBOUND_MEDIA = ("image", "video", "audio", "document", "sticker")
_WORKING_REACTION = "\N{EYES}"
_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
_MEDIA_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


class WhatsAppConnectionConfig(BridgeConnectionConfig):
    phone_number_id: str = Field(
        title="Phone number ID",
        description="From WhatsApp → API Setup in your Meta app. Digits only.",
    )
    access_token: str = Field(
        title="Access token",
        description="A system user's permanent token with whatsapp_business_messaging.",
        repr=False,
    )
    app_secret: str = Field(
        title="App secret",
        description="From App settings → Basic. Meta signs every event with it.",
        repr=False,
    )
    verify_token: str = Field(
        title="Verify token",
        description="Any long random string. Paste the same into the webhook's settings in Meta.",
        min_length=16,
        repr=False,
    )

    @field_validator("phone_number_id")
    @classmethod
    def _number_id(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[0-9]{6,20}", value):
            raise ValueError(
                "The phone number ID is digits, from API Setup, not the number itself"
            )
        return value

    @field_validator("access_token", "app_secret")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This is required")
        return value


def sign(secret: str, body: bytes) -> str:
    """What Meta puts in `X-Hub-Signature-256`."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def appsecret_proof(token: str, secret: str) -> str:
    """Graph's `appsecret_proof`: HMAC-SHA256 of the token with the app secret."""
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()


class WhatsAppError(Exception):
    def __init__(self, status: int, code: int, message: str) -> None:
        super().__init__(f"{message} (HTTP {status}, code {code})")
        self.status = status
        self.code = code
        self.message = message


class WhatsAppAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "WhatsApp"
    receives_webhooks: ClassVar[bool] = True
    # Cloud API numbers talk 1:1: no groups to create or search.
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    # A business reacts to a person's message, one reaction per message, shared
    # by every agent since they all speak through the one number.
    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = False
    activity_reactions_per_agent: ClassVar[bool] = False

    def __init__(self, *, config: WhatsAppConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._http = httpx.AsyncClient(timeout=_TIMEOUT)

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, WhatsAppError):
            return (
                "auth_failed"
                if exc.status == 401 or exc.code == 190
                else "platform_error"
            )
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """One bridge per number: Meta sends a number's events to one app."""
        number = str(connection_config.get("phone_number_id") or "").strip()
        return f"whatsapp {number}" if number else None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """The token, the phone number ID and the app secret, each said apart.

        The token is read with `debug_token`, which says whether it is valid
        and what it may do. The number is then read with an `appsecret_proof`
        made from the app secret, which Graph refuses when the secret is not
        the token's app's: a wrong secret would otherwise only show when every
        event was refused as unsigned.
        """
        config = WhatsAppConnectionConfig.model_validate(connection_config)
        auth = {"Authorization": f"Bearer {config.access_token}"}
        async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
            try:
                debug = await http.get(
                    f"{GRAPH}/debug_token",
                    params={"input_token": config.access_token},
                    headers=auth,
                )
                number = await http.get(
                    f"{GRAPH}/{config.phone_number_id}",
                    params={
                        "fields": "display_phone_number",
                        "appsecret_proof": appsecret_proof(
                            config.access_token, config.app_secret
                        ),
                    },
                    headers=auth,
                )
            except httpx.TransportError as error:
                raise BridgeCredentialError(
                    f"Could not reach WhatsApp: {error}"
                ) from error
        # A token Graph will not describe is judged by the number check below.
        token = debug.json().get("data") if debug.status_code == 200 else {}
        if not isinstance(token, dict):
            token = {}
        if token.get("is_valid") is False:
            raise BridgeCredentialError(
                "WhatsApp does not accept the access token: it has expired, was "
                "revoked or was mistyped. Generate a new one in your Meta app."
            )
        scopes = token.get("scopes")
        if isinstance(scopes, list) and "whatsapp_business_messaging" not in scopes:
            raise BridgeCredentialError(
                "The access token lacks the whatsapp_business_messaging permission"
            )
        if number.status_code != 200:
            refused = _error(number)
            if "appsecret_proof" in refused.message:
                raise BridgeCredentialError(
                    "The app secret is not this app's: copy it again from App "
                    "settings → Basic in the Meta app the token belongs to"
                )
            raise BridgeCredentialError(
                f"WhatsApp refused the phone number ID: {refused.message}"
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
                "WhatsApp calls Switch for every message, so the server needs "
                "MESSAGING_PUBLIC_URL, an https address Meta can reach"
            )

    async def stop(self) -> None:
        await self._http.aclose()

    # ── Webhooks ─────────────────────────────────────────────────────────────

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method == "GET":
            given = request.query.get("hub.verify_token", "")
            if request.query.get("hub.mode") != "subscribe" or not hmac.compare_digest(
                given, self.config.verify_token
            ):
                raise WebhookAuthenticityError("wrong verify token")
            return
        given = request.headers.get(SIGNATURE_HEADER, "")
        if not hmac.compare_digest(given, sign(self.config.app_secret, request.body)):
            raise WebhookAuthenticityError("the Meta signature does not match")

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
        try:
            payload = json.loads(request.body)
            value = payload["entry"][0]["changes"][0]["value"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise WebhookPayloadError("the event is not a WhatsApp change") from error
        messages = value.get("messages") or []
        if not messages:
            return InboundWebhook(
                envelope_type="status",
                payload=value,
                handshake=None,
                external_event_id=None,
                delivery_attempt=0,
                answers_inline=False,
            )
        return InboundWebhook(
            envelope_type="message",
            payload=value,
            handshake=None,
            external_event_id=str(messages[0].get("id")),
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        if envelope_type == "status":
            for status in payload.get("statuses") or []:
                self._report_status(status)
            return
        if envelope_type != "message":
            return
        names = {
            str(c.get("wa_id")): str(
                (c.get("profile") or {}).get("name") or c.get("wa_id")
            )
            for c in payload.get("contacts") or []
        }
        for message in payload.get("messages") or []:
            await self._on_whatsapp_message(message, names)

    def _report_status(self, status: dict[str, Any]) -> None:
        """Delivery and read receipts reach no room. A message WhatsApp
        accepted and then failed to deliver is logged as an error with
        WhatsApp's reason, the 24-hour window said in words."""
        if status.get("status") != "failed":
            return
        errors = status.get("errors") or [{}]
        reason = (
            _OUTSIDE_WINDOW_TEXT
            if any(e.get("code") == _OUTSIDE_WINDOW for e in errors)
            else str(errors[0].get("title") or errors[0].get("message") or "unknown")
        )
        logger.error(
            "WhatsApp did not deliver message %s to %s: %s",
            status.get("id"),
            status.get("recipient_id"),
            reason,
        )

    async def _on_whatsapp_message(
        self, message: dict[str, Any], names: dict[str, str]
    ) -> None:
        sender = str(message.get("from") or "")
        name = names.get(sender, sender)
        root_id = (message.get("context") or {}).get("id")
        kind = message.get("type")
        if kind == "interactive":
            interactive = message.get("interactive") or {}
            reply = (
                interactive.get("button_reply") or interactive.get("list_reply") or {}
            )
            action, _, value = str(reply.get("id") or "").partition("|")
            if action and self._on_interaction is not None:
                await self._on_interaction(
                    InboundInteraction(
                        channel_id=sender,
                        sender_id=sender,
                        sender_name=name,
                        action_id=action,
                        value=value,
                        message_ref=root_id,
                    )
                )
            return
        if kind == "reaction":
            # A person's reaction to a message: nothing to relay as a post.
            return
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        if kind == "text":
            text = str((message.get("text") or {}).get("body") or "").strip()
        elif kind in _INBOUND_MEDIA:
            media = message.get(str(kind)) or {}
            text = str(media.get("caption") or "").strip()
            await self._fetch_media(str(kind), media, attachments, failures)
        elif kind == "button":
            # A quick-reply button on a template message.
            text = str((message.get("button") or {}).get("text") or "").strip()
        elif kind == "location":
            place = message.get("location") or {}
            label = " ".join(str(place[k]) for k in ("name", "address") if place.get(k))
            text = (
                f"_shared a location: {label + ' ' if label else ''}"
                f"({place.get('latitude')}, {place.get('longitude')})_"
            )
        elif kind == "contacts":
            people = [
                str((c.get("name") or {}).get("formatted_name") or "a contact")
                for c in message.get("contacts") or []
            ]
            text = f"_shared {', '.join(people) or 'a contact'}_"
        else:
            text = f"_sent a {kind} message, which Switch does not relay_"
        if not text and not attachments and not failures:
            return
        if text.startswith("!") and not attachments and self._on_command is not None:
            command, _, args = text[1:].partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=name,
                    command=command,
                    args=args.strip(),
                    message_ref=str(message.get("id")),
                    root_id=root_id,
                )
            )
            return
        if self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=sender,
                    channel_type="direct",
                    sender_id=sender,
                    sender_name=name,
                    content=text,
                    message_ref=str(message.get("id")),
                    root_id=root_id,
                    channel_name=name,
                    attachments=attachments,
                    attachment_failures=failures,
                )
            )

    # ── Attachments ──────────────────────────────────────────────────────────

    async def _fetch_media(
        self,
        kind: str,
        media: dict[str, Any],
        attachments: list[Attachment],
        failures: list[AttachmentFailure],
    ) -> None:
        """Download one file by its media id: Graph names its URL and size,
        and the URL serves the bytes to the same token. One that is too big
        or will not download is a failure the room is told about."""
        media_id = str(media.get("id") or "")
        mimetype = str(media.get("mime_type") or "application/octet-stream").split(";")[
            0
        ]
        filename = str(media.get("filename") or "") or (
            f"{kind}-{media_id[-8:] or 'file'}"
            f"{mimetypes.guess_extension(mimetype) or ''}"
        )
        cap = self._max_attachment_bytes
        try:
            described = await self._http.get(
                f"{GRAPH}/{media_id}", headers=self._auth()
            )
            if described.status_code != 200:
                raise BridgeOperationError(_error(described).message)
            info = described.json()
            size = info.get("file_size")
            if isinstance(size, int) and size > cap:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{size} bytes exceeds the {cap} byte limit",
                    )
                )
                return
            url = str(info.get("url") or "")
            parts = urlsplit(url)
            if parts.scheme != "https" or not str(parts.hostname or "").endswith(
                _MEDIA_HOSTS
            ):
                raise BridgeOperationError("WhatsApp named no Meta address for it")
            downloaded = await self._http.get(
                url, headers=self._auth(), timeout=_MEDIA_TIMEOUT
            )
            if downloaded.status_code != 200:
                raise BridgeOperationError(f"HTTP {downloaded.status_code}")
            data = downloaded.content
        except (BridgeOperationError, httpx.HTTPError, ValueError) as error:
            logger.warning(
                "Could not download WhatsApp %s %s: %s", kind, media_id, error
            )
            failures.append(
                AttachmentFailure(filename=filename, reason=f"download failed: {error}")
            )
            return
        if len(data) > cap:
            failures.append(
                AttachmentFailure(
                    filename=filename,
                    reason=f"{len(data)} bytes exceeds the {cap} byte limit",
                )
            )
            return
        attachments.append(Attachment(filename=filename, mimetype=mimetype, data=data))

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
        """Upload the file and send it as the media type WhatsApp shows inline
        for it, or as a document. A file over WhatsApp's limit for its type,
        or one WhatsApp refuses, is replaced by a message saying so and why."""
        kind, limit = _MEDIA_TYPES.get(
            mimetype.split(";")[0], ("document", _DOCUMENT_LIMIT)
        )
        caption = self.translate_outbound(caption) if caption else None
        named = f"*{sender_name}*" + (f"\n{caption}" if caption else "")
        try:
            if len(data) > limit:
                raise BridgeOperationError(
                    f"{len(data)} bytes is over WhatsApp's {limit // _MB} MB limit "
                    f"for {kind} files"
                )
            media_id = await self._upload(filename, mimetype, data)
            media: dict[str, Any] = {"id": media_id}
            if kind == "document":
                media["filename"] = filename
            if kind == "audio":
                # Audio carries no caption: the name goes first, on its own.
                await self.send_message(
                    channel_id, sender_name, caption or "", thread_root_id
                )
            else:
                media["caption"] = named[:_MAX_CAPTION]
            body: dict[str, Any] = {"to": channel_id, "type": kind, kind: media}
            if thread_root_id:
                body["context"] = {"message_id": thread_root_id}
            return await self._send(body)
        except (BridgeOperationError, httpx.HTTPError) as error:
            logger.error(
                "Could not send %s to WhatsApp chat %s: %s", filename, channel_id, error
            )
            note = f"_{filename} could not be sent on WhatsApp: {error}_"
            return await self.send_message(
                channel_id,
                sender_name,
                f"{caption}\n{note}" if caption else note,
                thread_root_id,
            )

    async def _upload(self, filename: str, mimetype: str, data: bytes) -> str:
        response = await self._http.post(
            f"{GRAPH}/{self.config.phone_number_id}/media",
            data={"messaging_product": "whatsapp", "type": mimetype},
            files={"file": (filename, data, mimetype)},
            headers=self._auth(),
            timeout=_MEDIA_TIMEOUT,
        )
        if response.status_code != 200:
            raise BridgeOperationError(
                f"WhatsApp refused the upload: {_error(response).message}"
            )
        return str(response.json().get("id") or "")

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.access_token}"}

    async def _send(self, body: dict[str, Any]) -> str:
        response = await self._http.post(
            f"{GRAPH}/{self.config.phone_number_id}/messages",
            json={"messaging_product": "whatsapp", **body},
            headers=self._auth(),
        )
        if response.status_code != 200:
            error = _error(response)
            if error.code == _OUTSIDE_WINDOW:
                raise BridgeOperationError(_OUTSIDE_WINDOW_TEXT)
            raise BridgeOperationError(f"WhatsApp refused the message: {error.message}")
        return str(((response.json().get("messages") or [{}])[0]).get("id") or "")

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        first: str | None = None
        for part in _chunk(f"*{sender_name}*\n{content}".rstrip()):
            body: dict[str, Any] = {
                "to": channel_id,
                "type": "text",
                "text": {"body": part, "preview_url": False},
            }
            if thread_root_id:
                body["context"] = {"message_id": thread_root_id}
            sent = await self._send(body)
            first = first or sent
        return first

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """A request with up to three options as reply buttons, and with up to
        ten as a list; any other card as text, answered by replying with its
        handle and number."""
        text = self.rich_fallback_text(content)
        controls = (
            offered_controls(content.request)
            if isinstance(content, RequestCard)
            else []
        )
        try:
            if isinstance(content, RequestCard) and 0 < len(controls) <= _MAX_ROWS:
                token = content.reference.token
                header = f"*{agent_name}*\n{text}"[:1024]
                if len(controls) <= _MAX_BUTTONS:
                    interactive: dict[str, Any] = {
                        "type": "button",
                        "body": {"text": header},
                        "action": {
                            "buttons": [
                                {
                                    "type": "reply",
                                    "reply": {
                                        "id": f"{position_action(c.position)}|{token}",
                                        "title": f"{c.position}. {c.label}"[
                                            :_BUTTON_TITLE
                                        ],
                                    },
                                }
                                for c in controls
                            ]
                        },
                    }
                else:
                    interactive = {
                        "type": "list",
                        "body": {"text": header},
                        "action": {
                            "button": "Choose",
                            "sections": [
                                {
                                    "rows": [
                                        {
                                            "id": f"{position_action(c.position)}|{token}",
                                            "title": f"{c.position}. {c.label}"[
                                                :_ROW_TITLE
                                            ],
                                            "description": c.label[:_ROW_DESCRIPTION],
                                        }
                                        for c in controls
                                    ]
                                }
                            ],
                        },
                    }
                body: dict[str, Any] = {
                    "to": channel_id,
                    "type": "interactive",
                    "interactive": interactive,
                }
                if thread_root_id:
                    body["context"] = {"message_id": thread_root_id}
                return await self._send(body)
            ref = await self.send_message(channel_id, agent_name, text, thread_root_id)
        except BridgeOperationError as error:
            raise RichContentFailed(str(error), text=text) from error
        return ref or ""

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
        """Put 👀 on the person's message while an agent works on it, and take
        it off after: a business has one reaction per message, so an empty
        emoji removes it. WhatsApp keeps no per-agent marks, and the publisher
        counts the turns holding the one there is."""
        try:
            await self._send(
                {
                    "recipient_type": "individual",
                    "to": channel_id,
                    "type": "reaction",
                    "reaction": {
                        "message_id": message_ref,
                        "emoji": _WORKING_REACTION if on else "",
                    },
                }
            )
        except BridgeOperationError as error:
            raise ActivityMarkRefused(
                f"WhatsApp will not {'add' if on else 'remove'} the working "
                f"reaction on {message_ref}: {error}"
            ) from error

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        logger.debug("WhatsApp cannot change a sent message (%s)", message_ref)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.debug("WhatsApp gives a business no delete (%s)", message_ref)

    async def send_typing(self, *args: Any, **kwargs: Any) -> None:
        return None

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self, name: str, topic: str, *, channel_type: ChannelType = "channel_public"
    ) -> str:
        raise ChannelCreationUnsupported(
            "A WhatsApp business number has no groups to create"
        )

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
        return to_whatsapp(content)

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message


def to_whatsapp(markdown: str) -> str:
    """Markdown in WhatsApp's own marks: *bold*, _italic_, ~strike~."""
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", markdown)
    text = re.sub(r"~~(.+?)~~", r"~\1~", text)
    text = re.sub(r"^#{1,6}\s+(.+)$", r"*\1*", text, flags=re.M)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1 (\2)", text)
    return text


def _chunk(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    """Split under WhatsApp's limit at a line, else a word; a code block cut
    in two is closed in the first part and opened again in the next."""
    parts: list[str] = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit - 4)
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit - 4)
        if cut <= 0:
            cut = limit - 4
        head, text = text[:cut].rstrip(), text[cut:].lstrip()
        if head.count("```") % 2:
            head, text = head + "\n```", "```\n" + text
        parts.append(head)
    return [*parts, text] if text else parts or [""]


def _error(response: httpx.Response) -> WhatsAppError:
    try:
        error = response.json().get("error") or {}
    except ValueError:
        error = {}
    return WhatsAppError(
        response.status_code,
        int(error.get("code") or 0),
        str(error.get("message") or f"HTTP {response.status_code}"),
    )

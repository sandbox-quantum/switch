"""WhatsApp as a messaging platform, through the operator's own Business app.

The operator creates a Meta app with the WhatsApp product, adds a business
phone number, and gives Switch its phone number id, a system user's access
token, the app secret and a verify token of their choosing. Each WhatsApp user
who writes to the number is a direct room of their own; every agent replies
from the one number, with its name in bold at the start of the message.

The Cloud API delivers messages by webhook, on the bridge's own address. The
address is verified with a GET carrying the verify token, and every event is
signed with the app secret (`X-Hub-Signature-256`, HMAC-SHA256 over the body).

WhatsApp has no threads: a reply in a thread is sent as a quote-reply of the
thread's root, and a quote-reply in WhatsApp arrives in the root's thread. A
business may send free-form messages only within 24 hours of the user's last
message; outside it WhatsApp refuses them (131047), and the refusal says so.
Cloud API numbers are 1:1 only: there are no group chats to bridge.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
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
# A text message's body takes 4096 characters.
MAX_MESSAGE = 4096
# Reply buttons: at most three, each title at most 20 characters.
_MAX_BUTTONS = 3
_BUTTON_TITLE = 20
# WhatsApp's code for a free-form message outside the 24-hour window.
_OUTSIDE_WINDOW = 131047
_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


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
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [GRAPH]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WhatsAppConnectionConfig.model_validate(connection_config)
        async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
            try:
                response = await http.get(
                    f"{GRAPH}/{config.phone_number_id}",
                    params={"fields": "display_phone_number"},
                    headers={"Authorization": f"Bearer {config.access_token}"},
                )
            except httpx.TransportError as error:
                raise BridgeCredentialError(
                    f"Could not reach WhatsApp: {error}"
                ) from error
        if response.status_code != 200:
            refused = _error(response)
            raise BridgeCredentialError(
                f"WhatsApp refused the token or phone number ID: {refused.message}"
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
            # Delivery and read statuses: nothing for a room.
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

    async def _on_whatsapp_message(
        self, message: dict[str, Any], names: dict[str, str]
    ) -> None:
        sender = str(message.get("from") or "")
        name = names.get(sender, sender)
        root_id = (message.get("context") or {}).get("id")
        kind = message.get("type")
        if kind == "interactive":
            reply = (message.get("interactive") or {}).get("button_reply") or {}
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
        if kind != "text":
            text = f"_sent a {kind} message, which Switch does not relay yet_"
        else:
            text = str((message.get("text") or {}).get("body") or "").strip()
        if not text:
            return
        if text.startswith("!") and self._on_command is not None:
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
                )
            )

    # ── Outbound ─────────────────────────────────────────────────────────────

    async def _send(self, body: dict[str, Any]) -> str:
        response = await self._http.post(
            f"{GRAPH}/{self.config.phone_number_id}/messages",
            json={"messaging_product": "whatsapp", **body},
            headers={"Authorization": f"Bearer {self.config.access_token}"},
        )
        if response.status_code != 200:
            error = _error(response)
            if error.code == _OUTSIDE_WINDOW:
                raise BridgeOperationError(
                    "WhatsApp allows a free-form reply only within 24 hours of the "
                    "person's last message; they have to write again first"
                )
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
        for part in _chunk(f"*{sender_name}*\n{content}"):
            body: dict[str, Any] = {
                "to": channel_id,
                "type": "text",
                "text": {"body": part, "preview_url": False},
            }
            if thread_root_id:
                body["context"] = {"message_id": thread_root_id}
            first = first or await self._send(body)
        return first

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """A request with up to three options as reply buttons; any other card
        as text, answered by replying with its handle and number."""
        text = self.rich_fallback_text(content)
        controls = (
            offered_controls(content.request)
            if isinstance(content, RequestCard)
            else []
        )
        try:
            if isinstance(content, RequestCard) and 0 < len(controls) <= _MAX_BUTTONS:
                body: dict[str, Any] = {
                    "to": channel_id,
                    "type": "interactive",
                    "interactive": {
                        "type": "button",
                        "body": {"text": f"*{agent_name}*\n{text}"[:1024]},
                        "action": {
                            "buttons": [
                                {
                                    "type": "reply",
                                    "reply": {
                                        "id": f"{position_action(c.position)}|{content.reference.token}",
                                        "title": f"{c.position}. {c.label}"[
                                            :_BUTTON_TITLE
                                        ],
                                    },
                                }
                                for c in controls
                            ]
                        },
                    },
                }
                if thread_root_id:
                    body["context"] = {"message_id": thread_root_id}
                return await self._send(body)
            ref = await self.send_message(channel_id, agent_name, text, thread_root_id)
        except BridgeOperationError as error:
            raise RichContentFailed(str(error), text=text) from error
        return ref or ""

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
    parts: list[str] = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        parts.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
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

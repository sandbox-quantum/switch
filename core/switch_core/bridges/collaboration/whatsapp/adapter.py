"""One-to-one text messaging over Meta's WhatsApp Cloud API."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ChannelNotBindable,
    PlatformAdapter,
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
    ChannelRetirement,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    PrivateNoticeDelivery,
    RetireOutcome,
)

_API_VERSION = re.compile(r"^v\d+\.0$")
_CUSTOMER_SERVICE_WINDOW = 24 * 60 * 60


class WhatsAppConnectionConfig(BridgeConnectionConfig):
    access_token: str = Field(min_length=1, title="Access token")
    phone_number_id: str = Field(min_length=1, title="Phone number ID")
    app_secret: str = Field(min_length=1, title="Meta app secret")
    verify_token: str = Field(min_length=1, title="Webhook verify token")
    api_version: str = Field(default="v25.0", title="Graph API version")

    @field_validator("api_version")
    @classmethod
    def validate_api_version(cls, value: str) -> str:
        if not _API_VERSION.fullmatch(value):
            raise ValueError("api_version must look like vNN.0, such as v25.0")
        return value


class WhatsAppAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "WhatsApp"
    docs_slug: ClassVar[str | None] = "whatsapp"
    receives_webhooks: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    channel_on_delete: ClassVar[ChannelRetirement] = "kept"
    private_notice_delivery: ClassVar[PrivateNoticeDelivery] = "direct_message"

    def __init__(self, *, config: WhatsAppConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._http: httpx.AsyncClient | None = None
        self._last_inbound: dict[str, float] = {}

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = WhatsAppConnectionConfig.model_validate(connection_config)
        url = (
            f"https://graph.facebook.com/{config.api_version}/{config.phone_number_id}"
        )
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(
                    url,
                    params={"fields": "id"},
                    headers={"Authorization": f"Bearer {config.access_token}"},
                )
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(
                f"Could not reach Meta to check the WhatsApp credentials: {exc}. Try again."
            ) from exc
        if response.is_error:
            raise BridgeCredentialError(
                _api_error(response, "Meta rejected the WhatsApp credentials")
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise BridgeCredentialError(
                "Meta returned an invalid credential check response."
            ) from exc
        if not isinstance(body, dict) or str(body.get("id")) != config.phone_number_id:
            raise BridgeCredentialError(
                "The WhatsApp credentials did not verify the configured phone number ID."
            )

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
        self._http = httpx.AsyncClient(timeout=20)

    async def stop(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def verify_webhook(self, request: WebhookRequest) -> None:
        if request.method.upper() == "GET":
            if request.query.get("hub.mode") != "subscribe" or not hmac.compare_digest(
                request.query.get("hub.verify_token", "").encode("utf-8"),
                self._config.verify_token.encode("utf-8"),
            ):
                raise WebhookAuthenticityError(
                    "the WhatsApp webhook verification token does not match"
                )
            return
        if request.method.upper() != "POST":
            raise WebhookAuthenticityError("unsupported WhatsApp webhook method")
        supplied = request.headers.get("x-hub-signature-256", "")
        expected = (
            "sha256="
            + hmac.new(
                self._config.app_secret.encode(), request.body, hashlib.sha256
            ).hexdigest()
        )
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            raise WebhookAuthenticityError(
                "the WhatsApp webhook signature does not match"
            )

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        if request.method.upper() == "GET":
            challenge = request.query.get("hub.challenge", "")
            if not challenge:
                raise WebhookPayloadError("WhatsApp address check has no challenge")
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
        except (ValueError, UnicodeDecodeError) as exc:
            raise WebhookPayloadError("WhatsApp event body is not JSON") from exc
        if (
            not isinstance(payload, dict)
            or payload.get("object") != "whatsapp_business_account"
        ):
            raise WebhookPayloadError(
                "WhatsApp event is not a business account notification"
            )
        entries = payload.get("entry", [])
        if not isinstance(entries, list):
            raise WebhookPayloadError(
                "WhatsApp business account notification has invalid entries"
            )
        message_ids: list[str] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            changes = entry.get("changes", [])
            if not isinstance(changes, list):
                continue
            for change in changes:
                if not isinstance(change, dict) or change.get("field") != "messages":
                    continue
                value = change.get("value")
                messages = value.get("messages", []) if isinstance(value, dict) else []
                if isinstance(messages, list):
                    message_ids.extend(
                        str(message["id"])
                        for message in messages
                        if isinstance(message, dict) and message.get("id")
                    )
        # A delivery can include multiple messages; a stable combined receipt
        # prevents a retried envelope from dispatching any of them twice.
        event_id = ",".join(message_ids) if message_ids else None
        return InboundWebhook(
            envelope_type="messages",
            payload=payload,
            handshake=None,
            external_event_id=event_id,
            delivery_attempt=0,
            answers_inline=False,
        )

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        if envelope_type != "messages" or self._on_message is None:
            return
        now = time.time()
        entries = payload.get("entry", [])
        if not isinstance(entries, list):
            return
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            changes = entry.get("changes", [])
            if not isinstance(changes, list):
                continue
            for change in changes:
                if not isinstance(change, dict) or change.get("field") != "messages":
                    continue
                value = change.get("value")
                if not isinstance(value, dict):
                    continue
                metadata = value.get("metadata")
                if (
                    not isinstance(metadata, dict)
                    or str(metadata.get("phone_number_id", ""))
                    != self._config.phone_number_id
                ):
                    continue
                contacts: dict[str, str] = {}
                raw_contacts = value.get("contacts", [])
                if isinstance(raw_contacts, list):
                    for contact in raw_contacts:
                        if not isinstance(contact, dict) or not contact.get("wa_id"):
                            continue
                        contact_id = str(contact["wa_id"])
                        profile = contact.get("profile")
                        profile_name = (
                            profile.get("name") if isinstance(profile, dict) else None
                        )
                        contacts[contact_id] = str(profile_name or contact_id)
                messages = value.get("messages", [])
                if not isinstance(messages, list):
                    continue
                for item in messages:
                    if not isinstance(item, dict) or item.get("type") != "text":
                        continue
                    sender = str(item.get("from", ""))
                    text = item.get("text")
                    if (
                        not sender
                        or not item.get("id")
                        or not isinstance(text, dict)
                        or not isinstance(text.get("body"), str)
                    ):
                        continue
                    try:
                        timestamp = float(item["timestamp"])
                    except (KeyError, TypeError, ValueError):
                        timestamp = None
                    if timestamp is not None and 0 < timestamp <= now:
                        self._last_inbound[sender] = max(
                            timestamp, self._last_inbound.get(sender, 0)
                        )
                    await self._on_message(
                        InboundMessage(
                            channel_id=sender,
                            channel_type="direct",
                            sender_id=sender,
                            sender_name=str(contacts.get(sender, sender)),
                            content=text["body"],
                            message_ref=str(item["id"]),
                            channel_name=str(contacts.get(sender, sender)),
                        )
                    )

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        last_inbound = self._last_inbound.get(channel_id)
        if (
            last_inbound is None
            or time.time() - last_inbound >= _CUSTOMER_SERVICE_WINDOW
        ):
            raise BridgeOperationError(
                "WhatsApp's 24-hour customer service window is closed or unknown. "
                "Ask the person to message this WhatsApp number again before replying."
            )
        if self._http is None:
            raise BridgeOperationError("WhatsApp is not connected to the Cloud API.")
        url = (
            f"https://graph.facebook.com/{self._config.api_version}/"
            f"{self._config.phone_number_id}/messages"
        )
        try:
            response = await self._http.post(
                url,
                headers={"Authorization": f"Bearer {self._config.access_token}"},
                json={
                    "messaging_product": "whatsapp",
                    "recipient_type": "individual",
                    "to": channel_id,
                    "type": "text",
                    "text": {
                        "preview_url": False,
                        "body": self.translate_outbound(content),
                    },
                },
            )
        except httpx.HTTPError as exc:
            raise BridgeOperationError(
                f"Could not reach Meta to send the WhatsApp message: {exc}. Try again."
            ) from exc
        if response.is_error:
            raise BridgeOperationError(
                _api_error(response, "WhatsApp refused the message")
            )
        try:
            body = response.json()
            return str(body["messages"][0]["id"])
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise BridgeOperationError(
                "Meta returned an invalid message response."
            ) from exc

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

    def channel_ids_refused(self) -> str | None:
        return "WhatsApp chats are learned from inbound messages and cannot be selected by ID."

    async def require_bindable_channel(self, channel_id: str) -> None:
        if channel_id not in self._last_inbound:
            raise ChannelNotBindable(
                "This WhatsApp chat has not sent a message to the connected phone number."
            )

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        return []

    async def create_agent_identity(self, agent: Any) -> None:
        return None

    async def remove_agent_identity(self, agent: Any) -> None:
        return None

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "WhatsApp chats cannot be created through the Cloud API."
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        raise BridgeOperationError(
            "WhatsApp message edits are not supported by this integration."
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        raise BridgeOperationError(
            "WhatsApp message deletion is not supported by this integration."
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        return RetireOutcome(outcome="kept")


def _api_error(response: httpx.Response, fallback: str) -> str:
    try:
        body = response.json()
        error = body.get("error") if isinstance(body, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
    except ValueError:
        message = None
    return f"{fallback}: {message or f'HTTP {response.status_code}'}"

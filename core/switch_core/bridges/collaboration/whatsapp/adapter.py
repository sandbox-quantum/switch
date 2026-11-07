from __future__ import annotations

import hashlib
import hmac
import logging
import time
from collections.abc import Awaitable, Callable
from typing import ClassVar

from pydantic import Field

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)


class WhatsAppConnectionConfig(BridgeConnectionConfig):
    """Configuration for connecting WhatsApp Business Cloud API to Switch."""

    phone_number_id: str = Field(description="WhatsApp Business Phone Number ID from Meta App Dashboard")
    access_token: str = Field(description="Meta Graph API access token (System User or App token)")
    app_secret: str = Field(description="Meta App Secret for verifying X-Hub-Signature-256 headers")
    webhook_verify_token: str = Field(
        default="switch_verify_token",
        description="Verify token specified in Meta App Webhook configuration",
    )
    business_account_id: str | None = Field(default=None, description="WhatsApp Business Account ID (WABA ID)")


class WhatsAppAdapter(PlatformAdapter):
    """Messaging bridge adapter for WhatsApp Business Cloud API."""

    display_name: ClassVar[str] = "WhatsApp"
    docs_slug: ClassVar[str | None] = "whatsapp"
    icon_file: ClassVar[str] = "icon.svg"
    receives_webhooks: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False

    def __init__(self, config: WhatsAppConnectionConfig) -> None:
        self.config = config
        self._running = False
        self._sent_messages: list[dict[str, str | None]] = []
        # Maps user phone numbers to last interaction timestamp for 24h window enforcement
        self._last_user_activity: dict[str, float] = {}

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._running = True
        logger.info("WhatsApp Cloud API bridge started for Phone Number ID: %s", self.config.phone_number_id)

    async def stop(self) -> None:
        self._running = False
        logger.info("WhatsApp Cloud API bridge stopped.")

    def record_user_activity(self, sender_id: str) -> None:
        """Record activity timestamp to track the 24-hour customer service window."""
        self._last_user_activity[sender_id] = time.time()

    def is_within_24h_window(self, sender_id: str) -> bool:
        """Check if message is within the free-form 24-hour service window."""
        last_seen = self._last_user_activity.get(sender_id)
        if last_seen is None:
            return True  # If unknown, allow attempt
        return (time.time() - last_seen) <= 86400  # 24 hours

    def verify_webhook_signature(self, payload: bytes, signature_header: str) -> bool:
        """Verify Meta's X-Hub-Signature-256 header."""
        if not signature_header.startswith("sha256="):
            return False
        expected_sig = hmac.new(
            self.config.app_secret.encode("utf-8"),
            payload,
            hashlib.sha256,
        ).hexdigest()
        actual_sig = signature_header.removeprefix("sha256=")
        return hmac.compare_digest(expected_sig, actual_sig)

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        if not self.is_within_24h_window(channel_id):
            raise BridgeOperationError(
                f"Cannot send free-form message to WhatsApp user {channel_id}: 24-hour customer service window expired."
            )

        msg_id = f"wamid.{hashlib.sha256(f'{channel_id}:{time.time()}'.encode()).hexdigest()[:16]}"
        self._sent_messages.append({
            "message_id": msg_id,
            "channel_id": channel_id,
            "sender_name": sender_name,
            "content": content,
            "context_message_id": thread_root_id,
        })
        logger.debug("Simulated WhatsApp Cloud API message sent: %s to %s", msg_id, channel_id)
        return msg_id

    async def update_message(self, channel_id: str, message_ref: str, new_content: str) -> None:
        logger.debug("WhatsApp Cloud API does not support editing messages.")

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.debug("WhatsApp Cloud API does not support deleting messages.")

    async def send_typing(self, channel_id: str, sender_name: str, is_typing: bool) -> None:
        pass

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "WhatsApp cannot create chats or groups via Cloud API. Chats are initiated by the customer."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct"

    async def add_agents_to_channel(self, channel_id: str, agent_names: list[str]) -> None:
        pass

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        pass

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message.strip()

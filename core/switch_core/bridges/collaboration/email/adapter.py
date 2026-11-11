from __future__ import annotations

import email
import email.policy
import email.utils
import logging
import re
from collections.abc import Awaitable, Callable
from typing import ClassVar

from pydantic import Field

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    BridgeConnectionConfig,
    ChannelCreationUnsupported,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

# Patterns for stripping quoted replies from inbound email
_RE_QUOTED_HEADER = re.compile(
    r"(?:^|\n)(?:On\s+.+?\bwrote:|-+\s*Original Message\s*-+|From:\s*.+?\nSent:\s*.+?\n)",
    re.IGNORECASE,
)
_RE_EMAIL_SIGNATURE = re.compile(r"(?:^|\n)--\s*\n.*$", re.DOTALL)


class EmailConnectionConfig(BridgeConnectionConfig):
    """Configuration for connecting an Email mailbox to Switch."""

    email_address: str = Field(description="The primary email address for this bridge (e.g. agents@example.com)")
    smtp_host: str = Field(default="localhost", description="Outbound SMTP hostname")
    smtp_port: int = Field(default=587, description="SMTP port (typically 587 for STARTTLS or 465 for SSL)")
    smtp_user: str | None = Field(default=None, description="SMTP username for authentication")
    smtp_password: str | None = Field(default=None, description="SMTP password or app password")
    imap_host: str | None = Field(default=None, description="Inbound IMAP hostname for polling mailboxes")
    imap_port: int = Field(default=993, description="IMAP port (typically 993 for SSL)")
    imap_user: str | None = Field(default=None, description="IMAP username")
    imap_password: str | None = Field(default=None, description="IMAP password")
    use_tls: bool = Field(default=True, description="Whether to use TLS/STARTTLS")
    webhook_secret: str | None = Field(
        default=None,
        description="Shared secret for verifying inbound webhook deliveries from mail providers (SendGrid, Postmark, SES)",
    )


class EmailAdapter(PlatformAdapter):
    """Messaging bridge adapter that connects Switch rooms to email threads."""

    display_name: ClassVar[str] = "Email"
    docs_slug: ClassVar[str | None] = "email"
    icon_file: ClassVar[str] = "icon.svg"
    receives_webhooks: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False

    def __init__(self, config: EmailConnectionConfig) -> None:
        self.config = config
        self._running = False
        self._sent_messages: list[dict[str, str | None]] = []

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._running = True
        logger.info("Email messaging bridge started for %s", self.config.email_address)

    async def stop(self) -> None:
        self._running = False
        logger.info("Email messaging bridge stopped for %s", self.config.email_address)

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        msg_id = email.utils.make_msg_id(domain="switch.local")
        self._sent_messages.append({
            "message_id": msg_id,
            "channel_id": channel_id,
            "sender_name": sender_name,
            "content": content,
            "thread_root_id": thread_root_id,
        })
        logger.debug("Simulated outbound email sent: %s to %s", msg_id, channel_id)
        return msg_id

    async def update_message(self, channel_id: str, message_ref: str, new_content: str) -> None:
        # Email protocol has no native message edit capability; record edit notice if needed
        logger.debug("Email does not support message edits in-place: %s", message_ref)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.debug("Email does not support message retraction: %s", message_ref)

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
            "Email cannot provision mailboxes or channels automatically. Inbound emails map to rooms."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "direct" if "@" in channel_id else "channel_public"

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
        # Strip quoted email chains
        text = _RE_QUOTED_HEADER.split(raw_message)[0]
        # Strip signature
        text = _RE_EMAIL_SIGNATURE.sub("", text)
        return text.strip()

    def parse_raw_email(self, raw_bytes: bytes) -> tuple[str, str, str | None, list[Attachment]]:
        """Parse raw RFC 822 email bytes into (sender, body, in_reply_to, attachments)."""
        msg = email.message_from_bytes(raw_bytes, policy=email.policy.default)
        sender = msg.get("From", "")
        in_reply_to = msg.get("In-Reply-To") or msg.get("References")
        
        body_parts = []
        attachments = []

        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                disposition = part.get_content_disposition()
                
                if disposition == "attachment":
                    filename = part.get_filename() or "attachment.dat"
                    payload = part.get_payload(decode=True) or b""
                    attachments.append(Attachment(filename=filename, mimetype=content_type, data=payload))
                elif content_type == "text/plain":
                    body_parts.append(part.get_content())
        else:
            body_parts.append(msg.get_content())

        raw_body = "\n".join(body_parts)
        cleaned_body = self.translate_inbound(raw_body)
        return sender, cleaned_body, in_reply_to, attachments

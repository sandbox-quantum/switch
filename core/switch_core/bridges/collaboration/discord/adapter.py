from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)


class DiscordConnectionConfig(BridgeConnectionConfig):
    bot_token: str
    guild_id: str


class DiscordAdapter(CollaborationAdapter):
    """Discord collaboration bridge adapter.

    Single-bot identity model like Slack: all agents post through one bot
    application, differentiated per message via channel webhooks (Discord
    webhooks accept a per-message username and avatar_url). Inbound events
    arrive over a Gateway WebSocket session scoped to the configured guild;
    outbound goes through the REST API.
    """

    def __init__(self, *, config: DiscordConnectionConfig) -> None:
        super().__init__()
        self._config = config

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
        # Single-bot identity model: agents share the one Discord bot via
        # per-message webhook username/avatar override, so there is no
        # per-agent join to detect. The bot's own join to a guild channel is
        # surfaced via on_app_joined instead.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        logger.info(
            "Discord adapter configured for guild %s (gateway connection lands in P1)",
            self._config.guild_id,
        )

    async def stop(self) -> None:
        logger.info("Discord adapter stopped")

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        raise NotImplementedError("Discord outbound messaging lands in P1")

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        raise NotImplementedError("Discord message editing lands in P1")

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        raise NotImplementedError("Discord message deletion lands in P1")

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        raise NotImplementedError("Discord typing indicator lands in P1")

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise NotImplementedError("Discord channel provisioning lands in P3")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        raise NotImplementedError("Discord channel provisioning lands in P3")

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        pass

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> None:
        raise NotImplementedError("Discord channel membership lands in P3")

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        pass

    async def remove_agent_identity(self, agent_name: str) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Translation ──────────────────────────────────────────────────────────

    def translate_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

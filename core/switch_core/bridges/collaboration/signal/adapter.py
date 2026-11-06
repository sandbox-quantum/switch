"""The Signal adapter: a user-run signal-cli daemon's HTTP JSON-RPC and SSE.

The operator runs `signal-cli daemon --http <host>:8080 --receive-mode on-start`
for their registered Signal number, and Switch connects to it. Inbound events
arrive over the daemon's SSE stream (`GET /api/v1/events`); every outbound call
goes through the JSON-RPC endpoint (`POST /api/v1/rpc`).

The adapter keeps no state another pod or a restart needs: the SSE connection
runs only on the pod holding the bridge lease, and every identifier it hands
to Switch encodes what signal-cli needs to act on it — `g:<base64 groupId>`
for a group, `d:<source uuid>` for a DM, and `<author>:<timestamp>` for a
message (Signal identifies one by the author that sent it and when).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

from pydantic import Field

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    ChannelCreationUnsupported,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)



class SignalConnectionConfig(BridgeConnectionConfig):
    """A connection to one account on a signal-cli daemon."""

    daemon_url: str = Field(
        description=(
            "The signal-cli daemon's HTTP address, as the server reaches it, "
            "for example http://127.0.0.1:8080. The daemon has no "
            "authentication, so it must only be reachable on a private "
            "network."
        ),
    )
    account: str = Field(
        description=(
            "The Signal number this bridge acts as, in E.164 form, for "
            "example +15555550100."
        ),
    )


class SignalAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Signal"
    # The daemon's SSE stream is the one long-lived connection, so quiet pods
    # open nothing the platform delivers over; only the lease holder listens.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # The bot can only name people who have messaged it.
    supports_directory_search: ClassVar[bool] = False
    # Signal linkifies only http(s), so a switchdash:// deeplink cannot work.
    renders_custom_url_schemes: ClassVar[bool] = False
    # v1 cannot create a chat from Switch; one is opened on the phone and the
    # bot is added there.
    supports_channel_creation: ClassVar[bool] = False

    def __init__(self, *, config: SignalConnectionConfig) -> None:
        super().__init__()
        self.config = config

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        url = connection_config.get("daemon_url")
        return [str(url)] if url else []

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        raise NotImplementedError

    async def stop(self) -> None:
        raise NotImplementedError

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        raise NotImplementedError

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        raise NotImplementedError

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        raise NotImplementedError

    async def send_typing(self, channel_id: str, sender_name: str, is_typing: bool) -> None:
        raise NotImplementedError

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Signal cannot create a chat from Switch; open it on the phone "
            "and add the bot there."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        raise NotImplementedError

    async def add_agents_to_channel(self, channel_id: str, agent_names: list[str]) -> None:
        raise NotImplementedError

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        raise NotImplementedError

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        raise NotImplementedError

    # One Signal account cannot have per-agent names or avatars, so an agent's
    # identity is carried by its name in the message text instead.
    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

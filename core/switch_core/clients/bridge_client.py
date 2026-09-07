from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Unpack

from switch_core.clients.client_base import (
    ClientBase,
    ClientBaseKwargs,
    ClientConfig,
)
from switch_core.events import AgentRuntimeStateEvent
from switch_core.transport import InboundMedia, InboundMessage, RoomRef

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.bridge_core import BridgeCore

logger = logging.getLogger(__name__)


class BridgeClientConfig(ClientConfig):
    bridge_id: str


class BridgeClient(ClientBase[BridgeClientConfig]):
    config_class = BridgeClientConfig

    def __init__(
        self,
        *,
        bridge_core: BridgeCore,
        **kwargs: Unpack[ClientBaseKwargs[BridgeClientConfig]],
    ) -> None:
        super().__init__(**kwargs)
        self._bridge_core = bridge_core

    async def on_message(self, room: RoomRef, event: InboundMessage) -> None:
        logger.debug(
            "[BRIDGE-CLIENT] on_message room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        await self._bridge_core.handle_outbound_message(room, event)

    async def on_media(self, room: RoomRef, event: InboundMedia) -> None:
        logger.debug(
            "[BRIDGE-CLIENT] on_media room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        await self._bridge_core.handle_outbound_media(room, event, self)

    async def on_agent_runtime_state(
        self, room: RoomRef, event: AgentRuntimeStateEvent
    ) -> None:
        await self._bridge_core.handle_agent_runtime_state(room, event)

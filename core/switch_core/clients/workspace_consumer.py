from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from switch_core.clients.actor import Actor, ClientConfig
from switch_core.clients.consumer import Consumer
from switch_core.logging_context import log_context
from switch_core.transport import InboundMedia, InboundMessage, RoomRef

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.collaboration_core import CollaborationCore

logger = logging.getLogger(__name__)


class WorkspaceConsumerConfig(ClientConfig):
    bridge_id: str


class WorkspaceConsumer(Consumer[Actor[WorkspaceConsumerConfig]]):
    """Reads every room a collaboration bridge mirrors, for its workspace.

    One per bridge (client type `bridge`). Everything new in those rooms is
    handed to the bridge's `CollaborationCore`, which drops what came from the
    platform and posts the rest to it. Its actor is the bridge's own identity
    in the room; it writes nothing, because the people on the platform write
    through their own `HumanActor`s.
    """

    def __init__(
        self,
        *,
        actor: Actor[WorkspaceConsumerConfig],
        collaboration_core: CollaborationCore,
    ) -> None:
        super().__init__(actor=actor)
        self._collaboration_core = collaboration_core

    async def on_message(self, room: RoomRef, event: InboundMessage) -> None:
        logger.debug(
            "[WORKSPACE-CONSUMER] on_message room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        with log_context(
            bridge="collaboration", platform=self._collaboration_core.bridge_type
        ):
            await self._collaboration_core.handle_outbound_message(room, event)

    async def on_media(self, room: RoomRef, event: InboundMedia) -> None:
        logger.debug(
            "[WORKSPACE-CONSUMER] on_media room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        with log_context(
            bridge="collaboration", platform=self._collaboration_core.bridge_type
        ):
            await self._collaboration_core.handle_outbound_media(room, event, self)

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from switch_core.clients.actor import Actor, ClientConfig
from switch_core.clients.consumer import Consumer
from switch_core.events import CommandEvent
from switch_core.logging_context import log_context
from switch_core.transport import InboundMedia, InboundMessage, RoomRef

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.collaboration_core import CollaborationCore

logger = logging.getLogger(__name__)

# How long after a room message failed to reach the platform to try it again,
# attempt by attempt. Until it is posted, or the last attempt fails too, the
# bridge's progress in the room stops before it (`held_from`), so whoever holds
# the bridge next tries it if this process stops first.
RETRY_RELAY_AFTER_SECONDS: tuple[float, ...] = (2.0, 10.0, 60.0)


class WorkspaceConsumerConfig(ClientConfig):
    bridge_id: str


class WorkspaceConsumer(Consumer[Actor[WorkspaceConsumerConfig]]):
    """Reads every room a collaboration bridge mirrors, for its workspace.

    One per bridge (client type `bridge`), running in the one switch-core
    process that holds the bridge (`ownership.py`). Everything new in those
    rooms is handed to the bridge's `CollaborationCore`, which drops what came
    from the platform and posts the rest to it. Its actor is the bridge's own
    identity in the room; it writes nothing, because the people on the
    platform write through their own `HumanActor`s.
    """

    def __init__(
        self,
        *,
        actor: Actor[WorkspaceConsumerConfig],
        collaboration_core: CollaborationCore,
    ) -> None:
        super().__init__(actor=actor)
        self._collaboration_core = collaboration_core
        # The `messages.seq` of each room message that failed to reach the
        # platform and is being tried again, by room and event id.
        self._retrying: dict[str, dict[str, int]] = {}
        self._retries: set[asyncio.Task[None]] = set()

    def held_from(self, room_id: str) -> int | None:
        """The first row in the room not posted yet: a file of a multi-file
        message still waiting to be posted as one, or a message being tried
        again. Progress stops before it, so whoever holds the bridge next
        posts it."""
        held = [
            seq
            for seq in [
                self._collaboration_core.held_from(room_id),
                *self._retrying.get(room_id, {}).values(),
            ]
            if seq is not None
        ]
        return min(held) if held else None

    async def teardown(self) -> None:
        """Stop trying failed messages again. They stay held, so whoever holds
        the bridge next tries them."""
        for task in self._retries:
            task.cancel()
        await asyncio.gather(*self._retries, return_exceptions=True)

    async def _relay(
        self,
        room: RoomRef,
        event_id: str,
        seq: int,
        relay: Callable[[], Awaitable[None]],
    ) -> None:
        """Relay a room message, and try it again later if it fails.

        The bridge lets go of its claim on a message the platform refused
        (`CollaborationCore._release_outbound`), but the transport has already
        moved past the row, so nothing would read it again.

        A message that fails while the bridge is stopping, the one in hand
        when it was told to stop, is held but not tried again here: the
        retries were stopped already (`teardown`), and whoever holds the
        bridge next reads it again."""
        try:
            await relay()
        except Exception:
            if seq == 0:
                raise
            self._retrying.setdefault(room.room_id, {})[event_id] = seq
            if not self.running:
                logger.warning(
                    "[WORKSPACE-CONSUMER] %s did not reach the platform as the "
                    "bridge stopped; whoever holds it next tries it again",
                    event_id,
                    exc_info=True,
                )
                return
            logger.warning(
                "[WORKSPACE-CONSUMER] %s did not reach the platform; trying it "
                "again in %.0fs",
                event_id,
                RETRY_RELAY_AFTER_SECONDS[0],
                exc_info=True,
            )
            task = asyncio.create_task(self._retry(room, event_id, relay))
            self._retries.add(task)
            task.add_done_callback(self._retries.discard)

    async def _retry(
        self, room: RoomRef, event_id: str, relay: Callable[[], Awaitable[None]]
    ) -> None:
        attempts = len(RETRY_RELAY_AFTER_SECONDS)
        for attempt, delay in enumerate(RETRY_RELAY_AFTER_SECONDS, start=1):
            await asyncio.sleep(delay)
            try:
                await relay()
                break
            except Exception:
                if attempt == attempts:
                    logger.error(
                        "[WORKSPACE-CONSUMER] %s did not reach the platform in "
                        "%d more attempts; giving up on it",
                        event_id,
                        attempts,
                        exc_info=True,
                    )
                else:
                    logger.warning(
                        "[WORKSPACE-CONSUMER] %s did not reach the platform "
                        "again (attempt %d of %d); trying it again in %.0fs",
                        event_id,
                        attempt,
                        attempts,
                        RETRY_RELAY_AFTER_SECONDS[attempt],
                        exc_info=True,
                    )
        held = self._retrying.get(room.room_id, {})
        held.pop(event_id, None)
        if not held:
            self._retrying.pop(room.room_id, None)
        transport = self.transport
        if transport is not None:
            transport.held_back_released(room.room_id)

    async def on_message(self, room: RoomRef, event: InboundMessage) -> None:
        logger.debug(
            "[WORKSPACE-CONSUMER] on_message room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        with log_context(
            bridge="collaboration", platform=self._collaboration_core.bridge_type
        ):
            await self._relay(
                room,
                event.event_id,
                event.seq,
                lambda: self._collaboration_core.handle_outbound_message(room, event),
            )

    async def on_media(self, room: RoomRef, event: InboundMedia) -> None:
        logger.debug(
            "[WORKSPACE-CONSUMER] on_media room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        with log_context(
            bridge="collaboration", platform=self._collaboration_core.bridge_type
        ):
            await self._relay(
                room,
                event.event_id,
                event.seq,
                lambda: self._collaboration_core.handle_outbound_media(
                    room, event, self
                ),
            )

    async def on_command(self, room: RoomRef, event: CommandEvent) -> None:
        with log_context(
            bridge="collaboration", platform=self._collaboration_core.bridge_type
        ):
            await self._relay(
                room,
                event.source_event_id or "",
                event.room_seq,
                lambda: self._collaboration_core.handle_outbound_command(room, event),
            )

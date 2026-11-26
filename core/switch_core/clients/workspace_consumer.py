from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
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

Relay = Callable[[], Awaitable[None]]


class RelayFailed(Exception):
    """A relay that failed on behalf of earlier rows too: the last file of a
    multi-file message, which posts the whole group. The room is held from the
    group's first row, and `retry` posts the group again."""

    def __init__(self, hold_from: int, retry: Relay) -> None:
        super().__init__(f"relaying from row {hold_from} failed")
        self.hold_from = hold_from
        self.retry = retry


@dataclass
class _Held:
    """A room row not posted yet: one that failed, or one behind it."""

    seq: int
    hold_from: int
    relay: Relay
    # Whether it has been tried and failed, so the next try waits first.
    failed: bool


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
        # By room: a row that failed to reach the platform, and every row of
        # the room after it, posted in order by the room's worker.
        self._held: dict[str, deque[_Held]] = {}
        self._workers: dict[str, asyncio.Task[None]] = {}

    def held_from(self, room_id: str) -> int | None:
        """The first row in the room not posted yet: a file of a multi-file
        message still waiting to be posted as one, or a row held behind a
        failure. Progress stops before it, so whoever holds the bridge next
        posts it."""
        held = [
            seq
            for seq in [
                self._collaboration_core.held_from(room_id),
                *(item.hold_from for item in self._held.get(room_id, ())),
            ]
            if seq is not None
        ]
        return min(held) if held else None

    async def teardown(self) -> None:
        """Stop posting held rows. They stay held, so whoever holds the bridge
        next posts them."""
        workers = list(self._workers.values())
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)

    async def relay_held_back(self, room_id: str, seq: int, relay: Relay) -> None:
        """Relay a row the bridge held back and posts on its own time (a
        multi-file message posted incomplete when its wait ran out), held and
        tried again as a row relayed as it was read is (`_relay`)."""
        await self._relay(RoomRef(room_id=room_id), seq, relay)

    async def _relay(self, room: RoomRef, seq: int, relay: Relay) -> None:
        """Relay a room row, or hold it to post later.

        The bridge lets go of its claim on a message the platform refused
        (`CollaborationCore._release_outbound`), but the transport has already
        moved past the row, so nothing would read it again. A row that fails
        is held, and so is every later row of the room, so a reply is not
        posted before the message it answers; the room's worker tries the
        failed row again (`RETRY_RELAY_AFTER_SECONDS`) and then posts the rest
        in order. A refusal the platform's adapter calls permanent is not
        tried again. A row delivered again while it is held, as when the room
        is read again from its recorded progress, is held once.

        Once the bridge is stopping, a failed row is held but not tried: the
        worker was stopped already (`teardown`), and whoever holds the bridge
        next reads it again."""
        held = self._held.get(room.room_id)
        if held is not None:
            if seq not in {item.seq for item in held}:
                held.append(_Held(seq, seq, relay, failed=False))
            return
        try:
            await relay()
        except Exception as error:
            if seq == 0:
                raise
            failed = self._failed(room, seq, relay, error)
            if failed is None:
                return
            self._held[room.room_id] = deque([failed])
            if self.running:
                self._workers[room.room_id] = asyncio.create_task(self._post_held(room))

    def _failed(
        self, room: RoomRef, seq: int, relay: Relay, error: Exception
    ) -> _Held | None:
        """What to hold for a row that failed, or None when trying it again
        cannot help."""
        kind = self._collaboration_core.refusal_kind(error)
        if kind == "permanent":
            logger.error(
                "[WORKSPACE-CONSUMER] row %d of %s was refused for good by the "
                "platform; not trying it again",
                seq,
                room.room_id,
                exc_info=error,
            )
            return None
        logger.warning(
            "[WORKSPACE-CONSUMER] row %d of %s did not reach the platform; "
            "holding the room's later rows behind it%s",
            seq,
            room.room_id,
            "" if self.running else ", for whoever holds the bridge next",
            exc_info=error,
        )
        if isinstance(error, RelayFailed):
            return _Held(seq, error.hold_from, error.retry, failed=True)
        return _Held(seq, seq, relay, failed=True)

    async def _post_held(self, room: RoomRef) -> None:
        """Post a room's held rows in order: the first after its failure, as
        `RETRY_RELAY_AFTER_SECONDS` says, then each after it, until none is
        left. A row that fails holds the rest again."""
        held = self._held[room.room_id]
        try:
            while held:
                await self._post_first(room, held[0])
                held.popleft()
                transport = self.transport
                if transport is not None:
                    transport.held_back_released(room.room_id)
            del self._held[room.room_id]
        finally:
            self._workers.pop(room.room_id, None)

    async def _post_first(self, room: RoomRef, item: _Held) -> None:
        if not item.failed:
            try:
                await item.relay()
                return
            except Exception as error:
                failed = self._failed(room, item.seq, item.relay, error)
                if failed is None:
                    return
                item.hold_from, item.relay, item.failed = (
                    failed.hold_from,
                    failed.relay,
                    True,
                )
        attempts = len(RETRY_RELAY_AFTER_SECONDS)
        for attempt, delay in enumerate(RETRY_RELAY_AFTER_SECONDS, start=1):
            await asyncio.sleep(delay)
            try:
                await item.relay()
                return
            except Exception as error:
                if self._collaboration_core.refusal_kind(error) == "permanent":
                    logger.error(
                        "[WORKSPACE-CONSUMER] row %d of %s was refused for good "
                        "by the platform; not trying it again",
                        item.seq,
                        room.room_id,
                        exc_info=True,
                    )
                    return
                if attempt == attempts:
                    logger.error(
                        "[WORKSPACE-CONSUMER] row %d of %s did not reach the "
                        "platform in %d more attempts; giving up on it",
                        item.seq,
                        room.room_id,
                        attempts,
                        exc_info=True,
                    )
                    return
                logger.warning(
                    "[WORKSPACE-CONSUMER] row %d of %s did not reach the platform "
                    "again (attempt %d of %d); trying it again in %.0fs",
                    item.seq,
                    room.room_id,
                    attempt,
                    attempts,
                    RETRY_RELAY_AFTER_SECONDS[attempt],
                    exc_info=True,
                )

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
                event.room_seq,
                lambda: self._collaboration_core.handle_outbound_command(room, event),
            )

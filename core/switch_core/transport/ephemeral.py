"""How presence reaches the clients watching a room.

Some events are announced and never stored: runtime state today, typing if it
ever returns. Their next value replaces them, so a row in `messages` would put
something in the room's ordering that no reader is ever shown, and a delivery
cursor would faithfully replay a status that stopped being true minutes ago.
The message log is deliberately not their home.

But a Postgres transport delivers by reading rows, so dropping the write also
dropped the delivery: runtime state was captured in `agent_runtime_states` and
reached nobody, which is why an agent going busy stopped showing up on a
bridged channel.

This is the delivery, without the storage: an in-process fan-out to the
transports watching that room, carrying the event itself rather than a
position — the opposite of the notify listener, and correct for the opposite
reason. A position is right when the value is durable and the reader can go and
fetch it. Presence has nowhere to fetch from, so the announcement has to be the
value, and a missed one costs a briefly stale indicator rather than data.

**It is in-process, the same limitation `InviteBus` documents**, and it should
be lifted at the same time and in the same way. A second replica needs a
cross-process signal for both; until switch-core can run more than one, this is
no worse than the Matrix sessions it replaces.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from switch_core.transport.types import InboundCustomEvent

logger = logging.getLogger(__name__)

EphemeralHandler = Callable[[InboundCustomEvent], Awaitable[None]]


class EphemeralBus:
    """Routes an unstored room event to whoever is watching that room."""

    def __init__(self) -> None:
        self._handlers: dict[str, set[EphemeralHandler]] = {}

    def subscribe(self, transport_room_id: str, handler: EphemeralHandler) -> None:
        self._handlers.setdefault(transport_room_id, set()).add(handler)

    def unsubscribe(self, transport_room_id: str, handler: EphemeralHandler) -> None:
        self._handlers.get(transport_room_id, set()).discard(handler)

    async def publish(self, transport_room_id: str, event: InboundCustomEvent) -> None:
        """Hand the event to every watcher, and let none of them stop another.

        A handler that raises is logged rather than propagated: this is
        presence, and failing the send of a status update because one listener
        mishandled it would turn a cosmetic problem into a real one.
        """
        for handler in list(self._handlers.get(transport_room_id, ())):
            try:
                await handler(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error(
                    "A watcher failed handling %s in room %s",
                    event.event_type,
                    transport_room_id,
                    exc_info=True,
                )

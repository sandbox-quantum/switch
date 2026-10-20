"""What a reading client does when it is taken out of a room while running.

Dropping the transport's subscription governs only what has not been read yet,
so the removal is handed to the client as well (`Consumer.on_removed`). An
agent reads no room: what its removal does is the router's
(`tests/switch_core/delivery/test_removed_from_room.py`).
"""

from __future__ import annotations

from switch_core.clients.actor import Actor
from switch_core.clients.consumer import Consumer
from switch_core.transport import InboundMembership, RoomRef


def _leave(transport_room_id: str) -> InboundMembership:
    return InboundMembership(
        room_id=transport_room_id,
        event_id="$leave",
        sender="@agent:test",
        timestamp=0,
        state_key="@agent:test",
        membership="leave",
        display_name="agent",
    )


class _CapturingTransport:
    def __init__(self) -> None:
        self.handlers: object | None = None

    def register_handlers(self, handlers: object) -> None:
        self.handlers = handlers


class _BareClient(Consumer):
    """Enough of a consumer for `setup` to run and a hook to be observed."""

    def __init__(self, transport: _CapturingTransport) -> None:
        actor = Actor.__new__(Actor)
        actor.transport_user_id = "@agent:test"
        # `_transport` is a property over this, and raises until it is set.
        actor.transport = transport
        self.actor = actor
        self._self_join_dispatched: set[str] = set()
        self.removed: list[str] = []

    async def on_removed(self, room: RoomRef, event: InboundMembership) -> None:
        self.removed.append(room.room_id)


async def test_setup_wires_the_removal_hook_to_the_transport() -> None:
    """The seam the whole eviction path hangs off.

    Everything else here calls `on_removed` directly, and the transport tests
    prove it dispatches `on_removed` — but nothing joined the two. Severing
    this one line left every other test in the suite green while a kick
    reached nobody, which is the leak with an extra step.
    """
    transport = _CapturingTransport()
    client = _BareClient(transport)

    client.setup()

    handlers = transport.handlers
    assert handlers is not None
    assert handlers.on_removed is not None, (  # type: ignore[attr-defined]
        "the transport was given no removal handler, so a kick reaches nothing"
    )

    await handlers.on_removed(  # type: ignore[attr-defined]
        RoomRef(room_id="!left:test"), _leave("!left:test")
    )
    assert client.removed == ["!left:test"]


async def test_being_removed_ends_the_visit_so_a_return_is_a_fresh_arrival() -> None:
    """The same bookkeeping a `leave` delivered as a member event does.

    Otherwise an agent added back to a room it had been removed from would
    rejoin in silence, because the join it already announced is remembered.
    """
    transport = _CapturingTransport()
    client = _BareClient(transport)
    client._self_join_dispatched.add("!left:test")
    client.setup()

    await transport.handlers.on_removed(  # type: ignore[attr-defined, union-attr]
        RoomRef(room_id="!left:test"), _leave("!left:test")
    )

    assert client._self_join_dispatched == set()

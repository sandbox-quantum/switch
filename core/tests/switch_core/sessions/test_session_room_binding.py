"""A session's room is its own, and outlives the connection carrying it.

Until now "which room" was a property of a connection: one connection, one
room, and a room-scoped call read it off the connection the caller named. That
is what stops several sessions of an agent sharing one inbound connection —
the connection would hold all their rooms and be unable to say which caller
meant which.

So the binding moves down a level. `bind_room` records the room a session is
working in, `session_binding` reads it back behind the same fence, and the
connection goes back to being the route rather than the answer.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.sessions.service import SessionError

from .test_authority import setup

AGENT = "agent-demo"
SESSION = "session-demo"
HOST = "host-demo"
CONNECTION = "connection-demo"
ROOM = "room-demo"


def _connections() -> ConnectionRegistry:
    registry = ConnectionRegistry()
    registry.open(
        agent_id=AGENT,
        connection_id=CONNECTION,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    return registry


async def _bound(session_factory):
    """A session holding a live connection and no room yet."""
    service, epoch = await setup(session_factory)
    registry = _connections()
    await service.bind_connection(AGENT, SESSION, HOST, epoch, CONNECTION, registry)
    return service, epoch, registry


@pytest.mark.asyncio
async def test_a_bound_room_is_read_back_with_the_connection(session_factory) -> None:
    """One read answers both questions a room-scoped caller asks."""
    service, epoch, _ = await _bound(session_factory)

    assert (await service.session_binding(AGENT, SESSION, HOST, epoch)).room_id is None

    await service.bind_room(AGENT, SESSION, HOST, epoch, ROOM)

    binding = await service.session_binding(AGENT, SESSION, HOST, epoch)
    assert binding.connection_id == CONNECTION
    assert binding.room_id == ROOM


@pytest.mark.asyncio
async def test_the_room_survives_the_connection_it_was_bound_under(
    session_factory,
) -> None:
    """The point of making it durable.

    A runtime that reconnects gets a brand-new connection claiming nothing. If
    the room lived on the connection, reattaching would silently put the
    session nowhere — which is what `bind_connection` used to do by deriving
    the session's rooms from whatever the connection happened to hold.
    """
    service, epoch, _ = await _bound(session_factory)
    await service.bind_room(AGENT, SESSION, HOST, epoch, ROOM)

    replacement = ConnectionRegistry()
    replacement.open(
        agent_id=AGENT,
        connection_id="connection-reattached",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    rooms = await service.bind_connection(
        AGENT, SESSION, HOST, epoch, "connection-reattached", replacement
    )

    assert rooms == [ROOM]
    binding = await service.session_binding(AGENT, SESSION, HOST, epoch)
    assert binding.connection_id == "connection-reattached"
    assert binding.room_id == ROOM


@pytest.mark.asyncio
async def test_binding_a_room_the_agent_is_not_in_is_refused(session_factory) -> None:
    """Membership is checked here, not inherited from the connection's claims."""
    service, epoch, _ = await _bound(session_factory)

    with pytest.raises(SessionError) as caught:
        await service.bind_room(AGENT, SESSION, HOST, epoch, "room-not-joined")

    assert caught.value.code == "NOT_AUTHORIZED"
    assert (await service.session_binding(AGENT, SESSION, HOST, epoch)).room_id is None


@pytest.mark.asyncio
async def test_binding_a_room_passes_the_session_fence(session_factory) -> None:
    """Writing the binding is fenced exactly as reading it is.

    The alternative — trusting that the front door already checked — would make
    this a second, weaker way into the session row, which is how the two copies
    of a rule start to differ.
    """
    service, epoch, _ = await _bound(session_factory)

    with pytest.raises(SessionError) as stale:
        await service.bind_room(AGENT, SESSION, HOST, "not-this-epoch", ROOM)
    assert stale.value.code == "STALE_EPOCH"

    with pytest.raises(SessionError) as impostor:
        await service.bind_room(AGENT, SESSION, "another-host", epoch, ROOM)
    assert impostor.value.code == "NOT_AUTHORIZED"


@pytest.mark.asyncio
async def test_rebinding_the_same_room_appends_nothing(session_factory) -> None:
    """A reconnect that changes nothing must not spend a sequence number.

    `connect_to_room` is idempotent and agents re-run it; emitting a
    `session.upsert` each time would fill the session's event log with
    duplicates its client has to skip.
    """
    service, epoch, _ = await _bound(session_factory)
    await service.bind_room(AGENT, SESSION, HOST, epoch, ROOM)
    through = (await service.snapshot(SESSION, "owner")).through_sequence

    await service.bind_room(AGENT, SESSION, HOST, epoch, ROOM)

    assert (await service.snapshot(SESSION, "owner")).through_sequence == through

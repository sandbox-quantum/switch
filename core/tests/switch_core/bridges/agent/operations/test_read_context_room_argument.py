"""Reading a room you are a member of without connecting to it (CHOO-2628).

Catching up on another room used to mean travelling to it, which drops the
agent out of the room it is supposed to be attending. `read_context` therefore
takes an optional room: omit it and the connected room is read as before, pass
one and that room is read instead, with nothing about the caller's connection
disturbed.

Membership, not connection, is the authorization boundary — and it is checked
where it always was, inside the protocol service, so an explicit room id buys
reach and not privilege.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    CallerSession,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import read_context
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer, Reader
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import db_buffer_on, say, seed_member

AGENT = "agent-1"
CONN = "conn-1"
CONNECTED_ROOM = "room-here"
OTHER_ROOM = "room-elsewhere"


class _Protocol:
    """Just enough protocol to answer a read: a registry and a recorder."""

    def __init__(self, registry: AgentConnectionRegistry, buffer: EventBuffer) -> None:
        self.connections = registry
        self.event_buffer = buffer
        self.calls: list[tuple[str, str]] = []
        self.members: set[str] = {CONNECTED_ROOM, OTHER_ROOM}
        self.while_in_flight: list[Callable[[], Awaitable[None]]] = []
        # Rooms answered from the home room by a session bound there.
        self.shared_from_home: set[str] = set()

    async def answers_from_home(
        self, agent_id: str, bound_rooms: set[str], room_id: str
    ) -> bool:
        return CONNECTED_ROOM in bound_rooms and room_id in self.shared_from_home

    async def read_context(
        self, agent_id: str, room_id: str, **kwargs: Any
    ) -> dict[str, Any]:
        if room_id not in self.members:
            raise PermissionError("Agent is not a member of this room")
        self.calls.append((agent_id, room_id))
        for during in self.while_in_flight:
            await during()
        return {"threads": [], "truncated": False, "oldest_timestamp": None}


@pytest.fixture
async def protocol(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    db_buffer: EventBuffer,
) -> _Protocol:
    for room_id in (CONNECTED_ROOM, OTHER_ROOM):
        await seed_member(session_factory, AGENT, room_id)
    registry = AgentConnectionRegistry()
    service = _Protocol(registry, db_buffer)
    monkeypatch.setattr(op_context, "_protocol", service)
    return service


@pytest.fixture
def connected(protocol: _Protocol) -> None:
    connection = protocol.connections.open(
        agent_id=AGENT,
        connection_id=CONN,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    protocol.connections.claim_room(connection, CONNECTED_ROOM)


@pytest.fixture
def caller():
    token = set_call_context(
        CallContext(agent_id=AGENT, session_key=CONN, session=None)
    )
    yield
    reset_call_context(token)


@pytest.fixture
def unbound_caller():
    """A caller with no connection at all, so no room can be defaulted."""
    token = set_call_context(
        CallContext(agent_id=AGENT, session_key=None, session=None)
    )
    yield
    reset_call_context(token)


@pytest.mark.asyncio
async def test_omitting_the_room_reads_the_one_you_are_connected_to(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    """The default is unchanged: the overwhelmingly common call reads here."""
    await read_context()

    assert protocol.calls == [(AGENT, CONNECTED_ROOM)]


@pytest.mark.asyncio
async def test_a_room_id_reads_that_room_instead(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    await read_context(room_id=OTHER_ROOM)

    assert protocol.calls == [(AGENT, OTHER_ROOM)]


@pytest.mark.asyncio
async def test_reading_elsewhere_leaves_you_where_you_were(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    """The whole point: catching up must not cost the agent its own room."""
    await read_context(room_id=OTHER_ROOM)

    claimant = protocol.connections.claimant_of(AGENT, CONNECTED_ROOM)
    assert claimant is not None
    assert claimant.id == CONN
    assert protocol.connections.claimant_of(AGENT, OTHER_ROOM) is None


@pytest.mark.asyncio
async def test_a_room_you_are_not_a_member_of_is_refused(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    """Naming a room is not the same as being allowed to read it."""
    with pytest.raises(PermissionError):
        await read_context(room_id="room-strangers")

    assert protocol.calls == []


@pytest.mark.asyncio
async def test_a_timestamp_that_does_not_parse_is_refused_naming_it(
    protocol: _Protocol, connected: None, caller: None
) -> None:
    with pytest.raises(
        ValueError, match="'before' is not an ISO 8601 timestamp: 'yesterday'"
    ):
        await read_context(before="yesterday")

    assert protocol.calls == []


@pytest.mark.asyncio
async def test_an_unconnected_caller_can_still_read_a_room_it_names(
    protocol: _Protocol, unbound_caller: None
) -> None:
    """No connection is needed when the room is explicit — membership decides."""
    await read_context(room_id=OTHER_ROOM)

    assert protocol.calls == [(AGENT, OTHER_ROOM)]


@pytest.mark.asyncio
async def test_an_unconnected_caller_naming_no_room_is_told_to_connect(
    protocol: _Protocol, unbound_caller: None
) -> None:
    """The old error survives, but only for the case it actually describes."""
    with pytest.raises(ValueError, match="connect_to_room"):
        await read_context()


@pytest.mark.asyncio
async def test_the_room_is_advertised_as_an_argument() -> None:
    """Agents learn the tool from its generated schema, so it must appear there."""
    from switch_core.bridges.agent.operations.registry import get_operation

    op = get_operation("read_context")
    assert op is not None
    schema = op.input_schema
    assert "room_id" in schema["properties"]
    assert "room_id" not in schema.get("required", [])


async def _chatter(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> None:
    """Somebody else saying something in the room, addressed to nobody."""
    await say(session_factory, room_id, "chatter")


async def _unread(protocol: _Protocol, room_id: str) -> int | None:
    """What the room is behind by, through everything said in it so far."""
    buffer = protocol.event_buffer
    head = (await buffer.room_heads(TENANT_ZERO_ID, {room_id}))[room_id]
    return (await buffer.unread(TENANT_ZERO_ID, AGENT, room_id, head)).count


@pytest.mark.asyncio
async def test_reading_here_is_what_clears_this_room_s_unread_count(
    protocol: _Protocol,
    connected: None,
    caller: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Reading is the act of catching up; being delivered an event is not."""
    buffer = protocol.event_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, CONN, CONNECTED_ROOM)
    await _chatter(session_factory, CONNECTED_ROOM)
    assert await _unread(protocol, CONNECTED_ROOM) == 1

    await read_context()

    assert await _unread(protocol, CONNECTED_ROOM) == 0


@pytest.mark.asyncio
async def test_reading_elsewhere_clears_nothing(
    protocol: _Protocol,
    connected: None,
    caller: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A cross-room read is a read of somewhere else, and counts nowhere here."""
    buffer = protocol.event_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, CONN, CONNECTED_ROOM)
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, CONN, OTHER_ROOM)
    await _chatter(session_factory, CONNECTED_ROOM)
    await _chatter(session_factory, OTHER_ROOM)

    await read_context(room_id=OTHER_ROOM)

    assert await _unread(protocol, CONNECTED_ROOM) == 1
    # Nor the room that was read: this connection is not in it, so reading it
    # is a look elsewhere, not catching up there.
    assert await _unread(protocol, OTHER_ROOM) == 1


@pytest.mark.asyncio
async def test_chatter_arriving_while_the_read_is_in_flight_stays_unread(
    protocol: _Protocol,
    connected: None,
    caller: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """History answers from a snapshot, so a later arrival is not in the answer.

    Clearing through the head as it stands when the response lands would
    report zero for a message the agent was never shown.
    """
    buffer = protocol.event_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, CONN, CONNECTED_ROOM)
    protocol.while_in_flight.append(lambda: _chatter(session_factory, CONNECTED_ROOM))

    await read_context()

    assert await _unread(protocol, CONNECTED_ROOM) == 1


@pytest.mark.asyncio
async def test_a_read_that_lands_after_losing_the_room_clears_nothing(
    protocol: _Protocol,
    connected: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two sessions of one agent share a connection; only one is in the room.

    The read is answered from a snapshot taken before the history call, so a
    session displaced while it was in flight comes back with an answer about a
    room that is now somebody else's. That somebody has read nothing.
    """
    buffer = protocol.event_buffer
    await buffer.hand_counting_to(
        TENANT_ZERO_ID, AGENT, Reader(id="session-a", is_session=True), CONNECTED_ROOM
    )
    for _ in range(3):
        await _chatter(session_factory, CONNECTED_ROOM)

    async def displace() -> None:
        await buffer.hand_counting_to(
            TENANT_ZERO_ID,
            AGENT,
            Reader(id="session-b", is_session=True),
            CONNECTED_ROOM,
        )

    protocol.while_in_flight.append(displace)

    token = set_call_context(
        CallContext(
            agent_id=AGENT,
            session_key=CONN,
            session=CallerSession(
                id="session-a",
                host_id="host-1",
                epoch="epoch-1",
                room_id=CONNECTED_ROOM,
            ),
        )
    )
    try:
        await read_context()
    finally:
        reset_call_context(token)

    assert await _unread(protocol, CONNECTED_ROOM) == 3


@pytest.mark.asyncio
async def test_a_session_reading_after_a_restart_takes_its_rooms_count(
    protocol: _Protocol,
    connected: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A restart keeps a room's count, and the session's read clears it.

    The stream starts counting a room for the connection it opened on, before
    any session on it has spoken, and the count is kept in the database, so a
    restart leaves it there unchanged. The session then reads, presenting
    itself, and that has to land on the same count: otherwise the read clears
    nothing and every message the session is handed says the room is behind.
    """
    await protocol.event_buffer.ensure_counting(
        TENANT_ZERO_ID, AGENT, CONN, CONNECTED_ROOM
    )
    await _chatter(session_factory, CONNECTED_ROOM)
    # The server restarts: a new process, with nothing in memory, on the same
    # tables.
    protocol.event_buffer = db_buffer_on(session_factory)
    assert await _unread(protocol, CONNECTED_ROOM) == 1

    token = set_call_context(
        CallContext(
            agent_id=AGENT,
            session_key=CONN,
            session=CallerSession(
                id="session-a",
                host_id="host-1",
                epoch="epoch-1",
                room_id=CONNECTED_ROOM,
            ),
        )
    )
    try:
        await read_context()
    finally:
        reset_call_context(token)

    assert await _unread(protocol, CONNECTED_ROOM) == 0
    await _chatter(session_factory, CONNECTED_ROOM)
    assert await _unread(protocol, CONNECTED_ROOM) == 1


@pytest.mark.asyncio
async def test_a_failed_read_catches_up_on_nothing(
    protocol: _Protocol,
    connected: None,
    caller: None,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An agent that was handed an error has read nothing."""

    async def boom() -> None:
        raise RuntimeError("homeserver said no")

    buffer = protocol.event_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, CONN, CONNECTED_ROOM)
    await _chatter(session_factory, CONNECTED_ROOM)
    protocol.while_in_flight.append(boom)

    with pytest.raises(RuntimeError, match="homeserver said no"):
        await read_context()

    assert await _unread(protocol, CONNECTED_ROOM) == 1


@pytest.mark.asyncio
async def test_a_shared_session_reading_a_room_it_answers_clears_that_room(
    protocol: _Protocol,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A room sharing the agent's session is the home session's to clear,
    whoever held its count before, and with no share recorded for it (an
    agent controller places sessions without telling Switch)."""
    protocol.shared_from_home = {OTHER_ROOM}
    buffer = protocol.event_buffer
    await buffer.hand_counting_to(
        TENANT_ZERO_ID, AGENT, Reader(id="old-isolated", is_session=True), OTHER_ROOM
    )
    said = None
    for index in range(3):
        said = await say(session_factory, OTHER_ROOM, f"chatter {index}")
    assert said is not None
    token = set_call_context(
        CallContext(
            agent_id=AGENT,
            session_key=CONN,
            session=CallerSession(
                id="lead", host_id="host", epoch="epoch", room_id=CONNECTED_ROOM
            ),
        )
    )
    try:
        await read_context(room_id=OTHER_ROOM)
    finally:
        reset_call_context(token)

    assert (await buffer.unread(TENANT_ZERO_ID, AGENT, OTHER_ROOM, said.seq)).count == 0

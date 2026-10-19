"""What a `single`-scope connection holds after subscribing at the HTTP door.

One room at a time, replacing rather than accumulating — the promise this
endpoint has always made, and the one `SwitchEventStream.repoint` is built on:
it claims the new room and never releases the old one, because subscribing was
the release.

The registry stopped doing it. A connection's rooms became the union of its
sessions' rooms, so `claim_room` cannot drop a room without knowing whose it
was, and a caller here names no session. Which leaves the replacement to this
door, where the caller *is* the connection.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import connection_subscribe
from switch_core.bridges.agent.api.schemas import ConnectionSubscribeRequest
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer, Reader
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import say, seed_member

AGENT_ID = "agent-1"
CONN_ID = "conn-1"
ROOM_A = "!room-a"
ROOM_B = "!room-b"


@pytest.fixture(autouse=True)
async def _agent_rows(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent in both rooms, as rows: a room's unread count is kept against
    the agent and the room, and a room with no row is not counted at all."""
    for room_id in (ROOM_A, ROOM_B):
        await seed_member(session_factory, AGENT_ID, room_id)


class _Protocol:
    def __init__(self, event_buffer: EventBuffer) -> None:
        self.connections = AgentConnectionRegistry()
        self.event_buffer = event_buffer

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        return None

    async def require_recorded_rooms_unmoved(
        self,
        agent_id: str,
        connection: Any,
        claiming: frozenset[str],
        dropping: frozenset[str],
    ) -> None:
        """No session of this agent is recorded anywhere, so nothing is fenced."""


class _Agent:
    id = AGENT_ID
    tenant_id = TENANT_ZERO_ID
    metadata_ = None


def _open(protocol: _Protocol, scope: str, connection_id: str) -> Any:
    return protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=connection_id,
        scope=scope,
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )


async def _subscribe(
    protocol: _Protocol,
    room_id: str,
    generation: int,
    connection_id: str,
    takeover: bool,
) -> Any:
    return await connection_subscribe(
        AGENT_ID,
        ConnectionSubscribeRequest(
            connection_id=connection_id,
            room_id=room_id,
            generation=generation,
            takeover=takeover,
        ),
        agent=_Agent(),
        protocol=protocol,
    )


@pytest.mark.asyncio
async def test_a_single_scope_subscribe_replaces_the_room_it_held(
    db_buffer: EventBuffer,
) -> None:
    """A→B leaves the connection in B alone.

    Staying in A as well would go on delivering a room the client has left,
    and leave the agent's slot in it occupied by a client that is not there.
    """
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "single", CONN_ID)

    await _subscribe(protocol, ROOM_A, conn.stream_generation, CONN_ID, False)
    result = await _subscribe(protocol, ROOM_B, conn.stream_generation, CONN_ID, False)

    assert conn.rooms == {ROOM_B}
    assert result["rooms"] == [ROOM_B]


@pytest.mark.asyncio
async def test_resubscribing_to_the_same_room_keeps_it(db_buffer: EventBuffer) -> None:
    """The replacement must not release what the claim just took."""
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "single", CONN_ID)

    await _subscribe(protocol, ROOM_A, conn.stream_generation, CONN_ID, False)
    await _subscribe(protocol, ROOM_A, conn.stream_generation, CONN_ID, False)

    assert conn.rooms == {ROOM_A}


@pytest.mark.asyncio
async def test_an_all_scope_subscribe_accumulates(db_buffer: EventBuffer) -> None:
    """A supervising connection watches many rooms; one room at a time is not its rule."""
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "all", CONN_ID)

    await _subscribe(protocol, ROOM_A, conn.stream_generation, CONN_ID, False)
    await _subscribe(protocol, ROOM_B, conn.stream_generation, CONN_ID, False)

    assert conn.rooms == {ROOM_A, ROOM_B}


async def _chatter(
    session_factory: async_sessionmaker[AsyncSession], room_id: str, count: int
) -> int:
    """Messages addressed to nobody, from someone else, in the room's log.
    Returns the room position of the last one."""
    last = 0
    for index in range(count):
        last = (await say(session_factory, room_id, f"chatter {index}")).seq
    return last


@pytest.mark.asyncio
async def test_subscribing_takes_over_the_rooms_unread_count(
    db_buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Whoever holds the room slot is the one whose reading clears it.

    Taking the room here and being told how far behind it is, while the count
    still answers to the client that was displaced, leaves the new holder
    unable to clear a room it has read to the end of: it is told the same
    number beside every message it is ever handed.
    """
    protocol = _Protocol(db_buffer)
    first = _open(protocol, "single", "conn-a")
    await _subscribe(protocol, ROOM_A, first.stream_generation, "conn-a", False)
    head = await _chatter(session_factory, ROOM_A, 3)

    second = _open(protocol, "single", "conn-b")
    await _subscribe(protocol, ROOM_A, second.stream_generation, "conn-b", True)

    buffer = protocol.event_buffer
    assert (await buffer.unread(TENANT_ZERO_ID, AGENT_ID, ROOM_A, head)).count == 3
    await buffer.caught_up(
        TENANT_ZERO_ID,
        AGENT_ID,
        Reader(id="conn-b", is_session=False),
        ROOM_A,
        head,
        "conn-b",
    )
    assert (await buffer.unread(TENANT_ZERO_ID, AGENT_ID, ROOM_A, head)).count == 0


@pytest.mark.asyncio
async def test_a_legacy_subscribe_takes_the_room_from_a_managed_session(
    db_buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The mixed takeover: a session holds the count, a bare connection takes the room.

    A session outranking every connection is right while the connection is only
    covering the room, and wrong the moment one of them actually takes it. The
    registry has already moved the slot here, so the count has to move with it
    — and the session that lost the room, whose read was in flight while it
    happened, must not be able to take it back by finishing.
    """
    protocol = _Protocol(db_buffer)
    managed = _open(protocol, "single", "conn-a")
    await _subscribe(protocol, ROOM_A, managed.stream_generation, "conn-a", False)
    session = Reader(id="managed-a", is_session=True)
    buffer = protocol.event_buffer
    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT_ID, session, ROOM_A)
    head = await _chatter(session_factory, ROOM_A, 3)

    legacy = _open(protocol, "single", "conn-b")
    await _subscribe(protocol, ROOM_A, legacy.stream_generation, "conn-b", True)

    assert protocol.connections.claimant_of(AGENT_ID, ROOM_A) is legacy
    assert (await buffer.unread(TENANT_ZERO_ID, AGENT_ID, ROOM_A, head)).count == 3
    await buffer.caught_up(
        TENANT_ZERO_ID,
        AGENT_ID,
        Reader(id="conn-b", is_session=False),
        ROOM_A,
        head,
        "conn-b",
    )
    assert (await buffer.unread(TENANT_ZERO_ID, AGENT_ID, ROOM_A, head)).count == 0

    later = await _chatter(session_factory, ROOM_A, 2)
    await buffer.caught_up(TENANT_ZERO_ID, AGENT_ID, session, ROOM_A, later, "conn-a")

    assert (await buffer.unread(TENANT_ZERO_ID, AGENT_ID, ROOM_A, later)).count == 2


@pytest.mark.asyncio
async def test_a_subscribe_waits_while_the_agents_room_slots_are_held(
    db_buffer: EventBuffer,
) -> None:
    """A repoint lands either side of a decision taken on the slots, never inside one.

    The registry is in memory and every move through it is synchronous, so a
    reader of it is safe until it writes what it read somewhere that has to be
    awaited. Whoever does that holds the agent's slots across the write, and
    this door — the one a repoint arrives at — is made to wait for it rather
    than move a room out from under a decision already taken on it.
    """
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "single", CONN_ID)

    async with protocol.connections.slots(AGENT_ID):
        repoint = asyncio.create_task(
            _subscribe(protocol, ROOM_A, conn.stream_generation, CONN_ID, False)
        )
        await asyncio.sleep(0.01)
        assert protocol.connections.claimant_of(AGENT_ID, ROOM_A) is None

    await repoint

    assert protocol.connections.claimant_of(AGENT_ID, ROOM_A) is conn


@pytest.mark.asyncio
async def test_a_slow_subscribe_cannot_take_the_count_back_from_a_later_one(
    db_buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two subscribes to one room, the first slow to record its unread count.

    The second takes the room after the first, so the count must end up with
    the second. Were the first recorded after the second finished, the room's
    holder could never clear a room it has read to the end of.
    """
    protocol = _Protocol(db_buffer)
    buffer = protocol.event_buffer
    first = _open(protocol, "single", "conn-a")
    second = _open(protocol, "single", "conn-b")

    reached = asyncio.Event()
    proceed = asyncio.Event()
    take_counting = buffer.take_counting

    async def slow_for_the_first(
        tenant_id: str, agent_id: str, reader_id: str, room_id: str
    ) -> None:
        if reader_id == "conn-a":
            reached.set()
            await proceed.wait()
        await take_counting(tenant_id, agent_id, reader_id, room_id)

    monkeypatch.setattr(buffer, "take_counting", slow_for_the_first)

    slow = asyncio.create_task(
        _subscribe(protocol, ROOM_A, first.stream_generation, "conn-a", False)
    )
    await reached.wait()
    later = asyncio.create_task(
        _subscribe(protocol, ROOM_A, second.stream_generation, "conn-b", True)
    )
    await asyncio.sleep(0.05)
    proceed.set()
    await slow
    await later
    head = await _chatter(session_factory, ROOM_A, 3)

    assert protocol.connections.claimant_of(AGENT_ID, ROOM_A) is second
    assert (await buffer.unread(TENANT_ZERO_ID, AGENT_ID, ROOM_A, head)).count == 3
    await buffer.caught_up(
        TENANT_ZERO_ID,
        AGENT_ID,
        Reader(id="conn-b", is_session=False),
        ROOM_A,
        head,
        "conn-b",
    )
    assert (await buffer.unread(TENANT_ZERO_ID, AGENT_ID, ROOM_A, head)).count == 0

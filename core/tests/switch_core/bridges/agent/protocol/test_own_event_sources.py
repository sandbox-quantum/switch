"""An agent has at most one own event per source.

The consumer of every switch-core process decides, for each room row, whether
it is for the agent, and stores the event in `agent_events`. Two processes make
that decision for the same row, and a write retried after a commit whose
acknowledgement was lost repeats one that was made. The agent must still
receive the event once, under one number.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import db_buffer_on, seed_agent

AGENT = "agent-1"
ROOM = "room-1"

SessionFactory = async_sessionmaker[AsyncSession]


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: SessionFactory) -> None:
    await seed_agent(session_factory, AGENT)


def _message(body: str = "for you") -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=ROOM,
        payload=MessagePayload(
            addressed=True,
            sender="@alice:test",
            sender_name="Alice",
            message_id="$m",
            body=body,
            timestamp=0,
        ),
    )


async def _keep(
    buffer: EventBuffer, *, room_seq: int = 7, message_key: str | None = "$m"
) -> int:
    return await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM,
        _message(),
        room_seq=room_seq,
        message_key=message_key,
    )


async def _numbers(buffer: EventBuffer) -> list[int]:
    return [item.seq for item in await buffer.read_from(TENANT_ZERO_ID, AGENT, 0)]


async def test_two_processes_storing_the_same_source_store_one_event(
    session_factory: SessionFactory,
) -> None:
    """Each process's consumer makes the same decision for the same row; the
    second write is handed the first one's number."""
    first = db_buffer_on(session_factory)
    second = db_buffer_on(session_factory)

    stored = await _keep(first)
    again = await _keep(second)

    assert again == stored
    assert await _numbers(first) == [stored]


async def test_a_write_repeated_after_its_commit_stores_nothing_more(
    db_buffer: EventBuffer,
) -> None:
    """A write retried because its commit's acknowledgement was lost, though
    the commit was made, finds the event already there."""
    stored = await _keep(db_buffer)

    assert await _keep(db_buffer) == stored
    assert await _numbers(db_buffer) == [stored]


async def test_writes_racing_for_one_source_store_one_event_and_waste_no_number(
    session_factory: SessionFactory,
) -> None:
    """Two processes write the same source at once. One stores it; the other
    finds it at insert time, gives its number back, and is handed the stored
    one, so the next event is numbered right after it."""
    first = db_buffer_on(session_factory)
    second = db_buffer_on(session_factory)

    results = await asyncio.gather(_keep(first), _keep(second))
    following = await _keep(first, room_seq=8, message_key="$next")

    assert results[0] == results[1]
    assert await _numbers(first) == [results[0], following]
    assert following == results[0] + 1


async def test_a_file_arriving_after_its_message_was_delivered_is_its_own_event(
    db_buffer: EventBuffer,
) -> None:
    """Several files posted as one message share a key. When the message was
    delivered before all of them arrived, a later file comes from a later room
    row and is stored as an event of its own."""
    delivered = await _keep(db_buffer, room_seq=7, message_key="group-1")
    late = await _keep(db_buffer, room_seq=9, message_key="group-1")

    assert late != delivered
    assert await _numbers(db_buffer) == [delivered, late]


async def test_events_without_a_source_key_are_never_merged(
    db_buffer: EventBuffer,
) -> None:
    first = await _keep(db_buffer, message_key=None)
    second = await _keep(db_buffer, message_key=None)

    assert await _numbers(db_buffer) == [first, second]

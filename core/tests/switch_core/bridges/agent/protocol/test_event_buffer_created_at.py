"""An agent's own events are created in the order they are numbered.

Retention deletes by `created_at` and a resuming reader treats everything
numbered below what retention kept as deleted. If a higher number could be
older than a lower one, `expire` could delete the higher and keep the lower,
and a reader would skip the lower without being told.
"""

from __future__ import annotations

import asyncio
import time

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID, Agent, AgentEventRow
from tests.db_buffer import seed_member

AGENT = "agent-1"
ROOM_A = "room-a"
ROOM_B = "room-b"


def _message(room: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id=f"$evt-{room}",
            body=room,
            timestamp=0,
        ),
    )


async def _until_a_connection_waits_for_a_lock(
    session_factory: async_sessionmaker[AsyncSession], pid: int
) -> None:
    """Return once the connection with backend `pid` is waiting for a lock."""
    deadline = time.monotonic() + 10
    async with session_factory() as session:
        while time.monotonic() < deadline:
            waiting = await session.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE pid = :pid AND wait_event_type = 'Lock'"
                ),
                {"pid": pid},
            )
            if waiting:
                return
            await asyncio.sleep(0.01)
    raise AssertionError("the first transaction never waited for the agent's head row")


async def test_a_transaction_that_began_earlier_does_not_make_a_higher_number_older(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Two router transactions on one agent: the one that began first numbers
    its event second, after waiting for the other to commit. The event it
    numbers second must not be older than the one numbered first."""
    await seed_member(session_factory, AGENT, ROOM_A)
    await seed_member(session_factory, AGENT, ROOM_B)
    async with session_factory() as session:
        client_id = await session.scalar(
            select(Agent.client_id).where(Agent.id == AGENT)
        )
    assert client_id is not None

    async def store(session: AsyncSession, room: str) -> int:
        number = await db_buffer.store(
            session,
            tenant_id=TENANT_ZERO_ID,
            agent_id=AGENT,
            client_id=client_id,
            room_id=room,
            event=_message(room),
            room_seq=1,
            message_key=f"key-{room}",
        )
        assert number is not None
        return number

    async with session_factory() as began_first, session_factory() as began_second:
        first_began = await began_first.scalar(text("SELECT now()"))
        second_began = await began_second.scalar(text("SELECT now()"))
        assert first_began < second_began
        first_pid = await began_first.scalar(text("SELECT pg_backend_pid()"))
        assert isinstance(first_pid, int)

        lower = await store(began_second, ROOM_B)
        waiting = asyncio.create_task(store(began_first, ROOM_A))
        await _until_a_connection_waits_for_a_lock(session_factory, first_pid)
        assert not waiting.done()
        await began_second.commit()
        higher = await waiting
        await began_first.commit()

    assert lower < higher
    async with session_factory() as session:
        created = dict(
            (
                await session.execute(
                    select(AgentEventRow.seq, AgentEventRow.created_at).where(
                        AgentEventRow.agent_id == AGENT
                    )
                )
            )
            .tuples()
            .all()
        )
    assert created[lower] <= created[higher]

"""An agent's own events are created in the order they are numbered.

Retention deletes by `created_at` and a resuming reader treats everything
numbered below what retention kept as deleted. If a higher number could be
older than a lower one, `expire` could delete the higher and keep the lower,
and a reader would skip the lower without being told.
"""

from __future__ import annotations

import asyncio

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


async def test_a_transaction_that_began_earlier_does_not_make_a_higher_number_older(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await seed_member(session_factory, AGENT, ROOM_A)
    await seed_member(session_factory, AGENT, ROOM_B)
    async with session_factory() as session:
        client_id = await session.scalar(
            select(Agent.client_id).where(Agent.id == AGENT)
        )
    assert client_id is not None

    async def keep(session: AsyncSession, room: str, room_seq: int) -> int:
        number = await db_buffer.store(
            session,
            tenant_id=TENANT_ZERO_ID,
            agent_id=AGENT,
            client_id=client_id,
            room_id=room,
            event=_message(room),
            room_seq=room_seq,
            message_key=f"key-{room}",
        )
        assert number is not None
        await session.commit()
        return number

    async with session_factory() as began_first, session_factory() as began_second:
        await began_first.execute(text("SELECT 1"))
        await asyncio.sleep(0.05)
        await began_second.execute(text("SELECT 1"))
        lower = await keep(began_second, ROOM_B, 1)
        higher = await keep(began_first, ROOM_A, 1)

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

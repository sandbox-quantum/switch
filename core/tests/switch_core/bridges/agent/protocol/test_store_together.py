"""Several agents' own events from one room row, stored together
(`EventBuffer.store_together`): numbered from each agent's head, never taking
a number for an event that is not stored, so each agent's numbers stay
contiguous."""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import (
    EventBuffer,
    OwnEventToStore,
)
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID, AgentEventHead, ClientRoom, Room
from switch_core.db.session_scope import tenant_session
from tests.routing import add_member, make_agent, make_room, own_events, process_on


def _own(agent_id: str, client_id: str, room: Room, key: str) -> OwnEventToStore:
    return OwnEventToStore(
        agent_id=agent_id,
        client_id=client_id,
        event=AgentEvent(
            type="message",
            room_id=room.id,
            payload=MessagePayload(
                addressed=True,
                sender="@ada:test",
                sender_name="Ada",
                message_id=key,
                body="@you",
                timestamp=0,
            ),
        ),
        room_seq=1,
        message_key=key,
    )


async def _store(
    buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    events: list[OwnEventToStore],
) -> dict[str, int] | None:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        stored = await buffer.store_together(
            session, tenant_id=TENANT_ZERO_ID, room_id=room.id, events=events
        )
        await session.commit()
    return stored


async def _head(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> int:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        head = await session.scalar(
            select(AgentEventHead.last_seq).where(AgentEventHead.agent_id == agent_id)
        )
    assert head is not None
    return head


async def test_events_are_numbered_from_each_agents_head(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = process_on(session_factory).buffer
    room = await make_room(session_factory)
    first, first_client = await make_agent(session_factory, "first")
    second, second_client = await make_agent(session_factory, "second")
    for client, agent in ((first_client, first), (second_client, second)):
        await add_member(session_factory, room, client, agent=agent)
    await _store(
        buffer, session_factory, room, [_own(first.id, first_client.id, room, "$a")]
    )

    stored = await _store(
        buffer,
        session_factory,
        room,
        sorted(
            [
                _own(first.id, first_client.id, room, "$b"),
                _own(second.id, second_client.id, room, "$b"),
            ],
            key=lambda own: own.agent_id,
        ),
    )

    assert stored == {
        first.id: buffer.sequence_floor + 1,
        second.id: buffer.sequence_floor,
    }
    assert await _head(session_factory, first.id) == buffer.sequence_floor + 1
    assert await _head(session_factory, second.id) == buffer.sequence_floor
    assert [e.seq for e in await own_events(session_factory, first.id)] == [
        buffer.sequence_floor,
        buffer.sequence_floor + 1,
    ]


async def test_an_agent_out_of_the_room_takes_no_number(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Membership is read after the agent's head is locked, and an event not
    stored leaves the head where it was."""
    buffer = process_on(session_factory).buffer
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "leaver")
    await add_member(session_factory, room, client, agent=agent)
    await _store(buffer, session_factory, room, [_own(agent.id, client.id, room, "$a")])
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            delete(ClientRoom).where(ClientRoom.client_id == client.id)
        )
        await session.commit()

    stored = await _store(
        buffer, session_factory, room, [_own(agent.id, client.id, room, "$b")]
    )

    assert stored == {}
    assert await _head(session_factory, agent.id) == buffer.sequence_floor


async def test_an_event_already_stored_is_not_stored_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The same source twice, as an older process's consumer deciding the
    same row would write it: the second takes no number."""
    buffer = process_on(session_factory).buffer
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "twice")
    await add_member(session_factory, room, client, agent=agent)
    own = _own(agent.id, client.id, room, "$same")
    await _store(buffer, session_factory, room, [own])

    stored = await _store(buffer, session_factory, room, [own])

    assert stored == {}
    assert [e.seq for e in await own_events(session_factory, agent.id)] == [
        buffer.sequence_floor
    ]
    assert await _head(session_factory, agent.id) == buffer.sequence_floor


async def test_an_agent_with_no_head_yet_starts_at_the_floor(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = process_on(session_factory).buffer
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "new")
    await add_member(session_factory, room, client, agent=agent)

    stored = await _store(
        buffer, session_factory, room, [_own(agent.id, client.id, room, "$a")]
    )

    assert stored == {agent.id: buffer.sequence_floor}
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        first = await session.scalar(
            select(AgentEventHead.first_seq).where(AgentEventHead.agent_id == agent.id)
        )
    assert first == buffer.sequence_floor

"""Polling every room applies membership, as polling one room does.

The buffer is keyed by agent, so an event queued while the agent was a member
is still there after it is removed. `poll_room_events` asks
`require_room_member` first; this is the same question asked by the two calls
that have no room in them — the all-rooms poll and the notification stream.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID, Room
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.room_store import RoomStore
from tests.db_buffer import say, seed_member
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
    register,
)


async def _room(
    session_factory: async_sessionmaker[AsyncSession], name: str, agent_id: str
) -> str:
    """A room with the agent in it: a member, and its client in the room's
    conversation."""
    async with session_factory() as session:
        room = Room(transport_room_id=f"!{name}:test", name=name, description="")
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, [agent_id])
        await session.commit()
        room_id = room.id
    await seed_member(session_factory, agent_id, room_id)
    return room_id


async def _ask(
    session_factory: async_sessionmaker[AsyncSession],
    buffer: EventBuffer,
    agent_id: str,
    room_id: str,
    body: str,
) -> None:
    """A message addressed to the agent, as its consumer keeps it: the row in
    the room's log, and the agent's own event for that row."""
    row = await say(session_factory, room_id, body, sender="@someone:test")
    await buffer.enqueue(
        TENANT_ZERO_ID,
        agent_id,
        room_id,
        AgentEvent(
            type="message",
            room_id=room_id,
            payload=MessagePayload(
                addressed=True,
                sender="@someone:test",
                sender_name="someone",
                message_id=row.transport_event_id,
                body=body,
                timestamp=0,
            ),
        ),
        room_seq=row.seq,
        message_key=row.transport_event_id,
    )


async def test_events_from_a_room_the_agent_was_removed_from_are_not_returned(
    session_factory: async_sessionmaker[AsyncSession],
    db_buffer: EventBuffer,
) -> None:
    """Neither what was said there nor what was asked of the agent there.

    The all-rooms poll reads the conversation of the rooms it is given as well
    as the agent's own events, so membership has to govern both.
    """
    svc = make_service(session_factory)
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]
    svc.event_buffer = db_buffer  # type: ignore[attr-defined]

    owner = await make_owner(session_factory)
    agent_id = await register(svc, "poller", owner)
    kept = await _room(session_factory, "kept", agent_id)
    left = await _room(session_factory, "left", agent_id)

    await say(session_factory, left, "said in the old room", sender="@someone:test")
    await _ask(session_factory, db_buffer, agent_id, left, "asked in the old room")
    await say(session_factory, kept, "said in this one", sender="@someone:test")

    async with session_factory() as session:
        await RoomStore().remove_agents(session, left, [agent_id])
        await session.commit()

    events = await svc.poll_events(agent_id, timeout=0)

    assert [event.payload.body for event in events] == ["said in this one"]


async def test_notifications_from_a_room_the_agent_was_removed_from_are_not_returned(
    session_factory: async_sessionmaker[AsyncSession],
    db_buffer: EventBuffer,
) -> None:
    """The stream that carries what was said *to* the agent, under the same rule.

    Filtering the all-rooms poll and leaving this one open would close the less
    sensitive half of the leak: the connector reads this to decide what the
    agent has been asked to do.
    """
    svc = make_service(session_factory)
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]
    svc.event_buffer = db_buffer  # type: ignore[attr-defined]

    owner = await make_owner(session_factory)
    agent_id = await register(svc, "watcher", owner)
    kept = await _room(session_factory, "kept-notif", agent_id)
    left = await _room(session_factory, "left-notif", agent_id)

    await _ask(session_factory, db_buffer, agent_id, left, "asked in the old room")
    await _ask(session_factory, db_buffer, agent_id, kept, "asked in this one")

    async with session_factory() as session:
        await RoomStore().remove_agents(session, left, [agent_id])
        await session.commit()

    events = await svc.poll_notifications(agent_id, timeout=0)

    assert [event.payload.body for event in events] == ["asked in this one"]

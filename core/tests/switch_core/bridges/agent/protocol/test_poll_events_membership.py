"""Polling every room applies membership, as polling one room does.

The buffer is keyed by agent, so an event queued while the agent was a member
is still there after it is removed. `poll_room_events` asks
`require_room_member` first; this is the same question asked by the call that
has no room in it.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import Room
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
    register,
)


def _message(room_id: str, body: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        payload=MessagePayload(
            addressed=False,
            sender="@someone:test",
            sender_name="someone",
            message_id="$m",
            body=body,
            timestamp=0,
        ),
    )


async def _room(
    session_factory: async_sessionmaker[AsyncSession], name: str, agent_id: str
) -> str:
    async with session_factory() as session:
        room = Room(matrix_room_id=f"!{name}:test", name=name, description="")
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, [agent_id])
        await session.commit()
        return room.id


async def test_events_from_a_room_the_agent_was_removed_from_are_not_returned(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = make_service(session_factory)
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]
    svc.event_buffer = EventBuffer()  # type: ignore[attr-defined]

    owner = await make_owner(session_factory)
    agent_id = await register(svc, "poller", owner)
    kept = await _room(session_factory, "kept", agent_id)
    left = await _room(session_factory, "left", agent_id)

    svc.event_buffer.enqueue(agent_id, left, _message(left, "said in the old room"))
    svc.event_buffer.enqueue(agent_id, kept, _message(kept, "said in this one"))

    async with session_factory() as session:
        await RoomStore().remove_agents(session, left, [agent_id])
        await session.commit()

    events = await svc.poll_events(agent_id, timeout=0)

    assert [event.payload.body for event in events] == ["said in this one"]

"""`delete_agent` takes the agent's client with it, room memberships and all.

An agent that has been in a room holds two memberships: a `room_agents` row,
which `AgentStore.delete` clears, and a `client_rooms` row for its client,
which `ClientStore.delete` clears — reached through
`ClientLifecycleService.delete_record` in the same transaction as the agent's
delete. Nothing else clears the second, so this pins the whole chain against a
real database.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import Room
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    FakeClientLifecycle,
    make_owner,
    make_service,
    register,
)


class _DeletingClientLifecycle(FakeClientLifecycle):
    """Registration's fake, plus the `stop` and `delete_record` calls
    `delete_agent` makes. `delete_record` deletes through the real store in the
    caller's session and commits nothing, as the real service does, so what
    the test sees is what `delete_agent`'s own transaction left."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(session_factory)
        self.stopped: list[str] = []

    async def stop(self, client_id: str) -> None:
        self.stopped.append(client_id)

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        await ClientStore().delete(session, client_id)


class TestDeleteAgentInARoom:
    async def test_the_agent_its_client_and_both_memberships_go(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = make_service(session_factory)
        lifecycle = _DeletingClientLifecycle(session_factory)
        svc.client_lifecycle = lifecycle  # type: ignore[assignment]
        svc.event_buffer = EventBuffer()

        owner = await make_owner(session_factory)
        agent_id = await register(svc, "in-a-room", owner)
        async with session_factory() as session:
            agent = await svc.agent_store.get(session, agent_id)
            assert agent is not None
            client_id = agent.client_id
            room = Room(
                matrix_room_id=f"!{uuid.uuid4().hex[:8]}:test",
                name="a room",
                description="somewhere the agent has been",
            )
            session.add(room)
            await session.flush()
            room_id = room.id
            await RoomStore().add_agents(session, room_id, [agent_id])
            await RoomStore().add_client(session, client_id, room_id)
            await session.commit()

        await svc.delete_agent(agent_id=agent_id)

        assert lifecycle.stopped == [client_id]
        async with session_factory() as session:
            assert await svc.agent_store.get(session, agent_id) is None
            assert await ClientStore().get(session, client_id) is None
            assert await RoomStore().get_agent_ids(session, room_id) == []
            assert await RoomStore().get_client_ids(session, room_id) == []
            # Only the memberships go; the room outlives its member.
            assert await RoomStore().get(session, room_id) is not None

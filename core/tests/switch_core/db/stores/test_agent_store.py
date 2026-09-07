from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, Task, User
from switch_core.db.stores.agent_store import AgentStore


async def _make_agent(session: AsyncSession, name: str) -> Agent:
    """Minimal User → ApiKey → Client → Agent chain."""
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _make_room(session: AsyncSession, name: str) -> Room:
    room = Room(matrix_room_id=f"!{name}:test", name=name, description=f"{name} desc")
    session.add(room)
    await session.flush()
    return room


async def _make_task(
    session: AsyncSession, room: Room, requester: Agent, performer: Agent
) -> Task:
    task = Task(
        room_id=room.id,
        requester_agent_id=requester.id,
        performer_agent_id=performer.id,
        summary="do a thing",
        description="a longer description of the thing",
        status="pending",
    )
    session.add(task)
    await session.flush()
    return task


class TestDeleteAgentWithTasks:
    """Regression for CHOO-1315: deleting an agent with task history must not
    raise a ForeignKeyViolationError; dependent tasks cascade away."""

    async def test_delete_performer_with_tasks_cascades(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentStore()
        async with session_factory() as session:
            room = await _make_room(session, "room-perf")
            requester = await _make_agent(session, "requester-perf")
            performer = await _make_agent(session, "performer-perf")
            task = await _make_task(session, room, requester, performer)
            await session.commit()
            task_id = task.id

            await store.delete(session, performer.id)
            await session.commit()

        async with session_factory() as verify:
            assert await verify.get(Agent, performer.id) is None
            assert await verify.get(Task, task_id) is None
            # The other party to the task is untouched.
            assert await verify.get(Agent, requester.id) is not None

    async def test_delete_requester_with_tasks_cascades(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentStore()
        async with session_factory() as session:
            room = await _make_room(session, "room-req")
            requester = await _make_agent(session, "requester-req")
            performer = await _make_agent(session, "performer-req")
            await _make_task(session, room, requester, performer)
            await session.commit()
            requester_id = requester.id
            performer_id = performer.id

            await store.delete(session, requester.id)
            await session.commit()

        async with session_factory() as verify:
            assert await verify.get(Agent, requester_id) is None
            remaining = await verify.execute(
                select(Task).where(Task.requester_agent_id == requester_id)
            )
            assert remaining.scalars().first() is None
            assert await verify.get(Agent, performer_id) is not None

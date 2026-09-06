"""A delivery cursor moves forward and only forward."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore


async def _agent(session: AsyncSession) -> Agent:
    """Minimal User → ApiKey → Client → Agent chain."""
    name = f"agent-{uuid.uuid4().hex[:8]}"
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
        description="",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _make_agent_and_room(session: AsyncSession) -> tuple[str, str]:
    room = Room(
        matrix_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
        name="a room",
        description="",
    )
    session.add(room)
    agent = await _agent(session)
    await session.flush()
    return agent.id, room.id


class TestPosition:
    async def test_an_agent_that_was_never_delivered_is_at_zero(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Zero, not an error: `seq` starts at 1, so zero already says
        "behind everything"."""
        async with session_factory() as session:
            agent_id, room_id = await _make_agent_and_room(session)
            await session.commit()

            store = DeliveryCursorStore()
            assert await store.position(session, agent_id, room_id) == 0

    async def test_a_cursor_reads_back_where_it_was_left(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent_id, room_id = await _make_agent_and_room(session)
            store = DeliveryCursorStore()
            await store.advance(session, agent_id, room_id, 7)
            await session.commit()

            assert await store.position(session, agent_id, room_id) == 7

    async def test_positions_omit_agents_that_have_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Absent rather than zero, so a caller can tell an agent that has
        never been delivered from one sitting at the start."""
        async with session_factory() as session:
            first, room_id = await _make_agent_and_room(session)
            second = await _agent(session)
            session.add(second)
            await session.flush()

            store = DeliveryCursorStore()
            await store.advance(session, first, room_id, 3)
            await session.commit()

            positions = await store.positions_in(session, room_id, [first, second.id])

        assert positions == {first: 3}


class TestAdvancing:
    async def test_advancing_twice_keeps_the_further_position(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent_id, room_id = await _make_agent_and_room(session)
            store = DeliveryCursorStore()
            await store.advance(session, agent_id, room_id, 4)
            await store.advance(session, agent_id, room_id, 9)
            await session.commit()

            assert await store.position(session, agent_id, room_id) == 9

    async def test_a_late_write_cannot_rewind_the_cursor(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two deliveries can finish out of order. The later write must not
        undo the further one, because rewinding redelivers and a redelivered
        message is indistinguishable from a new one."""
        async with session_factory() as session:
            agent_id, room_id = await _make_agent_and_room(session)
            store = DeliveryCursorStore()
            await store.advance(session, agent_id, room_id, 9)
            await store.advance(session, agent_id, room_id, 4)
            await session.commit()

            assert await store.position(session, agent_id, room_id) == 9

    async def test_cursors_in_different_rooms_are_independent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent_id, first_room = await _make_agent_and_room(session)
            second_room = Room(
                matrix_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
                name="another room",
                description="",
            )
            session.add(second_room)
            await session.flush()

            store = DeliveryCursorStore()
            await store.advance(session, agent_id, first_room, 5)
            await session.commit()

            assert await store.position(session, agent_id, second_room.id) == 0

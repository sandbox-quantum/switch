from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.room_store import RoomStore


async def _make_room(rooms: RoomStore, session: AsyncSession, name: str) -> Room:
    return await rooms.create(
        session,
        Room(matrix_room_id=f"!{name}:test", name=name, description=f"{name} desc"),
    )


async def _make_agent(session: AsyncSession, name: str) -> Agent:
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
        agent_type="session_addressable",
        connector_type="claude_code",
        integration_profile={},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


class TestReceivesJoinEvents:
    async def test_defaults_off_and_opt_in_subset(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(store, session, "alpha")
            a = await _make_agent(session, "agent-a")
            b = await _make_agent(session, "agent-b")
            # Only `a` is opted in at add time.
            await store.add_agents(
                session, room.id, [a.id, b.id], join_event_listeners={a.id}
            )
            await session.commit()

            assert await store.get_receives_join_events(session, room.id, a.id) is True
            assert await store.get_receives_join_events(session, room.id, b.id) is False
            assert await store.get_join_event_listeners(session, room.id) == [a.id]

    async def test_add_without_listeners_defaults_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(store, session, "beta")
            a = await _make_agent(session, "beta-a")
            await store.add_agents(session, room.id, [a.id])
            await session.commit()

            assert await store.get_receives_join_events(session, room.id, a.id) is False
            assert await store.get_join_event_listeners(session, room.id) == []

    async def test_set_toggles_existing_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(store, session, "gamma")
            a = await _make_agent(session, "gamma-a")
            await store.add_agents(session, room.id, [a.id])
            await session.commit()

            await store.set_receives_join_events(session, room.id, a.id, True)
            await session.commit()
            assert await store.get_receives_join_events(session, room.id, a.id) is True

            await store.set_receives_join_events(session, room.id, a.id, False)
            await session.commit()
            assert await store.get_receives_join_events(session, room.id, a.id) is False

    async def test_set_on_non_member_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(store, session, "delta")
            a = await _make_agent(session, "delta-a")
            await session.commit()

            with pytest.raises(ValueError):
                await store.set_receives_join_events(session, room.id, a.id, True)

    async def test_get_on_non_member_returns_false(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(store, session, "epsilon")
            a = await _make_agent(session, "epsilon-a")
            await session.commit()

            assert await store.get_receives_join_events(session, room.id, a.id) is False

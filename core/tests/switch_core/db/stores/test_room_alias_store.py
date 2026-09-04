from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.room_store import RoomStore


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
    room = Room(matrix_room_id=f"!{name}:test", name=name, description="d")
    session.add(room)
    await session.flush()
    return room


class TestRoomAliasStore:
    async def test_set_get_and_resolve(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "alice")
            await store.add_agents(session, room.id, [agent.id])

            assert await store.get_alias(session, room.id, agent.id) is None

            await store.set_alias(session, room.id, agent.id, "boss")
            assert await store.get_alias(session, room.id, agent.id) == "boss"
            # Resolution is case-insensitive.
            assert await store.get_agent_id_by_alias(session, room.id, "BOSS") == (
                agent.id
            )
            assert await store.list_aliases(session, room.id) == {agent.id: "boss"}

    async def test_clear_alias(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "alice")
            await store.add_agents(session, room.id, [agent.id])
            await store.set_alias(session, room.id, agent.id, "boss")

            await store.set_alias(session, room.id, agent.id, None)
            assert await store.get_alias(session, room.id, agent.id) is None
            assert await store.list_aliases(session, room.id) == {}
            assert await store.get_agent_id_by_alias(session, room.id, "boss") is None

    async def test_alias_is_room_scoped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            r1 = await _make_room(session, "r1")
            r2 = await _make_room(session, "r2")
            agent = await _make_agent(session, "alice")
            await store.add_agents(session, r1.id, [agent.id])
            await store.add_agents(session, r2.id, [agent.id])

            await store.set_alias(session, r1.id, agent.id, "boss")
            assert await store.get_alias(session, r1.id, agent.id) == "boss"
            # Same agent, different room: no alias leaks across rooms.
            assert await store.get_alias(session, r2.id, agent.id) is None

    async def test_set_alias_for_non_member_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "alice")
            # agent is NOT added to the room.
            with pytest.raises(ValueError, match="not a member"):
                await store.set_alias(session, room.id, agent.id, "boss")

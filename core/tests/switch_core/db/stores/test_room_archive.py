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
    """Create the minimal User → ApiKey → Client → Agent chain so the agent
    can be referenced from room_agents (which has a FK to agents)."""
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


class TestSetArchived:
    async def test_archive_stamps_timestamp_and_unarchive_clears(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await _make_room(store, session, "alpha")
            await session.commit()
            assert room.archived_at is None

            await store.set_archived(session, room.id, True)
            await session.commit()
            await session.refresh(room)
            assert room.archived_at is not None

            await store.set_archived(session, room.id, False)
            await session.commit()
            await session.refresh(room)
            assert room.archived_at is None

    async def test_missing_room_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Room not found"):
                await store.set_archived(session, "does-not-exist", True)


class TestArchivedFilteringInListing:
    async def test_get_all_excludes_archived_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            active = await _make_room(store, session, "active")
            archived = await _make_room(store, session, "archived")
            await store.set_archived(session, archived.id, True)
            await session.commit()

            default = await store.get_all(session)
            assert {r.id for r in default} == {active.id}

            everything = await store.get_all(session, include_archived=True)
            assert {r.id for r in everything} == {active.id, archived.id}

    async def test_list_readable_excludes_archived_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            active = await _make_room(store, session, "active")
            archived = await _make_room(store, session, "archived")
            await store.set_archived(session, archived.id, True)
            await session.commit()

            # Both rooms are public, so visibility does not filter them.
            default = await store.list_readable(session, "user-1", is_admin=False)
            assert {r.id for r in default} == {active.id}

            with_archived = await store.list_readable(
                session, "user-1", is_admin=False, include_archived=True
            )
            assert {r.id for r in with_archived} == {active.id, archived.id}

    async def test_list_readable_admin_also_excludes_archived_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            active = await _make_room(store, session, "active")
            archived = await _make_room(store, session, "archived")
            await store.set_archived(session, archived.id, True)
            await session.commit()

            default = await store.list_readable(session, "admin-1", is_admin=True)
            assert {r.id for r in default} == {active.id}

            with_archived = await store.list_readable(
                session, "admin-1", is_admin=True, include_archived=True
            )
            assert {r.id for r in with_archived} == {active.id, archived.id}

    async def test_get_rooms_for_agent_excludes_archived_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "agent-1")
            active = await _make_room(store, session, "active")
            archived = await _make_room(store, session, "archived")
            await store.add_agents(session, active.id, [agent.id])
            await store.add_agents(session, archived.id, [agent.id])
            await store.set_archived(session, archived.id, True)
            await session.commit()

            default = await store.get_rooms_for_agent(session, agent.id)
            assert {r.id for r in default} == {active.id}

            with_archived = await store.get_rooms_for_agent(
                session, agent.id, include_archived=True
            )
            assert {r.id for r in with_archived} == {active.id, archived.id}

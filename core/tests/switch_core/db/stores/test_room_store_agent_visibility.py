"""An agent sees the rooms its owner may read and the rooms it is in, and
no other private room, page by page. Real Postgres."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User, room_agents
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.gateway.agent_route_harness import add_agent

_T0 = datetime(2026, 1, 1, tzinfo=UTC)


async def _room(
    session: AsyncSession, name: str, owner_id: str, read_visibility: str, minute: int
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="",
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility="private",
        created_at=_T0 + timedelta(minutes=minute),
    )
    session.add(room)
    await session.flush()
    return room


async def _page_names(
    store: RoomStore,
    session: AsyncSession,
    *,
    reader_id: str | None,
    reader_is_admin: bool,
    agent_id: str,
    limit: int,
) -> list[str]:
    rooms = await store.page_all(
        session,
        include_archived=False,
        name_contains=None,
        limit=limit,
        after=None,
        reader_id=reader_id,
        reader_is_admin=reader_is_admin,
        member_agent_id=agent_id,
    )
    return [r.name for r in rooms]


async def test_an_agent_sees_its_owners_rooms_and_its_own_and_no_other(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        alice = User(name="alice", email="alice@example.invalid", role="user")
        bob = User(name="bob", email="bob@example.invalid", role="user")
        session.add_all([alice, bob])
        await session.flush()

        hidden_first = await _room(session, "hidden-first", bob.id, "private", 0)
        own = await _room(session, "own", alice.id, "private", 1)
        public = await _room(session, "public", bob.id, "public", 2)
        joined = await _room(session, "joined", bob.id, "private", 3)
        hidden = await _room(session, "hidden", bob.id, "private", 4)

        agent = await add_agent(session, name="alices-agent", owner_id=alice.id)
        await session.execute(
            insert(room_agents), [{"room_id": joined.id, "agent_id": agent.id}]
        )
        await session.flush()

        # Rooms the agent may not see do not use up a page.
        assert await _page_names(
            store,
            session,
            reader_id=alice.id,
            reader_is_admin=False,
            agent_id=agent.id,
            limit=3,
        ) == ["own", "public", "joined"]

        # An agent with no owner sees public rooms and the rooms it is in.
        assert await _page_names(
            store,
            session,
            reader_id=None,
            reader_is_admin=False,
            agent_id=agent.id,
            limit=10,
        ) == ["public", "joined"]

        assert await _page_names(
            store,
            session,
            reader_id=alice.id,
            reader_is_admin=True,
            agent_id=agent.id,
            limit=10,
        ) == ["hidden-first", "own", "public", "joined", "hidden"]

        unpaged = await store.list_visible_to_agent(
            session,
            reader_id=alice.id,
            reader_is_admin=False,
            member_agent_id=agent.id,
            include_archived=False,
        )
        assert {r.id for r in unpaged} == {own.id, public.id, joined.id}
        assert hidden_first.id not in {r.id for r in unpaged}
        assert hidden.id not in {r.id for r in unpaged}

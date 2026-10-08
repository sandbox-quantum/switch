from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore

GroupStore = RoomGroupStore
Rooms = RoomStore


async def _make_room(
    rooms: RoomStore, session: AsyncSession, name: str, group_id: str | None = None
) -> Room:
    room = await rooms.create(
        session,
        Room(transport_room_id=f"!{name}:test", name=name, description=f"{name} desc"),
    )
    if group_id is not None:
        await rooms.set_group(session, room.id, group_id)
    return room


class TestRoomGroupStore:
    async def test_create_and_list(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        async with session_factory() as session:
            g = await store.create(
                session,
                name="Eng",
                description=None,
                color="#fff",
                parent_group_id=None,
            )
            await session.commit()
            groups = await store.get_all(session)
            assert [x.id for x in groups] == [g.id]
            assert groups[0].name == "Eng"

    async def test_create_under_missing_parent_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Parent group not found"):
                await store.create(
                    session,
                    name="X",
                    description=None,
                    color=None,
                    parent_group_id="does-not-exist",
                )

    async def test_room_counts_and_set_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        rooms = Rooms()
        async with session_factory() as session:
            g = await store.create(
                session, name="G", description=None, color=None, parent_group_id=None
            )
            r = await _make_room(rooms, session, "room-a", group_id=g.id)
            await session.commit()

            counts = await store.get_room_counts(session)
            assert counts == {g.id: 1}

            # Clearing the group makes the room standalone.
            await rooms.set_group(session, r.id, None)
            await session.commit()
            assert await store.get_room_counts(session) == {}
            refreshed = await rooms.get(session, r.id)
            assert refreshed is not None and refreshed.group_id is None

    async def test_set_group_missing_group_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        rooms = Rooms()
        async with session_factory() as session:
            r = await _make_room(rooms, session, "room-b")
            await session.commit()
            with pytest.raises(ValueError, match="Room group not found"):
                await rooms.set_group(session, r.id, "nope")

    async def test_reparent_rejects_self_and_cycles(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        async with session_factory() as session:
            a = await store.create(
                session, name="A", description=None, color=None, parent_group_id=None
            )
            b = await store.create(
                session, name="B", description=None, color=None, parent_group_id=a.id
            )
            c = await store.create(
                session, name="C", description=None, color=None, parent_group_id=b.id
            )
            await session.commit()

            with pytest.raises(ValueError, match="its own parent"):
                await store.update_fields(
                    session, a.id, parent_group_id=a.id, reparent=True
                )
            # A under C would make A a descendant of itself (A→B→C→A).
            with pytest.raises(ValueError, match="descendants"):
                await store.update_fields(
                    session, a.id, parent_group_id=c.id, reparent=True
                )

    async def test_reparent_to_top_level(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        async with session_factory() as session:
            a = await store.create(
                session, name="A", description=None, color=None, parent_group_id=None
            )
            b = await store.create(
                session, name="B", description=None, color=None, parent_group_id=a.id
            )
            await session.commit()

            await store.update_fields(
                session, b.id, parent_group_id=None, reparent=True
            )
            await session.commit()
            refreshed = await store.get(session, b.id)
            assert refreshed is not None and refreshed.parent_group_id is None

    async def test_update_without_reparent_keeps_parent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        async with session_factory() as session:
            a = await store.create(
                session, name="A", description=None, color=None, parent_group_id=None
            )
            b = await store.create(
                session, name="B", description=None, color=None, parent_group_id=a.id
            )
            await session.commit()

            # reparent defaults to False → parent untouched even though we pass None.
            await store.update_fields(session, b.id, name="B2")
            await session.commit()
            refreshed = await store.get(session, b.id)
            assert refreshed is not None
            assert refreshed.name == "B2"
            assert refreshed.parent_group_id == a.id

    async def test_delete_promotes_children_and_frees_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        rooms = Rooms()
        async with session_factory() as session:
            a = await store.create(
                session, name="A", description=None, color=None, parent_group_id=None
            )
            b = await store.create(
                session, name="B", description=None, color=None, parent_group_id=a.id
            )
            c = await store.create(
                session, name="C", description=None, color=None, parent_group_id=b.id
            )
            room = await _make_room(rooms, session, "room-c", group_id=b.id)
            await session.commit()

            removed = await store.delete(session, b.id)
            await session.commit()
            assert removed is True

            # C (child of B) is promoted to B's parent (A).
            c_refreshed = await store.get(session, c.id)
            assert c_refreshed is not None and c_refreshed.parent_group_id == a.id
            # The member room becomes standalone (FK ON DELETE SET NULL). The
            # cascade happens in the DB, so refresh to read the persisted value
            # rather than the session's cached instance.
            room_refreshed = await rooms.get(session, room.id)
            assert room_refreshed is not None
            await session.refresh(room_refreshed)
            assert room_refreshed.group_id is None
            # B is gone.
            assert await store.get(session, b.id) is None

    async def test_delete_root_promotes_children_to_top_level(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        async with session_factory() as session:
            a = await store.create(
                session, name="A", description=None, color=None, parent_group_id=None
            )
            b = await store.create(
                session, name="B", description=None, color=None, parent_group_id=a.id
            )
            await session.commit()

            assert await store.delete(session, a.id) is True
            await session.commit()
            b_refreshed = await store.get(session, b.id)
            assert b_refreshed is not None and b_refreshed.parent_group_id is None

    async def test_delete_missing_returns_false(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        async with session_factory() as session:
            assert await store.delete(session, "missing") is False

    async def test_set_group_bulk_assigns_and_clears(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = GroupStore()
        rooms = Rooms()
        async with session_factory() as session:
            g = await store.create(
                session, name="G", description=None, color=None, parent_group_id=None
            )
            r1 = await _make_room(rooms, session, "r1")
            r2 = await _make_room(rooms, session, "r2")
            await session.commit()

            assigned = await rooms.set_group_bulk(session, [r1.id, r2.id], g.id)
            await session.commit()
            assert assigned == 2
            assert await store.get_room_counts(session) == {g.id: 2}

            # Bulk clear (group_id=None) makes them standalone again.
            cleared = await rooms.set_group_bulk(session, [r1.id, r2.id], None)
            await session.commit()
            assert cleared == 2
            assert await store.get_room_counts(session) == {}

    async def test_set_group_bulk_empty_is_noop(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        rooms = Rooms()
        async with session_factory() as session:
            assert await rooms.set_group_bulk(session, [], None) == 0

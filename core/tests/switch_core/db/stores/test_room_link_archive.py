from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore


async def _make_room(rooms: RoomStore, session: AsyncSession, name: str) -> Room:
    return await rooms.create(
        session,
        Room(transport_room_id=f"!{name}:test", name=name, description=f"{name} desc"),
    )


class TestLinkedRoomArchivedFiltering:
    async def test_list_outbound_excludes_archived_targets(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        rooms = RoomStore()
        links = RoomLinkStore()
        async with session_factory() as session:
            source = await _make_room(rooms, session, "source")
            active = await _make_room(rooms, session, "active-target")
            archived = await _make_room(rooms, session, "archived-target")
            await links.attach(session, source.id, active.id, "active")
            await links.attach(session, source.id, archived.id, "archived")
            await rooms.set_archived(session, archived.id, True)
            await session.commit()

            result = await links.list_outbound(session, source.id)
            assert {rid for rid, _name, _desc, _label in result} == {active.id}

    async def test_list_inbound_excludes_archived_sources(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        rooms = RoomStore()
        links = RoomLinkStore()
        async with session_factory() as session:
            target = await _make_room(rooms, session, "target")
            active = await _make_room(rooms, session, "active-source")
            archived = await _make_room(rooms, session, "archived-source")
            await links.attach(session, active.id, target.id, "active")
            await links.attach(session, archived.id, target.id, "archived")
            await rooms.set_archived(session, archived.id, True)
            await session.commit()

            result = await links.list_inbound(session, target.id)
            assert {rid for rid, _name, _desc, _label in result} == {active.id}

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Room
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    # These methods only touch session_factory + room_group_store, so we can
    # exercise them on an un-__init__'d instance (matching the other protocol
    # tests) with just those attributes set.
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.room_group_store = RoomGroupStore()  # type: ignore[attr-defined]
    return svc


class TestCreateRoomGroup:
    async def test_creates_top_level_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        out = await svc.create_room_group(
            "agent-x", "Eng", "the eng group", "#abc", None
        )
        assert out["name"] == "Eng"
        assert out["description"] == "the eng group"
        assert out["color"] == "#abc"
        assert out["parent_group_id"] is None
        assert out["room_count"] == 0
        assert out["path"] == "Eng"
        assert out["member_rooms"] == []
        assert out["child_groups"] == []

        # Persisted (visible to a fresh read).
        detail = await svc.get_room_group_detail("agent-x", out["id"])
        assert detail["name"] == "Eng"

    async def test_creates_nested_group_by_parent_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        parent = await svc.create_room_group("agent-x", "P", None, None, None)
        child = await svc.create_room_group("agent-x", "C", None, None, "P")
        assert child["parent_group_id"] == parent["id"]
        assert child["path"] == "P / C"

    async def test_unknown_parent_name_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        with pytest.raises(ValueError, match="No room group named"):
            await svc.create_room_group("agent-x", "C", None, None, "Nope")


class TestGetRoomGroupDetail:
    async def test_returns_members_and_children(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        rooms = RoomStore()
        parent = await svc.create_room_group("agent-x", "P", None, None, None)
        child = await svc.create_room_group("agent-x", "C", None, None, "P")

        async with session_factory() as session:
            room = await rooms.create(
                session, Room(matrix_room_id="!r:test", name="r1", description="d")
            )
            await rooms.set_group(session, room.id, parent["id"])
            await session.commit()
            room_id, room_name = room.id, room.name

        detail = await svc.get_room_group_detail("agent-x", parent["id"])
        assert detail["room_count"] == 1
        assert detail["member_rooms"] == [{"id": room_id, "name": room_name}]
        assert detail["child_groups"] == [{"id": child["id"], "name": "C"}]
        assert detail["path"] == "P"

    async def test_missing_group_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        with pytest.raises(ValueError, match="Room group not found"):
            await svc.get_room_group_detail("agent-x", "does-not-exist")

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Room
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore


async def _acting_as_admin(session: AsyncSession, agent_id: str) -> Any:
    return SimpleNamespace(id=agent_id, owner_id="owner"), "owner", True


def _bare_service() -> AgentCore:
    # These methods only touch the passed-in session / session_factory and the
    # group store, so we can exercise them on an un-__init__'d instance
    # (matching the fake-based protocol tests).
    svc = object.__new__(AgentCore)
    svc.room_group_store = RoomGroupStore()  # type: ignore[attr-defined]
    return svc


class TestResolveGroupName:
    async def test_none_returns_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _bare_service()
        async with session_factory() as session:
            assert await svc._resolve_group_name(session, None) is None

    async def test_resolves_unique_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _bare_service()
        store = RoomGroupStore()
        async with session_factory() as session:
            g = await store.create(
                session, name="Eng", description=None, color=None, parent_group_id=None
            )
            await session.commit()
            assert await svc._resolve_group_name(session, "Eng") == g.id

    async def test_unknown_name_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _bare_service()
        async with session_factory() as session:
            with pytest.raises(ValueError, match="No room group named"):
                await svc._resolve_group_name(session, "Nope")

    async def test_ambiguous_name_lists_paths_and_path_resolves(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _bare_service()
        store = RoomGroupStore()
        async with session_factory() as session:
            a = await store.create(
                session, name="Root", description=None, color=None, parent_group_id=None
            )
            # Two distinct groups can share a name (one nested under the other).
            top = await store.create(
                session, name="Dup", description=None, color=None, parent_group_id=None
            )
            nested = await store.create(
                session, name="Dup", description=None, color=None, parent_group_id=a.id
            )
            await session.commit()
            with pytest.raises(ValueError) as e:
                await svc._resolve_group_name(session, "Dup")
            assert str(e.value) == (
                "Ambiguous room group 'Dup': use 'Root/Dup' or id "
                f"'{top.id}' for the top-level 'Dup'"
            )
            assert await svc._resolve_group_name(session, "Root/Dup") == nested.id
            assert await svc._resolve_group_name(session, top.id) == top.id

    async def test_unknown_path_names_the_missing_segment(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _bare_service()
        store = RoomGroupStore()
        async with session_factory() as session:
            await store.create(
                session, name="Root", description=None, color=None, parent_group_id=None
            )
            await session.commit()
            with pytest.raises(ValueError, match="no group named 'Nope' under 'Root'"):
                await svc._resolve_group_name(session, "Root/Nope")


class TestListRoomGroups:
    async def test_lists_with_counts_and_paths(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _bare_service()
        svc.session_factory = session_factory  # type: ignore[attr-defined]
        svc.room_store = RoomStore()  # type: ignore[attr-defined]
        svc._resolve_acting_identity = _acting_as_admin  # type: ignore[method-assign]
        store = RoomGroupStore()
        rooms = RoomStore()
        async with session_factory() as session:
            parent = await store.create(
                session, name="P", description=None, color=None, parent_group_id=None
            )
            child = await store.create(
                session,
                name="C",
                description=None,
                color=None,
                parent_group_id=parent.id,
            )
            room = await rooms.create(
                session,
                Room(transport_room_id="!r:test", name="r", description="d"),
            )
            await rooms.set_group(session, room.id, child.id)
            await session.commit()

        result = await svc.list_room_groups("agent-x")
        by_path = {g["path"]: g for g in result}
        assert set(by_path) == {"P", "P / C"}
        assert by_path["P"]["room_count"] == 0
        assert by_path["P / C"]["room_count"] == 1
        assert by_path["P / C"]["parent_group_id"] == parent.id
        # Sorted by path.
        assert [g["path"] for g in result] == ["P", "P / C"]

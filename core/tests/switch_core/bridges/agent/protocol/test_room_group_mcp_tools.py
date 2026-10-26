from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Room, User
from switch_core.db.stores.room_group_store import (
    RoomGroupNameTaken,
    RoomGroupStore,
)
from switch_core.db.stores.room_store import RoomStore


def _service(session_factory: async_sessionmaker[AsyncSession]) -> AgentCore:
    # These methods only touch session_factory + room_group_store, so we can
    # exercise them on an un-__init__'d instance (matching the other protocol
    # tests) with just those attributes set.
    svc = object.__new__(AgentCore)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = AgentConnectionRegistry()
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.room_group_store = RoomGroupStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc._resolve_acting_identity = _acting_as(owner_is_admin=True)  # type: ignore[method-assign]
    return svc


def _acting_as(*, owner_is_admin: bool, owner_id: str = "owner") -> Any:
    """Stand in for the agent lookup: an agent owned by `owner_id`, whose
    workspace admin bit is `owner_is_admin`."""

    async def resolve(session: AsyncSession, agent_id: str) -> Any:
        agent = SimpleNamespace(id=agent_id, owner_id=owner_id)
        return agent, owner_id, owner_is_admin

    return resolve


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

    async def test_creates_under_a_parent_given_by_path(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        for top in ("Payments", "Fraud"):
            await svc.create_room_group("agent-x", top, None, None, None)
            await svc.create_room_group("agent-x", "Incidents", None, None, top)
        fraud_incidents = await svc.create_room_group(
            "agent-x", "Triage", None, None, "Fraud/Incidents"
        )
        assert fraud_incidents["path"] == "Fraud / Incidents / Triage"

        with pytest.raises(ValueError) as e:
            await svc.create_room_group("agent-x", "Triage", None, None, "Incidents")
        assert str(e.value) == (
            "Ambiguous room group 'Incidents': use 'Fraud/Incidents' or "
            "'Payments/Incidents'"
        )

    async def test_refuses_a_sibling_with_the_same_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        await svc.create_room_group("agent-x", "Fraud", None, None, None)
        await svc.create_room_group("agent-x", "Incidents", None, None, "Fraud")
        with pytest.raises(RoomGroupNameTaken) as e:
            await svc.create_room_group("agent-x", "incidents", None, None, "Fraud")
        assert str(e.value) == (
            "A room group named 'Incidents' already exists under 'Fraud'"
        )


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
                session, Room(transport_room_id="!r:test", name="r1", description="d")
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


class TestRoomGroupsForNonAdmins:
    async def test_a_non_admins_agent_cannot_create_a_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        svc._resolve_acting_identity = _acting_as(owner_is_admin=False)  # type: ignore[method-assign]

        with pytest.raises(PermissionError):
            await svc.create_room_group("agent-x", "Eng", None, None, None)

        assert await svc.list_room_groups("agent-x") == []

    async def test_private_rooms_of_others_are_not_listed_or_counted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        group = await svc.create_room_group("agent-x", "Shared", None, None, None)
        rooms = RoomStore()
        async with session_factory() as session:
            mine = User(name="mine", email="mine@example.com", role="user")
            theirs = User(name="theirs", email="theirs@example.com", role="user")
            session.add_all([mine, theirs])
            await session.flush()
            own_room = await rooms.create(
                session,
                Room(
                    transport_room_id="!own:test",
                    name="own",
                    description="d",
                    owner_id=mine.id,
                    read_visibility="private",
                    write_visibility="private",
                ),
            )
            hidden_room = await rooms.create(
                session,
                Room(
                    transport_room_id="!hidden:test",
                    name="hidden",
                    description="d",
                    owner_id=theirs.id,
                    read_visibility="private",
                    write_visibility="private",
                ),
            )
            for room in (own_room, hidden_room):
                await rooms.set_group(session, room.id, group["id"])
            await session.commit()
            own_id, mine_id = own_room.id, mine.id

        svc._resolve_acting_identity = _acting_as(  # type: ignore[method-assign]
            owner_is_admin=False, owner_id=mine_id
        )

        detail = await svc.get_room_group_detail("agent-x", group["id"])
        assert detail["member_rooms"] == [{"id": own_id, "name": "own"}]
        assert detail["room_count"] == 1
        [listed] = await svc.list_room_groups("agent-x")
        assert listed["room_count"] == 1

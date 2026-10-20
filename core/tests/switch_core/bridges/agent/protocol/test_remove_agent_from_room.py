"""Who may take an agent out of a room through the agent tool.

An agent may remove one it may address, or — with "can manage agents" — one
that belongs to its own owner, whatever that agent's addressing policy says.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.db.models import Agent, Room
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


class _RecordingRoomService:
    def __init__(self) -> None:
        self.removed: list[tuple[str, list[str], str]] = []

    async def remove_agents_from_room(
        self, room_id: str, agent_ids: list[str], removed_by_kind: str
    ) -> None:
        self.removed.append((room_id, agent_ids, removed_by_kind))


def _core(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[AgentCore, _RecordingRoomService]:
    svc = _service(session_factory)
    rooms = _RecordingRoomService()
    svc.room_service = rooms  # type: ignore[assignment]
    return svc, rooms


async def _room_with(
    session_factory: async_sessionmaker[AsyncSession], agent_ids: list[str]
) -> str:
    async with session_factory() as session:
        room = Room(transport_room_id="!work:test", name="work", description="")
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, agent_ids)
        await session.commit()
        return room.id


async def _set(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    *,
    addressing: str | None = None,
    can_manage_agents: bool | None = None,
) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        if addressing is not None:
            agent.addressing_policy = addressing_policy_for(addressing)
        if can_manage_agents is not None:
            agent.can_manage_agents = can_manage_agents
        await session.commit()


class TestRemoveAgentFromRoom:
    async def test_removes_an_agent_the_caller_may_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="anyone")
        room_id = await _room_with(session_factory, [target])

        await svc.remove_agent_from_room(caller, room_id, "alice-agent")

        assert rooms.removed == [(room_id, [target], "agent")]

    async def test_refuses_an_agent_the_caller_may_not_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        await _set(session_factory, caller, can_manage_agents=True)
        room_id = await _room_with(session_factory, [target])

        with pytest.raises(PermissionError, match="Not permitted to remove"):
            await svc.remove_agent_from_room(caller, room_id, "alice-agent")
        assert rooms.removed == []

    async def test_manager_removes_its_owners_agent_it_may_not_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        buddy = await _register(svc, "alice-buddy", alice)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        await _set(session_factory, buddy, can_manage_agents=True)
        room_id = await _room_with(session_factory, [target])

        await svc.remove_agent_from_room(buddy, room_id, "alice-agent")

        assert rooms.removed == [(room_id, [target], "agent")]

    async def test_same_owner_without_can_manage_agents_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        sibling = await _register(svc, "alice-helper", alice)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [target])

        with pytest.raises(PermissionError):
            await svc.remove_agent_from_room(sibling, room_id, "alice-agent")
        assert rooms.removed == []

    async def test_agent_not_in_the_room_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        caller = await _register(svc, "alice-buddy", alice)
        await _register(svc, "alice-agent", alice)
        room_id = await _room_with(session_factory, [caller])

        with pytest.raises(ValueError, match="not in this room"):
            await svc.remove_agent_from_room(caller, room_id, "alice-agent")
        assert rooms.removed == []

    async def test_unknown_agent_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        caller = await _register(svc, "alice-buddy", alice)
        room_id = await _room_with(session_factory, [caller])

        with pytest.raises(ValueError, match="unknown agent"):
            await svc.remove_agent_from_room(caller, room_id, "nobody")
        assert rooms.removed == []

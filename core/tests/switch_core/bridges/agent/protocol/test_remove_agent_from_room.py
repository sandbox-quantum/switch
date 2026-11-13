"""Who may take an agent out of a room through the agent tool.

The room policy decides, judging the calling agent as its owner: the room's
owner or a workspace admin may remove any agent. Another agent of the target's
owner may remove it if the target takes requests from it, or it can manage
agents. Being allowed to address the agent is not enough on its own.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.db.models import Agent, Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_policy import RoomPermissionError
from switch_core.room_service import MembershipFixed
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
    session_factory: async_sessionmaker[AsyncSession],
    agent_ids: list[str],
    owner_id: str | None = None,
) -> str:
    async with session_factory() as session:
        room = Room(
            transport_room_id="!work:test",
            name="work",
            description="",
            owner_id=owner_id,
        )
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
    async def test_room_owners_agent_removes_anyones_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [target], owner_id=bob)

        await svc.remove_agent_from_room(caller, room_id, "alice-agent")

        assert rooms.removed == [(room_id, [target], "agent")]

    async def test_room_owners_agent_open_to_anyone_does_not_use_her_rights(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Whoever may address it could otherwise remove other people's
        agents with the room owner's rights."""
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, caller, addressing="anyone")
        room_id = await _room_with(session_factory, [target, caller], owner_id=bob)

        with pytest.raises(
            RoomPermissionError, match="takes requests from people other than"
        ):
            await svc.remove_agent_from_room(caller, room_id, "alice-agent")
        assert rooms.removed == []

    async def test_being_allowed_to_address_the_agent_is_not_enough(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="anyone")
        await _set(session_factory, caller, can_manage_agents=True)
        room_id = await _room_with(session_factory, [target])

        with pytest.raises(
            RoomPermissionError, match="room's owner or a workspace admin"
        ):
            await svc.remove_agent_from_room(caller, room_id, "alice-agent")
        assert rooms.removed == []

    @pytest.mark.parametrize("channel_type", ["direct", "group"])
    async def test_refuses_a_direct_or_group_conversation(
        self, session_factory: async_sessionmaker[AsyncSession], channel_type: str
    ) -> None:
        """Its platform fixes who is in it, as the room routes say too; the
        people in it use `!remove-agent`. Even its owner's own manager is
        refused, which is let through anywhere else."""
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        buddy = await _register(svc, "alice-buddy", alice)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, buddy, can_manage_agents=True)
        room_id = await _room_with(session_factory, [target])
        async with session_factory() as session:
            room = await session.get(Room, room_id)
            assert room is not None
            room.channel_type = channel_type
            await session.commit()

        with pytest.raises(MembershipFixed, match=channel_type):
            await svc.remove_agent_from_room(buddy, room_id, "alice-agent")
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

    async def test_same_owner_without_can_manage_agents_is_refused_by_only_me(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Its owner said "only me", so their other agents may not act on it
        for them."""
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        sibling = await _register(svc, "alice-helper", alice)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [target])

        with pytest.raises(RoomPermissionError, match="doesn't take requests"):
            await svc.remove_agent_from_room(sibling, room_id, "alice-agent")
        assert rooms.removed == []

    async def test_same_owner_removes_an_agent_that_takes_its_requests(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        sibling = await _register(svc, "alice-helper", alice)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_and_owner_agents")
        room_id = await _room_with(session_factory, [target])

        await svc.remove_agent_from_room(sibling, room_id, "alice-agent")

        assert rooms.removed == [(room_id, [target], "agent")]

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

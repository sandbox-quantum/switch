"""Who may bring an agent into a room through the agent tool.

The rule `remove_agent_from_room` applies, the other way round: an agent may
invite one that would take instructions from it in that room, or — with "can
manage agents" — one that belongs to its own owner (`switch_core.agent_invites`).
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from tests.switch_core.bridges.agent.protocol.test_remove_agent_from_room import (
    _room_with,
    _set,
)
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


class _RecordingRoomService:
    def __init__(self) -> None:
        self.added: list[tuple[str, list[str], str]] = []

    async def add_agents_to_room(
        self,
        room_id: str,
        agent_names: list[str],
        include_subagents_for: list[str] | None,
        added_by_kind: str,
    ) -> None:
        self.added.append((room_id, agent_names, added_by_kind))


def _core(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[AgentCore, _RecordingRoomService]:
    svc = _service(session_factory)
    rooms = _RecordingRoomService()
    svc.room_service = rooms  # type: ignore[assignment]
    return svc, rooms


class TestInviteAgentToRoom:
    async def test_invites_an_agent_that_takes_instructions_from_the_caller(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="anyone")
        room_id = await _room_with(session_factory, [caller])

        await svc.invite_agent_to_room(caller, room_id, "alice-agent")

        assert rooms.added == [(room_id, ["alice-agent"], "agent")]

    async def test_refuses_an_agent_that_would_not_answer_the_caller(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A member of the room may change who is in it, but not by pulling in
        somebody else's private agent."""
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [caller])

        with pytest.raises(PermissionError) as refused:
            await svc.invite_agent_to_room(caller, room_id, "alice-agent")
        assert str(refused.value) == (
            "You can't invite alice-agent: it doesn't take instructions from "
            "you. Ask its owner to invite it, or to let you talk to it."
        )
        assert rooms.added == []

    async def test_the_default_policy_admits_the_owners_own_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        caller = await _register(svc, "alice-helper", alice)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_and_owner_agents")
        room_id = await _room_with(session_factory, [caller])

        await svc.invite_agent_to_room(caller, room_id, "alice-agent")

        assert rooms.added == [(room_id, ["alice-agent"], "agent")]

    async def test_manager_invites_its_owners_agent_it_may_not_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        buddy = await _register(svc, "alice-buddy", alice)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        await _set(session_factory, buddy, can_manage_agents=True)
        room_id = await _room_with(session_factory, [buddy])

        await svc.invite_agent_to_room(buddy, room_id, "alice-agent")

        assert rooms.added == [(room_id, ["alice-agent"], "agent")]

    async def test_another_owners_manager_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        manager = await _register(svc, "bob-buddy", bob)
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        await _set(session_factory, manager, can_manage_agents=True)
        room_id = await _room_with(session_factory, [manager])

        with pytest.raises(PermissionError, match="You can't invite alice-agent"):
            await svc.invite_agent_to_room(manager, room_id, "alice-agent")
        assert rooms.added == []

    async def test_unknown_agent_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        room_id = await _room_with(session_factory, [caller])

        with pytest.raises(ValueError, match="unknown agent nobody"):
            await svc.invite_agent_to_room(caller, room_id, "nobody")
        assert rooms.added == []

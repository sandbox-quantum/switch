"""Who may invite an agent through the agent tool and its HTTP twin.

`invite_agent_to_room` is reachable as an MCP tool and as
`POST /agents/{id}/ops/invite_agent_to_room`; both dispatch into this one
method, so this is the test for both doors. Room-roster authority
(`_require_room_roster_change`) is tested next door — what is pinned here is
the invited agent's own addressing policy, which is asked after it.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.operations import refusal_status
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.db.models import Agent, Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.invites import InviteNotPermitted, Inviter
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


class _RecordingRoomService:
    """Stands in for `RoomService`, which the shared check lives inside."""

    def __init__(self) -> None:
        self.added: list[tuple[str, list[str], Inviter]] = []
        self.refusal: str | None = None

    async def add_agents_to_room(
        self,
        room_id: str,
        *,
        invited_by: Inviter,
        agent_names: list[str] | None = None,
        include_subagents_for: list[str] | None = None,
    ) -> None:
        if self.refusal is not None:
            raise InviteNotPermitted(self.refusal)
        self.added.append((room_id, list(agent_names or []), invited_by))


def _core(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[AgentCore, _RecordingRoomService]:
    svc = _service(session_factory)
    rooms = _RecordingRoomService()
    svc.room_service = rooms  # type: ignore[assignment]
    return svc, rooms


async def _room_with(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    owner_id: str,
    agent_ids: list[str],
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
        if agent_ids:
            await RoomStore().add_agents(session, room.id, agent_ids)
        await session.commit()
        return room.id


async def _set_addressing(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str, choice: str
) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        agent.addressing_policy = addressing_policy_for(choice)
        await session.commit()


class TestInviteAgentToRoom:
    async def test_the_caller_is_named_as_an_agent_inviter(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        caller = await _register(svc, "alice-manager", alice)
        target = await _register(svc, "alice-worker", alice)
        await _set_addressing(session_factory, target, "owner_and_owner_agents")
        room_id = await _room_with(session_factory, owner_id=alice, agent_ids=[caller])

        await svc.invite_agent_to_room(caller, room_id, "alice-worker")

        assert len(rooms.added) == 1
        room, names, inviter = rooms.added[0]
        assert (room, names) == (room_id, ["alice-worker"])
        # Judged as the agent it is, with its owner, so an `owner_agents` rule
        # can resolve. An agent is never taken for the person who owns it.
        assert inviter == Inviter.agent(caller, alice)

    async def test_a_refusal_reaches_the_caller(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        caller = await _register(svc, "bob-agent", bob)
        target = await _register(svc, "alice-worker", alice)
        await _set_addressing(session_factory, target, "owner_only")
        room_id = await _room_with(session_factory, owner_id=bob, agent_ids=[caller])
        rooms.refusal = (
            "You're not permitted to invite `alice-worker` into this room: its "
            "owner restricts who can address it, and that same rule decides who "
            "can invite it. Its owner, alice, can invite it, as can anyone they "
            "allow to address it."
        )

        with pytest.raises(InviteNotPermitted) as refused:
            await svc.invite_agent_to_room(caller, room_id, "alice-worker")

        # Not wrapped in the "Failed to invite agent" ValueError wording: a
        # refusal is not a failure, and the explanation must survive intact.
        assert str(refused.value) == rooms.refusal
        assert rooms.added == []

    async def test_the_refusal_is_a_403_on_both_front_doors(self) -> None:
        # One registry serves the MCP server and the HTTP operations route, so
        # this is the status either door answers with.
        assert refusal_status(InviteNotPermitted("nope")) == 403

    async def test_an_unknown_caller_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _core(session_factory)
        alice = await _make_user(session_factory, "alice")
        member = await _register(svc, "alice-worker", alice)
        room_id = await _room_with(session_factory, owner_id=alice, agent_ids=[member])

        with pytest.raises(ValueError):
            await svc.invite_agent_to_room("no-such-agent", room_id, "alice-worker")
        assert rooms.added == []

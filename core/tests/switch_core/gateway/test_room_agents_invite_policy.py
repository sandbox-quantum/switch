"""The gateway's room page adds an agent only for someone it would take
instructions from in that room (`switch_core.agent_invites`). Exercised against real Postgres with real
stores, through the check `POST /gateway/rooms/{room_id}/agents` runs."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.rooms import _refuse_uninvited_agents
from tests.switch_core.bridges.agent.protocol.test_remove_agent_from_room import (
    _room_with,
    _set,
)
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


async def _check(
    session_factory: async_sessionmaker[AsyncSession],
    room_id: str,
    user_id: str,
    agent_ids: list[str],
) -> None:
    protocol = _service(session_factory)
    async with session_factory() as session:
        room = await session.get(Room, room_id)
        user = await session.get(User, user_id)
        assert room is not None and user is not None
        await _refuse_uninvited_agents(
            session, RoomStore(), protocol, room, user, agent_ids
        )


class TestRoomPageInvite:
    async def test_refuses_someone_the_agent_does_not_answer(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [])

        with pytest.raises(HTTPException) as refused:
            await _check(session_factory, room_id, bob, [target])
        assert refused.value.status_code == 403
        assert refused.value.detail == (
            "You can't invite alice-agent: it doesn't take instructions from "
            "you. Ask its owner to invite it, or to let you talk to it."
        )

    async def test_the_owner_may_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [])

        await _check(session_factory, room_id, alice, [target])

    async def test_anyone_may_invite_an_open_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="anyone")
        room_id = await _room_with(session_factory, [])

        await _check(session_factory, room_id, bob, [target])

    async def test_a_workspace_admin_is_held_to_the_policy_too(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Pulling a private agent into a room is what the rule stops, whoever
        does it; the owner can widen the policy."""
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        root = await _make_user(session_factory, "root", role="admin")
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [])

        with pytest.raises(HTTPException) as refused:
            await _check(session_factory, room_id, root, [target])
        assert refused.value.status_code == 403

    async def test_an_agent_already_in_the_room_is_not_an_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Agents already in rooms stay: re-sending the room's roster does not
        trip over one its sender could not have invited."""
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        target = await _register(svc, "alice-agent", alice)
        await _set(session_factory, target, addressing="owner_only")
        room_id = await _room_with(session_factory, [target])

        await _check(session_factory, room_id, bob, [target])

    async def test_one_refused_agent_refuses_the_whole_request(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        mine = await _register(svc, "bob-agent", bob)
        theirs = await _register(svc, "alice-agent", alice)
        await _set(session_factory, theirs, addressing="owner_only")
        room_id = await _room_with(session_factory, [])

        with pytest.raises(HTTPException) as refused:
            await _check(session_factory, room_id, bob, [mine, theirs])
        assert refused.value.status_code == 403

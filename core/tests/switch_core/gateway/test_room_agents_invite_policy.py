"""The gateway's room page invites as the signed-in person, and answers 403.

Room write access is checked first and tested elsewhere; this pins the two
things the room page adds to the shared check — who it says is inviting, and
that a refusal reaches the operator as a 403 carrying the explanation rather
than as a 500.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.rooms import post_room_agents
from switch_core.gateway.schemas import RoomAgentsRequest
from switch_core.invites import InviteNotPermitted, Inviter

_REFUSAL = (
    "You're not permitted to invite `worker` into this room: its owner "
    "restricts who can address it, and that same rule decides who can invite "
    "it. Its owner, alice, can invite it, as can anyone they allow to address "
    "it."
)


class _RoomService:
    def __init__(self, *, refuse: bool) -> None:
        self._refuse = refuse
        self.invited_by: list[Inviter] = []

    async def add_agents_to_room(
        self,
        room_id: str,
        *,
        invited_by: Inviter,
        agent_ids: list[str] | None = None,
        include_subagents_for: list[str] | None = None,
        join_event_listeners: list[str] | None = None,
    ) -> None:
        self.invited_by.append(invited_by)
        if self._refuse:
            raise InviteNotPermitted(_REFUSAL)


class _NoAgents:
    async def get_agent_statuses_by_ids_in_session(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> dict[str, object]:
        return {}


async def _owned_room(session: AsyncSession, name: str) -> tuple[User, Room]:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="d",
        owner_id=user.id,
        read_visibility="private",
        write_visibility="private",
    )
    session.add(room)
    await session.flush()
    await session.commit()
    return user, room


class TestRoomPageInvites:
    async def test_a_refused_invite_is_a_403_carrying_the_explanation(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user, room = await _owned_room(session, "bob")
        rooms = _RoomService(refuse=True)

        async with session_factory() as session:
            with pytest.raises(HTTPException) as raised:
                await post_room_agents(
                    room.id,
                    RoomAgentsRequest(agent_ids=["worker-id"]),
                    session,
                    rooms,  # type: ignore[arg-type]
                    RoomStore(),
                    None,  # type: ignore[arg-type]
                    None,  # type: ignore[arg-type]
                    _NoAgents(),  # type: ignore[arg-type]
                    user,
                    False,
                )

        assert raised.value.status_code == 403
        assert raised.value.detail == _REFUSAL
        # The person signed in is who the policy is asked about, not the room
        # owner and not the machinery running the request.
        assert rooms.invited_by == [Inviter.user(user.id)]

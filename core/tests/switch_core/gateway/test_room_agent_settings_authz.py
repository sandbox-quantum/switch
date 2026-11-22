"""Who may change an agent's settings in a room, such as whether it is told
when someone joins.

The room's owner or an admin may, as for any room setting, and so may the
agent's own owner, as they may take it out of the room. Taking part in the room
is not enough on its own. The route coroutine is called directly against real
Postgres; the room service stands in for what happens once it is allowed.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.rooms import patch_room_agent
from switch_core.gateway.schemas import RoomAgentUpdateRequest
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user


class _Allowed(Exception):
    """Raised by the stand-in room service: the route got past its checks."""


class _RoomService:
    async def set_join_event_listeners(self, *_a: Any, **_kw: Any) -> None:
        raise _Allowed


async def _call(session: AsyncSession, room_id: str, agent_id: str, user: User) -> None:
    await patch_room_agent(
        room_id,
        agent_id,
        RoomAgentUpdateRequest(receives_join_events=True),
        session,
        _RoomService(),  # type: ignore[arg-type]
        RoomStore(),
        None,  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        user,
        False,
    )


async def _world(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, User, User, User]:
    """Olivia's room, with Max in it and Ada's agent in it. Returns the room,
    the agent, and Olivia, Ada and Max."""
    async with session_factory() as session:
        olivia = await add_user(session, name="olivia")
        ada = await add_user(session, name="ada")
        max_ = await add_user(session, name="max")
        room = Room(
            transport_room_id="!settings:test",
            name="settings",
            description="",
            owner_id=olivia.id,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.flush()
        agent = await add_agent(session, name="ada-agent", owner_id=ada.id)
        max_agent = await add_agent(session, name="max-agent", owner_id=max_.id)
        await RoomStore().add_agents(session, room.id, [agent.id, max_agent.id])
        await session.commit()
        return room.id, agent.id, olivia, ada, max_


class TestAnAgentsSettingsInARoom:
    async def test_the_agents_owner_may(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, agent_id, _olivia, ada, _max = await _world(session_factory)
        async with session_factory() as session:
            with pytest.raises(_Allowed):
                await _call(session, room_id, agent_id, ada)

    async def test_the_rooms_owner_may(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, agent_id, olivia, _ada, _max = await _world(session_factory)
        async with session_factory() as session:
            with pytest.raises(_Allowed):
                await _call(session, room_id, agent_id, olivia)

    async def test_someone_else_in_the_room_may_not(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, agent_id, _olivia, _ada, max_ = await _world(session_factory)
        async with session_factory() as session:
            with pytest.raises(HTTPException) as refused:
                await _call(session, room_id, agent_id, max_)
        assert refused.value.status_code == 403

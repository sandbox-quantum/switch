"""The gateway routes Console uses to change an agent's shared session.

Against real Postgres with real stores: only the agent's owner or an admin may
change it, the home room must be one of the agent's rooms, and the agent detail
reports the result.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import update_room_session, update_shared_session
from switch_core.gateway.schemas import (
    AgentDetail,
    UpdateRoomSessionRequest,
    UpdateSharedSessionRequest,
)
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user

_PROTOCOL = SimpleNamespace(
    agent_session_store=AgentSessionStore(),
    room_role_store=RoomRoleStore(),
    connections=AgentConnectionRegistry(),
)


async def _room(session: AsyncSession, name: str, agent_id: str) -> str:
    room = Room(transport_room_id=f"!{name}:test", name=name, description="")
    session.add(room)
    await session.flush()
    await RoomStore().add_agents(session, room.id, [agent_id])
    return room.id


async def _share(
    session: AsyncSession, agent_id: str, user: User, is_admin: bool = False, **fields
) -> AgentDetail:
    return await update_shared_session(
        agent_id,
        UpdateSharedSessionRequest(**fields),
        session,
        AgentStore(),
        RoomStore(),
        UserStore(),
        _PROTOCOL,  # type: ignore[arg-type]
        user,
        is_admin,
    )


async def _room_session(
    session: AsyncSession, agent_id: str, room_id: str, user: User, shared: bool
) -> AgentDetail:
    return await update_room_session(
        agent_id,
        room_id,
        UpdateRoomSessionRequest(shared=shared),
        session,
        AgentStore(),
        RoomStore(),
        UserStore(),
        _PROTOCOL,  # type: ignore[arg-type]
        user,
        False,
    )


async def test_the_owner_sets_a_home_and_shares_a_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="lead", owner_id=owner.id)
        hub = await _room(session, "hub", agent.id)
        work = await _room(session, "work", agent.id)

        detail = await _share(
            session, agent.id, owner, home_room_id=hub, shared_by_default=True
        )
        assert detail.home_room_id == hub
        assert detail.shared_by_default is True

        detail = await _room_session(session, agent.id, work, owner, True)
        marks = {room.room_id: room.shared_session for room in detail.rooms}
        assert marks == {hub: "home", work: "shared"}

        detail = await _room_session(session, agent.id, work, owner, False)
        assert {r.room_id: r.shared_session for r in detail.rooms}[work] is None

        detail = await _share(session, agent.id, owner, clear_home=True)
        assert detail.home_room_id is None


async def test_a_home_outside_the_agents_rooms_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="lead", owner_id=owner.id)
        other = await add_agent(session, name="other", owner_id=owner.id)
        elsewhere = await _room(session, "elsewhere", other.id)

        with pytest.raises(HTTPException) as refused:
            await _share(session, agent.id, owner, home_room_id=elsewhere)
        assert refused.value.status_code == 400


async def test_only_the_owner_or_an_admin_may_change_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        stranger = await add_user(session, name="stranger")
        admin = await add_user(session, name="root", role="admin")
        agent = await add_agent(session, name="lead", owner_id=owner.id)
        hub = await _room(session, "hub", agent.id)

        with pytest.raises(HTTPException) as refused:
            await _share(session, agent.id, stranger, home_room_id=hub)
        assert refused.value.status_code == 403

        detail = await _share(session, agent.id, admin, True, home_room_id=hub)
        assert detail.home_room_id == hub

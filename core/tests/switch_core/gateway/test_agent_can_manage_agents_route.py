"""The gateway route that turns an agent's "can manage agents" capability on and off.

Against real Postgres with real stores: only the agent's owner may change it
(an admin may not, since the agent then acts on the owner's own machines), it
is off for a new agent, and the agent detail reports it.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import Agent, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import update_can_manage_agents
from switch_core.gateway.schemas import AgentDetail, UpdateAgentCanManageAgentsRequest
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user


async def _set(
    session: AsyncSession, agent_id: str, user: User, enabled: bool
) -> AgentDetail:
    return await update_can_manage_agents(
        agent_id,
        UpdateAgentCanManageAgentsRequest(enabled=enabled),
        session,
        AgentStore(),
        RoomStore(),
        UserStore(),
        SimpleNamespace(  # type: ignore[arg-type]
            agent_session_store=AgentSessionStore(),
            room_role_store=RoomRoleStore(),
            connections=AgentConnectionRegistry(),
        ),
        user,
    )


async def _stored(session: AsyncSession, agent_id: str) -> bool:
    agent = await session.get(Agent, agent_id, populate_existing=True)
    assert agent is not None
    return agent.can_manage_agents


async def test_is_off_for_a_new_agent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        await session.commit()
        assert await _stored(session, agent.id) is False


async def test_the_owner_turns_it_on_and_off(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="helper", owner_id=owner.id)

        detail = await _set(session, agent.id, owner, True)
        assert detail.can_manage_agents is True
        assert await _stored(session, agent.id) is True

        detail = await _set(session, agent.id, owner, False)
        assert detail.can_manage_agents is False
        assert await _stored(session, agent.id) is False


@pytest.mark.parametrize("role", ["user", "admin"])
async def test_nobody_else_may_change_it_not_even_an_admin(
    session_factory: async_sessionmaker[AsyncSession], role: str
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        other = await add_user(session, name="other", role=role)
        agent = await add_agent(session, name="helper", owner_id=owner.id)

        with pytest.raises(HTTPException) as refused:
            await _set(session, agent.id, other, True)

        assert refused.value.status_code == 403
        assert "owner" in str(refused.value.detail)
        assert await _stored(session, agent.id) is False


async def test_an_agent_with_no_owner_cannot_be_given_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        admin = await add_user(session, name="admin", role="admin")
        agent = await add_agent(session, name="orphan", owner_id=admin.id)
        agent.owner_id = None
        await session.flush()

        with pytest.raises(HTTPException) as refused:
            await _set(session, agent.id, admin, True)

        assert refused.value.status_code == 403


async def test_an_unknown_agent_is_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        with pytest.raises(HTTPException) as refused:
            await _set(session, "no-such-agent", owner, True)
        assert refused.value.status_code == 404


def test_the_body_must_say_on_or_off() -> None:
    with pytest.raises(ValidationError):
        UpdateAgentCanManageAgentsRequest.model_validate({})
    with pytest.raises(ValidationError):
        UpdateAgentCanManageAgentsRequest.model_validate({"enabled": True, "extra": 1})

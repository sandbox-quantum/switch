"""The gateway route that deletes an agent."""

from __future__ import annotations

from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.agents import delete_agent
from tests.switch_core.gateway.agent_route_harness import (
    add_agent,
    add_user,
    is_admin,
)

_AGENT_STORE = AgentStore()


async def test_a_local_agent_is_deleted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="local", owner_id=owner.id)
        protocol = AsyncMock()

        assert await delete_agent(
            agent.id,
            session,
            _AGENT_STORE,
            protocol,
            owner,
            await is_admin(session, owner),
        ) == {"ok": True}
        protocol.delete_agent.assert_awaited_once_with(agent_id=agent.id)

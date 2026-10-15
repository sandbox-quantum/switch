"""The gateway route that deletes an agent."""

from __future__ import annotations

from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentDeletionResult
from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.agents import delete_agent, delete_agent_by_name
from switch_core.gateway.schemas import DeleteAgentResponse
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
        protocol.delete_agent.return_value = AgentDeletionResult(bridge_failures=[])

        assert await delete_agent(
            agent.id,
            session,
            _AGENT_STORE,
            protocol,
            owner,
            await is_admin(session, owner),
        ) == DeleteAgentResponse(ok=True, bridge_cleanup_failures=[])
        protocol.delete_agent.assert_awaited_once_with(agent_id=agent.id)


async def test_a_platform_left_uncleaned_is_reported(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="local", owner_id=owner.id)
        protocol = AsyncMock()
        protocol.delete_agent.return_value = AgentDeletionResult(
            bridge_failures=["slack: Slack is down"]
        )

        assert await delete_agent(
            agent.id,
            session,
            _AGENT_STORE,
            protocol,
            owner,
            await is_admin(session, owner),
        ) == DeleteAgentResponse(
            ok=True, bridge_cleanup_failures=["slack: Slack is down"]
        )


async def test_deleting_by_name_reports_it_too(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        await add_agent(session, name="local", owner_id=owner.id)
        protocol = AsyncMock()
        protocol.delete_agent.return_value = AgentDeletionResult(
            bridge_failures=["mattermost: timed out"]
        )

        assert await delete_agent_by_name(
            "local",
            session,
            _AGENT_STORE,
            protocol,
            owner,
            await is_admin(session, owner),
        ) == DeleteAgentResponse(
            ok=True, bridge_cleanup_failures=["mattermost: timed out"]
        )
        protocol.delete_agent.assert_awaited_once_with(agent_name="local")

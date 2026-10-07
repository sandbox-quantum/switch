"""An agent cannot delete itself through the agent API when it is a cloud agent."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import delete_agent
from tests.switch_core.gateway.agent_route_harness import (
    add_agent,
    add_user,
    place_on_controller,
)


async def test_a_cloud_agent_cannot_delete_itself(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="cloud", owner_id=owner.id)
        await place_on_controller(session, agent, kind="ec2")
        protocol = AsyncMock()

        with pytest.raises(HTTPException) as refused:
            await delete_agent(agent.id, agent, session, protocol)

    assert refused.value.status_code == 409
    assert "cloud agent" in refused.value.detail
    protocol.delete_agent.assert_not_awaited()


async def test_a_local_agent_can_delete_itself(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="local", owner_id=owner.id)
        protocol = AsyncMock()

        assert await delete_agent(agent.id, agent, session, protocol) == {"ok": True}
    protocol.delete_agent.assert_awaited_once_with(agent_id=agent.id)

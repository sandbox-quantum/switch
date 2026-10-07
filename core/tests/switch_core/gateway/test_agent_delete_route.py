"""The gateway routes that delete an agent refuse a cloud agent.

A cloud agent is removed through its managed agent, which stops it on its
cloud machine before the identity goes.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.agents import (
    CLOUD_AGENT_DELETE_REFUSED,
    delete_agent,
    delete_agent_by_name,
)
from tests.switch_core.gateway.agent_route_harness import (
    add_agent,
    add_user,
    is_admin,
    place_on_controller,
)

_AGENT_STORE = AgentStore()


@pytest.mark.parametrize("by_name", [False, True])
async def test_a_cloud_agent_is_not_deleted(
    session_factory: async_sessionmaker[AsyncSession], by_name: bool
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="cloud", owner_id=owner.id)
        await place_on_controller(session, agent, kind="ec2")
        protocol = AsyncMock()

        with pytest.raises(HTTPException) as refused:
            if by_name:
                await delete_agent_by_name(
                    agent.name,
                    session,
                    _AGENT_STORE,
                    protocol,
                    owner,
                    await is_admin(session, owner),
                )
            else:
                await delete_agent(
                    agent.id,
                    session,
                    _AGENT_STORE,
                    protocol,
                    owner,
                    await is_admin(session, owner),
                )

        assert refused.value.status_code == 409
        assert refused.value.detail == CLOUD_AGENT_DELETE_REFUSED
        protocol.delete_agent.assert_not_awaited()


async def test_an_agent_managed_on_another_machine_is_deleted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        agent = await add_agent(session, name="managed", owner_id=owner.id)
        await place_on_controller(session, agent, kind="daemon")
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

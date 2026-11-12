"""Only an agent owner can change its persisted mid-turn preference."""

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.agents import update_mid_turn_delivery
from switch_core.gateway.schemas import UpdateAgentMidTurnDeliveryRequest
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user


@pytest.mark.parametrize("is_owner", [True, False])
async def test_mid_turn_preference_is_owner_only(
    session_factory: async_sessionmaker[AsyncSession], is_owner: bool
) -> None:
    async with session_factory() as session:
        owner = await add_user(session, name="owner")
        stranger = await add_user(session, name="admin", role="admin")
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        agent.metadata_ = {"other_option": "kept"}
        await session.commit()
        request = UpdateAgentMidTurnDeliveryRequest(delivery="queue")
        if not is_owner:
            with pytest.raises(HTTPException) as error:
                await update_mid_turn_delivery(
                    agent.id, request, session, AgentStore(), stranger
                )
            assert error.value.status_code == 403
            return
        assert await update_mid_turn_delivery(
            agent.id, request, session, AgentStore(), owner
        ) == {"delivery": "queue"}
        await session.refresh(agent)
        assert agent.metadata_ == {"other_option": "kept", "mid_turn_delivery": "queue"}

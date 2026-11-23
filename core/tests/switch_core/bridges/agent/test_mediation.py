"""Pre-invocation mediation says yes to what an agent has and no to the rest.

There was no test for this at all while it ran over Matrix — the round trip
made it awkward to exercise, which is its own argument. Against a direct call
it is four cases.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.mediation import BLOCKED, PROCEED, MediationService
from switch_core.db.models import Agent, ApiKey, Client, Model, User
from switch_core.db.stores.agent_store import AgentStore


async def _agent(session: AsyncSession) -> Agent:
    name = f"agent-{uuid.uuid4().hex[:8]}"
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        transport_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description="",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


def _service(session_factory: async_sessionmaker[AsyncSession]) -> MediationService:
    return MediationService(session_factory=session_factory, agent_store=AgentStore())


class TestModelAccess:
    async def test_an_attached_model_proceeds(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session)
            session.add(Model(name="a-model", description="", agent_id=agent.id))
            await session.commit()
            agent_id = agent.id

        verdict = await _service(session_factory).model_access(agent_id, "a-model")

        assert verdict.verdict == PROCEED

    async def test_a_model_the_agent_does_not_have_is_blocked_with_a_reason(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session)
            await session.commit()
            agent_id = agent.id

        verdict = await _service(session_factory).model_access(agent_id, "a-model")

        assert verdict.verdict == BLOCKED
        assert verdict.reason is not None
        assert "a-model" in verdict.reason

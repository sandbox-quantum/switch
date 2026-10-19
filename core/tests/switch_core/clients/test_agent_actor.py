"""An agent's actor loads the agent row it stands for when it connects.

An agent reads no room, so it has no consumer, and its actor is what the
bridges post the agent's replies through, found by agent id. So the actor
itself has to know its agent: read once when it connects, or handed to it
from the bulk read at boot.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.actor import AgentActor, ClientConfig
from switch_core.db.models import TENANT_ZERO_ID, Agent
from switch_core.db.stores.client_store import ClientStore
from tests.routing import make_agent, make_person
from tests.switch_core.statement_counts import StatementCounts


def _actor(
    session_factory: async_sessionmaker[AsyncSession], client_id: str
) -> AgentActor:
    return AgentActor(
        client_id=client_id,
        tenant_id=TENANT_ZERO_ID,
        transport_user_id="@agent:test",
        display_name="agent",
        session_factory=session_factory,
        client_store=ClientStore(),
        config=ClientConfig(),
        transport_factory=lambda _actor: MagicMock(connect=_no_op),
    )


async def _no_op() -> None:
    return None


async def test_connecting_loads_the_agent_it_stands_for(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    agent, client = await make_agent(session_factory, "stands-for")
    actor = _actor(session_factory, client.id)

    await actor.connect()

    assert actor.agent_id == agent.id
    assert actor.agent.name == "stands-for"


async def test_a_client_with_no_agent_row_fails_to_connect(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Loud rather than an actor that answers to no agent: the lifecycle
    counts it crashed and leaves it stopped."""
    person = await make_person(session_factory, "not-an-agent")
    actor = _actor(session_factory, person.id)

    with pytest.raises(RuntimeError, match="No agent found for client"):
        await actor.connect()


async def test_a_preloaded_row_needs_no_read(
    session_factory: async_sessionmaker[AsyncSession],
    statement_counts: StatementCounts,
) -> None:
    agent, client = await make_agent(session_factory, "preloaded")
    actor = _actor(session_factory, client.id)
    actor.preload_agent(agent)

    with statement_counts.scope("connect") as scope:
        await actor.connect()

    assert scope.statements == []
    assert isinstance(actor.agent, Agent)
    assert actor.agent_id == agent.id


async def test_an_agent_hears_its_rooms_without_waiting_for_its_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A template run waits for each new agent's client to take events before
    it posts the kickoff. An agent's rows are decided as they are written,
    so its client has nothing to start first: the answer is yes at once,
    even before it connects."""
    _, client = await make_agent(session_factory, "new-hire")
    actor = _actor(session_factory, client.id)

    assert await actor.wait_receiving(0)

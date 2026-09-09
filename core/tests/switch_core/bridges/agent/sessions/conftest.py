"""The session routes, driven in-process against real Postgres.

One harness for every route in the family, because they share a door: the same
router, the same exception handlers, the same authenticated agent. A test that
built its own would be testing a different app from its neighbours.

Only the agent is substituted. The middleware that resolves one from a bearer
token is tested where it lives, and re-proving it on every route would make each
of these tests fail for two reasons.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.app import install_exception_handlers
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_session,
    get_session_ingest_service,
    get_session_lease_service,
)
from switch_core.bridges.agent.sessions.ingest_service import SessionIngestService
from switch_core.bridges.agent.sessions.lease_service import SessionLeaseService
from switch_core.bridges.agent.sessions.routes import router
from switch_core.db.models import Agent, ApiKey, Client, User
from switch_core.db.stores.session_event_store import SessionEventStore
from switch_core.db.stores.session_lease_store import SessionLeaseStore
from switch_core.db.stores.session_store import SessionStore


async def make_agent(session: AsyncSession) -> Agent:
    """Minimal User → ApiKey → Client → Agent chain (sessions.agent_id FK)."""
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
    client = Client(matrix_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


class Caller:
    """The app under test, plus the agent its requests arrive as.

    `as_agent` swaps the caller without rebuilding anything, which is how the
    foreign-agent case is written: the same session id, a different token.
    """

    def __init__(
        self, client: httpx.AsyncClient, app: FastAPI, agent: Agent, other: Agent
    ) -> None:
        self.client = client
        self.app = app
        self.agent = agent
        self.other = other

    def as_agent(self, agent: Agent) -> None:
        self.app.dependency_overrides[get_agent_from_scope] = lambda: agent

    async def lease(self, session_id: str, **body: object) -> httpx.Response:
        return await self.client.post(
            f"/agent/v1/sessions/{session_id}/lease", json=body
        )

    async def send(
        self, session_id: str, events: list[dict[str, Any]]
    ) -> httpx.Response:
        return await self.client.post(
            f"/agent/v1/sessions/{session_id}/events", json={"events": events}
        )


@pytest_asyncio.fixture
async def agents(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[tuple[Agent, Agent]]:
    async with session_factory() as session:
        first = await make_agent(session)
        second = await make_agent(session)
        await session.commit()
        yield first, second


@pytest_asyncio.fixture
async def caller(
    session_factory: async_sessionmaker[AsyncSession],
    agents: tuple[Agent, Agent],
) -> AsyncIterator[Caller]:
    """The app driven in-process on the test's own event loop.

    Not `TestClient`: it runs the app in a second loop, and the engine these
    tests read the database with is bound to this one.
    """
    agent, other = agents
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(router)

    async def _db() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _db
    app.dependency_overrides[get_agent_from_scope] = lambda: agent
    app.dependency_overrides[get_session_lease_service] = lambda: SessionLeaseService(
        SessionStore(), SessionLeaseStore()
    )
    app.dependency_overrides[get_session_ingest_service] = lambda: SessionIngestService(
        SessionStore(), SessionLeaseStore(), SessionEventStore()
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://agent-bridge"
    ) as client:
        yield Caller(client, app, agent, other)

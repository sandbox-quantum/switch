"""The refusals list over real HTTP: an owner sees their agents' refusals,
an admin sees everyone's."""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import AgentRefusal, User
from switch_core.gateway.agent_refusals import router
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import get_session


@pytest_asyncio.fixture
async def seeded(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[dict[str, User]]:
    async with session_factory() as session:
        alice = User(name="alice", email="alice@test", role="user", password_hash="x")
        bob = User(name="bob", email="bob@test", role="user", password_hash="x")
        session.add_all([alice, bob])
        await session.flush()
        session.add(
            AgentRefusal(
                agent_name="helper",
                owner_id=alice.id,
                operation="update_template",
                reason="not_yours",
                message="'standup' was saved by alice.",
                subject="standup",
            )
        )
        await session.commit()
        yield {"alice": alice, "bob": bob}


def _client(
    session_factory: async_sessionmaker[AsyncSession], user: User, *, is_admin: bool
) -> httpx.AsyncClient:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_tenant_is_admin] = lambda: is_admin
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def test_an_owner_sees_their_agents_refusals(session_factory, seeded):
    async with _client(session_factory, seeded["alice"], is_admin=False) as client:
        response = await client.get("/agent-refusals")
    assert response.status_code == 200, response.text
    [refusal] = response.json()
    assert (refusal["agent_name"], refusal["reason"], refusal["subject"]) == (
        "helper",
        "not_yours",
        "standup",
    )


async def test_someone_else_sees_none(session_factory, seeded):
    async with _client(session_factory, seeded["bob"], is_admin=False) as client:
        response = await client.get("/agent-refusals")
    assert response.json() == []


async def test_an_admin_sees_every_refusal(session_factory, seeded):
    async with _client(session_factory, seeded["bob"], is_admin=True) as client:
        response = await client.get("/agent-refusals")
    assert len(response.json()) == 1

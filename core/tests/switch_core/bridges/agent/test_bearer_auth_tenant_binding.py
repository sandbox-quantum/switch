"""BearerAuthMiddleware binds the tenant of the resolved credential (CHOO-2623):
`api_keys.tenant_id` for an agent key, before the wrapped app ever runs — and
unbinds it once that call returns, so it cannot outlive the request.
"""

from __future__ import annotations

import hashlib
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.db.models import Agent, ApiKey, Client, Tenant, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.tenant_context import current_tenant_id

TENANT_A = "bearer-auth-tenant-a"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _seed_agent(
    session_factory: async_sessionmaker[AsyncSession], token: str, tenant_id: str
) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.flush()

        user = User(name="owner", email="owner@example.invalid", role="user")
        session.add(user)
        await session.flush()

        client = Client(
            tenant_id=tenant_id,
            matrix_user_id="@bearer-agent:test",
            display_name="bearer-agent",
            type="agent",
        )
        session.add(client)
        await session.flush()

        api_key = ApiKey(
            tenant_id=tenant_id,
            user_id=user.id,
            key_hash=_hash(token),
            encrypted_key="enc",
            label="k",
            type="agent",
        )
        session.add(api_key)
        await session.flush()

        agent = Agent(
            tenant_id=tenant_id,
            name="bearer-agent",
            description="desc",
            agent_type="always_on",
            connector_type="claude_code",
            integration_profile={"connection_model": "always_on"},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=user.id,
        )
        session.add(agent)
        await session.commit()


def _middleware(session_factory: Any) -> tuple[BearerAuthMiddleware, dict]:
    captured: dict[str, Any] = {}

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        # Read while the middleware's `self.app(...)` call is still on the
        # stack — the only place the bound tenant is supposed to be visible.
        captured["tenant_id"] = current_tenant_id()
        captured["agent_id"] = scope.get("agent_id")

    mw = BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        session_factory=session_factory,
    )
    return mw, captured


async def _dispatch(mw: BearerAuthMiddleware, token: str) -> list[dict]:
    async def receive() -> dict:
        return {"type": "http.request"}

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "path": "/agents/whatever",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
    }
    await mw(scope, receive, send)
    return sent


class TestBearerAuthBindsTheApiKeysTenant:
    async def test_the_agents_api_key_tenant_is_bound_during_the_call(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_agent(session_factory, "tok", TENANT_A)
        mw, captured = _middleware(session_factory)

        sent = await _dispatch(mw, "tok")

        assert sent == []  # never rejected — the inner app ran
        assert captured["agent_id"] is not None
        assert captured["tenant_id"] == TENANT_A

    async def test_the_tenant_is_not_bound_before_or_after_the_call(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_agent(session_factory, "tok", TENANT_A)
        mw, _ = _middleware(session_factory)

        assert current_tenant_id() is None
        await _dispatch(mw, "tok")
        assert current_tenant_id() is None

    async def test_an_unknown_token_binds_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        mw, captured = _middleware(session_factory)

        sent = await _dispatch(mw, "not-a-real-token")

        assert sent[0]["status"] == 401
        assert captured == {}
        assert current_tenant_id() is None

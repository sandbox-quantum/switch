"""BearerAuthMiddleware's registration-token pass-through gate.

Both `"registration"` (personal, self-serve) and `"bootstrap"` (the
deployment-wide AGENT_REGISTRATION_TOKEN) keys must reach the registration
handlers on ordinary paths, and neither may reach `/mcp` — a registration
token opens no MCP session, bootstrap included.
"""

from __future__ import annotations

import hashlib
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.db.models import ApiKey, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _seed_key(
    session_factory: async_sessionmaker[AsyncSession], token: str, key_type: str
) -> None:
    async with session_factory() as session:
        user = User(name="u", email="u@test", role="user", password_hash="x")
        session.add(user)
        await session.flush()
        session.add(
            ApiKey(
                user_id=user.id,
                key_hash=_hash(token),
                encrypted_key="enc",
                label="k",
                type=key_type,
            )
        )
        await session.commit()


def _middleware(session_factory: Any) -> tuple[BearerAuthMiddleware, dict]:
    called: dict[str, Any] = {}

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        called["scope"] = scope

    mw = BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        session_factory=session_factory,
    )
    return mw, called


async def _dispatch(mw: BearerAuthMiddleware, path: str, token: str) -> list[dict]:
    async def receive() -> dict:
        return {"type": "http.request"}

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "path": path,
        "headers": [(b"authorization", f"Bearer {token}".encode())],
    }
    await mw(scope, receive, send)
    return sent


class TestRegistrationPassThrough:
    async def test_a_bootstrap_key_reaches_a_registration_path(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_key(session_factory, "tok", "bootstrap")
        mw, called = _middleware(session_factory)

        sent = await _dispatch(mw, "/agents", "tok")

        assert sent == []
        assert called["scope"]["api_key"].type == "bootstrap"

    async def test_a_bootstrap_key_is_rejected_on_mcp(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_key(session_factory, "tok", "bootstrap")
        mw, called = _middleware(session_factory)

        sent = await _dispatch(mw, "/mcp", "tok")

        assert "scope" not in called
        assert sent[0]["status"] == 401

    async def test_a_registration_key_reaches_a_registration_path(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_key(session_factory, "tok", "registration")
        mw, called = _middleware(session_factory)

        sent = await _dispatch(mw, "/agents", "tok")

        assert sent == []
        assert called["scope"]["api_key"].type == "registration"

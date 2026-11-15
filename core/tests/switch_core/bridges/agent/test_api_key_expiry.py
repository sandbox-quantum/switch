"""A key past its `api_keys.expires_at` is refused wherever keys are checked:
the bearer middleware, whether the key is read or remembered in the
`ApiKeyCache`, and the registration endpoint's own check."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import auth as bearer_auth
from switch_core.bridges.agent.api.handlers import _resolve_registration_user_id
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.db.models import ApiKey
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from tests.switch_core.bridges.agent.test_bearer_auth_tenant_binding import (
    _seed_agent,
    _seed_registration_key,
)

TENANT = "api-key-expiry-tenant"
_PAST = datetime.now(UTC) - timedelta(minutes=1)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _expire(
    session_factory: async_sessionmaker[AsyncSession], token: str, at: datetime
) -> None:
    async with session_factory() as session:
        await session.execute(
            update(ApiKey).where(ApiKey.key_hash == _hash(token)).values(expires_at=at)
        )
        await session.commit()


def _middleware(
    session_factory: async_sessionmaker[AsyncSession], cache: ApiKeyCache
) -> tuple[BearerAuthMiddleware, list[str]]:
    reached: list[str] = []

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        reached.append(scope["path"])

    return (
        BearerAuthMiddleware(
            _app,
            agent_store=AgentStore(),
            api_key_store=ApiKeyStore(),
            api_key_cache=cache,
            session_factory=session_factory,
        ),
        reached,
    )


async def _dispatch(
    mw: BearerAuthMiddleware, token: str, path: str = "/agents/whatever"
) -> list[dict]:
    async def receive() -> dict:
        return {"type": "http.request"}

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    await mw(
        {
            "type": "http",
            "path": path,
            "headers": [(b"authorization", f"Bearer {token}".encode())],
        },
        receive,
        send,
    )
    return sent


def _refusal(sent: list[dict]) -> tuple[int, bytes]:
    return sent[0]["status"], sent[1]["body"]


async def test_an_expired_agent_key_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_agent(session_factory, "agent-tok", TENANT)
    await _expire(session_factory, "agent-tok", _PAST)
    cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
    mw, reached = _middleware(session_factory, cache)

    sent = await _dispatch(mw, "agent-tok")

    assert reached == []
    assert _refusal(sent) == (401, b"API key expired")
    assert cache.get(_hash("agent-tok")) is None


async def test_a_remembered_key_is_refused_once_it_expires(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed_agent(session_factory, "agent-tok", TENANT)
    expiry = datetime.now(UTC) + timedelta(hours=1)
    await _expire(session_factory, "agent-tok", expiry)
    cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
    mw, reached = _middleware(session_factory, cache)
    assert await _dispatch(mw, "agent-tok") == []
    assert cache.get(_hash("agent-tok")) is not None

    class _Later(datetime):
        @classmethod
        def now(cls, tz: Any = None) -> datetime:  # type: ignore[override]
            return expiry + timedelta(seconds=1)

    monkeypatch.setattr(bearer_auth, "datetime", _Later)
    sent = await _dispatch(mw, "agent-tok")

    assert reached == ["/agents/whatever"]
    assert _refusal(sent) == (401, b"API key expired")
    assert cache.get(_hash("agent-tok")) is None


async def test_a_key_before_its_expiry_still_works(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_agent(session_factory, "agent-tok", TENANT)
    await _expire(session_factory, "agent-tok", datetime.now(UTC) + timedelta(days=1))
    mw, reached = _middleware(
        session_factory, ApiKeyCache(ttl_seconds=0, max_entries=8)
    )

    assert await _dispatch(mw, "agent-tok") == []
    assert reached == ["/agents/whatever"]


async def test_an_expired_registration_key_is_refused_at_the_door(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_registration_key(session_factory, "reg-tok", TENANT)
    await _expire(session_factory, "reg-tok", _PAST)
    mw, reached = _middleware(
        session_factory, ApiKeyCache(ttl_seconds=5, max_entries=8)
    )

    sent = await _dispatch(mw, "reg-tok", path="/agents/register")

    assert reached == []
    assert _refusal(sent) == (401, b"API key expired")


async def test_the_registration_endpoint_refuses_an_expired_key(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_registration_key(session_factory, "reg-tok", TENANT)
    await _expire(session_factory, "reg-tok", _PAST)

    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await _resolve_registration_user_id(
                "Bearer reg-tok",
                session,
                ApiKeyStore(),
                protocol=None,  # type: ignore[arg-type]
            )

    assert refused.value.status_code == 401
    assert refused.value.detail == "Registration token has expired"

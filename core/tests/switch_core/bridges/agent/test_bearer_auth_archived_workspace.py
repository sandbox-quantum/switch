"""A credential of an archived workspace is refused at the bearer middleware:
an agent key, a registration key and an OIDC client alike, with a 403 its
client can tell apart from a bad key. Nothing is revoked, so Restore lets the
same credential in again."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.archived_workspace import WORKSPACE_ARCHIVED
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.db.models import Agent, Tenant
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from tests.switch_core.bridges.agent.test_bearer_auth_tenant_binding import (
    _seed_agent,
    _seed_registration_key,
)

TENANT = "archived-workspace-tenant"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _archive(
    session_factory: async_sessionmaker[AsyncSession], *, archived: bool
) -> None:
    async with session_factory() as session:
        await session.execute(
            update(Tenant)
            .where(Tenant.id == TENANT)
            .values(archived_at=datetime.now(UTC) if archived else None)
        )
        await session.commit()


class _Validator:
    """An OIDC validator that accepts any token as `client_id`'s."""

    def __init__(self, client_id: str) -> None:
        self._client_id = client_id

    def validate(self, token: str) -> dict[str, Any]:
        return {"azp": self._client_id}


def _middleware(
    session_factory: async_sessionmaker[AsyncSession],
    cache: ApiKeyCache,
    oidc_validator: _Validator | None = None,
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
            oidc_validator=oidc_validator,  # type: ignore[arg-type]
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


def _refusal(sent: list[dict]) -> tuple[int, dict[str, Any]]:
    return sent[0]["status"], json.loads(sent[1]["body"])


_ARCHIVED = {
    "error": {
        "code": "workspace_archived",
        "message": WORKSPACE_ARCHIVED,
        "retryable": False,
    }
}


async def test_an_agent_key_of_an_archived_workspace_is_refused_and_not_remembered(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_agent(session_factory, "agent-tok", TENANT)
    await _archive(session_factory, archived=True)
    cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
    mw, reached = _middleware(session_factory, cache)

    sent = await _dispatch(mw, "agent-tok")

    assert reached == []
    assert _refusal(sent) == (403, _ARCHIVED)
    assert cache.get(_hash("agent-tok")) is None


async def test_restoring_the_workspace_lets_the_same_agent_key_in_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_agent(session_factory, "agent-tok", TENANT)
    await _archive(session_factory, archived=True)
    cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
    mw, reached = _middleware(session_factory, cache)
    assert _refusal(await _dispatch(mw, "agent-tok"))[0] == 403

    await _archive(session_factory, archived=False)

    assert await _dispatch(mw, "agent-tok") == []
    assert reached == ["/agents/whatever"]
    assert cache.get(_hash("agent-tok")) is not None


async def test_a_registration_key_of_an_archived_workspace_is_refused_at_the_door(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_registration_key(session_factory, "reg-tok", TENANT)
    await _archive(session_factory, archived=True)
    mw, reached = _middleware(
        session_factory, ApiKeyCache(ttl_seconds=5, max_entries=8)
    )

    sent = await _dispatch(mw, "reg-tok", path="/agents/register")

    assert reached == []
    assert _refusal(sent) == (403, _ARCHIVED)


async def test_an_oidc_client_of_an_archived_workspace_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_agent(session_factory, "agent-tok", TENANT)
    async with session_factory() as session:
        await session.execute(
            update(Agent).where(Agent.tenant_id == TENANT).values(oauth_client_id="oc")
        )
        await session.commit()
    mw, reached = _middleware(
        session_factory, ApiKeyCache(ttl_seconds=5, max_entries=8), _Validator("oc")
    )
    assert await _dispatch(mw, "a-jwt") == []
    assert reached == ["/agents/whatever"]

    await _archive(session_factory, archived=True)
    sent = await _dispatch(mw, "a-jwt")

    assert reached == ["/agents/whatever"]
    assert _refusal(sent) == (403, _ARCHIVED)

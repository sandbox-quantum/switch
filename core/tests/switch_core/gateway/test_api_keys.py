"""`key_prefix` in the API key list is the real key's prefix, not the hash's.

The list column is headed "Key Prefix" in the gateway UI so an operator can
match a key they hold against its row. That only works if the value is the
opening characters of the plaintext key — not of its SHA-256 hash. This drives
real HTTP against real Postgres: create a key (which returns the plaintext
once), then list the keys and prove the listed prefix is that plaintext's
prefix, and specifically not the hash prefix the endpoint used to return.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.api_keys import router
from switch_core.gateway.auth import create_jwt

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow

_USER_STORE = UserStore()
_API_KEY_STORE = ApiKeyStore()


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router, prefix="/api-keys")
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_api_key_store] = lambda: _API_KEY_STORE
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET,
    )
    return app


async def _seed_user(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(name="Ada", email="ada@example.invalid", role="user")
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


def _client(app: FastAPI, user_id: str) -> httpx.AsyncClient:
    token = create_jwt(user_id, "ada@example.invalid", "user", _SECRET, None)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


class TestKeyPrefixIsThePlaintextPrefix:
    async def test_listed_prefix_matches_the_created_key(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_user(session_factory)
        app = _app(session_factory)

        async with _client(app, user_id) as client:
            created = await client.post("/api-keys", json={"label": "ci"})
            assert created.status_code == 200, created.text
            plaintext = created.json()["key"]

            listed = await client.get("/api-keys")
            assert listed.status_code == 200, listed.text

        rows = listed.json()
        assert len(rows) == 1
        prefix = rows[0]["key_prefix"]

        assert prefix == plaintext[:12]
        # The old behavior returned the hash prefix; guard against regressing.
        assert prefix != hashlib.sha256(plaintext.encode()).hexdigest()[:12]

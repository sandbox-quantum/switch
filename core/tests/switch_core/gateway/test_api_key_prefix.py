"""`GET /api-keys` reports a prefix of the key, not of its hash.

The listing used to return `key_hash[:12]`, which the gateway renders under a
"Key Prefix" column — truthfully a hash prefix, but displayed as though it were
the key's opening characters, so an operator holding a key could not match it
against its row.

Driven over real HTTP against real Postgres, in the style of
`test_change_password.py`: the prefix has to survive create -> store -> list,
and a stub for any of those steps would happily echo a prefix of either string.
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
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_api_key_store] = lambda: _API_KEY_STORE
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
    )
    return app


async def _seed_user(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> str:
    async with session_factory() as session:
        user = User(name="Ada", email=email, role="user", password_hash=None)
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


def _client(app: FastAPI, user_id: str, email: str) -> httpx.AsyncClient:
    token = create_jwt(user_id, email, "user", _SECRET, None)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


class TestListedPrefix:
    async def test_it_is_the_start_of_the_key_and_not_of_the_hash(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "ada@example.invalid"
        user_id = await _seed_user(session_factory, email)
        app = _app(session_factory)

        async with _client(app, user_id, email) as client:
            created = await client.post("/api-keys", json={"label": "laptop"})
            assert created.status_code == 200, created.text
            plaintext = created.json()["key"]

            listed = await client.get("/api-keys")
        assert listed.status_code == 200, listed.text

        rows = [r for r in listed.json() if r["id"] == created.json()["id"]]
        assert len(rows) == 1
        prefix = rows[0]["key_prefix"]

        assert prefix == plaintext[:12]
        key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
        assert prefix != key_hash[:12]

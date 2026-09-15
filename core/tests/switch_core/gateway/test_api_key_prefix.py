"""GET /api-keys returns the plaintext opening of the key as `key_prefix`.

The regression under test: `list_api_keys` used to set `key_prefix` to
`key_hash[:12]`, a prefix of the sha256 digest rather than of the key. The
gateway renders that value in a column headed "Key Prefix", so an operator
holding a key could not match it against the row. The fix decrypts the stored
key and returns its first twelve characters, the way `reveal_api_key` does.

Drives real HTTP against real Postgres for the same reason as
`test_change_password.py`: the route reads the same session it was handed, and
a fake store could not prove the value comes from the real encrypted column.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.crypto import encrypt_token
from switch_core.db.models import ApiKey, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.api_keys import router
from switch_core.gateway.auth import create_jwt

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow

_API_KEY_STORE = ApiKeyStore()
_USER_STORE = UserStore()


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router, prefix="/api-keys")
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_api_key_store] = lambda: _API_KEY_STORE
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
    )
    return app


async def _seed_user(
    session_factory: async_sessionmaker[AsyncSession], *, email: str
) -> str:
    async with session_factory() as session:
        user = User(name="Ada", email=email, role="user", password_hash=None)
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


async def _seed_key(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str,
    plaintext: str,
) -> str:
    async with session_factory() as session:
        import hashlib

        key = ApiKey(
            user_id=user_id,
            key_hash=hashlib.sha256(plaintext.encode()).hexdigest(),
            encrypted_key=encrypt_token(plaintext, _SECRET),
            label="my-key",
            type="registration",
        )
        await _API_KEY_STORE.create(session, key)
        await session.commit()
        return key.id


def _client(app: FastAPI, user_id: str, email: str) -> httpx.AsyncClient:
    token = create_jwt(user_id, email, "user", _SECRET, None)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


class TestListApiKeyPrefix:
    async def test_prefix_is_the_start_of_the_key_not_the_hash(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "ada@example.invalid"
        plaintext = "abcdef1234567890-this-is-the-real-key"
        user_id = await _seed_user(session_factory, email=email)
        await _seed_key(session_factory, user_id=user_id, plaintext=plaintext)

        app = _app(session_factory)
        async with _client(app, user_id, email) as client:
            response = await client.get("/api-keys")

        assert response.status_code == 200, response.text
        rows = response.json()
        assert len(rows) == 1
        prefix = rows[0]["key_prefix"]

        # The prefix is the opening of the key the operator holds...
        assert prefix == plaintext[:12]
        assert plaintext.startswith(prefix)
        # ...and specifically NOT a prefix of the sha256 digest, which is the
        # bug this guards against.
        import hashlib

        assert prefix != hashlib.sha256(plaintext.encode()).hexdigest()[:12]

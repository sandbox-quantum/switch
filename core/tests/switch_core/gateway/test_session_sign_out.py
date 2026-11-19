"""Signing out of one session (`/auth/logout`, `revoked_sessions`).

Every session cookie carries its session's id, kept by every re-mint, so
signing out refuses each copy of that session's cookie wherever it was
copied, and leaves the person's other sessions alone. Real HTTP against real
Postgres.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import jwt
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import RevokedSession, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    JWT_ALGORITHM,
    SESSION_MAX_AGE,
    decode_jwt,
    hash_password,
    session_is_current,
)
from switch_core.gateway.auth_routes import router
from switch_core.keys import Keyring, Purpose
from tests.switch_core.gateway.login_limit_defaults import LOGIN_LIMIT_DEFAULTS

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_PASSWORD = "password-one-1"
_EMAIL = "ada@example.invalid"
_USER_STORE = UserStore()


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
        gateway_tenant_choice_enabled=False,
        **LOGIN_LIMIT_DEFAULTS,
    )
    return app


@pytest.fixture
async def app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async with session_factory() as session:
        await _USER_STORE.create(
            session,
            User(
                name="Ada",
                email=_EMAIL,
                role="user",
                password_hash=hash_password(_PASSWORD),
            ),
        )
        await session.commit()
    return _app(session_factory)


def _client(app: FastAPI, token: str | None = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token} if token is not None else None,
    )


async def _sign_in(app: FastAPI) -> str:
    async with _client(app) as client:
        response = await client.post(
            "/auth/login", json={"email": _EMAIL, "password": _PASSWORD}
        )
    assert response.status_code == 200, response.text
    return response.cookies["switch_auth"]


async def _me(app: FastAPI, token: str) -> int:
    async with _client(app, token) as client:
        return (await client.get("/auth/me")).status_code


async def _sign_out(app: FastAPI, token: str | None) -> httpx.Response:
    async with _client(app, token) as client:
        return await client.post("/auth/logout")


async def _revoked(factory: async_sessionmaker[AsyncSession]) -> list[RevokedSession]:
    async with factory() as session:
        return list(await session.scalars(select(RevokedSession)))


async def test_signing_out_refuses_every_copy_of_that_session_and_no_other(
    app: FastAPI,
) -> None:
    here = await _sign_in(app)
    elsewhere = await _sign_in(app)
    assert decode_jwt(here, _KEYRING)["sid"] != decode_jwt(elsewhere, _KEYRING)["sid"]
    # Someone else holds a copy of this browser's cookie.
    copied = here

    signed_out = await _sign_out(app, here)
    assert signed_out.status_code == 200
    assert 'switch_auth=""' in signed_out.headers["set-cookie"]

    assert await _me(app, copied) == 401
    async with _client(app, copied) as client:
        refused = await client.get("/auth/me")
    assert refused.json() == {"detail": "Session ended"}
    assert await _me(app, elsewhere) == 200


async def test_a_copy_refreshed_before_the_sign_out_is_refused_too(
    app: FastAPI,
) -> None:
    """Refreshing keeps the session's id, so every copy of it, older or
    newer, is the same session."""
    first = await _sign_in(app)
    async with _client(app, first) as client:
        refreshed = await client.post("/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    newer = refreshed.cookies["switch_auth"]
    assert decode_jwt(newer, _KEYRING)["sid"] == decode_jwt(first, _KEYRING)["sid"]

    await _sign_out(app, first)
    assert await _me(app, newer) == 401
    async with _client(app, newer) as client:
        assert (await client.post("/auth/refresh")).status_code == 401


async def test_a_signed_out_session_is_no_longer_current_for_a_socket(
    app: FastAPI, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    token = await _sign_in(app)
    claims = decode_jwt(token, _KEYRING)

    async def current() -> bool:
        return await session_is_current(
            session_factory, _USER_STORE, claims["sub"], claims["sv"], claims["sid"]
        )

    assert await current()
    await _sign_out(app, token)
    assert not await current()


async def test_signing_out_everywhere_still_ends_every_session(app: FastAPI) -> None:
    here = await _sign_in(app)
    elsewhere = await _sign_in(app)
    async with _client(app, here) as client:
        assert (await client.post("/auth/sessions/revoke")).status_code == 200
    assert await _me(app, here) == 401
    assert await _me(app, elsewhere) == 401


async def test_a_signed_out_session_is_forgotten_once_no_copy_could_be_live(
    app: FastAPI, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    first = await _sign_in(app)
    await _sign_out(app, first)
    [row] = await _revoked(session_factory)
    signed_in = datetime.fromtimestamp(decode_jwt(first, _KEYRING)["auth_time"], UTC)
    assert row.expires_at == signed_in + SESSION_MAX_AGE

    async with session_factory() as session:
        await session.execute(
            update(RevokedSession).values(
                expires_at=RevokedSession.expires_at - SESSION_MAX_AGE - timedelta(1)
            )
        )
        await session.commit()
    second = await _sign_in(app)
    await _sign_out(app, second)
    assert [row.session_id for row in await _revoked(session_factory)] == [
        decode_jwt(second, _KEYRING)["sid"]
    ]


@pytest.mark.parametrize("cookie", [None, "not-a-session", "expired"])
async def test_signing_out_without_a_live_session_still_clears_the_cookie(
    app: FastAPI,
    session_factory: async_sessionmaker[AsyncSession],
    cookie: str | None,
) -> None:
    if cookie == "expired":
        claims = decode_jwt(await _sign_in(app), _KEYRING)
        claims["exp"] = int((datetime.now(UTC) - timedelta(minutes=1)).timestamp())
        cookie = _signed(claims)
    response = await _sign_out(app, cookie)
    assert response.status_code == 200
    assert await _revoked(session_factory) == []


def _signed(claims: dict) -> str:
    return jwt.encode(
        claims,
        _KEYRING.derive(Purpose.SESSION),
        algorithm=JWT_ALGORITHM,
        headers={"kid": _KEYRING.current.id},
    )


async def test_a_cookie_from_before_session_ids_gets_one_when_minted_again(
    app: FastAPI, session_factory: async_sessionmaker[AsyncSession], caplog
) -> None:
    """It cannot be signed out of on its own, and the log says so; its next
    re-mint gives it an id, and from then on it can."""
    claims = decode_jwt(await _sign_in(app), _KEYRING)
    del claims["sid"]
    legacy = _signed(claims)

    with caplog.at_level(logging.WARNING):
        assert (await _sign_out(app, legacy)).status_code == 200
    assert await _revoked(session_factory) == []
    assert "minted before sessions had ids" in caplog.text
    assert await _me(app, legacy) == 200

    async with _client(app, legacy) as client:
        refreshed = (await client.post("/auth/refresh")).cookies["switch_auth"]
    assert decode_jwt(refreshed, _KEYRING)["sid"]
    await _sign_out(app, refreshed)
    assert await _me(app, refreshed) == 401

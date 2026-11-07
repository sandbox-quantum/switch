"""No session outlives its sign-in by more than `SESSION_MAX_AGE`.

A session cookie carries when the person signed in (`auth_time`). Refreshing
keeps it, and caps the new cookie's expiry at `SESSION_MAX_AGE` after it, so
an active client can renew every day and still has to sign in again in the
end. Real HTTP against real Postgres, like `test_session_version.py`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import jwt
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    JWT_ALGORITHM,
    JWT_EXPIRY_HOURS,
    SESSION_MAX_AGE,
    create_jwt,
    decode_jwt,
    hash_password,
)
from switch_core.gateway.auth_routes import router
from switch_core.keys import Keyring, Purpose

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_PASSWORD = "password-one-1"

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
    )
    return app


async def _seed_user(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> str:
    async with session_factory() as session:
        user = User(
            name=email.split("@")[0],
            email=email,
            role="user",
            password_hash=hash_password(_PASSWORD),
        )
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


def _session_signed_in(
    user_id: str, email: str, signed_in: datetime, *, with_auth_time: bool = True
) -> str:
    """A valid, unexpired cookie whose sign-in was `signed_in`. With
    `with_auth_time` False it is shaped like a cookie from before the claim
    existed, minted (`iat`) at `signed_in`."""
    claims = decode_jwt(
        create_jwt(
            user_id,
            email,
            "user",
            _KEYRING,
            None,
            session_version=0,
            auth_time=datetime.now(UTC),
        ),
        _KEYRING,
    )
    if with_auth_time:
        claims["auth_time"] = int(signed_in.timestamp())
    else:
        del claims["auth_time"]
        claims["iat"] = int(signed_in.timestamp())
    return jwt.encode(
        claims,
        _KEYRING.derive(Purpose.SESSION),
        algorithm=JWT_ALGORITHM,
        headers={"kid": _KEYRING.current.id},
    )


def _client(app: FastAPI, token: str | None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={} if token is None else {"switch_auth": token},
    )


async def test_signing_in_starts_the_session_now(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    email = "fresh@example.invalid"
    await _seed_user(session_factory, email)
    before = int(datetime.now(UTC).timestamp())

    async with _client(_app(session_factory), None) as client:
        signed_in = await client.post(
            "/auth/login", json={"email": email, "password": _PASSWORD}
        )

    assert signed_in.status_code == 200, signed_in.text
    claims = decode_jwt(signed_in.cookies["switch_auth"], _KEYRING)
    assert before <= claims["auth_time"] <= int(datetime.now(UTC).timestamp())
    assert claims["exp"] - claims["iat"] == JWT_EXPIRY_HOURS * 3600


async def test_refreshing_keeps_when_the_session_signed_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    email = "renewing@example.invalid"
    user_id = await _seed_user(session_factory, email)
    signed_in = datetime.now(UTC) - timedelta(days=3)

    async with _client(
        _app(session_factory), _session_signed_in(user_id, email, signed_in)
    ) as client:
        renewed = await client.post("/auth/refresh")

    assert renewed.status_code == 200, renewed.text
    claims = decode_jwt(renewed.cookies["switch_auth"], _KEYRING)
    assert claims["auth_time"] == int(signed_in.timestamp())


async def test_the_last_refresh_expires_when_the_session_reaches_its_limit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    email = "last@example.invalid"
    user_id = await _seed_user(session_factory, email)
    signed_in = datetime.now(UTC) - SESSION_MAX_AGE + timedelta(hours=2)

    async with _client(
        _app(session_factory), _session_signed_in(user_id, email, signed_in)
    ) as client:
        renewed = await client.post("/auth/refresh")

    assert renewed.status_code == 200, renewed.text
    claims = decode_jwt(renewed.cookies["switch_auth"], _KEYRING)
    assert claims["exp"] == int((signed_in + SESSION_MAX_AGE).timestamp())
    max_age = int(renewed.headers["set-cookie"].split("Max-Age=")[1].split(";")[0])
    assert max_age <= 2 * 3600


@pytest.mark.parametrize("with_auth_time", [True, False])
async def test_a_session_past_its_limit_cannot_be_refreshed(
    session_factory: async_sessionmaker[AsyncSession], with_auth_time: bool
) -> None:
    email = f"stale-{with_auth_time}@example.invalid"
    user_id = await _seed_user(session_factory, email)
    signed_in = datetime.now(UTC) - SESSION_MAX_AGE - timedelta(minutes=1)
    token = _session_signed_in(user_id, email, signed_in, with_auth_time=with_auth_time)

    async with _client(_app(session_factory), token) as client:
        refused = await client.post("/auth/refresh")

    assert refused.status_code == 401
    assert "switch_auth" not in refused.cookies


async def test_a_cookie_from_before_the_claim_counts_from_when_it_was_minted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    email = "legacy@example.invalid"
    user_id = await _seed_user(session_factory, email)
    minted = datetime.now(UTC) - timedelta(hours=1)
    token = _session_signed_in(user_id, email, minted, with_auth_time=False)

    async with _client(_app(session_factory), token) as client:
        renewed = await client.post("/auth/refresh")

    assert renewed.status_code == 200, renewed.text
    claims = decode_jwt(renewed.cookies["switch_auth"], _KEYRING)
    assert claims["auth_time"] == int(minted.timestamp())

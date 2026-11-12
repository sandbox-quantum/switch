"""Changing your own display name (PATCH /auth/me), end to end.

Real HTTP against real Postgres, for the same reason as the password change:
the route writes the `User` that `get_current_user` handed it and commits the
session `get_session` handed it, so only a read through a fresh session proves
the write was issued.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import TENANT_ZERO_ID, Client, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.auth_routes import router
from switch_core.keys import Keyring

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
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
    session_factory: async_sessionmaker[AsyncSession],
    email: str,
    password_hash: str | None = None,
) -> str:
    async with session_factory() as session:
        user = User(name="Ada", email=email, role="user", password_hash=password_hash)
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


async def _stored_name(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> str:
    async with session_factory() as session:
        user = await _USER_STORE.get(session, user_id)
        assert user is not None
        return user.name


def _client(app: FastAPI, user_id: str, email: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={
            "switch_auth": create_jwt(
                user_id,
                email,
                "user",
                _KEYRING,
                None,
                session_version=0,
                auth_time=datetime.now(UTC),
            )
        },
    )


async def test_the_new_name_is_stored_and_answered(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    email = "ada-name@example.invalid"
    user_id = await _seed_user(session_factory, email)

    async with _client(_app(session_factory), user_id, email) as client:
        response = await client.patch("/auth/me", json={"name": "  Ada Lovelace  "})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Ada Lovelace"
    assert await _stored_name(session_factory, user_id) == "Ada Lovelace"


async def test_a_blank_name_is_refused_and_writes_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    email = "bo-name@example.invalid"
    user_id = await _seed_user(session_factory, email)

    async with _client(_app(session_factory), user_id, email) as client:
        blank = await client.patch("/auth/me", json={"name": "   "})
        too_long = await client.patch("/auth/me", json={"name": "x" * 256})
        extra = await client.patch("/auth/me", json={"name": "Bo", "email": "x@y.z"})

    assert blank.status_code == 422
    assert too_long.status_code == 422
    assert extra.status_code == 422
    assert await _stored_name(session_factory, user_id) == "Ada"


async def test_signed_out_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)), base_url="http://test"
    ) as anonymous:
        response = await anonymous.patch("/auth/me", json={"name": "Anyone"})
    assert response.status_code == 401


async def test_says_whether_the_account_has_a_password_of_its_own(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    sso_email = "sso-name@example.invalid"
    sso = await _seed_user(session_factory, sso_email)
    pw_email = "pw-name@example.invalid"
    pw = await _seed_user(session_factory, pw_email, password_hash="not-a-real-hash")
    app = _app(session_factory)

    async with _client(app, sso, sso_email) as client:
        sso_answer = await client.patch("/auth/me", json={"name": "Sso"})
    async with _client(app, pw, pw_email) as client:
        pw_answer = await client.patch("/auth/me", json={"name": "Pw"})

    assert sso_answer.json()["has_password"] is False
    assert pw_answer.json()["has_password"] is True


async def test_renames_the_member_client_others_see_in_console_chats(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    email = "cy-name@example.invalid"
    user_id = await _seed_user(session_factory, email)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        session.add(
            Client(
                tenant_id=TENANT_ZERO_ID,
                transport_user_id=f"@switch-member-{user_id}:test",
                display_name="Ada",
                type=MEMBER_CLIENT_TYPE,
                user_id=user_id,
            )
        )
        await session.commit()

    async with _client(_app(session_factory), user_id, email) as client:
        response = await client.patch("/auth/me", json={"name": "Cy Young"})

    assert response.status_code == 200, response.text
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        names = (
            (
                await session.execute(
                    select(Client.display_name).where(Client.user_id == user_id)
                )
            )
            .scalars()
            .all()
        )
    assert names == ["Cy Young"]

"""Self-service password change (PUT /auth/me/password), end to end.

Deliberately not a stubbed session. The endpoint mutates the `User` object
`get_current_user` handed it and commits the session `get_session` handed it,
so it is only correct if those are the *same* session — and a fake session
records a commit no matter which. This drives real HTTP against real Postgres
and then proves the change survived by signing in again with the new password,
which is the only assertion that cannot pass on a write that was never issued.

Uses `httpx.AsyncClient` over `ASGITransport` rather than
`fastapi.testclient.TestClient` for the same reason as
`test_tenant_resolution.py`: the sync client runs the app on its own event
loop, and the `session_factory` fixture's connections belong to this one.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.tenant_member_store import TenantMemberStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt, hash_password, verify_password
from switch_core.gateway.auth_routes import router
from switch_core.gateway.schemas import ChangePasswordRequest

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_OLD_PASSWORD = "old-password-1"
_NEW_PASSWORD = "new-password-1"

_USER_STORE = UserStore()


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    """The real auth router, with only the process-global wiring replaced.

    `get_session` is overridden with one that opens a session per request, the
    way the real one does — not with a per-call session — so FastAPI's
    dependency cache hands the endpoint and `get_current_user` the same object,
    which is the property under test.
    """

    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_tenant_member_store] = lambda: (
        TenantMemberStore()
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET,
        gateway_cookie_secure=False,
        gateway_password_login_enabled=True,
    )
    return app


async def _seed_user(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    email: str,
    password: str | None,
) -> str:
    async with session_factory() as session:
        user = User(
            name="Ada",
            email=email,
            role="user",
            password_hash=None if password is None else hash_password(password),
        )
        # Also inserts the tenant_members row tenant resolution needs.
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


async def _stored_hash(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> str | None:
    """Read back through a session that shares nothing with the request's."""
    async with session_factory() as session:
        user = await _USER_STORE.get(session, user_id)
        assert user is not None
        return user.password_hash


def _client(app: FastAPI, user_id: str, email: str) -> httpx.AsyncClient:
    token = create_jwt(user_id, email, "user", _SECRET)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


class TestPasswordChangeIsPersisted:
    async def test_the_new_password_can_be_logged_in_with(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "ada@example.invalid"
        user_id = await _seed_user(session_factory, email=email, password=_OLD_PASSWORD)
        app = _app(session_factory)

        async with _client(app, user_id, email) as client:
            changed = await client.put(
                "/auth/me/password",
                json={
                    "current_password": _OLD_PASSWORD,
                    "new_password": _NEW_PASSWORD,
                },
            )
        assert changed.status_code == 200, changed.text
        assert changed.json() == {"ok": True}

        # The assertion the old stubbed test could not make: a fresh client,
        # a fresh session, and the credential actually working.
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as anonymous:
            logged_in = await anonymous.post(
                "/auth/login", json={"email": email, "password": _NEW_PASSWORD}
            )
            refused = await anonymous.post(
                "/auth/login", json={"email": email, "password": _OLD_PASSWORD}
            )
        assert logged_in.status_code == 200, logged_in.text
        assert logged_in.json()["id"] == user_id
        assert refused.status_code == 401

    async def test_the_row_in_the_database_carries_the_new_hash(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "bo@example.invalid"
        user_id = await _seed_user(session_factory, email=email, password=_OLD_PASSWORD)

        async with _client(_app(session_factory), user_id, email) as client:
            response = await client.put(
                "/auth/me/password",
                json={
                    "current_password": _OLD_PASSWORD,
                    "new_password": _NEW_PASSWORD,
                },
            )
        assert response.status_code == 200, response.text

        stored = await _stored_hash(session_factory, user_id)
        assert verify_password(_NEW_PASSWORD, stored)
        assert not verify_password(_OLD_PASSWORD, stored)


class TestPasswordChangeIsRefused:
    async def test_a_wrong_current_password_is_403_and_writes_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "cy@example.invalid"
        user_id = await _seed_user(session_factory, email=email, password=_OLD_PASSWORD)
        before = await _stored_hash(session_factory, user_id)

        async with _client(_app(session_factory), user_id, email) as client:
            response = await client.put(
                "/auth/me/password",
                json={"current_password": "wrong-password", "new_password": "x" * 12},
            )

        assert response.status_code == 403
        assert await _stored_hash(session_factory, user_id) == before

    async def test_an_oidc_user_with_no_password_hash_is_403(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        email = "di@example.invalid"
        user_id = await _seed_user(session_factory, email=email, password=None)

        async with _client(_app(session_factory), user_id, email) as client:
            response = await client.put(
                "/auth/me/password",
                json={"current_password": "anything", "new_password": _NEW_PASSWORD},
            )

        assert response.status_code == 403
        assert await _stored_hash(session_factory, user_id) is None


class TestSchemaValidation:
    """No database needed: the length floor is the schema's, not the route's."""

    def test_short_new_password_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            ChangePasswordRequest(current_password=_OLD_PASSWORD, new_password="short")
        assert any(e["type"] == "string_too_short" for e in exc_info.value.errors())

    def test_empty_new_password_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ChangePasswordRequest(current_password=_OLD_PASSWORD, new_password="")

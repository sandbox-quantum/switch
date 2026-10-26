"""Admin user creation (POST /users): the same password and address rules as
signup.

bcrypt reads only the first 72 bytes of a password, so a longer one would be
stored as a prefix of itself; the request schema refuses it instead, and
refuses anything under 8 characters. The address is normalised the way signup
normalises it, so the same address means the same account whichever way it
was created (`SignupRequest` shares the constraints, and `test_signup.py`
covers its HTTP behaviour end to end).

The HTTP tests drive the real auth router against real Postgres, as
`test_change_password.py` does; the schema tests need no database.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.auth_routes import router
from switch_core.gateway.schemas import CreateUserRequest
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


async def _admin_client(
    session_factory: async_sessionmaker[AsyncSession], app: FastAPI
) -> httpx.AsyncClient:
    async with session_factory() as session:
        admin = User(
            name="Operator",
            email="operator@example.invalid",
            role="admin",
            password_hash=None,
        )
        await _USER_STORE.create(session, admin)
        await session.commit()
    token = create_jwt(admin.id, admin.email, "admin", _KEYRING, None)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _emails_like(
    session_factory: async_sessionmaker[AsyncSession], address: str
) -> list[str]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(User.email).where(
                func.lower(func.trim(User.email)) == address.strip().lower()
            )
        )
        return list(rows)


class TestCreateUserOverHttp:
    async def test_a_short_password_is_422_and_creates_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        async with await _admin_client(session_factory, app) as client:
            response = await client.post(
                "/users",
                json={
                    "name": "Ada",
                    "email": "ada@example.invalid",
                    "password": "hello",
                },
            )

        assert response.status_code == 422, response.text
        assert await _emails_like(session_factory, "ada@example.invalid") == []

    async def test_an_overlong_password_is_422_and_creates_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        async with await _admin_client(session_factory, app) as client:
            response = await client.post(
                "/users",
                json={
                    "name": "Bo",
                    "email": "bo@example.invalid",
                    "password": "correct horse battery staple " * 3,
                },
            )

        assert response.status_code == 422, response.text
        assert "at most 72 bytes" in response.text
        assert await _emails_like(session_factory, "bo@example.invalid") == []

    async def test_the_address_is_stored_normalised(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        async with await _admin_client(session_factory, app) as client:
            response = await client.post(
                "/users",
                json={
                    "name": "Cy",
                    "email": "  Cy@Example.INVALID ",
                    "password": "good-pass-1",
                },
            )

        assert response.status_code == 200, response.text
        assert response.json()["email"] == "cy@example.invalid"
        assert await _emails_like(session_factory, "cy@example.invalid") == [
            "cy@example.invalid"
        ]

    async def test_the_same_address_padded_or_recased_is_a_conflict(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        async with await _admin_client(session_factory, app) as client:
            first = await client.post(
                "/users",
                json={
                    "name": "Di",
                    "email": "di@example.invalid",
                    "password": "good-pass-1",
                },
            )
            second = await client.post(
                "/users",
                json={
                    "name": "Di again",
                    "email": " DI@example.invalid ",
                    "password": "good-pass-2",
                },
            )

        assert first.status_code == 200, first.text
        assert second.status_code == 409, second.text
        assert await _emails_like(session_factory, "di@example.invalid") == [
            "di@example.invalid"
        ]


class TestCreateUserSchemaValidation:
    def test_email_is_normalised(self) -> None:
        request = CreateUserRequest(
            name="Ada", email="  Admin@Example.COM  ", password="good-pass-1"
        )
        assert request.email == "admin@example.com"

    def test_role_defaults_to_user(self) -> None:
        request = CreateUserRequest(
            name="Ada", email="ada@example.com", password="good-pass-1"
        )
        assert request.role == "user"

    def test_short_password_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            CreateUserRequest(name="Ada", email="ada@example.com", password="short")
        assert any(e["type"] == "string_too_short" for e in exc_info.value.errors())

    def test_empty_password_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreateUserRequest(name="Ada", email="ada@example.com", password="")

    def test_password_over_seventy_two_bytes_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            CreateUserRequest(name="Ada", email="ada@example.com", password="x" * 73)
        assert "at most 72 bytes" in str(exc_info.value.errors())

    def test_password_over_seventy_two_bytes_rejected_even_when_few_characters(
        self,
    ) -> None:
        # 40 characters clears the 8-character floor, but is 80 bytes —
        # bcrypt's input limit is counted in bytes, so the schema counts
        # bytes too.
        with pytest.raises(ValidationError) as exc_info:
            CreateUserRequest(name="Ada", email="ada@example.com", password="é" * 40)
        assert "at most 72 bytes" in str(exc_info.value.errors())

    def test_password_of_exactly_seventy_two_bytes_accepted(self) -> None:
        request = CreateUserRequest(
            name="Ada", email="ada@example.com", password="é" * 36
        )
        assert request.password == "é" * 36

    def test_bad_email_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreateUserRequest(name="Ada", email="not-an-email", password="good-pass-1")

"""Failed password sign-ins are counted, with nothing about who.

A wrong password and an unknown email count alike; a correct one and a
refused-by-config one don't.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import hash_password
from switch_core.gateway.auth_routes import router
from switch_core.keys import Keyring
from switch_core.observability.catalogue import AUTH_SIGN_IN_FAILURES
from switch_core.observability.metrics import MetricsRegistry, install, uninstall

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_PASSWORD = "right-password-1"
_USER_STORE = UserStore()


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    installed = MetricsRegistry()
    install(installed)
    yield installed
    uninstall()


def _app(
    session_factory: async_sessionmaker[AsyncSession], *, password_login: bool = True
) -> FastAPI:
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
        gateway_password_login_enabled=password_login,
        gateway_tenant_choice_enabled=False,
    )
    return app


async def _seed_user(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(
            name="Ada",
            email="ada@example.invalid",
            role="user",
            password_hash=hash_password(_PASSWORD),
        )
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


def _failures(registry: MetricsRegistry) -> list[tuple[dict, float]]:
    return [
        (dict(point.attributes), point.value)
        for payload in registry.collect()
        if payload.name == AUTH_SIGN_IN_FAILURES.name
        for point in payload.numbers
    ]


async def _sign_in(app: FastAPI, email: str, password: str) -> int:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/auth/login", json={"email": email, "password": password}
        )
    return response.status_code


async def test_wrong_passwords_and_unknown_emails_are_counted_without_attributes(
    session_factory: async_sessionmaker[AsyncSession], registry: MetricsRegistry
) -> None:
    await _seed_user(session_factory)
    app = _app(session_factory)

    assert await _sign_in(app, "ada@example.invalid", "wrong-password-1") == 401
    assert await _sign_in(app, "nobody@example.invalid", _PASSWORD) == 401
    assert await _sign_in(app, "ada@example.invalid", _PASSWORD) == 200

    assert _failures(registry) == [({}, 2.0)]


async def test_nothing_is_counted_when_password_sign_in_is_off(
    session_factory: async_sessionmaker[AsyncSession], registry: MetricsRegistry
) -> None:
    await _seed_user(session_factory)
    app = _app(session_factory, password_login=False)

    assert await _sign_in(app, "ada@example.invalid", "wrong-password-1") == 403

    assert _failures(registry) == []

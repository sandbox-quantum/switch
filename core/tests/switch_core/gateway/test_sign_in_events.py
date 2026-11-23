"""Password sign-ins as security events: a success is a server audit event,
a failure a log-only event that names the account only by id."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import ServerAuditEvent, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import hash_password
from switch_core.gateway.auth_routes import router
from switch_core.keys import Keyring
from switch_core.logging_context import structured_fields
from switch_core.security_events import LOGGER_NAME as SECURITY_LOGGER_NAME
from tests.switch_core.gateway.login_limit_defaults import LOGIN_LIMIT_DEFAULTS

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_PASSWORD = "right-password-1"
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


async def _seed_user(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(
            name="Ada",
            email=_EMAIL,
            role="user",
            password_hash=hash_password(_PASSWORD),
        )
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


async def _sign_in(app: FastAPI, email: str, password: str) -> int:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("203.0.113.7", 4000)),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/auth/login", json={"email": email, "password": password}
        )
    return response.status_code


def _security(caplog: pytest.LogCaptureFixture) -> list[dict]:
    return [
        structured_fields(record)
        for record in caplog.records
        if record.name == SECURITY_LOGGER_NAME
    ]


async def test_failed_sign_ins_are_logged_by_account_id_never_email(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=SECURITY_LOGGER_NAME)
    user_id = await _seed_user(session_factory)
    app = _app(session_factory)

    assert await _sign_in(app, _EMAIL, "wrong-password-1") == 401
    assert await _sign_in(app, "nobody@example.invalid", _PASSWORD) == 401

    wrong, unknown = _security(caplog)
    assert wrong["switch"]["event"] == "security.auth.sign_in_failed"
    assert wrong["switch"]["scope"] == "log"
    assert wrong["switch"]["target_id"] == user_id
    assert wrong["security_details"] == {
        "method": "password",
        "reason": "wrong_password",
        "client_ip": "203.0.113.7",
    }
    assert unknown["switch"]["target_id"] is None
    assert unknown["security_details"]["reason"] == "unknown_account"
    assert "example.invalid" not in json.dumps([wrong, unknown])
    async with session_factory() as session:
        assert (await session.execute(select(ServerAuditEvent))).scalars().all() == []


async def test_a_sign_in_is_a_server_audit_event(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=SECURITY_LOGGER_NAME)
    user_id = await _seed_user(session_factory)

    assert await _sign_in(_app(session_factory), _EMAIL, _PASSWORD) == 200

    async with session_factory() as session:
        [event] = (await session.execute(select(ServerAuditEvent))).scalars().all()
    assert event.action == ServerAuditAction.USER_SIGNED_IN
    assert event.actor_user_id == user_id
    assert event.target_id == user_id
    assert event.details is not None
    assert event.details["method"] == "password"
    assert event.details["client_ip"] == "203.0.113.7"
    [logged] = _security(caplog)
    assert logged["switch"]["event"] == "security.user.signed_in"
    assert logged["switch"]["scope"] == "server"

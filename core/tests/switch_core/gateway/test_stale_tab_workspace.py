"""A dashboard tab left open after another tab switched workspace must not
write into the new workspace while still showing the old.

The session's workspace is a claim in the cookie every tab shares. The
dashboard names the workspace its page shows in `X-Switch-Workspace` on every
write, and `get_current_user` refuses a write whose header names another
workspace than the one the session binds, with a 409 the dashboard shows. A
request without the header (Switch Console, an older dashboard) is bound as it
always was, and a read goes ahead whatever the header says.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, Tenant, TenantMember, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    WORKSPACE_HEADER,
    WORKSPACE_MISMATCH,
    create_jwt,
    get_current_user,
)
from switch_core.keys import Keyring
from switch_core.organization_directory import LocalDirectory

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
SECOND = "stale-tab-second"


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_organization_directory] = lambda: (
        LocalDirectory()
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING, gateway_tenant_choice_enabled=False
    )

    @app.get("/thing")
    async def read(user: Annotated[User, Depends(get_current_user)]) -> dict:
        return {"user_id": user.id}

    @app.post("/thing")
    async def write(user: Annotated[User, Depends(get_current_user)]) -> dict:
        return {"user_id": user.id}

    return app


async def _session_in_second(
    session_factory: async_sessionmaker[AsyncSession],
) -> str:
    """A session cookie for someone in Default and Second, which the session
    has switched to."""
    async with session_factory() as session:
        session.add(Tenant(id=SECOND, slug=SECOND, name="Second"))
        await session.flush()
        user = User(name="two-tabs", email="two-tabs@example.invalid", role="user")
        session.add(user)
        await session.flush()
        for tenant_id in (TENANT_ZERO_ID, SECOND):
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=user.id, role="member")
            )
        await session.commit()
        user_id = user.id
    return create_jwt(
        user_id,
        "two-tabs@example.invalid",
        "user",
        _KEYRING,
        SECOND,
        session_version=0,
        auth_time=datetime.now(UTC),
    )


def _client(app: FastAPI, token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def test_a_write_from_a_tab_showing_another_workspace_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = await _session_in_second(session_factory)
    async with _client(_app(session_factory), token) as client:
        response = await client.post(
            "/thing", headers={WORKSPACE_HEADER: TENANT_ZERO_ID}
        )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["error"] == WORKSPACE_MISMATCH
    assert detail["message"] == (
        "This tab is showing another workspace. Reload to continue."
    )


async def test_a_write_from_a_tab_showing_the_sessions_workspace_goes_ahead(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = await _session_in_second(session_factory)
    async with _client(_app(session_factory), token) as client:
        response = await client.post("/thing", headers={WORKSPACE_HEADER: SECOND})

    assert response.status_code == 200, response.text


async def test_a_write_naming_no_workspace_goes_ahead(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = await _session_in_second(session_factory)
    async with _client(_app(session_factory), token) as client:
        response = await client.post("/thing")

    assert response.status_code == 200, response.text


async def test_a_read_from_a_tab_showing_another_workspace_goes_ahead(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = await _session_in_second(session_factory)
    async with _client(_app(session_factory), token) as client:
        response = await client.get(
            "/thing", headers={WORKSPACE_HEADER: TENANT_ZERO_ID}
        )

    assert response.status_code == 200, response.text

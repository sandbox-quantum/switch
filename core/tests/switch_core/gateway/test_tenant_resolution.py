"""Tenant resolution for the gateway (CHOO-2623): a request binds the tenant
of the *user*, from their membership row — never a guess, never a request
parameter.

`TestGetSoleTenantId` covers `TenantMemberStore.get_sole_tenant_id` raising
rather than picking a tenant when a user's memberships aren't exactly one.
`TestAGatewayRequestBindsTheCallersTenant` drives a real HTTP request through
`get_current_user` end to end — cookie in, `app.tenant_id` on the database
session out — the same way `test_reference_types_routes.py` builds a
route-scoped app rather than the process-global `init_dependencies`, so nothing
here leaks into another test.

Uses `httpx.AsyncClient` over `ASGITransport` rather than
`fastapi.testclient.TestClient`: the sync `TestClient` runs the app in a
separate thread with its own event loop, and the `session_factory` fixture's
connections belong to this test's loop — crossing that boundary is a real bug
class of its own (asyncpg futures tied to the wrong loop), not something to
paper over here.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, Tenant, TenantMember, User
from switch_core.db.stores.tenant_member_store import (
    TenantMembershipError,
    TenantMemberStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt, get_current_user

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
TENANT_B = "tenant-resolution-b"


class TestGetSoleTenantId:
    async def test_raises_when_the_user_has_no_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TenantMemberStore()
        async with session_factory() as session:
            user = User(name="orphan", email="orphan@example.invalid", role="user")
            session.add(user)
            await session.flush()

            with pytest.raises(TenantMembershipError):
                await store.get_sole_tenant_id(session, user.id)

    async def test_raises_when_the_user_has_more_than_one_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TenantMemberStore()
        async with session_factory() as session:
            user = User(name="dual", email="dual@example.invalid", role="user")
            session.add(user)
            await session.flush()
            session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
            await session.flush()
            session.add_all(
                [
                    TenantMember(
                        tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"
                    ),
                    TenantMember(tenant_id=TENANT_B, user_id=user.id, role="member"),
                ]
            )
            await session.flush()

            with pytest.raises(TenantMembershipError):
                await store.get_sole_tenant_id(session, user.id)

    async def test_returns_the_one_tenant_a_user_belongs_to(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TenantMemberStore()
        async with session_factory() as session:
            user = User(name="single", email="single@example.invalid", role="user")
            session.add(user)
            await session.flush()
            session.add(
                TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member")
            )
            await session.flush()

            assert await store.get_sole_tenant_id(session, user.id) == TENANT_ZERO_ID


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    """A route-scoped app: real `get_current_user`, everything it depends on
    stubbed to the shared test database rather than through
    `init_dependencies` (see `test_reference_types_routes.py`'s `_app`)."""

    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_tenant_member_store] = lambda: (
        TenantMemberStore()
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET
    )

    @app.get("/whoami")
    async def whoami(
        user: Annotated[User, Depends(get_current_user)],
        session: Annotated[AsyncSession, Depends(gw_deps.get_session)],
    ) -> dict:
        row = await session.execute(
            text("SELECT current_setting('app.tenant_id', true)")
        )
        return {"user_id": user.id, "db_tenant_id": row.scalar_one() or None}

    return app


class TestAGatewayRequestBindsTheCallersTenant:
    async def test_the_sessions_tenant_matches_the_users_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store = UserStore()
        async with session_factory() as session:
            user = User(name="Ada", email="ada@example.invalid", role="user")
            # UserStore.create also inserts the tenant_members row — see its
            # docstring — landing this user in tenant zero, since no request
            # context is bound while seeding it here.
            await user_store.create(session, user)
            await session.commit()
            user_id = user.id

        token = create_jwt(user_id, "ada@example.invalid", "user", _SECRET)
        transport = httpx.ASGITransport(app=_app(session_factory))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test", cookies={"switch_auth": token}
        ) as client:
            response = await client.get("/whoami")

        assert response.status_code == 200
        body = response.json()
        assert body["user_id"] == user_id
        assert body["db_tenant_id"] == TENANT_ZERO_ID

    async def test_a_request_with_no_cookie_is_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport = httpx.ASGITransport(app=_app(session_factory))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            response = await client.get("/whoami")

        assert response.status_code == 401

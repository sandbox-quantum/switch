"""Tenant resolution for the gateway (CHOO-2623): a request binds the tenant
of the *user*, from their membership row — never a guess, never a request
parameter.

`TestGetSoleTenantId` covers `TenantMemberStore.get_sole_tenant_id` raising
rather than picking a tenant when a user's memberships aren't exactly one.
`TestAGatewayRequestBindsTheCallersTenant` drives a real HTTP request through
`get_current_user` end to end — cookie in, `app.tenant_id` on the database
session out — the same way `test_reference_types_routes.py` builds a
route-scoped app rather than the process-global `init_dependencies`, so nothing
here leaks into another test. `TestConcurrentRequests` runs two of those at
once, in different tenants, because the whole design rests on one request's
tenant being invisible to another.

Uses `httpx.AsyncClient` over `ASGITransport` rather than
`fastapi.testclient.TestClient`: the sync `TestClient` runs the app in a
separate thread with its own event loop, and the `session_factory` fixture's
connections belong to this test's loop — crossing that boundary is a real bug
class of its own (asyncpg futures tied to the wrong loop), not something to
paper over here.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from switch_core.db.base import Base
from switch_core.db.engine import create_session_factory
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
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
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
        hold: float = 0.0,
    ) -> dict:
        first = await _session_tenant(session)
        # `hold` lets a caller keep this request inside its transaction while
        # another one runs, so the second read below happens with both in
        # flight rather than one after the other.
        await asyncio.sleep(hold)
        return {
            "user_id": user.id,
            "db_tenant_id": first,
            "db_tenant_id_after": await _session_tenant(session),
        }

    return app


async def _session_tenant(session: AsyncSession) -> str | None:
    row = await session.execute(text("SELECT current_setting('app.tenant_id', true)"))
    return row.scalar_one() or None


def _client(app: FastAPI, token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _make_user(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    name: str,
    tenant_id: str,
) -> str:
    """A user with exactly one membership, in `tenant_id`."""
    async with session_factory() as session:
        if tenant_id != TENANT_ZERO_ID:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            await session.flush()
        user = User(name=name, email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role="member"))
        await session.commit()
        return user.id


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
        async with _client(_app(session_factory), token) as client:
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


class TestAUserWithNoMembership:
    """The failure has no current cause — every creation path leaves a
    membership — but it must be legible if one ever appears, rather than the
    opaque 500 an uncaught `TenantMembershipError` produces."""

    async def test_the_response_is_403_and_names_no_user_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Inserted directly, not through UserStore.create, precisely because
        # that would give them the membership this test needs them to lack.
        async with session_factory() as session:
            user = User(name="orphan", email="orphan@example.invalid", role="user")
            session.add(user)
            await session.commit()
            user_id = user.id

        token = create_jwt(user_id, "orphan@example.invalid", "user", _SECRET)
        async with _client(_app(session_factory), token) as client:
            response = await client.get("/whoami")

        assert response.status_code == 403
        detail = response.json()["detail"]
        assert "tenant" in detail
        assert user_id not in detail


class TestConcurrentRequests:
    async def test_two_requests_in_different_tenants_do_not_see_each_other(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        zero_user = await _make_user(
            session_factory, name="inzero", tenant_id=TENANT_ZERO_ID
        )
        b_user = await _make_user(session_factory, name="inb", tenant_id=TENANT_B)
        app = _app(session_factory)

        async def _call(user_id: str, name: str) -> dict:
            token = create_jwt(user_id, f"{name}@example.invalid", "user", _SECRET)
            async with _client(app, token) as client:
                response = await client.get("/whoami", params={"hold": 0.2})
            assert response.status_code == 200, response.text
            return response.json()

        # Both are inside their own transaction for the whole `hold`, so the
        # second read in each happens while the other request is live. A
        # tenant that leaked — through the contextvar or through a shared
        # connection — would show up there.
        in_zero, in_b = await asyncio.gather(
            _call(zero_user, "inzero"), _call(b_user, "inb")
        )

        assert in_zero["db_tenant_id"] == TENANT_ZERO_ID
        assert in_zero["db_tenant_id_after"] == TENANT_ZERO_ID
        assert in_b["db_tenant_id"] == TENANT_B
        assert in_b["db_tenant_id_after"] == TENANT_B


@pytest_asyncio.fixture
async def one_connection_session_factory(
    postgres_url: str,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """A pool of exactly one connection, and a short timeout for waiting on it.

    Makes "how many connections does a request hold at once?" an assertion
    rather than an inspection: a request needing two deadlocks against itself
    and fails on the timeout instead of quietly halving pool capacity in
    production.
    """
    engine = create_async_engine(
        postgres_url, pool_size=1, max_overflow=0, pool_timeout=5
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(
            insert(Tenant.__table__).values(
                id=TENANT_ZERO_ID, slug="default", name="Default"
            )
        )
    try:
        yield create_session_factory(engine)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


class TestARequestHoldsOneConnection:
    """Tenant resolution's session is opened and closed inside
    `get_current_user`, before the request's own session is touched, so an
    authenticated request never holds two pooled connections at once.

    Held as a yield dependency instead — the shape this replaced — the
    resolution session would keep its connection, idle in a transaction
    nothing ever ends, for the whole request. On a pool of one that is a
    deadlock; on a real pool it is half the capacity and every request one
    `idle_in_transaction_session_timeout` away from failing.
    """

    async def test_an_authenticated_request_completes_on_a_pool_of_one(
        self, one_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user(
            one_connection_session_factory, name="solo", tenant_id=TENANT_ZERO_ID
        )
        token = create_jwt(user_id, "solo@example.invalid", "user", _SECRET)

        async with _client(_app(one_connection_session_factory), token) as client:
            response = await client.get("/whoami")

        assert response.status_code == 200, response.text
        assert response.json()["db_tenant_id"] == TENANT_ZERO_ID

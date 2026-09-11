"""Tenant resolution for the gateway (CHOO-2623, CHOO-2723): a request binds a
tenant of the *user*, from a membership row — never a guess, never a request
parameter.

`_resolve_tenant_id` (`gateway/auth.py`) implements the five cases from
`docs/old/multi-tenancy-phase2-tenants.md`, §4, in order: a tenant claim with a
matching membership binds it; a claim naming no membership is refused; no
claim with exactly one membership binds it; no claim with several is a 409
listing them when `GATEWAY_TENANT_CHOICE_ENABLED` is set, otherwise the same
403 every multi-membership account got before this phase; no memberships at
all is a 403. `TestAGatewayRequestBindsTheCallersTenant` and the classes below
drive real HTTP requests through `get_current_user` end to end — cookie in,
`app.tenant_id` on the database session out — the same way
`test_reference_types_routes.py` builds a route-scoped app rather than the
process-global `init_dependencies`, so nothing here leaks into another test.
`TestConcurrentRequests` runs two of those at once, in different tenants,
because the whole design rests on one request's tenant being invisible to
another.

`TestListTenantsEndpoint` and `TestSwitchTenantEndpoint` cover
`gateway/tenants.py`'s two routes (§5, §7): listing a caller's own tenants
without binding one, and re-minting the cookie once they pick one.
`TestTenantListingHoldsOneConnectionAtATime` is the one pinned in the design
by name — §7 rejects looping bound sessions from inside a request that
already holds a connection open, and this proves `list_tenant_memberships`
does not do that, on the same pool-of-one shape as
`TestARequestHoldsOneConnection` below.

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
import pytest_asyncio
from fastapi import Depends, FastAPI
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from switch_core.db.base import Base
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, Tenant, TenantMember, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt, get_current_user
from switch_core.gateway.tenants import router as tenants_router

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
TENANT_B = "tenant-resolution-b"
NOT_A_MEMBER_TENANT = "tenant-resolution-not-a-member"


def _app(
    session_factory: async_sessionmaker[AsyncSession], *, choice_enabled: bool = False
) -> FastAPI:
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
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET, gateway_tenant_choice_enabled=choice_enabled
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


def _tenants_app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    """A route-scoped app for `gateway/tenants.py`'s routes, with the same
    stubbing approach as `_app` above."""

    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(tenants_router)
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
    )
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


async def _make_user_with_memberships(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    name: str,
    tenant_ids: list[str],
) -> str:
    """A user with one membership in each of `tenant_ids`, creating whichever
    of them isn't tenant zero."""
    async with session_factory() as session:
        for tenant_id in tenant_ids:
            if tenant_id != TENANT_ZERO_ID:
                session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
                await session.flush()
        user = User(name=name, email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        for tenant_id in tenant_ids:
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=user.id, role="member")
            )
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

        token = create_jwt(user_id, "ada@example.invalid", "user", _SECRET, None)
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


class TestAClaimSelectsAMembership:
    """Case 1 and case 2 of `_resolve_tenant_id`: a tenant claim binds if it
    names a membership, and is refused otherwise — the claim never widens
    what the caller may see beyond what a live membership row already grants
    (CHOO-2723)."""

    async def test_a_claim_binds_even_with_several_memberships(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The exact case blanket 403 used to refuse outright: two
        memberships, resolved by the claim rather than guessed at."""
        user_id = await _make_user_with_memberships(
            session_factory, name="claimant", tenant_ids=[TENANT_ZERO_ID, TENANT_B]
        )
        token = create_jwt(
            user_id, "claimant@example.invalid", "user", _SECRET, TENANT_B
        )

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/whoami")

        assert response.status_code == 200, response.text
        assert response.json()["db_tenant_id"] == TENANT_B

    async def test_a_claim_naming_no_membership_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user(
            session_factory, name="mismatched", tenant_id=TENANT_ZERO_ID
        )
        token = create_jwt(
            user_id, "mismatched@example.invalid", "user", _SECRET, NOT_A_MEMBER_TENANT
        )

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/whoami")

        assert response.status_code == 403
        assert "tenant" in response.json()["detail"]
        # The cookie is `lax`, so a cross-site navigation can reach this path;
        # clearing someone's selection off the back of a stale or forged
        # claim would be worse than just refusing (§4 of the design doc).
        assert "set-cookie" not in response.headers


class TestNoClaimWithSeveralMemberships:
    """Case 4: behind `GATEWAY_TENANT_CHOICE_ENABLED`. Off, a multi-membership
    account with no selection gets exactly the 403 every account got before
    this phase — nobody who could sign in before is broken by it shipping. On,
    it gets the list to choose from instead of a guess."""

    async def test_flag_off_is_the_same_403_as_before(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user_with_memberships(
            session_factory, name="undecided", tenant_ids=[TENANT_ZERO_ID, TENANT_B]
        )
        token = create_jwt(user_id, "undecided@example.invalid", "user", _SECRET, None)

        async with _client(
            _app(session_factory, choice_enabled=False), token
        ) as client:
            response = await client.get("/whoami")

        assert response.status_code == 403
        assert "tenant" in response.json()["detail"]

    async def test_flag_on_is_409_with_the_choices(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user_with_memberships(
            session_factory, name="chooser", tenant_ids=[TENANT_ZERO_ID, TENANT_B]
        )
        token = create_jwt(user_id, "chooser@example.invalid", "user", _SECRET, None)

        async with _client(_app(session_factory, choice_enabled=True), token) as client:
            response = await client.get("/whoami")

        assert response.status_code == 409
        tenant_ids = {choice["id"] for choice in response.json()["detail"]}
        assert tenant_ids == {TENANT_ZERO_ID, TENANT_B}


class TestAUserWithNoMembership:
    """The failure has no current cause — every creation path leaves a
    membership — but it must be legible if one ever appears, rather than the
    opaque 500 an uncaught error would produce."""

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

        token = create_jwt(user_id, "orphan@example.invalid", "user", _SECRET, None)
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
            token = create_jwt(
                user_id, f"{name}@example.invalid", "user", _SECRET, None
            )
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


class TestListTenantsEndpoint:
    async def test_lists_every_tenant_the_caller_belongs_to(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user_with_memberships(
            session_factory, name="lister", tenant_ids=[TENANT_ZERO_ID, TENANT_B]
        )
        token = create_jwt(user_id, "lister@example.invalid", "user", _SECRET, None)

        async with _client(_tenants_app(session_factory), token) as client:
            response = await client.get("/tenants")

        assert response.status_code == 200, response.text
        by_id = {row["id"]: row for row in response.json()}
        assert set(by_id) == {TENANT_ZERO_ID, TENANT_B}
        assert by_id[TENANT_ZERO_ID]["role"] == "member"
        assert by_id[TENANT_B]["slug"] == TENANT_B

    async def test_a_caller_with_no_selection_can_still_list(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The whole point of authenticating this route independently of
        `get_current_user`: a multi-membership caller with no claim cannot
        pass `get_current_user` at all, but must still be able to reach this
        list in order to pick one."""
        user_id = await _make_user_with_memberships(
            session_factory, name="undecided2", tenant_ids=[TENANT_ZERO_ID, TENANT_B]
        )
        token = create_jwt(user_id, "undecided2@example.invalid", "user", _SECRET, None)

        async with _client(_tenants_app(session_factory), token) as client:
            response = await client.get("/tenants")

        assert response.status_code == 200
        assert {row["id"] for row in response.json()} == {TENANT_ZERO_ID, TENANT_B}


class TestSwitchTenantEndpoint:
    async def test_switching_reminds_the_cookie_with_the_new_claim(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user_with_memberships(
            session_factory, name="switcher", tenant_ids=[TENANT_ZERO_ID, TENANT_B]
        )
        token = create_jwt(user_id, "switcher@example.invalid", "user", _SECRET, None)

        async with _client(_tenants_app(session_factory), token) as client:
            response = await client.post(f"/tenants/{TENANT_B}/switch")

        assert response.status_code == 200, response.text
        assert response.json()["id"] == user_id
        set_cookie = response.headers.get("set-cookie")
        assert set_cookie is not None and "switch_auth=" in set_cookie

    async def test_switching_to_a_tenant_you_do_not_belong_to_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user(
            session_factory, name="notmember", tenant_id=TENANT_ZERO_ID
        )
        token = create_jwt(user_id, "notmember@example.invalid", "user", _SECRET, None)

        async with _client(_tenants_app(session_factory), token) as client:
            response = await client.post(f"/tenants/{TENANT_B}/switch")

        assert response.status_code == 403


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
        token = create_jwt(user_id, "solo@example.invalid", "user", _SECRET, None)

        async with _client(_app(one_connection_session_factory), token) as client:
            response = await client.get("/whoami")

        assert response.status_code == 200, response.text
        assert response.json()["db_tenant_id"] == TENANT_ZERO_ID


class TestTenantListingHoldsOneConnectionAtATime:
    """§7, pinned the same way as `TestARequestHoldsOneConnection` above: a
    caller with several tenants to list must never need two pooled
    connections open at once to see them.

    This is the test the design calls out as most likely to be written so it
    cannot fail: a fixture that merely *builds* a pool of one proves nothing
    by itself unless the work under test would actually need two connections
    at the same moment to satisfy it. Two memberships are the minimum that
    makes that possible — `list_tenant_memberships` reading them one tenant
    at a time, sequentially, is exactly what keeps this passing on a pool of
    one rather than timing out.
    """

    async def test_listing_two_tenants_completes_on_a_pool_of_one(
        self, one_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_user_with_memberships(
            one_connection_session_factory,
            name="poolsolo",
            tenant_ids=[TENANT_ZERO_ID, TENANT_B],
        )
        token = create_jwt(user_id, "poolsolo@example.invalid", "user", _SECRET, None)

        async with _client(
            _tenants_app(one_connection_session_factory), token
        ) as client:
            response = await client.get("/tenants")

        assert response.status_code == 200, response.text
        assert {row["id"] for row in response.json()} == {TENANT_ZERO_ID, TENANT_B}

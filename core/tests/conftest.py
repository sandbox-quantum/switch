from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

import pytest
import pytest_asyncio
from sqlalchemy import insert, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from testcontainers.postgres import PostgresContainer

# Importing the models module registers every table on Base.metadata so
# create_all provisions the full schema (rooms, room_groups, FKs, …).
import switch_core.db.models  # noqa: F401
from switch_core.db.base import Base
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, Tenant
from switch_core.tenant_context import bind_tenant_id, unbind_tenant_id


async def _seed_tenant_zero(conn: AsyncConnection) -> None:
    """Insert the one tenant every scoped row's `tenant_id` default points at.

    Every scoped table's `tenant_id` FK requires a matching `tenants` row, so
    this must run right after the schema exists.
    """
    await conn.execute(
        insert(Tenant.__table__).values(
            id=TENANT_ZERO_ID, slug="default", name="Default"
        )
    )


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    """A throwaway PostgreSQL instance for the whole test session.

    Store tests run against real Postgres (not SQLite/mocks) so behaviours like
    `ON DELETE SET NULL` and check constraints are exercised for real.
    """
    with PostgresContainer("postgres:16-alpine") as pg:
        host = pg.get_container_host_ip()
        port = pg.get_exposed_port(5432)
        yield (
            f"postgresql+asyncpg://{pg.username}:{pg.password}"
            f"@{host}:{port}/{pg.dbname}"
        )


@pytest_asyncio.fixture
async def session_factory(
    postgres_url: str, request: pytest.FixtureRequest
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """Fresh schema per test: create all tables, yield a session factory, drop.

    Also binds tenant zero for the duration of the test, unless the test is
    marked `no_ambient_tenant`. In production a tenant is always bound before
    store code runs — an authenticated request, or one of the background call
    sites `db/session_scope.py` covers — so a store method is never called
    with nothing bound outside a deliberately unscoped path. Most of this
    suite constructs scoped rows directly rather than through a request,
    though, so without this default they would be calling those methods with
    nothing bound — not a scenario the design means to exercise, and not what
    any of these tests are about.

    The marker exists for the tests that *are* about exactly that: a test
    asserting what is or is not bound before, after or around a call — the
    tenant-context machinery itself, not a store — needs `current_tenant_id()`
    to start `None`, and this default would otherwise stand in its way. A test
    doing ordinary multi-tenant work instead binds its own (`tenant_scope`,
    `tenant_session`, `no_tenant`) over the part it cares about, which simply
    overrides this default for that block — only the "nothing bound at all,
    including before I do anything" assertions need the marker.
    """
    engine = create_async_engine(postgres_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _seed_tenant_zero(conn)
    token = (
        None
        if request.node.get_closest_marker("no_ambient_tenant")
        else bind_tenant_id(TENANT_ZERO_ID)
    )
    try:
        # Goes through the same factory constructor production wiring uses,
        # so this fixture — which backs most of the store test suite — differs
        # from production in as little as possible.
        yield create_session_factory(engine)
    finally:
        if token is not None:
            unbind_tenant_id(token)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@dataclass(frozen=True)
class RLSHarness:
    """Two ways into the same database, for row-level-security tests that
    need both (CHOO-2623).

    `owner` connects the same way `session_factory` above does — as the
    container's superuser, which bypasses every policy by ownership, the same
    hatch a real system session relies on (see the design doc's "bootstrap
    problem" section). Test setup uses it to create cross-tenant fixture data
    no tenant-scoped session could ever legitimately write: a new `tenants`
    row, for one, since its own policy compares on `id` — inserting tenant B
    while bound to tenant A can never satisfy `with check`, and inserting it
    unscoped can never satisfy `using` either, because creating a tenant is
    necessarily a system operation.

    `restricted` is the role the policies actually apply to: every assertion
    about isolation is made through it, never through `owner` or the plain
    `session_factory` fixture, both of which would pass regardless of whether
    a single policy in `db/rls_ddl.py` exists.
    """

    owner: async_sessionmaker[AsyncSession]
    restricted: async_sessionmaker[AsyncSession]


@pytest_asyncio.fixture
async def rls_harness(postgres_url: str) -> AsyncIterator[RLSHarness]:
    """A session factory connected as a role row-level security applies to.

    `session_factory` connects as the container's superuser — the same shape
    local Compose, the chart and the test containers all use today — and **a
    superuser ignores row-level security unconditionally**. A test built only
    on that fixture cannot tell a working policy from a schema with none, so
    `docs/old/multi-tenancy-phase1-db.md`'s "Done when" is unreachable without
    something else.

    This is that something else. Per test, it builds the schema (so
    `create_all` attaches the same policies a migration would, exactly as
    `session_factory` does), seeds tenant zero, and creates a throwaway login
    role that is not the owner (so it doesn't inherit the owner's blanket
    exemption from its own tables' policies), not a superuser, and carries no
    `BYPASSRLS`. It is granted exactly what a restricted runtime role would
    need — CRUD on the schema's tables and `EXECUTE` on `require_tenant_id()`
    — and nothing else: deliberately the same shape `docs/old/multi-tenancy-
    phase1-db.md`'s "runtime role" section describes for the real deployment
    role this phase does not create. Creating it only here, inside a test
    fixture, is what that section calls out as the one place Phase 1 does
    keep a restricted role.

    Only the tests that exist to prove the policies correct ask for this
    fixture — the rest of the suite keeps using `session_factory` exactly as
    it does today. What this proves, and what it does not: it proves the
    *policies* are correct, that a session subject to them cannot cross a
    tenant boundary through the ordinary store layer. It does not prove the
    *deployment* is subject to them, since nothing here changes which role
    local Compose, the chart or production connect as — that is the separate
    role work (CHOO-2685); until it lands, a superuser or table-owner
    connection bypasses every policy below regardless of what this fixture
    demonstrates.
    """
    owner_engine = create_async_engine(postgres_url)
    role = f"switch_rls_test_{uuid.uuid4().hex[:12]}"
    password = uuid.uuid4().hex

    async with owner_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _seed_tenant_zero(conn)
        # CREATE ROLE does not accept a bind parameter for PASSWORD (it is not
        # a normal DML statement), so the password is interpolated directly.
        # It is a fresh, random, throwaway value scoped to this one test.
        await conn.execute(
            text(
                f"CREATE ROLE \"{role}\" LOGIN PASSWORD '{password}' "
                "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
            )
        )
        await conn.execute(text(f'GRANT USAGE ON SCHEMA public TO "{role}"'))
        await conn.execute(
            text(
                "GRANT SELECT, INSERT, UPDATE, DELETE "
                f'ON ALL TABLES IN SCHEMA public TO "{role}"'
            )
        )
        await conn.execute(
            text(f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "{role}"')
        )
        await conn.execute(
            text(f'GRANT EXECUTE ON FUNCTION require_tenant_id() TO "{role}"')
        )

    restricted_url = make_url(postgres_url).set(username=role, password=password)
    restricted_engine = create_async_engine(restricted_url)
    try:
        yield RLSHarness(
            owner=create_session_factory(owner_engine),
            restricted=create_session_factory(restricted_engine),
        )
    finally:
        await restricted_engine.dispose()
        async with owner_engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        async with owner_engine.begin() as conn:
            # Dropping the tables removes their own grants with them, but the
            # schema-level `GRANT USAGE` survives — `DROP OWNED BY` revokes
            # every privilege still granted to the role (it owns no objects,
            # so there is nothing for it to drop), which is what lets `DROP
            # ROLE` succeed right after.
            await conn.execute(text(f'DROP OWNED BY "{role}"'))
            await conn.execute(text(f'DROP ROLE "{role}"'))
        await owner_engine.dispose()

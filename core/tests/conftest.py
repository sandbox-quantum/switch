from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

import pytest
import pytest_asyncio
from sqlalchemy import insert, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
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
from switch_core.db.runtime_role import grant_runtime_role
from switch_core.tenant_context import tenant_scope


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


# Every table, emptied in one statement. `CASCADE` is what lets a single
# TRUNCATE cover tables that reference each other, and `RESTART IDENTITY`
# keeps sequence-backed columns (`messages.seq`) starting where a test that
# hard-codes an expected value needs them to.
_TRUNCATE_ALL = (
    "TRUNCATE "
    + ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
    + " RESTART IDENTITY CASCADE"
)


async def empty_the_database(engine: AsyncEngine) -> None:
    """Leave the schema in place and take every row out of it, tenant zero apart.

    The state a test wants from `create_all` is an empty database, which
    building the schema from nothing is only one way to reach. Emptying it
    instead is the same starting point for a fraction of the DDL, and it is
    what every per-test fixture here uses.
    """
    async with engine.begin() as conn:
        await conn.execute(text(_TRUNCATE_ALL))
        await _seed_tenant_zero(conn)


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    """A throwaway PostgreSQL instance for the whole test session.

    Store tests run against real Postgres (not SQLite/mocks) so behaviours like
    `ON DELETE SET NULL` and check constraints are exercised for real.

    Durability is off. The container is deleted when the session ends, so a
    crash has nothing to recover to and every fsync it would perform is work
    thrown away — which matters here because the per-test reset is almost
    entirely write traffic. Nothing about the behaviour under test changes:
    these settings govern what survives a crash, not what a transaction sees.
    """
    container = PostgresContainer("postgres:16-alpine").with_command(
        "postgres -c fsync=off -c synchronous_commit=off -c full_page_writes=off"
    )
    with container as pg:
        host = pg.get_container_host_ip()
        port = pg.get_exposed_port(5432)
        yield (
            f"postgresql+asyncpg://{pg.username}:{pg.password}"
            f"@{host}:{port}/{pg.dbname}"
        )


@pytest.fixture(scope="session")
def postgres_schema(postgres_url: str) -> str:
    """The schema, built once for the whole session.

    Returns `postgres_url`: it is the same database, and asking for this
    fixture rather than that one is how a test says it wants the tables there.
    The tests that want a schema of their own — migration parity, the backfill
    migrations, the frozen-DDL comparison — create a separate database off
    `postgres_url` and are untouched by this.

    Synchronous, with an event loop of its own, because it has to outlive the
    per-test loop pytest-asyncio opens: the schema belongs to the container,
    not to any one test's loop, and the engine that builds it is disposed
    before the first test runs.
    """

    async def build() -> None:
        engine = create_async_engine(postgres_url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        finally:
            await engine.dispose()

    asyncio.run(build())
    return postgres_url


@pytest_asyncio.fixture
async def session_factory(
    postgres_schema: str, request: pytest.FixtureRequest
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """An empty database per test, on a schema built once for the session.

    Emptied on the way in rather than the way out, so a test that fails leaves
    its rows in the container for a `psql` to look at, and so the guarantee
    holds for the first test as much as for the rest.

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
    engine = create_async_engine(postgres_schema)
    await empty_the_database(engine)
    ambient_tenant = (
        contextlib.nullcontext()
        if request.node.get_closest_marker("no_ambient_tenant")
        else tenant_scope(TENANT_ZERO_ID)
    )
    try:
        with ambient_tenant:
            # Goes through the same factory constructor production wiring
            # uses, so this fixture — which backs most of the store test
            # suite — differs from production in as little as possible.
            yield create_session_factory(engine)
    finally:
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
    # The engines behind the two factories, for the boot self-check
    # (`db/runtime_role.verify_restricted_role`), which is asked of a
    # connection rather than of a session. Exposed rather than rebuilt in the
    # test so that what it inspects is the connection the assertions above
    # were made through.
    owner_engine: AsyncEngine
    restricted_engine: AsyncEngine


@pytest_asyncio.fixture
async def rls_harness(postgres_schema: str) -> AsyncIterator[RLSHarness]:
    """A session factory connected as a role row-level security applies to.

    `session_factory` connects as the container's superuser — the same shape
    local Compose, the chart and the test containers all use today — and **a
    superuser ignores row-level security unconditionally**. A test built only
    on that fixture cannot tell a working policy from a schema with none, so
    `docs/old/multi-tenancy-phase1-db.md`'s "Done when" is unreachable without
    something else.

    This is that something else. Per test, it empties the session's schema
    (built by `create_all`, so it carries the same policies a migration would
    attach, exactly as `session_factory` sees), and creates a throwaway login
    role that is not the owner (so it doesn't inherit the owner's blanket
    exemption from its own tables' policies), not a superuser, and carries no
    `BYPASSRLS`.

    **It is granted by `db/runtime_role.grant_runtime_role`, the same function
    boot runs against a real deployment**, rather than by a second list of
    grants written out here. That is deliberate: a fixture that granted more
    than production does would let a test pass on a privilege the deployment
    has not got, and one that granted less would fail for a reason the
    deployment never hits. Sharing the definition makes "the restricted role
    can do its job" a property this suite actually proves.

    Only the tests that exist to prove the policies correct ask for this
    fixture — the rest of the suite keeps using `session_factory` exactly as
    it does today, connected as the owner. What this proves and what it does
    not is worth stating: it proves the *policies* and the *exemption* are
    correct against a role they apply to. Whether the deployment connects as
    such a role is a separate question, asked at boot by
    `db/runtime_role.verify_restricted_role` rather than here, because CI has
    no production connection to ask it of.
    """
    owner_engine = create_async_engine(postgres_schema)
    role = f"switch_rls_test_{uuid.uuid4().hex[:12]}"
    password = uuid.uuid4().hex

    await empty_the_database(owner_engine)
    async with owner_engine.begin() as conn:
        # CREATE ROLE does not accept a bind parameter for PASSWORD (it is not
        # a normal DML statement), so the password is interpolated directly.
        # It is a fresh, random, throwaway value scoped to this one test.
        await conn.execute(
            text(
                f"CREATE ROLE \"{role}\" LOGIN PASSWORD '{password}' "
                "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
            )
        )
        await grant_runtime_role(conn, role)

    restricted_url = make_url(postgres_schema).set(username=role, password=password)
    restricted_engine = create_async_engine(restricted_url)
    try:
        yield RLSHarness(
            owner=create_session_factory(owner_engine),
            restricted=create_session_factory(restricted_engine),
            owner_engine=owner_engine,
            restricted_engine=restricted_engine,
        )
    finally:
        await restricted_engine.dispose()
        async with owner_engine.begin() as conn:
            # The tables outlive the test, so their grants to this role would
            # too. `DROP OWNED BY` revokes every privilege still held by the
            # role — the table grants and the schema-level `GRANT USAGE` alike
            # (it owns no objects, so there is nothing for it to drop) — which
            # is both what leaves the shared schema as it was found and what
            # lets `DROP ROLE` succeed right after.
            await conn.execute(text(f'DROP OWNED BY "{role}"'))
            await conn.execute(text(f'DROP ROLE "{role}"'))
            # `grant_runtime_role` also revokes PUBLIC's default EXECUTE on
            # functions, and that one is recorded against the *owner* rather
            # than against the throwaway role — so `DROP OWNED BY` above does
            # not touch it and it outlives this test, governing every function
            # every later test in the session creates. Left in place it makes
            # the checks about it pass for the wrong reason: the second test
            # to ask whether a new function is PUBLIC-executable would be
            # answered by the first test's leftover rather than by the grants
            # under test. Granting it back restores the built-in default,
            # which Postgres records by deleting the row.
            await conn.execute(
                text("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC")
            )
            # The same argument, for the schema itself rather than the default
            # privileges on it. The tests this fixture exists for break the
            # schema on purpose — forcing row level security, granting EXECUTE
            # back to PUBLIC — to watch the boot check refuse it, and the
            # schema now outlives them. Put it back the way `create_all`
            # leaves it: nothing forced, and PUBLIC holding the EXECUTE
            # Postgres grants on a new function. `grant_runtime_role` above
            # revokes that again for every test, so what the assertions run
            # against is unchanged.
            forced = (
                (
                    await conn.execute(
                        text(
                            "SELECT relname FROM pg_class c "
                            "JOIN pg_namespace n ON n.oid = c.relnamespace "
                            "WHERE c.relforcerowsecurity AND n.nspname = 'public'"
                        )
                    )
                )
                .scalars()
                .all()
            )
            for table in forced:
                await conn.execute(
                    text(f'ALTER TABLE "{table}" NO FORCE ROW LEVEL SECURITY')
                )
            await conn.execute(
                text("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC")
            )
        await owner_engine.dispose()

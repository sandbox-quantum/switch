"""Row-level security (CHOO-2623): the "Done when" tests from
`docs/old/multi-tenancy-phase1-db.md`.

Every test here runs through `rls_harness` (`tests/conftest.py`, alongside
`session_factory`), which connects as a throwaway role the policies actually
apply to — never `session_factory` itself, the superuser-backed fixture the
rest of the suite uses, which ignores every policy unconditionally and so
cannot tell a working policy from a schema with none.

What this file proves: a session subject to the policies cannot read, insert
into, or update into another tenant through the ordinary store layer, and a
session with no tenant bound gets an error rather than an empty (or worse,
partial) result. What it does not prove: that any real deployment connects as
such a role. Local Compose, the chart and the plain test containers all
connect as the owner today, which bypasses every policy below by ownership —
see `tests/conftest.py`'s `rls_harness` docstring and the design doc's
"runtime role" section.

**Verifying this file actually bites** (not automated; done once by hand when
this suite was written and worth repeating after touching `db/rls_ddl.py`):
weaken `create_policy_ddl`'s `WITH CHECK` clause to something permissive like
`WITH CHECK (true)` and rerun `TestWriteSideNeedsWithCheck` — the insert test
and the unqualified-update test should both fail. Omitting `WITH CHECK`
entirely does *not* demonstrate this: Postgres reuses `USING` as `WITH CHECK`
when none is given, which happens to still block both and would falsely look
like the tests caught nothing.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from types import ModuleType

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import insert, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker

import switch_core
from switch_core.db.base import Base
from switch_core.db.models import RoomGroup, Tenant
from switch_core.db.rls_ddl import (
    POLICY_NAME,
    REQUIRE_TENANT_FUNCTION_NAME,
    scoped_tables,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_group_store import RoomGroupStore
from tests.conftest import RLSHarness

_RLS_REVISION = "265ed188ad6f"


async def _make_tenant(owner: async_sessionmaker, tenant_id: str) -> None:
    async with owner() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()


def _tenant_pair() -> tuple[str, str]:
    return f"tenant-{uuid.uuid4().hex[:8]}", f"tenant-{uuid.uuid4().hex[:8]}"


class TestIsolationThroughTheStoreLayer:
    """The test the ticket closes on: two tenants, and tenant A cannot read
    tenant B's rows through the ordinary store layer — connected as a
    restricted role, through `RoomGroupStore`, not by hand-written SQL.
    `RoomGroupStore.get` does no tenant filtering of its own (a plain
    `session.get(RoomGroup, group_id)`), so row-level security is the only
    thing standing between tenant A and tenant B's row.
    """

    async def test_tenant_a_cannot_read_tenant_bs_row_by_id(
        self, rls_harness: RLSHarness
    ) -> None:
        tenant_a, tenant_b = _tenant_pair()
        await _make_tenant(rls_harness.owner, tenant_a)
        await _make_tenant(rls_harness.owner, tenant_b)

        store = RoomGroupStore()
        async with tenant_session(rls_harness.restricted, tenant_b) as session:
            group_b = await store.create(
                session,
                name="b-group",
                description=None,
                color=None,
                parent_group_id=None,
            )
            await session.commit()
            group_b_id = group_b.id

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            found = await store.get(session, group_b_id)

        assert found is None, (
            "tenant A's session read a row belonging to tenant B through "
            "RoomGroupStore.get — the policy's USING clause should have "
            "hidden it"
        )

    async def test_tenant_as_listing_never_includes_tenant_bs_rows(
        self, rls_harness: RLSHarness
    ) -> None:
        tenant_a, tenant_b = _tenant_pair()
        await _make_tenant(rls_harness.owner, tenant_a)
        await _make_tenant(rls_harness.owner, tenant_b)

        store = RoomGroupStore()
        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            await store.create(
                session,
                name="a-group",
                description=None,
                color=None,
                parent_group_id=None,
            )
            await session.commit()
        async with tenant_session(rls_harness.restricted, tenant_b) as session:
            await store.create(
                session,
                name="b-group",
                description=None,
                color=None,
                parent_group_id=None,
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            groups = await store.get_all(session)

        assert [g.tenant_id for g in groups] == [tenant_a], (
            "get_all issues no tenant filter of its own; a second tenant's "
            "row reaching this list means the policy let it through"
        )


class TestWriteSideNeedsWithCheck:
    """`USING` alone gates what a statement can *see*; it says nothing about
    what a statement is allowed to *write*. The gap is starkest on `INSERT`:
    there is no existing row for `USING` to filter, so a policy carrying only
    `USING` — or a `WITH CHECK` weakened to something like `true` — leaves an
    `INSERT` free to address any tenant at all. That is `with_check`'s job,
    and this is what "reintroducing a defect" (see the module docstring's
    verification note) actually bites: loosen `WITH CHECK` and this test is
    the one that turns red.

    `UPDATE` is the same gap, in two shapes that behave differently and are
    both pinned below. Postgres re-checks the updated row against `USING`
    only when the statement needs `SELECT` rights on the table — that is,
    when it carries a `WHERE` or a `RETURNING` clause. A qualified update is
    therefore refused even under `WITH CHECK (true)`; an **unqualified** one
    (`UPDATE t SET tenant_id = 'B'`, no `WHERE`, no `RETURNING`) is not, and
    under a weakened `WITH CHECK` it succeeds and moves every row the caller
    can see into another tenant. Measured on Postgres 16, twice restated the
    other way round before that: `WITH CHECK` is load-bearing for updates,
    not belt-and-braces over a re-check that covers them.
    """

    async def test_cannot_insert_a_row_explicitly_addressed_to_another_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        """A plain Core `INSERT`, not `session.add()` + flush: the ORM path
        fetches `RoomGroup.created_at` back via an implicit `RETURNING`, and
        Postgres refuses to return a row `USING` would hide regardless of
        `WITH CHECK` — which would make this pass for the wrong reason (via
        `USING`-on-`RETURNING`, not `WITH CHECK`). A bare `INSERT` has no
        `RETURNING` and so isolates the one thing this test is about.
        """
        tenant_a, tenant_b = _tenant_pair()
        await _make_tenant(rls_harness.owner, tenant_a)
        await _make_tenant(rls_harness.owner, tenant_b)

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            with pytest.raises(DBAPIError, match="row-level security"):
                await session.execute(
                    insert(RoomGroup.__table__).values(
                        id=str(uuid.uuid4()), tenant_id=tenant_b, name="smuggled"
                    )
                )

    async def test_cannot_update_an_own_row_into_another_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        """The *qualified* update: refused by the `USING` re-check, which
        applies because a `WHERE` clause makes the statement need `SELECT`
        rights. This one stays red even under `WITH CHECK (true)`, so it is
        the weaker of the pair — kept because it is the shape application
        code actually writes, and because it is the half whose defence would
        disappear if `USING` and `WITH CHECK` were ever allowed to diverge.
        """
        tenant_a, tenant_b = _tenant_pair()
        await _make_tenant(rls_harness.owner, tenant_a)
        await _make_tenant(rls_harness.owner, tenant_b)

        store = RoomGroupStore()
        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            own = await store.create(
                session,
                name="mine",
                description=None,
                color=None,
                parent_group_id=None,
            )
            await session.commit()
            own_id = own.id

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            with pytest.raises(DBAPIError, match="row-level security"):
                await session.execute(
                    update(RoomGroup)
                    .where(RoomGroup.id == own_id)
                    .values(tenant_id=tenant_b)
                )

    async def test_cannot_move_own_rows_out_with_an_unqualified_update(
        self, rls_harness: RLSHarness
    ) -> None:
        """The update that only `WITH CHECK` refuses.

        No `WHERE`, no `RETURNING`, so the statement needs no `SELECT` rights
        and Postgres does not re-check the new row against `USING`. Under a
        `WITH CHECK` weakened to `true` this succeeds and rewrites every row
        tenant A can see into tenant B — measured on Postgres 16, and the
        reason the class docstring no longer says the re-check covers
        updates. The row is read back through the owner afterwards rather
        than through tenant A, because a row that *did* move is by
        construction invisible to the session that moved it.
        """
        tenant_a, tenant_b = _tenant_pair()
        await _make_tenant(rls_harness.owner, tenant_a)
        await _make_tenant(rls_harness.owner, tenant_b)

        store = RoomGroupStore()
        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            own = await store.create(
                session,
                name="mine",
                description=None,
                color=None,
                parent_group_id=None,
            )
            await session.commit()
            own_id = own.id

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            with pytest.raises(DBAPIError, match="row-level security"):
                await session.execute(
                    update(RoomGroup.__table__).values(tenant_id=tenant_b)
                )

        async with rls_harness.owner() as session:
            landed = await session.get(RoomGroup, own_id)
            assert landed is not None
            assert landed.tenant_id == tenant_a, (
                "an unqualified UPDATE moved a row out of its tenant — "
                "WITH CHECK is what refuses this one, and USING does not"
            )


class TestNoTenantSetRaises:
    async def test_a_query_with_no_tenant_bound_raises(
        self, rls_harness: RLSHarness
    ) -> None:
        """Not "returns nothing" — that would be indistinguishable from an
        empty tenant. `require_tenant_id()` fails closed instead."""
        async with rls_harness.restricted() as session:
            with pytest.raises(DBAPIError, match="app.tenant_id is not set"):
                await session.execute(select(RoomGroup))

    async def test_a_whitespace_tenant_raises_rather_than_matching_nothing(
        self, rls_harness: RLSHarness
    ) -> None:
        """The third spelling of "unset", and the one that looks set.

        `set_config('app.tenant_id', '   ')` passes a bare `v = ''` test, and
        what follows is a session whose reads all come back empty and whose
        writes all match nothing, with no error anywhere to say why. No
        tenant id is whitespace, so it gets the same raise the other two do.
        Issued as raw SQL rather than through `tenant_session`, because the
        value would have to be constructed by hand to get here at all.
        """
        async with rls_harness.restricted() as session:
            await session.execute(
                text("SELECT set_config('app.tenant_id', '   ', true)")
            )
            with pytest.raises(DBAPIError, match="app.tenant_id is not set"):
                await session.execute(select(RoomGroup))


async def _rowsecurity_by_table(session) -> dict[str, bool]:  # type: ignore[no-untyped-def]
    result = await session.execute(
        text("SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'")
    )
    return {row.tablename: row.rowsecurity for row in result}


async def _tenant_isolation_policies(
    session,  # type: ignore[no-untyped-def]
) -> dict[str, tuple[str | None, str | None]]:
    result = await session.execute(
        text(
            "SELECT tablename, qual, with_check FROM pg_policies "
            "WHERE schemaname = 'public' AND policyname = :name"
        ),
        {"name": POLICY_NAME},
    )
    return {row.tablename: (row.qual, row.with_check) for row in result}


def _expected_predicate(tenant_column: str) -> str:
    """`create_policy_ddl`'s predicate as `pg_policies` reads it back.

    Postgres stores a parsed expression and renders it from the tree, so the
    text is not the text that was submitted: the quoting is dropped and the
    scalar subquery comes back with its output column named. Written out
    literally rather than derived from `create_policy_ddl`, because a
    derivation that reused the same string-building would agree with a typo in
    it.
    """
    return (
        f"({tenant_column} = ( SELECT {REQUIRE_TENANT_FUNCTION_NAME}() "
        f"AS {REQUIRE_TENANT_FUNCTION_NAME}))"
    )


def _migration_module() -> ModuleType:
    """The `265ed188ad6f` revision module, loaded through Alembic.

    Alembic's own loader, rather than an `importlib` call on a path, so this
    finds the file the same way a deployment would and fails the same way if
    the revision were renamed or removed.
    """
    core = Path(switch_core.__file__).resolve().parents[1]
    config = Config(str(core / "alembic.ini"))
    config.set_main_option("script_location", str(core / "switch_core" / "migrations"))
    revision = ScriptDirectory.from_config(config).get_revision(_RLS_REVISION)
    return revision.module


class TestCatalogueCoverage:
    """Read the built schema back out of the database — `pg_tables` and
    `pg_policies` — rather than the model source, so a scoped table added
    later without a policy fails here even if nobody remembers to extend a
    hand-kept list. The table list itself comes from `rls_ddl.scoped_tables`,
    the same derivation `create_all` used to attach the policies in the first
    place, not a copy of it.
    """

    async def test_scoped_table_list_is_not_trivially_small(
        self, session_factory: async_sessionmaker
    ) -> None:
        scoped = scoped_tables(Base.metadata)
        assert len(scoped) >= 30, scoped
        assert "tenants" in scoped
        assert scoped["tenants"] == "id"
        assert "messages" in scoped
        assert "agents" in scoped
        for global_table in ("users", "oidc_identities", "feature_flags"):
            assert global_table not in scoped

    async def test_every_scoped_table_has_rls_enabled_and_the_right_policy(
        self, session_factory: async_sessionmaker
    ) -> None:
        """Both predicates, compared against the expected text.

        Asserting only that `qual` and `with_check` are non-null passes for
        `USING (true)` — a policy that is present, enabled, catalogued, and
        isolates nothing. So the comparison is on content: each table's
        expected predicate is built from the column `rls_ddl` says that table
        is scoped by, in the shape Postgres renders a `(SELECT f())` back as,
        and a table whose policy says anything else is named in the failure.
        """
        scoped = scoped_tables(Base.metadata)
        async with session_factory() as session:
            rowsecurity = await _rowsecurity_by_table(session)
            policies = await _tenant_isolation_policies(session)

        missing_rls = sorted(t for t in scoped if not rowsecurity.get(t))
        missing_policy = sorted(t for t in scoped if t not in policies)
        wrong_predicate = {
            table: policies[table]
            for table, column in sorted(scoped.items())
            if table in policies
            and policies[table] != (_expected_predicate(column),) * 2
        }

        assert missing_rls == [], f"row-level security not enabled: {missing_rls}"
        assert missing_policy == [], f"no {POLICY_NAME!r} policy: {missing_policy}"
        assert wrong_predicate == {}, (
            "policy does not isolate on the tenant column (USING, WITH CHECK): "
            f"{wrong_predicate}"
        )

    async def test_the_migrations_frozen_table_list_matches_the_models(self) -> None:
        """`265ed188ad6f` carries its own copy of the scoped-table list, on
        purpose — a migration must not change meaning because a model did. The
        cost of a frozen copy is that it can silently fall behind: a table
        added to the models gets a policy from `create_all`, so every test in
        this file still passes, while a real deployment built by Alembic has
        none. Nothing compared the two before this; they agree at 38 today.

        A deliberate divergence is still expressible — it just has to be a
        new migration, which is the point.
        """
        from_models = scoped_tables(Base.metadata)
        from_migration = dict(_migration_module().SCOPED_TABLES)

        assert from_migration == from_models, (
            "the frozen SCOPED_TABLES in migration 265ed188ad6f no longer "
            "matches the models: only in the migration "
            f"{sorted(set(from_migration) - set(from_models))}, only in the "
            f"models {sorted(set(from_models) - set(from_migration))}"
        )

    async def test_global_tables_carry_no_policy(
        self, session_factory: async_sessionmaker
    ) -> None:
        scoped = scoped_tables(Base.metadata)
        async with session_factory() as session:
            policies = await _tenant_isolation_policies(session)
        for global_table in ("users", "oidc_identities", "feature_flags"):
            assert global_table not in scoped
            assert global_table not in policies

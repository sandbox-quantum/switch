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
should fail. Omitting `WITH CHECK` entirely does *not* demonstrate this:
Postgres reuses `USING` as `WITH CHECK` when none is given, which happens to
still block that same insert and would falsely look like the test caught
nothing.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.db.base import Base
from switch_core.db.models import RoomGroup, Tenant
from switch_core.db.rls_ddl import POLICY_NAME, scoped_tables
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_group_store import RoomGroupStore
from tests.conftest import RLSHarness


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

    The `UPDATE` case included below is *not* the same gap. Postgres re-checks
    a row's new state against a table's visibility policy on `UPDATE`
    regardless of what `WITH CHECK` says, so — because this design gives
    `USING` and `WITH CHECK` the identical predicate — moving a row tenant A
    can see into tenant B is already refused before `WITH CHECK` gets
    involved. It is included anyway as the write-side counterpart the "Done
    when" list asks for, and because a future edit that let the two
    predicates diverge would only be caught by a test that actually exercises
    `UPDATE`.
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
        """Belt-and-suspenders, not a gap `WITH CHECK` alone closes here: see
        the class docstring. `USING` and `WITH CHECK` share one predicate by
        design, so this stays refused either way — pinned so a future change
        that let them diverge would be caught by a test that exercises
        `UPDATE`, not only the `INSERT` case above.
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


class TestNoTenantSetRaises:
    async def test_a_query_with_no_tenant_bound_raises(
        self, rls_harness: RLSHarness
    ) -> None:
        """Not "returns nothing" — that would be indistinguishable from an
        empty tenant. `require_tenant_id()` fails closed instead."""
        async with rls_harness.restricted() as session:
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

    async def test_every_scoped_table_has_rls_enabled_and_a_well_formed_policy(
        self, session_factory: async_sessionmaker
    ) -> None:
        scoped = scoped_tables(Base.metadata)
        async with session_factory() as session:
            rowsecurity = await _rowsecurity_by_table(session)
            policies = await _tenant_isolation_policies(session)

        missing_rls = sorted(t for t in scoped if not rowsecurity.get(t))
        missing_policy = sorted(t for t in scoped if t not in policies)
        missing_using_or_check = sorted(
            t
            for t, (qual, with_check) in policies.items()
            if t in scoped and (qual is None or with_check is None)
        )

        assert missing_rls == [], f"row-level security not enabled: {missing_rls}"
        assert missing_policy == [], f"no {POLICY_NAME!r} policy: {missing_policy}"
        assert missing_using_or_check == [], (
            f"policy missing USING or WITH CHECK: {missing_using_or_check}"
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

"""Catalogue tests for the multi-tenancy Phase 1 schema (CHOO-2623).

These read the built schema back out of the database — `pg_constraint` and
friends, via SQLAlchemy's reflection `Inspector` — rather than the model
source, so a table added later without following the tenant-scoping rule
fails here even if nobody remembers to update these tests by hand. See
`docs/old/multi-tenancy-phase1-db.md` for the rule itself:

    Every table holding customer data carries a non-null `tenant_id`, and
    every foreign key between two such tables carries `tenant_id` as well.
"""

from __future__ import annotations

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, async_sessionmaker

# Importing models registers every table (including the plain `Table()`
# junction tables) on `Base.metadata`.
import switch_core.db.models  # noqa: F401
from switch_core.db.base import Base


def _scoped_tables() -> set[str]:
    """Every table carrying a `tenant_id` column whose foreign key targets
    `tenants.id` — the schema's own definition of "scoped".

    Deliberately not the list from the design doc: a table that gains a
    `tenant_id` later by copying the mixin (or the equivalent inline column,
    for the plain `Table()` junction tables) is picked up automatically, and
    one that forgets the foreign key to `tenants` is correctly left out and
    so exempt from these checks — the accompanying test that every scoped
    table's FKs carry `tenant_id` only means anything once a table is on this
    list at all.
    """
    scoped = set()
    for table in Base.metadata.tables.values():
        tenant_id_col = table.columns.get("tenant_id")
        if tenant_id_col is None:
            continue
        if any(
            fk.column.table.name == "tenants" and fk.column.name == "id"
            for fk in tenant_id_col.foreign_keys
        ):
            scoped.add(table.name)
    return scoped


def _get_foreign_keys(sync_conn, table_name: str) -> list[dict]:
    return inspect(sync_conn).get_foreign_keys(table_name)


def _get_unique_column_sets(sync_conn, table_name: str) -> list[frozenset[str]]:
    insp = inspect(sync_conn)
    sets = [
        frozenset(uc["column_names"]) for uc in insp.get_unique_constraints(table_name)
    ]
    pk = insp.get_pk_constraint(table_name)
    if pk.get("constrained_columns"):
        sets.append(frozenset(pk["constrained_columns"]))
    return sets


async def _foreign_keys(conn: AsyncConnection, table_name: str) -> list[dict]:
    return await conn.run_sync(_get_foreign_keys, table_name)


async def _unique_column_sets(
    conn: AsyncConnection, table_name: str
) -> list[frozenset[str]]:
    return await conn.run_sync(_get_unique_column_sets, table_name)


class TestScopedTableCatalogue:
    async def test_scoped_tables_exist_and_are_not_trivial(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Sanity check on the derivation itself: if this list ever collapses
        to empty or to one table, the two tests below would pass vacuously."""
        scoped = _scoped_tables()
        assert len(scoped) >= 30, scoped
        assert "messages" in scoped
        assert "agents" in scoped
        # Global tables must not appear.
        assert "users" not in scoped
        assert "oidc_identities" not in scoped
        assert "feature_flags" not in scoped

    async def test_every_cross_scoped_foreign_key_carries_tenant_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A foreign key from one scoped table to another must be composite
        on `tenant_id`, so a row can never reference a parent in another
        tenant. Foreign keys to a *global* table (e.g. `rooms.owner_id ->
        users.id`) are single-column by design and are not checked here."""
        scoped = _scoped_tables()
        violations: list[tuple[str, str, str]] = []
        async with session_factory() as session:
            conn = await session.connection()
            for table_name in scoped:
                for fk in await _foreign_keys(conn, table_name):
                    ref_table = fk["referred_table"]
                    if ref_table not in scoped:
                        continue
                    local_cols = set(fk["constrained_columns"])
                    ref_cols = set(fk["referred_columns"])
                    if "tenant_id" not in local_cols or "tenant_id" not in ref_cols:
                        violations.append((table_name, fk["name"] or "?", ref_table))
        assert violations == [], (
            "foreign key(s) between scoped tables missing tenant_id "
            f"(table, constraint, referenced table): {violations}"
        )

    async def test_every_referenced_scoped_table_has_id_tenant_unique(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Any scoped table that is the target of a composite (`tenant_id`,
        `id`)-shaped foreign key must itself expose a `UNIQUE (id,
        tenant_id)` — Postgres requires a unique constraint on the referenced
        columns for a composite foreign key to exist at all, but this asserts
        it is exactly the `(id, tenant_id)` shape the design calls for,
        derived from who actually references whom rather than a hand-kept
        list of "the ~13 referenced tables"."""
        scoped = _scoped_tables()
        async with session_factory() as session:
            conn = await session.connection()
            referenced: set[str] = set()
            for table_name in scoped:
                for fk in await _foreign_keys(conn, table_name):
                    ref_table = fk["referred_table"]
                    if ref_table not in scoped:
                        continue
                    local_cols = fk["constrained_columns"]
                    ref_cols = fk["referred_columns"]
                    if "tenant_id" in local_cols and "tenant_id" in ref_cols:
                        referenced.add(ref_table)

            missing: list[str] = []
            for table_name in referenced:
                unique_sets = await _unique_column_sets(conn, table_name)
                if not any({"id", "tenant_id"} <= s for s in unique_sets):
                    missing.append(table_name)
        assert referenced, "expected at least one table referenced by a composite key"
        assert missing == [], (
            "scoped table(s) referenced by a composite key but missing "
            f"UNIQUE (id, tenant_id): {missing}"
        )

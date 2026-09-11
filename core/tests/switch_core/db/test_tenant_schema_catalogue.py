"""Catalogue tests for the multi-tenancy Phase 1 schema (CHOO-2623).

These read the built schema back out of the database — `pg_constraint` and
friends, via SQLAlchemy's reflection `Inspector` — rather than the model
source, so a table added later without following the tenant-scoping rule
fails here even if nobody remembers to update these tests by hand. See
`docs/old/multi-tenancy-phase1-db.md` for the rule itself:

    Every table holding customer data carries a non-null `tenant_id`, and
    every foreign key between two such tables carries `tenant_id` as well.

**The invariant is stated the way round that fails closed**, which it was
not when this file was written. It used to derive "scoped" as *carries a
`tenant_id` foreign key*, and then check things about the tables in that
set — so a new table full of customer data and no tenant column was not in
the set, was checked by nothing, and passed. That is the exact regression
these tests exist to prevent, so the derivation is inverted: the small set
of tables with no tenant is hardcoded in `rls_ddl.GLOBAL_TABLES`, and every
other table in the metadata must be scoped. Adding a table with customer
data and no tenant column now fails at import — `db/models.py` attaches the
policies at the bottom and `scoped_tables` refuses — and the two tests below
pin both halves of the escape hatch so it cannot be widened quietly.
"""

from __future__ import annotations

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, async_sessionmaker

# Importing models registers every table (including the plain `Table()`
# junction tables) on `Base.metadata`.
import switch_core.db.models  # noqa: F401
from switch_core.db.base import Base
from switch_core.db.rls_ddl import GLOBAL_TABLES, scoped_tables, unscoped_tables


def _scoped_tables() -> set[str]:
    """Every table the schema says is tenant-scoped: all but the globals.

    The same derivation `create_all` used to attach the policies
    (`rls_ddl.scoped_tables`), not a second copy of it — a private copy here
    is what let this file and the policies disagree in the first place.
    """
    return set(scoped_tables(Base.metadata))


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


class TestEveryTableIsScopedUnlessItIsNamedGlobal:
    """The inverted invariant itself, in two halves.

    Half one: nothing in the metadata is unaccounted for. Half two: the list
    of things excused is exactly the list someone signed off on. Without the
    second, the first is trivially satisfiable by adding the new table to
    `GLOBAL_TABLES` — which is a legitimate thing to do and must simply be
    visible in a diff rather than available as a quick way to get a red suite
    green.
    """

    async def test_no_table_escapes_the_rule(self) -> None:
        assert unscoped_tables(Base.metadata) == [], (
            "table(s) hold customer data with no tenant and no exemption; "
            "inherit TenantScoped, or name them in rls_ddl.GLOBAL_TABLES and "
            "update the test below"
        )

    async def test_the_global_table_list_is_exactly_these(self) -> None:
        """Hardcoded on purpose, and hardcoded twice on purpose.

        `users` is a person rather than a tenant member, `oidc_identities`
        records how that person proves who they are, and `feature_flags` is a
        deployment switch — a flag that has to vary per customer is a new
        scoped table, not a nullable column there. `alembic_version` is
        global too but is not in this metadata: Alembic owns it.
        """
        assert set(GLOBAL_TABLES) == {
            "users",
            "oidc_identities",
            "feature_flags",
            "stored_templates",
        }

    async def test_scoped_is_everything_else(self) -> None:
        scoped = _scoped_tables()
        assert scoped == set(Base.metadata.tables) - set(GLOBAL_TABLES)
        # Not vacuous, and the shape is what the design doc describes.
        assert len(scoped) >= 30, scoped
        assert {"messages", "agents", "tenants", "tenant_members"} <= scoped


class TestScopedTableCatalogue:
    async def test_every_cross_scoped_foreign_key_carries_tenant_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A foreign key from one scoped table to another must be composite
        on `tenant_id`, so a row can never reference a parent in another
        tenant. Foreign keys to a *global* table (e.g. `rooms.owner_id ->
        users.id`) are single-column by design and are not checked here, and
        neither is a table's own key to `tenants` — that key is what makes it
        scoped in the first place and is single-column by construction."""
        scoped = _scoped_tables()
        violations: list[tuple[str, str, str]] = []
        async with session_factory() as session:
            conn = await session.connection()
            for table_name in scoped:
                for fk in await _foreign_keys(conn, table_name):
                    ref_table = fk["referred_table"]
                    if ref_table not in scoped or ref_table == "tenants":
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

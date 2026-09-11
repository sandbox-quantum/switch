"""Row-level security: the backstop for a query that forgets its tenant filter.

Composite foreign keys (see `db/models.py`) stop a row from *referencing* a
parent in another tenant. They do nothing for the read side: a store method
that drops a `WHERE tenant_id = …` clause, by a typo or by never having one to
begin with, still runs and still returns rows — just someone else's. Row-level
security is what turns that into an empty result instead, at the database, so
the guarantee does not depend on every one of roughly 250 store methods
getting its filter right forever.

**The function fails closed, and everything below rests on that.**
`require_tenant_id()` reads `current_setting('app.tenant_id', true)` and
raises unless it is a non-empty string. Both empty cases matter and are not
the same bug: a session that never bound a tenant reads NULL (the `true`
argument asks for that instead of an error); a session whose transaction
already committed — releasing the `is_local` setting `db/tenant_session.py`
issued — reads the empty string, not NULL. A function that only checked for
NULL would pass the second case, which is exactly the pooled-connection leak
this whole design exists to close: a session that finishes a tenant's
transaction and is then handed unset-but-not-NULL to the next borrower. Empty
string produced a real incident elsewhere in the company for that reason, so
it gets the same treatment as NULL here rather than being assumed away.
Whitespace is the third spelling of the same thing and gets it too: no tenant
id is whitespace, `set_config('app.tenant_id', '   ')` would otherwise satisfy
the check, and what follows is a session whose every read is silently empty
and whose every write silently matches nothing. The raise trims to decide,
and returns the value untrimmed — a fail-closed function that quietly
repaired its input would be deciding, on a caller's behalf, that a malformed
tenant id meant a real tenant.

The policy text is one shape, applied identically to every scoped table:

    alter table <t> enable row level security;
    create policy tenant_isolation on <t>
      for all
      using       (<col> = (select require_tenant_id()))
      with check  (<col> = (select require_tenant_id()));

- **`with check` is not optional, on inserts *and* on updates.** `using` only
  gates which existing rows a statement can see; it says nothing about the row
  a statement leaves behind. An `INSERT` has no existing row for `using` to
  filter, so without `with check` it is free to address any tenant at all —
  writing a row into another tenant that the writer can never read back.
  Prior art elsewhere, not a hypothetical.

  `UPDATE` is the same gap, and it is easy to talk yourself out of that.
  Postgres *does* re-check the updated row against `using` — but only when
  the statement needs `SELECT` rights on the table, which is to say when it
  carries a `WHERE` or a `RETURNING` clause. `UPDATE t SET tenant_id = 'B'`
  carries neither, so under a `with check (true)` it succeeds and moves every
  row the caller can see into another tenant. Verified on Postgres 16;
  `tests/switch_core/db/test_row_level_security.py` pins both shapes so the
  weaker claim cannot be restated.
- **`(select require_tenant_id())`**, not a bare call: wrapping it in a
  `select` makes the planner evaluate it once per query, as an `InitPlan`,
  instead of once per row. Marking the function `stable` is necessary but not
  sufficient for that on its own.
- **No `to <role>` clause.** Naming the eventual runtime role here would make
  this DDL fail everywhere that role does not exist yet — including
  `create_all` in every test that does not need it. Postgres already
  exempts a table's owner from its own policies unless `force row level
  security` is set (which this design deliberately does not set — see
  `docs/old/multi-tenancy-phase1-db.md`'s "runtime role" section), so the
  clause would buy nothing that ownership does not already give for free.
- **`tenants` compares on `id`**, because a tenant *is* the boundary rather
  than belonging to one. Every other scoped table compares on `tenant_id`.

**Scoped is the default; global is the list.** The rule is stated the way
round that fails closed: every table in the metadata is scoped *unless* it is
named in `GLOBAL_TABLES`, and a table that is neither named there nor
actually carrying a tenant raises `UnscopedTableError` — at import, because
`db/models.py` calls `attach_row_level_security` at the bottom, which is to
say the process does not start.

This was originally written the other way round, deriving "scoped" from *has
a `tenant_id` foreign key to `tenants.id`*, and that version failed open: a
new table holding customer data and no tenant column simply was not in the
set, so nothing enabled a policy on it, nothing complained, and the
catalogue tests — which take their table list from here — passed. That is
precisely the regression these checks exist to catch, so the invariant is
inverted. Adding a table is now a choice between inheriting `TenantScoped`
and arguing in a diff for an entry in `GLOBAL_TABLES`; forgetting to choose
is not one of the options.

The membership test for "actually carries a tenant" is unchanged: a
`tenant_id` column whose foreign key targets `tenants.id` — exactly
`TenantScoped`'s column, and exactly what a plain `Table()` junction table
gets by adding the equivalent column inline, since the mixin only works on a
declarative class. The foreign key, not just the column name: a table that
merely happens to have a column called `tenant_id` without the constraint is
not tied to a tenant, and a policy comparing it would reject every row the
table holds.

**Where the SQL lives.** Same house pattern as `notify_ddl.py`: this module's
DDL is attached to `Base.metadata` (`db/models.py`) so `create_all` builds it
and every test exercises the same policies the server would run in
production; the migration that installs this for real carries its own frozen
verbatim copy of the SQL as it stood when written, because a migration is a
record of a change that already happened and must not change meaning because
this module later does.
"""

from __future__ import annotations

from sqlalchemy import DDL, MetaData, Table, event

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

# The whole exemption from tenancy, written out. Everything else in
# `Base.metadata` is scoped, so this list is the only place a table can be
# excused from carrying a tenant, and extending it is an edit a reviewer sees
# — `tests/switch_core/db/test_tenant_schema_catalogue.py` pins the contents,
# so widening it fails the suite until someone changes the test too.
#
# A person is not a tenant member (`users`), nor is the record of how they
# prove who they are (`oidc_identities`); `feature_flags` is a deployment
# switch, and a flag that needs to vary per customer is a new scoped table
# rather than a nullable column here. Alembic's `alembic_version` needs no
# entry: Alembic owns that table and never registers it on this metadata.
GLOBAL_TABLES = frozenset(
    {"users", "oidc_identities", "feature_flags", "stored_templates"}
)


class UnscopedTableError(RuntimeError):
    """A table is neither tenant-scoped nor named in `GLOBAL_TABLES`.

    Raised while attaching the policies, which happens at the bottom of
    `db/models.py` — so a table added without a tenant and without a
    deliberate exemption stops the process at import rather than quietly
    shipping a table with customer data in it and no isolation policy.
    """


# SQLSTATE 42501, insufficient_privilege — the closest standard code for "you
# may not see or touch this row", and the one an operator's tooling is likely
# to already recognise as an authorization failure rather than a generic
# error.
_TENANT_NOT_SET_SQLSTATE = "42501"

CREATE_REQUIRE_TENANT_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {REQUIRE_TENANT_FUNCTION_NAME}() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v text := current_setting('app.tenant_id', true);
BEGIN
    IF v IS NULL OR btrim(v) = '' THEN
        RAISE EXCEPTION 'app.tenant_id is not set on this session'
            USING ERRCODE = '{_TENANT_NOT_SET_SQLSTATE}';
    END IF;
    RETURN v;
END;
$$
"""

DROP_REQUIRE_TENANT_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {REQUIRE_TENANT_FUNCTION_NAME}()"
)


def enable_rls_ddl(table_name: str) -> str:
    return f'ALTER TABLE "{table_name}" ENABLE ROW LEVEL SECURITY'


def create_policy_ddl(table_name: str, tenant_column: str) -> str:
    predicate = f'"{tenant_column}" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table_name}"\n'
        f"    FOR ALL\n"
        f"    USING ({predicate})\n"
        f"    WITH CHECK ({predicate})"
    )


def drop_policy_ddl(table_name: str) -> str:
    return f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{table_name}"'


def _tenant_column(table: Table) -> str | None:
    """The column this table's policy would compare, or None if it has none.

    `tenants` is the one table compared on `id`, because a tenant *is* the
    boundary rather than belonging to one. Every other table qualifies by
    carrying a `tenant_id` column whose foreign key targets `tenants.id`.
    """
    if table.name == "tenants":
        return "id"
    tenant_id_col = table.columns.get("tenant_id")
    if tenant_id_col is None:
        return None
    if any(
        fk.column.table.name == "tenants" and fk.column.name == "id"
        for fk in tenant_id_col.foreign_keys
    ):
        return "tenant_id"
    return None


def unscoped_tables(metadata: MetaData) -> list[str]:
    """Every table that breaks the rule: not global, and carrying no tenant.

    Empty in a healthy schema. `scoped_tables` refuses to answer at all while
    this is non-empty; it is exposed separately so a test can state the
    invariant in its own words, and so a caller that wants the diagnosis
    rather than the exception can ask for it.
    """
    return sorted(
        table.name
        for table in metadata.tables.values()
        if table.name not in GLOBAL_TABLES and _tenant_column(table) is None
    )


def scoped_tables(metadata: MetaData) -> dict[str, str]:
    """Table name -> the column its policy compares: everything not global.

    Raises `UnscopedTableError` naming any table that is neither in
    `GLOBAL_TABLES` nor actually carrying a tenant. The failure is the point:
    deriving the set from "has a tenant column" instead would quietly answer
    with a shorter list, and a table holding customer data with no isolation
    on it would be indistinguishable from one that was never added.
    """
    tables: dict[str, str] = {}
    violations: list[str] = []
    for table in metadata.tables.values():
        if table.name in GLOBAL_TABLES:
            continue
        column = _tenant_column(table)
        if column is None:
            violations.append(table.name)
        else:
            tables[table.name] = column
    if violations:
        raise UnscopedTableError(
            f"table(s) carry no tenant and are not global: {sorted(violations)}. "
            "Every table in the model metadata is tenant-scoped unless it is "
            "named in db/rls_ddl.py's GLOBAL_TABLES. Inherit TenantScoped (or, "
            "for a plain Table(), add the equivalent tenant_id column with a "
            "foreign key to tenants.id), or — if the table genuinely holds no "
            "customer data — add it to GLOBAL_TABLES, which is a decision "
            "tests/switch_core/db/test_tenant_schema_catalogue.py makes you "
            "state twice."
        )
    return tables


def attach_row_level_security(metadata: MetaData) -> None:
    """Register the function and every table's policy on `metadata`.

    Mirrors how `notify_ddl.py`'s trigger is attached in `db/models.py`: the
    function is bracketed around the whole `create_all`/`drop_all` (a
    `MetaData`-level event, since no single table owns it), and each table's
    `ENABLE ROW LEVEL SECURITY` plus its policy ride that table's own
    `after_create` — after the function exists (metadata `before_create` runs
    before any table's own events) and after the table itself does.
    """
    event.listen(
        metadata,
        "before_create",
        DDL(CREATE_REQUIRE_TENANT_FUNCTION).execute_if(dialect="postgresql"),
    )
    for table_name, column in scoped_tables(metadata).items():
        table = metadata.tables[table_name]
        event.listen(
            table,
            "after_create",
            DDL(enable_rls_ddl(table_name)).execute_if(dialect="postgresql"),
        )
        event.listen(
            table,
            "after_create",
            DDL(create_policy_ddl(table_name, column)).execute_if(dialect="postgresql"),
        )
        event.listen(
            table,
            "before_drop",
            DDL(drop_policy_ddl(table_name)).execute_if(dialect="postgresql"),
        )
    event.listen(
        metadata,
        "after_drop",
        DDL(DROP_REQUIRE_TENANT_FUNCTION).execute_if(dialect="postgresql"),
    )

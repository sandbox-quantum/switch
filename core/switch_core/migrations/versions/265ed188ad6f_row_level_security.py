"""row-level security for every tenant-scoped table

Implements the row-level-security half of Phase 1 multi-tenancy (see
`docs/old/multi-tenancy-phase1-db.md`, "Row-level security"), which the
schema migration (`8b276792ee30`) deliberately stopped short of: one
function, one policy text, applied identically to all 38 tenant-scoped
tables — the 36 the schema migration named plus `tenants` and
`tenant_members`.

`require_tenant_id()` reads `current_setting('app.tenant_id', true)` and
raises unless it holds something other than whitespace. All three empty cases
matter: a session that never bound a tenant reads NULL; a session whose
transaction already committed — releasing the `is_local` setting
`db/tenant_session.py` issued — reads the empty string, not NULL; and a
whitespace-only value is neither of those while naming no tenant that can
exist. A function that only checked for NULL would miss the second, which is
exactly the pooled-connection leak this design exists to close, and one that
stopped at the empty string would let the third through into a session whose
every read comes back silently empty.

Every policy is `for all`, comparing `tenant_id` (or, for `tenants` itself,
`id`) against `(select require_tenant_id())` in both `using` and `with
check`. The `select` wrapper makes the planner evaluate the function once per
query rather than once per row; `with check` is not optional — without it an
`insert` can address any tenant at all, and an `update` with neither a
`where` clause nor a `returning` clause can move rows out of the caller's own
tenant, which is two of the four prior-art bugs this design cites. There is
no `to <role>` clause: naming the
future runtime role here would make this migration fail on every environment
that role does not exist in yet, and Postgres already exempts a table's owner
from its own policies (this migration does not set `force row level
security`), which is the exemption the design relies on instead.

The DDL below is a verbatim copy of `switch_core/db/rls_ddl.py` as it stood
when this migration was written, copied rather than imported for the same
reason `d4e17b90c3a5`'s notify trigger is: a migration is a record of a
change that already happened, and importing the live module would let a
later edit to it silently change what this migration means.

This migration creates no roles and issues no grants — that is a separate,
later change (CHOO-2685; see the design doc's "runtime role" section). Until
that role exists and the application connects as it, every policy below is
inert against a superuser or table-owner connection, which is what local
Compose, the chart and the test containers use today. Nothing here changes
that; it only makes the policies exist so that work has something to point
the runtime at.

Revision ID: 265ed188ad6f
Revises: 8b276792ee30
Create Date: 2026-09-10 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "265ed188ad6f"
down_revision: str | None = "8b276792ee30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

CREATE_REQUIRE_TENANT_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {REQUIRE_TENANT_FUNCTION_NAME}() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v text := current_setting('app.tenant_id', true);
BEGIN
    IF v IS NULL OR btrim(v) = '' THEN
        RAISE EXCEPTION 'app.tenant_id is not set on this session'
            USING ERRCODE = '42501';
    END IF;
    RETURN v;
END;
$$
"""

DROP_REQUIRE_TENANT_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {REQUIRE_TENANT_FUNCTION_NAME}()"
)

# Every scoped table and the column its policy compares. Matches
# `8b276792ee30`'s `SCOPED_TABLES` (compared on `tenant_id`) plus
# `tenant_members` (also `tenant_id`) and `tenants` itself (compared on `id`,
# since a tenant *is* the boundary rather than belonging to one).
SCOPED_TABLES: list[tuple[str, str]] = [
    ("tenants", "id"),
    ("tenant_members", "tenant_id"),
    ("agent_runtime_states", "tenant_id"),
    ("agent_sessions", "tenant_id"),
    ("agent_skills", "tenant_id"),
    ("agents", "tenant_id"),
    ("api_keys", "tenant_id"),
    ("bridge_message_map", "tenant_id"),
    ("client_rooms", "tenant_id"),
    ("clients", "tenant_id"),
    ("collaboration_bridges", "tenant_id"),
    ("delivery_cursors", "tenant_id"),
    ("documents", "tenant_id"),
    ("external_user_claims", "tenant_id"),
    ("external_users", "tenant_id"),
    ("media_blobs", "tenant_id"),
    ("message_attachments", "tenant_id"),
    ("messages", "tenant_id"),
    ("models", "tenant_id"),
    ("package_documents", "tenant_id"),
    ("package_references", "tenant_id"),
    ("packages", "tenant_id"),
    ("reference_types", "tenant_id"),
    ("references", "tenant_id"),
    ("role_leases", "tenant_id"),
    ("room_agents", "tenant_id"),
    ("room_documents", "tenant_id"),
    ("room_groups", "tenant_id"),
    ("room_links", "tenant_id"),
    ("room_packages", "tenant_id"),
    ("room_references", "tenant_id"),
    ("room_roles", "tenant_id"),
    ("room_skills", "tenant_id"),
    ("rooms", "tenant_id"),
    ("server_connectors", "tenant_id"),
    ("skills", "tenant_id"),
    ("tasks", "tenant_id"),
    ("tools", "tenant_id"),
]


def _enable_rls_ddl(table_name: str) -> str:
    return f'ALTER TABLE "{table_name}" ENABLE ROW LEVEL SECURITY'


def _create_policy_ddl(table_name: str, tenant_column: str) -> str:
    predicate = f'"{tenant_column}" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table_name}"\n'
        f"    FOR ALL\n"
        f"    USING ({predicate})\n"
        f"    WITH CHECK ({predicate})"
    )


def _drop_policy_ddl(table_name: str) -> str:
    return f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{table_name}"'


def upgrade() -> None:
    op.execute(CREATE_REQUIRE_TENANT_FUNCTION)
    for table_name, column in SCOPED_TABLES:
        op.execute(_enable_rls_ddl(table_name))
        op.execute(_create_policy_ddl(table_name, column))


def downgrade() -> None:
    for table_name, _column in reversed(SCOPED_TABLES):
        op.execute(_drop_policy_ddl(table_name))
        op.execute(f'ALTER TABLE "{table_name}" DISABLE ROW LEVEL SECURITY')
    op.execute(DROP_REQUIRE_TENANT_FUNCTION)

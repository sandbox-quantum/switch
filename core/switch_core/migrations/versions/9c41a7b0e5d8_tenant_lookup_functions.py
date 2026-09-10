"""the eight tenant lookups that are exempt from row-level security

The policies installed by `265ed188ad6f` are enforced by
`require_tenant_id()`, which raises when no tenant is bound. Resolving *who a
caller is* is what produces the tenant, so credential lookups necessarily run
unbound and the policy refuses them. That is not a corner case: under a
restricted runtime role it stops the process before it finishes booting, and
`docs/old/multi-tenancy-phase1-db.md`'s "The bootstrap problem" describes a
model — an "unscoped session" — that does not work, because unscoped is
exactly the state the function raises on.

This revision installs the replacement: eight `SECURITY DEFINER` functions
that answer *which tenant* and never return a row. Owned by whoever runs this
migration — the schema owner — so they run outside the policies, which is what
Postgres gives a table's owner as long as `force row level security` is not
set. It is not set here and must not be; see `db/runtime_role.py`, which
refuses to boot if it ever is.

Each returns `setof text`. Uniformly, including the seven that can answer at
most once: a `LANGUAGE sql` function declared `RETURNS text` over a query that
matches two rows silently returns the first, and `agents.oauth_client_id`
carries no unique index, so one of these genuinely can. The caller enforces
cardinality and refuses rather than picking.

Each parameter is prefixed `p_`, which is load-bearing rather than a style
choice: a `LANGUAGE sql` parameter spelled like a column of a table in its own
query resolves to the column, so `WHERE id = client_id` against a table with a
`client_id` column compares that column with itself and matches every row.

`SET search_path = pg_catalog, public, pg_temp`, with `pg_temp` last, per the
Postgres note on writing `SECURITY DEFINER` functions safely: a role able to
create a temporary table could otherwise shadow one of the tables read here.

No grants and no roles are created here either. `EXECUTE` defaults to `PUBLIC`
for a new function, which is what makes these callable by the runtime role
without this migration having to know its name — and the most a caller can
learn from any of them is the tenant an identifier it already holds belongs
to. The runtime role's table grants are re-issued at boot by the owner
connection (`db/runtime_role.py`), after this migration has run, so a table a
later revision adds is granted without a runbook step.

The DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py` as it
stood when this migration was written, copied rather than imported for the
same reason `265ed188ad6f`'s policies are: a migration is a record of a change
that already happened, and importing the live module would let a later edit
silently change what this one means.

Revision ID: 9c41a7b0e5d8
Revises: 265ed188ad6f
Create Date: 2026-09-10 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "9c41a7b0e5d8"
down_revision: str | None = "265ed188ad6f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

# (function name, parameter declaration, drop signature, body)
LOOKUPS: tuple[tuple[str, str, str, str], ...] = (
    (
        "all_tenant_ids",
        "",
        "all_tenant_ids()",
        "SELECT id FROM tenants ORDER BY created_at, id",
    ),
    (
        "tenants_of_user",
        "p_user_id text",
        "tenants_of_user(text)",
        "SELECT tenant_id FROM tenant_members "
        "WHERE user_id = p_user_id ORDER BY tenant_id",
    ),
    (
        "tenant_of_api_key",
        "p_key_hash text",
        "tenant_of_api_key(text)",
        "SELECT tenant_id FROM api_keys WHERE key_hash = p_key_hash",
    ),
    (
        "tenant_of_agent_oauth_client",
        "p_oauth_client_id text",
        "tenant_of_agent_oauth_client(text)",
        "SELECT tenant_id FROM agents WHERE oauth_client_id = p_oauth_client_id",
    ),
    (
        "tenant_of_client",
        "p_client_id text",
        "tenant_of_client(text)",
        "SELECT tenant_id FROM clients WHERE id = p_client_id",
    ),
    (
        "tenant_of_room",
        "p_room_id text",
        "tenant_of_room(text)",
        "SELECT tenant_id FROM rooms WHERE id = p_room_id",
    ),
    (
        "tenant_of_collaboration_bridge",
        "p_bridge_id text",
        "tenant_of_collaboration_bridge(text)",
        "SELECT tenant_id FROM collaboration_bridges WHERE id = p_bridge_id",
    ),
    (
        "tenant_of_server_connector",
        "p_connector_id text",
        "tenant_of_server_connector(text)",
        "SELECT tenant_id FROM server_connectors WHERE id = p_connector_id",
    ),
)


def create_lookup_ddl(name: str, parameters: str, body: str) -> str:
    """This revision's frozen copy of the `CREATE FUNCTION` text.

    A function rather than an inline f-string in `upgrade`, so that a test can
    compare what this migration would actually run against what
    `db/tenant_lookup.py` builds today. Without that the frozen list below
    could agree with the live module name for name and body for body while
    this template quietly said `SECURITY INVOKER`, and an Alembic-built
    database would install eight functions that cannot resolve a tenant —
    with every test still green, because the suite builds its schema from the
    models and never runs this file.
    """
    return (
        f"CREATE OR REPLACE FUNCTION {name}({parameters})\n"
        f"    RETURNS SETOF text\n"
        f"    LANGUAGE sql STABLE SECURITY DEFINER\n"
        f"    SET search_path = {SECURE_SEARCH_PATH}\n"
        f"AS $${body}$$"
    )


def upgrade() -> None:
    for name, parameters, _signature, body in LOOKUPS:
        op.execute(create_lookup_ddl(name, parameters, body))


def downgrade() -> None:
    for _name, _parameters, signature, _body in LOOKUPS:
        op.execute(f"DROP FUNCTION IF EXISTS {signature}")

"""drop server_connectors: Switch no longer drives agent hosts itself

A server-side connector had Switch reach out to an agent host and run its
agents from inside switch-core. OpenCode was the only type, and the release
before this one removed it together with the framework it plugged into. This
drops what only it used, now that no release still serving reads it:

- `server_connectors`, and the row-level security policy that goes with it;
- `tenant_of_server_connector`, one of the `SECURITY DEFINER` lookups that are
  the whole exemption from row-level security (`db/tenant_lookup.py`);
- each connector's row in `ownership_leases` (kind `connector`), which no
  process will claim or release again.

The agents a connector registered are left in place. Deleting an agent takes
its client, its room memberships and its handle on each chat platform with it
(`AgentCore.delete_agent`), which is not a statement to repeat here. Nothing
can drive them now, so each is logged by workspace and name for an operator
to delete from the gateway. The connector's id stays in their metadata, the
one durable record of where they came from, and the gateway shows each as
`server-side:<type>`.

The keys go out of use without going away. A connector minted a registration
key to register its agents, and removing a connector never deleted it; each
agent it registered has an agent key of its own. Nothing holds any of them,
yet each still authenticates, so each is retired the way a stale bootstrap
key is (`registration_bootstrap.RETIRED_KEY_TYPE`): it stops authenticating
exactly as deletion would, and the row stays on the API Keys page with a
label that says why. A registration key is found by its connector's row, or
by the `server-connector:` label every connector gave its key, which is what
finds those of connectors already removed.

The warnings are written once the statements have run, and say they take
effect when the upgrade commits: Alembic runs every pending revision in one
transaction, so a later revision that fails rolls this one back too. Each
retired key is named with its workspace and id, so two keys with the same
label can be told apart on the API Keys page.

Dropping the table takes an ACCESS EXCLUSIVE lock on `api_keys` and `tenants`,
which its foreign keys point at, until the upgrade commits; Postgres takes the
same lock to drop just the constraints. Bearer authentication reads `api_keys`
on every request, so a migration that has to wait for the lock holds those
reads up for as long as it waits. `DB_MIGRATION_LOCK_TIMEOUT` (10s by default)
bounds that. The drop is the last statement here, so the lock is held only
until the upgrade commits, longer only if later revisions run in the same
upgrade.

The downgrade puts the table, its policy and the lookup back as they were,
empty: the connectors are not restored, and the keys stay retired. The DDL is
a verbatim copy of what the earlier revisions built, for the same reason
every revision in this chain copies rather than imports.

Revision ID: e223eae63078
Revises: e5a9c3d71f08
Create Date: 2026-10-26 00:00:00.000000

"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

logger = logging.getLogger("alembic.runtime.migration")

revision: str = "e223eae63078"
down_revision: str | None = "e5a9c3d71f08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
# Contracting: it drops a table and a lookup, and retires keys. It ships a
# release after the code that used them went.
expand_only: bool = False

TABLE = "server_connectors"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANT_OF_SERVER_CONNECTOR = f"""CREATE OR REPLACE FUNCTION tenant_of_server_connector(p_connector_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM server_connectors WHERE id = p_connector_id$$"""

DROP_TENANT_OF_SERVER_CONNECTOR = (
    "DROP FUNCTION IF EXISTS tenant_of_server_connector(text)"
)

# A connector registered each agent it found with its own id in the agent's
# metadata and `server-side:<type>` as the connector type. Both, and a value
# rather than a JSON null: the metadata is the client's to write over HTTP, and
# an agent that merely carries the key is not one a connector left behind.
CONNECTOR_AGENT = (
    "(a.metadata ->> 'server_connector_id') IS NOT NULL "
    "AND a.connector_type LIKE 'server-side:%'"
)

# Every key a connector minted was labelled this, and removing a connector
# never deleted its key, so the label is what finds the keys of connectors
# already gone as well as those of the ones still here.
CONNECTOR_KEY_LABEL = "server-connector:"

# `registration_bootstrap.RETIRED_KEY_TYPE`, copied: not a type any bearer
# authentication accepts.
RETIRED_KEY_TYPE = "retired"
RETIRED_LABEL_SUFFIX = " (retired: its server-side connector is gone)"


def upgrade() -> None:
    bind = op.get_bind()
    stranded = [
        f"{row.slug}/{row.name}"
        for row in bind.execute(
            sa.text(
                "SELECT t.slug, a.name FROM agents a "
                "JOIN tenants t ON t.id = a.tenant_id "
                f"WHERE {CONNECTOR_AGENT} ORDER BY t.slug, a.name"
            )
        )
    ]
    retired = [
        f"{row.slug}/{row.label} (id {row.id})"
        for row in bind.execute(
            sa.text(
                "UPDATE api_keys k SET type = :retired, label = k.label || :suffix "
                "FROM tenants t WHERE t.id = k.tenant_id AND ("
                "(k.type = 'registration' AND (k.label LIKE :minted "
                "OR EXISTS (SELECT 1 FROM server_connectors c "
                "WHERE c.tenant_id = k.tenant_id AND c.api_key_id = k.id))) "
                "OR (k.type = 'agent' AND EXISTS (SELECT 1 FROM agents a "
                "WHERE a.tenant_id = k.tenant_id AND a.api_key_id = k.id "
                f"AND {CONNECTOR_AGENT}))) "
                "RETURNING t.slug, k.id, k.label"
            ),
            {
                "retired": RETIRED_KEY_TYPE,
                "suffix": RETIRED_LABEL_SUFFIX,
                "minted": f"{CONNECTOR_KEY_LABEL}%",
            },
        )
    ]
    op.execute("DELETE FROM ownership_leases WHERE kind = 'connector'")
    op.execute(DROP_TENANT_OF_SERVER_CONNECTOR)
    op.drop_table(TABLE)

    if retired:
        logger.warning(
            "Once this upgrade commits, the keys server-side connectors and "
            "their agents held are retired: they no longer authenticate and "
            "stay on the API Keys page, under Retired Keys "
            "(workspace/label (id)): %s",
            ", ".join(sorted(retired)),
        )
    if stranded:
        logger.warning(
            "Once this upgrade commits, nothing can run the agents server-side "
            "connectors registered (shown in the gateway as type "
            "server-side:...). Delete these from the gateway "
            "(workspace/agent): %s",
            ", ".join(stranded),
        )


def downgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("connection_config", postgresql.JSONB(), nullable=True),
        sa.Column("api_key_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_server_connectors_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_server_connectors_api_key",
        ),
    )
    op.create_index("ix_server_connectors_tenant_id", TABLE, ["tenant_id"])
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)
    op.execute(CREATE_TENANT_OF_SERVER_CONNECTOR)

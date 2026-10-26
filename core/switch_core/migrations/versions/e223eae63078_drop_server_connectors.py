"""drop server_connectors: Switch no longer drives agent hosts itself

A server-side connector had Switch reach out to an agent host and run its
agents from inside switch-core. OpenCode was the only type, and it is gone
together with the framework it plugged into. This drops what only it used:

- `server_connectors`, and the row-level security policy that goes with it;
- `tenant_of_server_connector`, one of the `SECURITY DEFINER` lookups that are
  the whole exemption from row-level security (`db/tenant_lookup.py`);
- the registration key each connector minted to register its agents. Such a
  key can still register agents over HTTP, and nothing holds it any more, so
  it is deleted rather than left live.

The agents a connector registered are left in place. Deleting an agent takes
its client, its room memberships and its handle on each chat platform with it
(`AgentCore.delete_agent`), which is not a statement to repeat here. Nothing
can drive them now, so each is logged by workspace and name for an operator
to delete from the gateway, and the connector's id comes off its metadata.

The downgrade puts the table, its policy and the lookup back as they were,
empty: the connectors, their keys and the mark on their agents are not
restored. The DDL is a verbatim copy of what the earlier revisions built, for
the same reason every revision in this chain copies rather than imports.

Revision ID: e223eae63078
Revises: f68b679599ab
Create Date: 2026-10-26 00:00:00.000000

"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

logger = logging.getLogger("alembic.runtime.migration")

revision: str = "e223eae63078"
down_revision: str | None = "f68b679599ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

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


def upgrade() -> None:
    stranded = [
        f"{row.slug}/{row.name}"
        for row in op.get_bind().execute(
            sa.text(
                "SELECT t.slug, a.name FROM agents a "
                "JOIN tenants t ON t.id = a.tenant_id "
                "WHERE (a.metadata -> 'server_connector_id') IS NOT NULL "
                "ORDER BY t.slug, a.name"
            )
        )
    ]
    if stranded:
        logger.warning(
            "Server-side connectors are gone, and nothing can run the agents "
            "they registered. Delete these from the gateway (workspace/agent): %s",
            ", ".join(stranded),
        )
    op.execute(
        "UPDATE agents SET metadata = metadata - 'server_connector_id' "
        "WHERE (metadata -> 'server_connector_id') IS NOT NULL"
    )

    op.drop_constraint("fk_server_connectors_api_key", TABLE, type_="foreignkey")
    op.execute(
        "DELETE FROM api_keys k USING server_connectors c "
        "WHERE k.tenant_id = c.tenant_id AND k.id = c.api_key_id "
        "AND k.type = 'registration'"
    )
    op.execute(DROP_TENANT_OF_SERVER_CONNECTOR)
    op.drop_table(TABLE)


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

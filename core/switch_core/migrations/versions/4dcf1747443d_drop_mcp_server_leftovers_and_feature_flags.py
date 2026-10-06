"""drop what only Switch's own MCP server used, and feature flags

Switch no longer serves MCP itself: every session gets its tools from a
runtime on its own host, which calls `/agents/{id}/ops`. This drops what only
the `/mcp` endpoint read or wrote:

- `agents.oauth_client_id`, its deployment-wide unique index, and
  `tenant_of_agent_oauth_client`, the lookup in the row-level-security
  exemption that resolved an OIDC-authenticated agent's tenant. Agents signed
  in with an OIDC token only on `/mcp`. `db/tenant_lookup.py` no longer names
  the lookup, and `tests/switch_core/db/test_tenant_lookup.py` records this
  revision as the one that dropped it.
- `agent_sessions.transport_session_id` and its index: the room an MCP
  transport session had connected to, the only binding such a caller had. A
  connection carries its own rooms. The `explicit` rows, which existed only to
  hold that binding for session_passive agents, go with it; the heartbeat rows
  stay.

It also drops `feature_flags`. Its one flag, `ecosystem.show_owners`, could
only be flipped through agent routes that are gone, so the ecosystem graph now
always behaves as it did with the flag off, its default.

The downgrade puts both columns, both indexes and the lookup back, empty: no
agent has an OIDC client id and no row a transport binding, and the deleted
`explicit` rows are not restored. It recreates `feature_flags` empty, which
reads as every flag off. The lookup DDL is frozen, like the rest of
this chain: the text `9c41a7b0e5d8` ran, not whatever `db/tenant_lookup.py`
would build today.

Revision ID: 4dcf1747443d
Revises: 7c26ad1a2d81
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4dcf1747443d"
down_revision: str | None = "7c26ad1a2d81"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANT_OF_AGENT_OAUTH_CLIENT = f"""CREATE OR REPLACE FUNCTION tenant_of_agent_oauth_client(p_oauth_client_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM agents WHERE oauth_client_id = p_oauth_client_id$$"""

DROP_TENANT_OF_AGENT_OAUTH_CLIENT = (
    "DROP FUNCTION IF EXISTS tenant_of_agent_oauth_client(text)"
)

OAUTH_CLIENT_INDEX = "uq_agents_oauth_client_id"
TRANSPORT_SESSION_INDEX = "ix_agent_sessions_transport_session_id"


def upgrade() -> None:
    op.execute(DROP_TENANT_OF_AGENT_OAUTH_CLIENT)
    op.drop_index(OAUTH_CLIENT_INDEX, table_name="agents")
    op.drop_column("agents", "oauth_client_id")

    op.execute("DELETE FROM agent_sessions WHERE lifecycle = 'explicit'")
    op.drop_index(TRANSPORT_SESSION_INDEX, table_name="agent_sessions")
    op.drop_column("agent_sessions", "transport_session_id")

    op.drop_table("feature_flags")


def downgrade() -> None:
    op.create_table(
        "feature_flags",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("key"),
    )

    op.add_column(
        "agent_sessions",
        sa.Column("transport_session_id", sa.Text(), nullable=True),
    )
    op.create_index(TRANSPORT_SESSION_INDEX, "agent_sessions", ["transport_session_id"])

    op.add_column("agents", sa.Column("oauth_client_id", sa.Text(), nullable=True))
    op.create_index(
        OAUTH_CLIENT_INDEX,
        "agents",
        ["oauth_client_id"],
        unique=True,
        postgresql_where=sa.text("oauth_client_id IS NOT NULL"),
    )
    op.execute(CREATE_TENANT_OF_AGENT_OAUTH_CLIENT)

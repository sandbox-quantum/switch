"""remove server-side connectors and the task protocol

Two designs Switch no longer has.

Switch no longer dials out to agent hosts: every agent session is started by
Switch Console or its sidecar and connects in. This drops what the server-side
connectors kept:

- `server_connectors`, and with it `tenant_of_server_connector`, the lookup in
  the row-level-security exemption that resolved a connector's tenant at boot.
  `db/tenant_lookup.py` no longer names it, and
  `tests/switch_core/db/test_tenant_lookup.py` records this revision as the one
  that dropped it.
- The registration key each connector held. It stays as a row, retired the way
  `main.py` retires a stale bootstrap key, so nothing can register an agent
  with a credential that only a dropped table knew about.

The task protocol (delegate, accept, update, finalise, cancel) was never put
to use, and its `can_delegate` / `can_accept` capabilities were never
enforced. This drops `tasks`, and strips `task_protocol` from every stored
integration profile.

The downgrade recreates both tables and the lookup empty, as `c3f1a9d27e46`
left them, so a rollback lands on a schema that revision recognises, and puts
a `task_protocol` with both capabilities off back on every profile, because
the code before this revision requires the key. The rows, the capabilities
an agent had, and the keys' registration type are not restored.

The lookup DDL is frozen, like the rest of this chain: the text `9c41a7b0e5d8`
ran, not whatever `db/tenant_lookup.py` would build today.

Revision ID: 7c26ad1a2d81
Revises: c3f1a9d27e46
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7c26ad1a2d81"
down_revision: str | None = "c3f1a9d27e46"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"
REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"
RETIRED_KEY_TYPE = "retired"

CREATE_TENANT_OF_SERVER_CONNECTOR = f"""CREATE OR REPLACE FUNCTION tenant_of_server_connector(p_connector_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM server_connectors WHERE id = p_connector_id$$"""

DROP_TENANT_OF_SERVER_CONNECTOR = (
    "DROP FUNCTION IF EXISTS tenant_of_server_connector(text)"
)

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _create_policy(table: str) -> str:
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def _enable_rls(table: str) -> None:
    op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy(table))


def upgrade() -> None:
    op.execute(DROP_TENANT_OF_SERVER_CONNECTOR)
    op.execute(
        f"UPDATE api_keys SET type = '{RETIRED_KEY_TYPE}' "
        "WHERE (tenant_id, id) IN (SELECT tenant_id, api_key_id FROM server_connectors)"
    )
    op.drop_table("server_connectors")

    op.drop_table("tasks")
    op.execute(
        "UPDATE agents SET integration_profile = integration_profile - 'task_protocol' "
        "WHERE integration_profile ? 'task_protocol'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE agents SET integration_profile = integration_profile || "
        """'{"task_protocol": {"can_delegate": false, "can_accept": false}}'::jsonb """
        "WHERE NOT integration_profile ? 'task_protocol'"
    )
    op.create_table(
        "tasks",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("requester_agent_id", sa.Text(), nullable=False),
        sa.Column("performer_agent_id", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updates",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finalised_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="tasks_pkey"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "performer_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_tasks_performer_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "requester_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_tasks_requester_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_tasks_room",
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], name="fk_tasks_tenant"),
    )
    op.create_index("ix_tasks_tenant_id", "tasks", ["tenant_id"])
    _enable_rls("tasks")

    op.create_table(
        "server_connectors",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column(
            "connection_config", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.Column("api_key_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="server_connectors_pkey"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_server_connectors_api_key",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_server_connectors_tenant"
        ),
    )
    op.create_index(
        "ix_server_connectors_tenant_id", "server_connectors", ["tenant_id"]
    )
    _enable_rls("server_connectors")
    op.execute(CREATE_TENANT_OF_SERVER_CONNECTOR)

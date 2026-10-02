"""index tenant_id on every tenant table that had no index leading with it

Each of these tables already had a tenant column, a foreign key to `tenants`
and a row-level-security policy filtering on it, but no index whose first
column is `tenant_id` (`uq_<table>_id_tenant` leads with `id`). A query
across one tenant's rows, the policy's filter on such a query, and the
foreign-key check when a tenant row is deleted were each a sequential scan of
the whole table, every tenant's rows included.

**Not `CONCURRENTLY`**, for the same reason as `b8f2d0c41e57`: revisions run
in a transaction, and these tables are small on every deployment today. A
deployment where one is not can build that index by hand first with
`CREATE INDEX CONCURRENTLY ix_<table>_tenant_id ON <table> (tenant_id)`, and
`IF NOT EXISTS` makes this a no-op for it.

Revision ID: 5b8d2e6f0a41
Revises: 9c2e7b4d1a63
Create Date: 2026-10-01 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "5b8d2e6f0a41"
down_revision: str | None = "9c2e7b4d1a63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = (
    "agent_runtime_states",
    "agent_sessions",
    "agent_skills",
    "api_keys",
    "bridge_message_map",
    "client_rooms",
    "collaboration_bridges",
    "delivery_cursors",
    "documents",
    "external_user_claims",
    "external_users",
    "invitations",
    "message_attachments",
    "messaging_install_states",
    "messaging_installs",
    "models",
    "package_documents",
    "package_references",
    "packages",
    "references",
    "role_leases",
    "room_agents",
    "room_documents",
    "room_groups",
    "room_links",
    "room_packages",
    "room_references",
    "room_roles",
    "room_skills",
    "server_connectors",
    "skills",
    "tasks",
    "templates",
    "tools",
    "usage_budgets",
)


def upgrade() -> None:
    for table in _TABLES:
        op.execute(
            f'CREATE INDEX IF NOT EXISTS ix_{table}_tenant_id ON "{table}" (tenant_id)'
        )


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"DROP INDEX IF EXISTS ix_{table}_tenant_id")

"""audit_events: the tenant audit log

One row per security-relevant change in a tenant. Tenant-scoped like every
other table and brings its own `tenant_isolation` policy, for the reason
`5daaea6b674d` gives. The runtime role's `UPDATE` and `DELETE` on it are taken
back by `grant_runtime_role` at the next boot, not here, because that is where
every runtime grant is issued.

The policy DDL below is a verbatim copy of `switch_core/db/rls_ddl.py` as it
stood when this migration was written, copied rather than imported so a later
edit to it cannot change what this revision means.

Revision ID: e4a7c1d93b25
Revises: 5b8d2e6f0a41
Create Date: 2026-10-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e4a7c1d93b25"
down_revision: str | None = "5b8d2e6f0a41"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "audit_events"
POLICY_NAME = "tenant_isolation"
ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'
CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""
DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("actor_user_id", sa.Text(), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Text(), nullable=True),
        sa.Column("details", postgresql.JSONB(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_audit_events_tenant"
        ),
    )
    op.create_index(
        "ix_audit_events_tenant_occurred_at",
        TABLE,
        ["tenant_id", "occurred_at"],
    )
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)


def downgrade() -> None:
    op.execute(DROP_POLICY)
    op.drop_index("ix_audit_events_tenant_occurred_at", table_name=TABLE)
    op.drop_table(TABLE)

"""Persist bridge activity publication journals."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "f5a902bc1843"
down_revision = "e4f8c1a90372"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "session_activity_posts",
        sa.Column("tenant_id", sa.Text(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("bridge_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("command_id", sa.Text(), nullable=False),
        sa.Column("data", postgresql.JSONB(), nullable=False),
        sa.PrimaryKeyConstraint("tenant_id", "bridge_id", "session_id", "command_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "session_id"],
            ["sdk_sessions.tenant_id", "sdk_sessions.id"],
            ondelete="CASCADE",
        ),
    )
    op.execute("ALTER TABLE session_activity_posts ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON session_activity_posts FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("session_activity_posts")

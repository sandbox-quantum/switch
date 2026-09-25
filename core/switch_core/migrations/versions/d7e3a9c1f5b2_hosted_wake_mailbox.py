"""The wake mailbox: every addressed event for a hosted agent until its worker admits it."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "d7e3a9c1f5b2"
down_revision = "c4d8e2f1a9b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "hosted_wake_mailbox",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_hosted_wake_mailbox_tenant"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("message_id", sa.Text(), nullable=False),
        sa.Column("launch_id", sa.Text(), nullable=False),
        sa.Column("thread_id", sa.Text(), nullable=True),
        sa.Column("event", JSONB(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column("ever_offered", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("offered_to", sa.Text(), nullable=True),
        sa.Column("offered_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("origin", sa.Text(), nullable=False, server_default="live"),
        sa.Column("addressed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("tenant_id", "agent_id", "room_id", "message_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'offered', 'accepted', 'admitted', 'held', 'cancelled', 'cancel_requested', 'refused', 'duplicate', 'expired', 'expired_uncertain')",
            name="ck_hosted_wake_mailbox_state",
        ),
        sa.CheckConstraint(
            "cancel_reason IS NULL OR cancel_reason IN ('stopped', 'expired')",
            name="ck_hosted_wake_mailbox_cancel_reason",
        ),
        sa.CheckConstraint(
            "origin IN ('live', 'cutover')", name="ck_hosted_wake_mailbox_origin"
        ),
    )
    op.create_index(
        "ix_hosted_wake_mailbox_agent_state",
        "hosted_wake_mailbox",
        ["tenant_id", "agent_id", "state", "addressed_at"],
    )
    op.execute("ALTER TABLE hosted_wake_mailbox ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON hosted_wake_mailbox FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("hosted_wake_mailbox")

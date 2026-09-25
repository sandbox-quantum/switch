"""A wake mailbox row remembers the room notice it still owes until one is posted."""

import sqlalchemy as sa
from alembic import op

revision = "a6f2c8d4e1b9"
down_revision = "d7e3a9c1f5b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hosted_wake_mailbox", sa.Column("notice_owed", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_hosted_wake_mailbox_notice_owed",
        "hosted_wake_mailbox",
        "notice_owed IS NULL OR notice_owed IN ('stopped', 'expired', 'expired_uncertain', 'started_before_stop', 'started_before_expiry')",
    )
    op.create_index(
        "ix_hosted_wake_mailbox_notice_owed",
        "hosted_wake_mailbox",
        ["tenant_id", "addressed_at"],
        postgresql_where=sa.text("notice_owed IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_hosted_wake_mailbox_notice_owed", table_name="hosted_wake_mailbox"
    )
    op.drop_constraint(
        "ck_hosted_wake_mailbox_notice_owed", "hosted_wake_mailbox", type_="check"
    )
    op.drop_column("hosted_wake_mailbox", "notice_owed")

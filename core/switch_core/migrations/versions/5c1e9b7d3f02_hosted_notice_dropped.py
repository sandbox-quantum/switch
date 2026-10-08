"""A notice that can never be posted records why, instead of being retried or marked posted."""

import sqlalchemy as sa
from alembic import op

revision = "5c1e9b7d3f02"
down_revision = "a6f2c8d4e1b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("hosted_wake_mailbox", "hosted_cutover_items"):
        op.add_column(table, sa.Column("notice_dropped", sa.Text(), nullable=True))
        op.create_check_constraint(
            f"ck_{table}_notice_dropped",
            table,
            "notice_dropped IS NULL OR notice_dropped IN ('agent_deleted')",
        )


def downgrade() -> None:
    for table in ("hosted_cutover_items", "hosted_wake_mailbox"):
        op.drop_constraint(f"ck_{table}_notice_dropped", table, type_="check")
        op.drop_column(table, "notice_dropped")

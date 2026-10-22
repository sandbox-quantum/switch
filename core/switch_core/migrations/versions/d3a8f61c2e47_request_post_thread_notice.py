"""Record when a channel-root card's outcome was told to the thread it came from."""

import sqlalchemy as sa
from alembic import op

revision = "d3a8f61c2e47"
down_revision = "c7715ebb95c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "approval_request_posts",
        sa.Column("thread_notice_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("approval_request_posts", "thread_notice_at")

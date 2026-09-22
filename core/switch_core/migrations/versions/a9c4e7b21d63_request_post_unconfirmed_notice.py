"""Record when a card's unconfirmed delivery was disclosed."""

import sqlalchemy as sa
from alembic import op

revision = "a9c4e7b21d63"
down_revision = "a7b319ce2048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "session_request_posts",
        sa.Column("unconfirmed_notice_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("session_request_posts", "unconfirmed_notice_at")

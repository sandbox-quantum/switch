"""record when an answered request card was taken off the platform

The row has to outlive the card it named: a typed answer still resolves
against it, and without a mark saying the card is gone a restart reads the row
as a card that merely needs redrawing and posts the settled question again.

Null for every card still standing, which is every card there is when this
runs — so no backfill, and an older row is correctly read as not removed.

Revision ID: c1e4b73a0d58
Revises: d94a7f1b5230
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1e4b73a0d58"
down_revision: str | Sequence[str] | None = "d94a7f1b5230"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "session_request_posts",
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("session_request_posts", "removed_at")

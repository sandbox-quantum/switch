"""Persist shared session recovery operations and quiescence."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e9b7d3f50216"
down_revision = "d8a6c2e4f901"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sdk_sessions",
        sa.Column("recovery", postgresql.JSONB(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("sdk_sessions", "recovery")

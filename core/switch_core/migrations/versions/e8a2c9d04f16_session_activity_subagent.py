"""Keep subagent identity on tool activity rows.

Revision ID: e8a2c9d04f16
Revises: f3a8d1c6b927
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e8a2c9d04f16"
down_revision: str | None = "f3a8d1c6b927"
branch_labels = None
depends_on = None
expand_only = True


def upgrade() -> None:
    op.add_column(
        "session_activity_items",
        sa.Column("subagent", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("session_activity_items", "subagent")

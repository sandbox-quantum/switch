"""Keep subagent identity on tool activity rows.

Revision ID: e8a2c9d04f16
Revises: c3d9a1f7b246
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e8a2c9d04f16"
down_revision = "c3d9a1f7b246"
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

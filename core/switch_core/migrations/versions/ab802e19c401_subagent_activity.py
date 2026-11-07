"""Mark tool activity as subagent progress without adding an item kind.

Revision ID: ab802e19c401
Revises: a3d9f6c2b871
"""

import sqlalchemy as sa
from alembic import op

revision = "ab802e19c401"
down_revision = "a3d9f6c2b871"
branch_labels = None
depends_on = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "session_activity_items",
        sa.Column("subagent", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    # Rows remain ordinary tool activity with their descriptions/status intact.
    op.drop_column("session_activity_items", "subagent")

"""An agent's own switch for showing what its tool calls did

Revision ID: c3f8a1d27e54
Revises: b7e1d4c9a2f6
Create Date: 2026-10-31 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision: str = "c3f8a1d27e54"
down_revision: str | None = "b7e1d4c9a2f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("tool_details", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "tool_details")

"""An agent's own switch for showing what its tool calls did

Marked `expand_only`: adding a nullable column only extends the schema, so an
older pod keeps serving through a rolling upgrade.

Revision ID: c3f8a1d27e54
Revises: f3a8d1c6b927
Create Date: 2026-10-31 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision: str = "c3f8a1d27e54"
down_revision: str | None = "f3a8d1c6b927"
branch_labels = None
depends_on = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column("agents", sa.Column("tool_details", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "tool_details")

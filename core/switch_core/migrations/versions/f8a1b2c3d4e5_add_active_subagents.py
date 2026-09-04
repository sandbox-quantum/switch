"""add active_subagents to agent_runtime_states

Revision ID: f8a1b2c3d4e5
Revises: c81f4a06d2b7
Create Date: 2026-09-03 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f8a1b2c3d4e5"
down_revision: str | None = "c81f4a06d2b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runtime_states",
        sa.Column("active_subagents", postgresql.JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_runtime_states", "active_subagents")

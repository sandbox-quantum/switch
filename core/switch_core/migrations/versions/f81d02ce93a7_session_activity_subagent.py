"""Persist subagent labels on tool activity rows.

Revision ID: f81d02ce93a7
Revises: fabf9b9bff78
Create Date: 2026-11-07 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f81d02ce93a7"
down_revision: str | Sequence[str] | None = "f3a8d1c6b927"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "session_activity_items",
        sa.Column("subagent", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_check_constraint(
        "ck_session_activity_items_subagent_kind",
        "session_activity_items",
        "subagent IS NULL OR kind = 'tool-activity'",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_session_activity_items_subagent_kind",
        "session_activity_items",
        type_="check",
    )
    op.drop_column("session_activity_items", "subagent")

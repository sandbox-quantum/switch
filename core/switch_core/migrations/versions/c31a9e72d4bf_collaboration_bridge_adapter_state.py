"""Persist adapter cursors independently of connection credentials.

Revision ID: c31a9e72d4bf
Revises: 10f6d02ac5bc
Create Date: 2026-11-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c31a9e72d4bf"
down_revision: str | None = "10f6d02ac5bc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "collaboration_bridges",
        sa.Column(
            "adapter_state",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("collaboration_bridges", "adapter_state")

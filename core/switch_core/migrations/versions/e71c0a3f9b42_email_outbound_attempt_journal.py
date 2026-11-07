"""Persist outbound platform attempt state on bridge message claims.

Revision ID: e71c0a3f9b42
Revises: a3d9f6c2b871
Create Date: 2026-11-05 16:20:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e71c0a3f9b42"
down_revision: str | None = "a3d9f6c2b871"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "bridge_message_map",
        sa.Column(
            "outbound_attempts",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "bridge_message_map",
        sa.Column(
            "outbound_uncertain",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("bridge_message_map", "outbound_uncertain")
    op.drop_column("bridge_message_map", "outbound_attempts")

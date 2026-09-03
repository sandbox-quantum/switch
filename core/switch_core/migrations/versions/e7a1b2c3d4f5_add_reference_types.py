"""add reference_types

Revision ID: e7a1b2c3d4f5
Revises: a2171c0de1f4
Create Date: 2026-09-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7a1b2c3d4f5"
down_revision: str | None = "a2171c0de1f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reference_types",
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("read_visibility", sa.Text(), nullable=False),
        sa.Column("write_visibility", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("value_hint", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("type"),
    )


def downgrade() -> None:
    op.drop_table("reference_types")

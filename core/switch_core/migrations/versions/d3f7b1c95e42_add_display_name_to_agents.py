"""add display_name to agents

Revision ID: d3f7b1c95e42
Revises: a2171c0de1f4
Create Date: 2026-09-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3f7b1c95e42"
down_revision: str | None = "e7a1b2c3d4f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("display_name", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "display_name")

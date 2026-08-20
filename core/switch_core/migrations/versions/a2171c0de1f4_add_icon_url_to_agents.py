"""add icon_url to agents (CHOO-2171)

Revision ID: a2171c0de1f4
Revises: c2137e4a9b7d
Create Date: 2026-08-16 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a2171c0de1f4"
down_revision: str | None = "c2137e4a9b7d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("icon_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "icon_url")

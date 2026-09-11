"""add repo_url and sources to templates

Revision ID: ddb436ff9c0d
Revises: a3f61c02d5be
Create Date: 2026-09-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "ddb436ff9c0d"
down_revision: str | None = "a3f61c02d5be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("templates", sa.Column("repo_url", sa.Text(), nullable=True))
    op.add_column("templates", sa.Column("sources", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("templates", "sources")
    op.drop_column("templates", "repo_url")

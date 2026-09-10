"""merge shared session and room index migrations

Revision ID: 34bca049f601
Revises: f1a8c4d6e902, b47e0c39a1f5
Create Date: 2026-09-10 15:13:52.042608

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "34bca049f601"
down_revision: str | None = ("f1a8c4d6e902", "b47e0c39a1f5")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

"""merge the template installs and room attachment cascade heads

Two migrations were merged in parallel off the same parent, leaving the chain
with two heads and `alembic upgrade head` ambiguous. Neither carries schema of
its own; this only rejoins them.

Revision ID: e5a9c3d71f08
Revises: a4c1e7b93d20, b7e2f4a91c35
Create Date: 2026-10-28

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "e5a9c3d71f08"
down_revision: str | Sequence[str] | None = ("a4c1e7b93d20", "b7e2f4a91c35")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

"""merge the api_key_id index and display_name heads

Two migrations were merged in parallel off the same parent, leaving the chain
with two heads and `alembic upgrade head` ambiguous. Neither carries schema of
its own; this only rejoins them.

Revision ID: c81f4a06d2b7
Revises: f3b81c47d9a2, d3f7b1c95e42
Create Date: 2026-09-02

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "c81f4a06d2b7"
down_revision: str | Sequence[str] | None = ("f3b81c47d9a2", "d3f7b1c95e42")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

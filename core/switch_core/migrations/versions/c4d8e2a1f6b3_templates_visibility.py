"""a template can be private to its owner, or open for anyone to edit

Revision ID: c4d8e2a1f6b3
Revises: 5daaea6b674d
Create Date: 2026-09-18 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4d8e2a1f6b3"
down_revision: str | None = "5daaea6b674d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The defaults give an existing template the access it had: seen by the
    # whole workspace, changed by its owner or an admin.
    op.add_column(
        "templates",
        sa.Column(
            "read_visibility", sa.Text(), nullable=False, server_default="public"
        ),
    )
    op.add_column(
        "templates",
        sa.Column(
            "write_visibility", sa.Text(), nullable=False, server_default="private"
        ),
    )


def downgrade() -> None:
    op.drop_column("templates", "write_visibility")
    op.drop_column("templates", "read_visibility")

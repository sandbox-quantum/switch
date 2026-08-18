"""add channel_creation_enabled to collaboration_bridges

Revision ID: d1a7c3e58b40
Revises: b3f36489c258
Create Date: 2026-08-13 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d1a7c3e58b40"
down_revision: str | None = "b3f36489c258"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "collaboration_bridges",
        sa.Column(
            "channel_creation_enabled",
            sa.Boolean(),
            server_default="true",
            nullable=False,
        ),
    )
    # Existing connections keep the behaviour they had, which was "whatever the
    # platform allows" — so the operator switch defaults on and the adapter's
    # own ceiling is what turns it off for a platform that never could.
    op.execute(
        "UPDATE collaboration_bridges SET channel_creation_enabled = false "
        "WHERE type = 'telegram'"
    )


def downgrade() -> None:
    op.drop_column("collaboration_bridges", "channel_creation_enabled")

"""add preconfigured to collaboration_bridges

Revision ID: f4c8a2d61e93
Revises: e3b7c9d2a415

Marks a connection the deployment's setup step registered itself, as opposed
to one a person added. Existing rows are left false rather than guessed at: the
setup step marks the connection it owns the next time it runs.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f4c8a2d61e93"
down_revision: str | Sequence[str] | None = "e3b7c9d2a415"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "collaboration_bridges",
        sa.Column(
            "preconfigured",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("collaboration_bridges", "preconfigured")

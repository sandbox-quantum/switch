"""service grant revision: what an issue in flight is checked against

`service_grants.revision` moves on every change to a grant and whenever what
it was issued for ends, such as a cloud launch stopping. The credential broker
records a token only if the grant's revision is the one it issued against, so
a token being issued as the launch stops is taken back rather than left live.

Revision ID: dfc2a46131f1
Revises: 5e04ecff65b8
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "dfc2a46131f1"
down_revision: str | Sequence[str] | None = "5e04ecff65b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "service_grants",
        sa.Column(
            "revision", sa.Integer(), server_default=sa.text("1"), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("service_grants", "revision")

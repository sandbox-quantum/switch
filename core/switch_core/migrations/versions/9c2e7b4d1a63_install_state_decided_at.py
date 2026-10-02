"""messaging_install_states.decided_at, for the install confirmation step

An install's callback no longer claims the workspace on arrival; it asks the
approver to confirm the organisation first. `decided_at` records their Connect
or Cancel, set once by a conditional update.

Revision ID: 9c2e7b4d1a63
Revises: 3e9a6c2b7f14
Create Date: 2026-10-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9c2e7b4d1a63"
down_revision: str | None = "3e9a6c2b7f14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messaging_install_states",
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messaging_install_states", "decided_at")

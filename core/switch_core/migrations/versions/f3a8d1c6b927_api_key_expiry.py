"""api key expiry: ``api_keys.expires_at``

A key whose ``expires_at`` has passed is refused wherever keys are checked.
NULL never expires, which is what every existing key keeps.

Expand only: a process from before this revision neither writes nor reads the
column, so the keys it mints never expire, as before.

Revision ID: f3a8d1c6b927
Revises: c7b2e9f4a1d6
Create Date: 2026-11-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3a8d1c6b927"
down_revision: str | None = "c7b2e9f4a1d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "api_keys",
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("api_keys", "expires_at")

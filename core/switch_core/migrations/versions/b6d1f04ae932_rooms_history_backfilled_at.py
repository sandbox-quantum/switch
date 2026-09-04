"""record when a room's history has been reconstructed

Revision ID: b6d1f04ae932
Revises: a1d7f3c95b60

The backfill always walks from a room's newest message towards its start, so
it cannot tell from the rows alone that it has already finished — a second run
reads every page of every room again to discover it has nothing to write. On a
deployment where the backfill runs unattended at startup, that is the whole
history re-read on every boot.

Null means never completed, which deliberately includes a walk that stopped at
the page limit: that room is only partly reconstructed, and treating it as done
would strand the rest.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b6d1f04ae932"
down_revision: str | Sequence[str] | None = "a1d7f3c95b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("history_backfilled_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rooms", "history_backfilled_at")

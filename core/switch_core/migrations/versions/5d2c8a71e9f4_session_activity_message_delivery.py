"""session activity: how a message sent mid-turn was delivered

A nullable `delivery` column on `session_activity_items`. A host marks a user
message that arrived while another turn was running: `steered` when it was
delivered into that running turn, `queued` when it waits to run as a turn of
its own. Every other row, and every row recorded before the column existed,
is null, which says nothing about delivery.

Revision ID: 5d2c8a71e9f4
Revises: a3d9f6c2b871
Create Date: 2026-11-04 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5d2c8a71e9f4"
down_revision: str | None = "a3d9f6c2b871"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "session_activity_items", sa.Column("delivery", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_session_activity_items_delivery",
        "session_activity_items",
        "delivery IS NULL OR (kind = 'user-message' "
        "AND delivery IN ('steered', 'queued'))",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_session_activity_items_delivery", "session_activity_items", type_="check"
    )
    op.drop_column("session_activity_items", "delivery")

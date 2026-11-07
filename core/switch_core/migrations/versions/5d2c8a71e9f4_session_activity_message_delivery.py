"""session activity: how a message sent mid-turn was delivered

A nullable `delivery` column on `session_activity_items`. A host marks a user
message that arrived while another turn was running: `steered` when it was
delivered into that running turn, `queued` when it waits to run as a turn of
its own. Every other row, and every row recorded before the column existed,
is null, which says nothing about delivery.

Expand only: a process from before this revision never names the column, so
it keeps writing and reading activity rows as it did.

**On locking.** Every pod writes activity rows, so nothing here scans the
table. Adding a nullable column with no default only changes the catalog.
The check constraint is added `NOT VALID`, which also skips the scan: Postgres
enforces it on every row written from then on, and the rows already there
are all null in the new column, so none of them can break it. Revisions run
in one transaction (`migrations/env.py`), so a `VALIDATE CONSTRAINT` here
would scan while this revision still holds its lock, which is exactly the
stall this avoids. Marking the constraint validated is left to a later
release, where `VALIDATE CONSTRAINT` runs on its own and takes only a
`SHARE UPDATE EXCLUSIVE` lock that does not block writes.

Revision ID: 5d2c8a71e9f4
Revises: f3a8d1c6b927
Create Date: 2026-11-04 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5d2c8a71e9f4"
down_revision: str | None = "f3a8d1c6b927"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "session_activity_items", sa.Column("delivery", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_session_activity_items_delivery",
        "session_activity_items",
        "delivery IS NULL OR (kind = 'user-message' "
        "AND delivery IN ('steered', 'queued'))",
        postgresql_not_valid=True,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_session_activity_items_delivery", "session_activity_items", type_="check"
    )
    op.drop_column("session_activity_items", "delivery")

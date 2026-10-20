"""sign_in_flows: a flow settles as connected or failed, with any warning

A sign-in connects as Switch Console hands the code back: that one request
exchanges it, reads the account and writes the connection, where before the
flow waited as `ready` for a confirm step. The flow then stays, holding no
token, so Console can read the outcome: `connected`, with any warning the
write carried, or `failed` with the reason. `status` admits `connected`, and
the row gains a nullable `warning`.

Expand only: every status a process from before this revision writes is still
admitted, and that process never reads `warning`. A `connected` row it reads
it reports as pending, as it does any status it does not know.

Revision ID: bf016e18bc16
Revises: 98c28a6e7c55
Create Date: 2026-10-16 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "bf016e18bc16"
down_revision: str | Sequence[str] | None = "98c28a6e7c55"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "sign_in_flows"
CONSTRAINT = "ck_sign_in_flows_status"
STATUSES_BEFORE = (
    "'pending', 'authorizing', 'returning', 'delivered', 'checking', 'ready', 'failed'"
)
STATUSES = (
    "'pending', 'authorizing', 'returning', 'delivered', 'checking', 'ready', "
    "'connected', 'failed'"
)


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("warning", sa.Text(), nullable=True))
    op.drop_constraint(CONSTRAINT, TABLE, type_="check")
    op.create_check_constraint(CONSTRAINT, TABLE, f"status IN ({STATUSES})")


def downgrade() -> None:
    op.execute(f"DELETE FROM {TABLE} WHERE status = 'connected'")
    op.drop_constraint(CONSTRAINT, TABLE, type_="check")
    op.create_check_constraint(CONSTRAINT, TABLE, f"status IN ({STATUSES_BEFORE})")
    op.drop_column(TABLE, "warning")

"""Give a promised room delivery a durable place in its room's order

Revision ID: 4d18ba7c6f31
Revises: 3c7a91d4e0b6
Create Date: 2026-09-23

A room is answered in the order its messages arrived, and the position each
promise carries is the replay stream's, which starts again from one whenever
the server restarts. Two promises made either side of a restart therefore
compare backwards. The moment the row was written does not, so that is what the
order is taken from, with the message id to break ties.

Rows written before this column existed are dated from the promise they carry:
it was always set to a fixed span after the row was made.
"""

import sqlalchemy as sa
from alembic import op

revision = "4d18ba7c6f31"
down_revision = "3c7a91d4e0b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sdk_room_admissions",
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        "UPDATE sdk_room_admissions SET created_at = expires_at - interval '15 minutes' WHERE created_at IS NULL"
    )
    op.alter_column("sdk_room_admissions", "created_at", nullable=False)


def downgrade() -> None:
    op.drop_column("sdk_room_admissions", "created_at")

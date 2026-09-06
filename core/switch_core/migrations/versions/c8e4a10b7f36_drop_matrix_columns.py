"""drop the homeserver's columns and rename the ones it named

Revision ID: c8e4a10b7f36
Revises: b6d1f04ae932

Four columns on `clients` existed to hold a homeserver session. Nothing has
written them since the transport moved to Postgres: there is no login, so no
access token and no device id; delivery starts at each room's head, so no sync
cursor; and the password was a random value generated to register an account
with a server that is gone. A client is a row, and a row does not authenticate.

`rooms.history_backfilled_at` goes with them. It recorded how far the backfill
had walked, and the backfill is gone: it read the homeserver, which is what
this release removes.

The two renames carry no data change. Both columns already hold Switch-minted
ids — `sw_…`, never `$event` — so the names were the last thing still saying
Matrix. `sender_matrix_id` is also not an id in the foreign-key sense: the real
reference is `sender_client_id` beside it, and this is the denormalised handle
the sender showed under.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8e4a10b7f36"
down_revision: str | Sequence[str] | None = "b6d1f04ae932"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("clients", "password")
    op.drop_column("clients", "device_id")
    op.drop_column("clients", "access_token")
    op.drop_column("clients", "next_batch_token")
    op.drop_column("rooms", "history_backfilled_at")

    op.alter_column(
        "messages", "sender_matrix_id", new_column_name="sender_id", nullable=False
    )
    op.alter_column(
        "bridge_message_map",
        "matrix_event_id",
        new_column_name="transport_event_id",
        nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "bridge_message_map",
        "transport_event_id",
        new_column_name="matrix_event_id",
        nullable=False,
    )
    op.alter_column(
        "messages", "sender_id", new_column_name="sender_matrix_id", nullable=False
    )

    # The dropped values are not recoverable: they were a homeserver's, and
    # there is no homeserver to ask. A downgrade restores the shape so an older
    # revision can run, not the credentials, which that revision would have to
    # re-register anyway.
    op.add_column("clients", sa.Column("next_batch_token", sa.Text(), nullable=True))
    op.add_column("clients", sa.Column("access_token", sa.Text(), nullable=True))
    op.add_column("clients", sa.Column("device_id", sa.Text(), nullable=True))
    op.add_column(
        "clients",
        sa.Column("password", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "rooms",
        sa.Column("history_backfilled_at", sa.DateTime(timezone=True), nullable=True),
    )

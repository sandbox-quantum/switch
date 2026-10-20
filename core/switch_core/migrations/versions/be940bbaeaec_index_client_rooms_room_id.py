"""index client_rooms on room_id for the router

The router reads a room's agent members on every row it writes to that room
(`RoomReads.load`), and once more under the room's lock to find an agent
that joined meanwhile. The primary key is (client_id, room_id), whose leading
column is the client, so neither read could use it and each was a sequential
scan of `client_rooms`.

Not `CONCURRENTLY`, for the reason `b8f2d0c41e57` gives: revisions run in
a transaction, and the table is small on every deployment today. A deployment
where it is not can build the index by hand first, and this becomes a no-op:

    CREATE INDEX CONCURRENTLY ix_client_rooms_room_id ON client_rooms (room_id);

Expand only: a process from before this revision reads the table as it did.

Revision ID: be940bbaeaec
Revises: 87ebf9517271
Create Date: 2026-10-15 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "be940bbaeaec"
down_revision: str | None = "87ebf9517271"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_INDEX = "ix_client_rooms_room_id"


def upgrade() -> None:
    # `IF NOT EXISTS` so an index built by hand ahead of the upgrade is kept.
    op.execute(f"CREATE INDEX IF NOT EXISTS {_INDEX} ON client_rooms (room_id)")


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_INDEX}")

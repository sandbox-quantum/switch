"""index room_agents on agent_id

Reading the rooms an agent is in (`RoomStore.get_rooms_for_agent` and six
other reads by agent), and the check of `fk_room_agents_agent` when an agent
is deleted, filter `room_agents` by agent. The primary key is (room_id,
agent_id), whose leading column is the room, so none could use it and each
was a sequential scan: 2.9 ms at 10,000 agents, and reading the rooms of a
controller's agents, which every process does when a controller connects,
ran it for each of them.

Not `CONCURRENTLY`, for the reason `b8f2d0c41e57` gives: revisions run in
a transaction, and the table is small on every deployment today. A deployment
where it is not can build the index by hand first, and this becomes a no-op:

    CREATE INDEX CONCURRENTLY ix_room_agents_agent_id ON room_agents (agent_id);

Expand only: a process from before this revision reads the table as it did.

Revision ID: 063652bcb450
Revises: bad5099ef32b
Create Date: 2026-11-01 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "063652bcb450"
down_revision: str | None = "bad5099ef32b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_INDEX = "ix_room_agents_agent_id"


def upgrade() -> None:
    # `IF NOT EXISTS` so an index built by hand ahead of the upgrade is kept.
    op.execute(f"CREATE INDEX IF NOT EXISTS {_INDEX} ON room_agents (agent_id)")


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_INDEX}")

"""agent_events: at most one event per agent and source

An agent's consumer decides whether a room row is for the agent and stores the
event in `agent_events`. With more than one switch-core process, the consumer
of each process makes the same decision for the same row, and a write retried
after a commit whose acknowledgement was lost stores the same event again.
Either way the agent would receive the event twice, with two numbers, so
nothing on the reading side could tell the copies apart.

A unique index on the event's source, `(agent_id, message_key, room_id,
room_seq, type)`, lets the second write find the first. Events with no
`message_key` are left out. The index starts with `agent_id, message_key`, so
it also serves the lookups `ix_agent_events_agent_message_key` served, and
replaces it.

Copies stored before this migration are removed first, keeping the lowest
number of each, so the index can always be built. The table is locked against
writes first, so a copy an older release stores while the migration runs
waits for it and then finds the index, rather than landing after the delete
and failing the index build.

Revision ID: c4d8e2f6a913
Revises: b3c7e1d9f2a5
Create Date: 2026-10-13 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4d8e2f6a913"
down_revision: str | None = "b3c7e1d9f2a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "uq_agent_events_source"
REPLACED = "ix_agent_events_agent_message_key"


def upgrade() -> None:
    op.execute("LOCK TABLE agent_events IN SHARE ROW EXCLUSIVE MODE")
    op.execute(
        """
        DELETE FROM agent_events AS later
        USING agent_events AS earlier
        WHERE later.agent_id = earlier.agent_id
          AND later.message_key = earlier.message_key
          AND later.room_id = earlier.room_id
          AND later.room_seq = earlier.room_seq
          AND later.type = earlier.type
          AND later.seq > earlier.seq
        """
    )
    op.create_index(
        INDEX,
        "agent_events",
        ["agent_id", "message_key", "room_id", "room_seq", "type"],
        unique=True,
        postgresql_where=sa.text("message_key IS NOT NULL"),
    )
    op.drop_index(REPLACED, table_name="agent_events")


def downgrade() -> None:
    op.create_index(REPLACED, "agent_events", ["agent_id", "message_key"])
    op.drop_index(INDEX, table_name="agent_events")

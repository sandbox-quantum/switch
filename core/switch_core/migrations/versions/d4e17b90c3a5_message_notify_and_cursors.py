"""announce new messages, and remember how far each agent has been delivered

The trigger makes an insert into `messages` announce itself on commit, so
delivery can be driven by the table rather than by a live bus connection. The
payload is a hint — room, position, row id — and consumers read the row, which
is what keeps a lost notification a latency problem rather than a data one.

`delivery_cursors` persists what the event buffer held in memory, so an agent's
position outlives the process that was serving it.

The DDL below is a verbatim copy of `switch_core/db/notify_ddl.py` as it stood
when this migration was written. It is copied rather than imported on purpose:
a migration is a record of a change that already happened, and importing the
live module would make an old migration mean something new.

Revision ID: d4e17b90c3a5
Revises: c71a4f9d2b83
Create Date: 2026-09-03 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e17b90c3a5"
down_revision: str | None = "c71a4f9d2b83"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CREATE_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_message() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'switch_message',
        json_build_object(
            'room_id', NEW.room_id,
            'seq', NEW.seq,
            'id', NEW.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_NOTIFY_TRIGGER = """
CREATE TRIGGER messages_notify
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION switch_notify_message()
"""


def upgrade() -> None:
    op.execute(CREATE_NOTIFY_FUNCTION)
    op.execute(CREATE_NOTIFY_TRIGGER)

    op.create_table(
        "delivery_cursors",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("last_seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "agent_id", "room_id", name="uq_delivery_cursors_agent_room"
        ),
    )


def downgrade() -> None:
    op.drop_table("delivery_cursors")
    op.execute("DROP TRIGGER IF EXISTS messages_notify ON messages")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_message()")

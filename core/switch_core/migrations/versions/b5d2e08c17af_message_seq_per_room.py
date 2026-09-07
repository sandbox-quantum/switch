"""number messages per room, in commit order

`seq` was a global identity column. A sequence allocates when a statement
runs, not when it commits, so a row could commit behind one with a higher
number and a cursor paging on `seq > n` would step over it permanently. The
column is now assigned per room by the store under an advisory lock, which
makes sequence order and commit order the same order.

Existing rows are renumbered by their old global order, which preserves the
order they were written in.

Revision ID: b5d2e08c17af
Revises: a3f7c91b8e24
Create Date: 2026-09-03 23:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b5d2e08c17af"
down_revision: str | None = "a3f7c91b8e24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The identity has to go before the values can be rewritten: an
    # `always` identity rejects a plain UPDATE.
    op.execute("ALTER TABLE messages ALTER COLUMN seq DROP IDENTITY IF EXISTS")
    op.drop_constraint("messages_seq_key", "messages", type_="unique")
    op.drop_index("ix_messages_room_seq", table_name="messages")
    op.execute(
        """
        UPDATE messages AS m
        SET seq = renumbered.position
        FROM (
            SELECT id, row_number() OVER (PARTITION BY room_id ORDER BY seq)
                AS position
            FROM messages
        ) AS renumbered
        WHERE m.id = renumbered.id
        """
    )
    op.create_unique_constraint("uq_messages_room_seq", "messages", ["room_id", "seq"])


def downgrade() -> None:
    op.drop_constraint("uq_messages_room_seq", "messages", type_="unique")
    # Per-room numbers collide across rooms, so a global identity cannot be
    # restored over them. Renumber globally by the order rows were sent in.
    op.execute(
        """
        UPDATE messages AS m
        SET seq = renumbered.position
        FROM (
            SELECT id, row_number() OVER (ORDER BY sent_at, room_id, seq)
                AS position
            FROM messages
        ) AS renumbered
        WHERE m.id = renumbered.id
        """
    )
    op.create_index("ix_messages_room_seq", "messages", ["room_id", "seq"])
    op.create_unique_constraint("messages_seq_key", "messages", ["seq"])
    op.execute(
        "ALTER TABLE messages ALTER COLUMN seq "
        "ADD GENERATED ALWAYS AS IDENTITY (START WITH 1)"
    )
    op.execute(
        sa.text(
            "SELECT setval("
            "  pg_get_serial_sequence('messages', 'seq'),"
            "  coalesce((SELECT max(seq) FROM messages), 1)"
            ")"
        )
    )

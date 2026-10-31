"""Announce each message's type, and index the rooms' command rows

Switch's own reader (the admin client's `CommandConsumer`) acts on one kind of
row, the `com.switch.command` a person's `!command` is written as, and it was
woken for and read every row of every room to find them. The announcement of a
new row now names its type, so a reader can ask to be woken only for the types
it acts on, and a partial index on the command rows lets it read just those
however far behind its cursor is.

Not `CONCURRENTLY`, for the reason `b8f2d0c41e57` gives: revisions run in a
transaction. The index holds only command rows; a deployment whose `messages`
table is large can build it by hand first, and this becomes a no-op:

    CREATE INDEX CONCURRENTLY ix_messages_room_commands ON messages (room_id, seq)
        WHERE event_type = 'com.switch.command';

Expand only: a process from before this revision ignores the field it does not
read, and reads rooms as it did.

Revision ID: f2a9c7d41e08
Revises: b7e1d4c9a2f6
Create Date: 2026-10-31 00:00:00.000000
"""

from alembic import op

revision: str = "f2a9c7d41e08"
down_revision: str | None = "b7e1d4c9a2f6"
branch_labels = None
depends_on = None
expand_only: bool = True

_INDEX = "ix_messages_room_commands"


def upgrade() -> None:
    op.execute(_WITH_TYPE)
    # `IF NOT EXISTS` so an index built by hand ahead of the upgrade is kept.
    op.execute(
        f"CREATE INDEX IF NOT EXISTS {_INDEX} ON messages (room_id, seq) "
        "WHERE event_type = 'com.switch.command'"
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_INDEX}")
    op.execute(_WITHOUT_TYPE)


# Frozen copies of `switch_core.db.notify_ddl` before and as of this revision;
# the live module may change later, this migration must not.
_WITH_TYPE = """
CREATE OR REPLACE FUNCTION switch_notify_message() RETURNS trigger AS $$
BEGIN
    IF NEW.seq <= 0 THEN
        RETURN NULL;
    END IF;
    PERFORM pg_notify(
        'switch_message',
        json_build_object(
            'room_id', NEW.room_id,
            'seq', NEW.seq,
            'id', NEW.id,
            'type', NEW.event_type
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

_WITHOUT_TYPE = """
CREATE OR REPLACE FUNCTION switch_notify_message() RETURNS trigger AS $$
BEGIN
    IF NEW.seq <= 0 THEN
        RETURN NULL;
    END IF;
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

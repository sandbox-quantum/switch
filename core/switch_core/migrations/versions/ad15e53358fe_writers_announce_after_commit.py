"""Let a writer announce its messages and own events after its commit

A transaction that sends a `NOTIFY` takes a lock that every other notifying
transaction waits on until its commit is durable: on Aurora about 700 such
commits a second for the whole database, whatever its size. The triggers on
`messages` and `agent_events` notified from inside every message's own
transaction, so every message in the system waited on that lock.

The triggers now stand down for a transaction that sets
`switch.writer_announces` to `on`. The router sets it, and once its
transaction has committed it hands the same announcements to the process's
`Announcer`, which sends them in batches, one transaction each. Every other
writer still announces through the triggers.

Expand only: a process from before this revision never sets the setting, so
for it the triggers announce as they did, and its listeners hear this
release's announcements on the same channels with the same payloads.

Revision ID: ad15e53358fe
Revises: 4103210581d6
Create Date: 2026-11-02 00:00:00.000000
"""

from alembic import op

revision: str = "ad15e53358fe"
down_revision: str | None = "4103210581d6"
branch_labels = None
depends_on = None
expand_only: bool = True


def upgrade() -> None:
    op.execute(_MESSAGE_WRITER_ANNOUNCES)
    op.execute(_AGENT_EVENT_WRITER_ANNOUNCES)


def downgrade() -> None:
    op.execute(_AGENT_EVENT_ALWAYS)
    op.execute(_MESSAGE_ALWAYS)


# Frozen copies of `switch_core.db.notify_ddl` and
# `switch_core.db.agent_event_notify_ddl` as of this revision and before it;
# the live modules may change later, this migration must not.
_MESSAGE_WRITER_ANNOUNCES = """
CREATE OR REPLACE FUNCTION switch_notify_message() RETURNS trigger AS $$
BEGIN
    IF NEW.seq <= 0 THEN
        RETURN NULL;
    END IF;
    IF current_setting('switch.writer_announces', true) = 'on' THEN
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

_AGENT_EVENT_WRITER_ANNOUNCES = """
CREATE OR REPLACE FUNCTION switch_notify_agent_event() RETURNS trigger AS $$
BEGIN
    IF current_setting('switch.writer_announces', true) = 'on' THEN
        RETURN NULL;
    END IF;
    PERFORM pg_notify(
        'switch_agent_event',
        json_build_object('agent_id', NEW.agent_id, 'seq', NEW.seq)::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

_MESSAGE_ALWAYS = """
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

_AGENT_EVENT_ALWAYS = """
CREATE OR REPLACE FUNCTION switch_notify_agent_event() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'switch_agent_event',
        json_build_object('agent_id', NEW.agent_id, 'seq', NEW.seq)::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

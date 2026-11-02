"""The database side of message delivery: a trigger that announces new rows.

Delivery is the table announcing its own inserts, and a listener reading the
rows back.

**The notification is a hint, never the payload.** It carries a room, a
position, a row id and the row's type, and a consumer reads the row itself.
The type lets a reader that acts on some kinds of row only be woken for those
(`MessageListener.subscribe`). That is what makes
a lost notification cost latency instead of data: a consumer that keeps a
position can always ask what it has not seen, and one that never hears
anything is behind rather than wrong. Putting the message in the payload would
make the queue authoritative, and Postgres's notification queue is neither
durable nor replayable.

**It is a trigger rather than a call in the writer** so that it cannot be
forgotten. Anything that inserts a row (a send, a backfill, a human with
psql) announces it, and the announcement commits with
the row or not at all. `NOTIFY` is only delivered on commit, so a listener
never learns about a row it could not then read.

**The router announces its own rows instead.** A transaction that notifies
takes a database-wide lock until its commit is durable, so every message
announced from inside its own transaction waits on every other one: on Aurora
about 700 a second for the whole database. The router writes nearly every row,
so it sets `WRITER_ANNOUNCES` in its transaction, the trigger stands down for
that transaction, and the router hands the same announcement to the process's
`Announcer` once it has committed, which sends a batch in one transaction.
Every other writer still announces through the trigger.

One channel carries every room, and listeners filter. A channel per room would
save wakeups, but each one needs a `LISTEN` issued before the first row it
should catch, which is a race the consumer has to close by reading the table
anyway — so the correctness machinery is identical and the subscription churn
is pure cost. See `switch_core/messages/notify.py` for the in-process fan-out
that does the filtering.

The migration that installs this on a real database carries its own verbatim
copy: a migration is frozen at the moment it was written and must not change
meaning because this file did. The copy here is what `create_all` builds, so
tests exercise the same trigger the server runs.
"""

from __future__ import annotations

import json

# Deliberately not per-room. See the module docstring.
MESSAGE_CHANNEL = "switch_message"

# Set for one transaction by a writer that announces its rows itself, after
# its commit (`announcer.py`): the triggers on `messages` and `agent_events`
# then send nothing for that transaction. A writer that sets it must announce
# every row of either table it writes in that transaction.
WRITER_ANNOUNCES_SETTING = "switch.writer_announces"
SET_WRITER_ANNOUNCES = f"set_config('{WRITER_ANNOUNCES_SETTING}', 'on', true)"

NOTIFY_FUNCTION_NAME = "switch_notify_message"
NOTIFY_TRIGGER_NAME = "messages_notify"

CREATE_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
BEGIN
    -- Reconstructed history is numbered below zero and is not news. A backfill
    -- inserts thousands of rows nobody is waiting for, and announcing them
    -- would wake every subscriber in the room to read nothing, because their
    -- cursors are above these positions by construction.
    IF NEW.seq <= 0 THEN
        RETURN NULL;
    END IF;
    -- The writer announces this row itself, after its commit.
    IF current_setting('{WRITER_ANNOUNCES_SETTING}', true) = 'on' THEN
        RETURN NULL;
    END IF;
    PERFORM pg_notify(
        '{MESSAGE_CHANNEL}',
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

CREATE_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {NOTIFY_TRIGGER_NAME}
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION {NOTIFY_FUNCTION_NAME}()
"""

DROP_NOTIFY_TRIGGER = f"DROP TRIGGER IF EXISTS {NOTIFY_TRIGGER_NAME} ON messages"
DROP_NOTIFY_FUNCTION = f"DROP FUNCTION IF EXISTS {NOTIFY_FUNCTION_NAME}()"


def message_announcement(room_id: str, seq: int, message_id: str, row_type: str) -> str:
    """What the trigger sends for a row, for a writer that announces it itself."""
    return json.dumps(
        {"room_id": room_id, "seq": seq, "id": message_id, "type": row_type},
        separators=(",", ":"),
    )

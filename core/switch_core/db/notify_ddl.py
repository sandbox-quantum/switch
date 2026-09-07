"""The database side of message delivery: a trigger that announces new rows.

Delivery used to be the message bus pushing an event at a long-lived sync
connection. It becomes the table announcing its own inserts, and a listener
reading the rows back.

**The notification is a hint, never the payload.** It carries a room, a
position and a row id, and a consumer reads the row itself. That is what makes
a lost notification cost latency instead of data: a consumer that keeps a
position can always ask what it has not seen, and one that never hears
anything is behind rather than wrong. Putting the message in the payload would
make the queue authoritative, and Postgres's notification queue is neither
durable nor replayable.

**It is a trigger rather than a call in the writer** so that it cannot be
forgotten. Anything that inserts a row — the recorder today, a backfill
tomorrow, a human with psql — announces it, and the announcement commits with
the row or not at all. `NOTIFY` is only delivered on commit, so a listener
never learns about a row it could not then read.

One channel carries every room, and listeners filter. A channel per room would
save wakeups, but each one needs a `LISTEN` issued before the first row it
should catch, which is a race the consumer has to close by reading the table
anyway — so the correctness machinery is identical and the subscription churn
is pure cost. See `switch_core/messages/notify.py` for the in-process fan-out
that replaces it.

The migration that installs this on a real database carries its own verbatim
copy: a migration is frozen at the moment it was written and must not change
meaning because this file did. The copy here is what `create_all` builds, so
tests exercise the same trigger the server runs.
"""

from __future__ import annotations

# Deliberately not per-room. See the module docstring.
MESSAGE_CHANNEL = "switch_message"

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
    PERFORM pg_notify(
        '{MESSAGE_CHANNEL}',
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

CREATE_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {NOTIFY_TRIGGER_NAME}
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION {NOTIFY_FUNCTION_NAME}()
"""

DROP_NOTIFY_TRIGGER = f"DROP TRIGGER IF EXISTS {NOTIFY_TRIGGER_NAME} ON messages"
DROP_NOTIFY_FUNCTION = f"DROP FUNCTION IF EXISTS {NOTIFY_FUNCTION_NAME}()"

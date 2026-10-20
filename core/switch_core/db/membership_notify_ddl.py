"""The trigger that announces each change to `client_rooms` as a signal.

A client reads the rooms it is a member of, and every switch-core process runs
its own copy of each client, so a membership written by one process has to
reach the copies in all of them: the one added must start reading the room,
and the one removed must stop. Removal is an access-control decision, so it
cannot depend on every writer remembering to say so. Memberships are written
from several places (an invitation, a join, room provisioning, a room or
client deleted with its rows), and a trigger is the one place none of them can
skip, as `notify_ddl.py` argues for messages.

The notification goes out on the `SignalBus` channel as an ordinary signal,
`membership.changed`, naming the tenant, the client and the room. It carries no
sender process, so every process handles it, the writer's included, and each
re-reads that client's rows rather than trusting the payload
(`transport/membership_signals.py`). `NOTIFY` is delivered on commit, so a
process never hears of a membership it could not then read.

The migration that installs this carries its own copy, frozen as it was
written; this copy is what `create_all` builds for the tests.
"""

from __future__ import annotations

from switch_core.signals import SIGNAL_CHANNEL

MEMBERSHIP_CHANGED_SIGNAL = "membership.changed"

MEMBERSHIP_NOTIFY_FUNCTION_NAME = "switch_notify_membership"
MEMBERSHIP_NOTIFY_TRIGGER_NAME = "client_rooms_notify"

CREATE_MEMBERSHIP_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {MEMBERSHIP_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
    changed client_rooms;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        '{SIGNAL_CHANNEL}',
        json_build_object(
            'kind', '{MEMBERSHIP_CHANGED_SIGNAL}',
            'tenant_id', changed.tenant_id,
            'client_id', changed.client_id,
            'room_id', changed.room_id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_MEMBERSHIP_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {MEMBERSHIP_NOTIFY_TRIGGER_NAME}
    AFTER INSERT OR DELETE ON client_rooms
    FOR EACH ROW EXECUTE FUNCTION {MEMBERSHIP_NOTIFY_FUNCTION_NAME}()
"""

DROP_MEMBERSHIP_NOTIFY_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {MEMBERSHIP_NOTIFY_TRIGGER_NAME} ON client_rooms"
)
DROP_MEMBERSHIP_NOTIFY_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {MEMBERSHIP_NOTIFY_FUNCTION_NAME}()"
)

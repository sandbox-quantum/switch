"""The triggers that announce changes to what a post or a context read checks
first, as signals.

Every post an agent makes checks that the agent is in the room, reading the
room's row and the agent's `room_agents` row, and that no budget covering the
agent has run out. A controller relaying the post checks the membership once
more, for the room it names. Each process keeps the rows those checks read
(`RoomAccessCache`) for as long as its signal connection listens and no signal
says they changed. Memberships are written from several places (a join, an
invitation, room provisioning, a room or agent deleted with its rows), so, as
`membership_notify_ddl.py` argues for `client_rooms`, a trigger is the one
place none of them can skip.

`room_agent.changed` names the tenant, the room and the agent, for a
membership added or removed. `room.changed` names the tenant and the room, when
a column the room's descriptor carries changes and when the room is deleted;
the room's other columns send nothing. `budgets.changed` names the tenant, for
any change to its budgets. None carries a sender process, so every process
handles them, the writer's included, and `NOTIFY` is delivered on commit.

The migration that installs these carries its own copy, frozen as it was
written; this copy is what `create_all` builds for the tests.
"""

from __future__ import annotations

from switch_core.signals import SIGNAL_CHANNEL

ROOM_AGENT_CHANGED_SIGNAL = "room_agent.changed"
ROOM_CHANGED_SIGNAL = "room.changed"
BUDGETS_CHANGED_SIGNAL = "budgets.changed"

ROOM_AGENT_NOTIFY_FUNCTION_NAME = "switch_notify_room_agent_changed"
ROOM_AGENT_NOTIFY_TRIGGER_NAME = "room_agents_notify_changed"
ROOM_NOTIFY_FUNCTION_NAME = "switch_notify_room_changed"
ROOM_NOTIFY_TRIGGER_NAME = "rooms_notify_changed"
BUDGETS_NOTIFY_FUNCTION_NAME = "switch_notify_budgets_changed"
BUDGETS_NOTIFY_TRIGGER_NAME = "usage_budgets_notify_changed"

CREATE_ROOM_AGENT_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {ROOM_AGENT_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
    changed room_agents;
BEGIN
    IF TG_OP = 'INSERT' THEN
        changed := NEW;
    ELSE
        changed := OLD;
    END IF;
    PERFORM pg_notify(
        '{SIGNAL_CHANNEL}',
        json_build_object(
            'kind', '{ROOM_AGENT_CHANGED_SIGNAL}',
            'tenant_id', changed.tenant_id,
            'room_id', changed.room_id,
            'agent_id', changed.agent_id
        )::text
    );
    IF TG_OP = 'UPDATE' THEN
        PERFORM pg_notify(
            '{SIGNAL_CHANNEL}',
            json_build_object(
                'kind', '{ROOM_AGENT_CHANGED_SIGNAL}',
                'tenant_id', NEW.tenant_id,
                'room_id', NEW.room_id,
                'agent_id', NEW.agent_id
            )::text
        );
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_ROOM_AGENT_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {ROOM_AGENT_NOTIFY_TRIGGER_NAME}
    AFTER INSERT OR UPDATE OF room_id, agent_id OR DELETE ON room_agents
    FOR EACH ROW EXECUTE FUNCTION {ROOM_AGENT_NOTIFY_FUNCTION_NAME}()
"""

CREATE_ROOM_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {ROOM_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
    changed rooms;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSIF NEW.matrix_room_id IS NOT DISTINCT FROM OLD.matrix_room_id
        AND NEW.name IS NOT DISTINCT FROM OLD.name
        AND NEW.description IS NOT DISTINCT FROM OLD.description
        AND NEW.bridge_id IS NOT DISTINCT FROM OLD.bridge_id
        AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
        RETURN NULL;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        '{SIGNAL_CHANNEL}',
        json_build_object(
            'kind', '{ROOM_CHANGED_SIGNAL}',
            'tenant_id', changed.tenant_id,
            'room_id', changed.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_ROOM_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {ROOM_NOTIFY_TRIGGER_NAME}
    AFTER UPDATE OF matrix_room_id, name, description, bridge_id, archived_at
        OR DELETE ON rooms
    FOR EACH ROW EXECUTE FUNCTION {ROOM_NOTIFY_FUNCTION_NAME}()
"""

CREATE_BUDGETS_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {BUDGETS_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
    changed usage_budgets;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        '{SIGNAL_CHANNEL}',
        json_build_object(
            'kind', '{BUDGETS_CHANGED_SIGNAL}',
            'tenant_id', changed.tenant_id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_BUDGETS_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {BUDGETS_NOTIFY_TRIGGER_NAME}
    AFTER INSERT OR UPDATE OR DELETE ON usage_budgets
    FOR EACH ROW EXECUTE FUNCTION {BUDGETS_NOTIFY_FUNCTION_NAME}()
"""

DROP_ROOM_AGENT_NOTIFY_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {ROOM_AGENT_NOTIFY_TRIGGER_NAME} ON room_agents"
)
DROP_ROOM_AGENT_NOTIFY_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {ROOM_AGENT_NOTIFY_FUNCTION_NAME}()"
)
DROP_ROOM_NOTIFY_TRIGGER = f"DROP TRIGGER IF EXISTS {ROOM_NOTIFY_TRIGGER_NAME} ON rooms"
DROP_ROOM_NOTIFY_FUNCTION = f"DROP FUNCTION IF EXISTS {ROOM_NOTIFY_FUNCTION_NAME}()"
DROP_BUDGETS_NOTIFY_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {BUDGETS_NOTIFY_TRIGGER_NAME} ON usage_budgets"
)
DROP_BUDGETS_NOTIFY_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {BUDGETS_NOTIFY_FUNCTION_NAME}()"
)

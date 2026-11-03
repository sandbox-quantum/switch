"""room_access_notify: signal every switch-core process when an agent joins or
leaves a room, a room's descriptor changes, or a tenant's budgets do

Every process keeps what a post checks first: that the agent is in the room,
with the room's descriptor, and whether any budget covers the agent. These
triggers send `room_agent.changed` when a `room_agents` row is added or
removed, `room.changed` when a column of a room's descriptor changes or the
room is deleted, and `budgets.changed` for any change to a tenant's budgets,
so every process drops what it kept of them.

Expand only: a process from before this revision has no handler for these
signals and skips them, as it does any kind it does not know.

Revision ID: 4103210581d6
Revises: 063652bcb450
Create Date: 2026-11-01 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "4103210581d6"
down_revision: str | None = "063652bcb450"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

# Copies of the DDL in `db/room_access_notify_ddl.py`, written out here so this
# migration keeps creating the same objects if that module changes.
CREATE_ROOM_AGENT_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_room_agent_changed() RETURNS trigger AS $$
DECLARE
    changed room_agents;
BEGIN
    IF TG_OP = 'INSERT' THEN
        changed := NEW;
    ELSE
        changed := OLD;
    END IF;
    PERFORM pg_notify(
        'switch_signal',
        json_build_object(
            'kind', 'room_agent.changed',
            'tenant_id', changed.tenant_id,
            'room_id', changed.room_id,
            'agent_id', changed.agent_id
        )::text
    );
    IF TG_OP = 'UPDATE' THEN
        PERFORM pg_notify(
            'switch_signal',
            json_build_object(
                'kind', 'room_agent.changed',
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

CREATE_ROOM_AGENT_NOTIFY_TRIGGER = """
CREATE TRIGGER room_agents_notify_changed
    AFTER INSERT OR UPDATE OF room_id, agent_id OR DELETE ON room_agents
    FOR EACH ROW EXECUTE FUNCTION switch_notify_room_agent_changed()
"""

CREATE_ROOM_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_room_changed() RETURNS trigger AS $$
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
        'switch_signal',
        json_build_object(
            'kind', 'room.changed',
            'tenant_id', changed.tenant_id,
            'room_id', changed.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_ROOM_NOTIFY_TRIGGER = """
CREATE TRIGGER rooms_notify_changed
    AFTER UPDATE OF matrix_room_id, name, description, bridge_id, archived_at
        OR DELETE ON rooms
    FOR EACH ROW EXECUTE FUNCTION switch_notify_room_changed()
"""

CREATE_BUDGETS_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_budgets_changed() RETURNS trigger AS $$
DECLARE
    changed usage_budgets;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        'switch_signal',
        json_build_object(
            'kind', 'budgets.changed',
            'tenant_id', changed.tenant_id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_BUDGETS_NOTIFY_TRIGGER = """
CREATE TRIGGER usage_budgets_notify_changed
    AFTER INSERT OR UPDATE OR DELETE ON usage_budgets
    FOR EACH ROW EXECUTE FUNCTION switch_notify_budgets_changed()
"""


def upgrade() -> None:
    op.execute(CREATE_ROOM_AGENT_NOTIFY_FUNCTION)
    op.execute(CREATE_ROOM_AGENT_NOTIFY_TRIGGER)
    op.execute(CREATE_ROOM_NOTIFY_FUNCTION)
    op.execute(CREATE_ROOM_NOTIFY_TRIGGER)
    op.execute(CREATE_BUDGETS_NOTIFY_FUNCTION)
    op.execute(CREATE_BUDGETS_NOTIFY_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS usage_budgets_notify_changed ON usage_budgets")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_budgets_changed()")
    op.execute("DROP TRIGGER IF EXISTS rooms_notify_changed ON rooms")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_room_changed()")
    op.execute("DROP TRIGGER IF EXISTS room_agents_notify_changed ON room_agents")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_room_agent_changed()")

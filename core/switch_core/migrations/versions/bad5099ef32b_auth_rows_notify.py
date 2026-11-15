"""auth_rows_notify: signal every switch-core process when an agent's row or a
controller's authority changes

Every process keeps the controller and agent rows a controller access token's
requests are authorized with. These triggers send `agent.changed` on the
`switch_signal` channel for every update that changes an agent's row and for
its deletion, and `controller.auth_changed` when a controller's owner,
credential or revocation changes and when it is deleted, so every process
drops what it kept of them.

Expand only: a process from before this revision has no handler for either
signal and skips them, as it does any kind it does not know.

Revision ID: bad5099ef32b
Revises: f2a9c7d41e08
Create Date: 2026-11-01 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "bad5099ef32b"
down_revision: str | None = "f2a9c7d41e08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

# Copies of the DDL in `db/auth_rows_notify_ddl.py`, written out here so this
# migration keeps creating the same objects if that module changes.
CREATE_AGENT_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_agent_changed() RETURNS trigger AS $$
DECLARE
    changed agents;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSIF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NULL;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        'switch_signal',
        json_build_object(
            'kind', 'agent.changed',
            'tenant_id', changed.tenant_id,
            'agent_id', changed.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_AGENT_NOTIFY_TRIGGER = """
CREATE TRIGGER agents_notify_changed
    AFTER UPDATE OR DELETE ON agents
    FOR EACH ROW EXECUTE FUNCTION switch_notify_agent_changed()
"""

CREATE_CONTROLLER_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_controller_auth_changed() RETURNS trigger AS $$
DECLARE
    changed agent_controllers;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSIF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id
        AND NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at
        AND NEW.api_key_id IS NOT DISTINCT FROM OLD.api_key_id THEN
        RETURN NULL;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        'switch_signal',
        json_build_object(
            'kind', 'controller.auth_changed',
            'tenant_id', changed.tenant_id,
            'controller_id', changed.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_CONTROLLER_NOTIFY_TRIGGER = """
CREATE TRIGGER agent_controllers_notify_auth_changed
    AFTER UPDATE OF owner_id, revoked_at, api_key_id OR DELETE ON agent_controllers
    FOR EACH ROW EXECUTE FUNCTION switch_notify_controller_auth_changed()
"""


def upgrade() -> None:
    op.execute(CREATE_AGENT_NOTIFY_FUNCTION)
    op.execute(CREATE_AGENT_NOTIFY_TRIGGER)
    op.execute(CREATE_CONTROLLER_NOTIFY_FUNCTION)
    op.execute(CREATE_CONTROLLER_NOTIFY_TRIGGER)


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS agent_controllers_notify_auth_changed "
        "ON agent_controllers"
    )
    op.execute("DROP FUNCTION IF EXISTS switch_notify_controller_auth_changed()")
    op.execute("DROP TRIGGER IF EXISTS agents_notify_changed ON agents")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_agent_changed()")

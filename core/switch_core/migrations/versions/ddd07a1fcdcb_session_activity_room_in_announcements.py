"""Session activity announcements carry the room

A turn step's announcement, and an approval request announced by key because
its row is too large, now name the step's or request's room (`room_id`, null
outside any room), so a subscriber can tell whom the change concerns without
reading the row. Replaces the notify function only.

Revision ID: ddd07a1fcdcb
Revises: f4a9c2e7b153
Create Date: 2026-10-19 00:00:00.000000
"""

from alembic import op

revision: str = "ddd07a1fcdcb"
down_revision: str | None = "f4a9c2e7b153"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(_NOTIFY_FUNCTION)


def downgrade() -> None:
    op.execute(_PREVIOUS_NOTIFY_FUNCTION)


# Frozen copy of `switch_core.db.session_activity_notify_ddl` as of this
# revision; the live module may change later, this migration must not.
_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_session_activity() RETURNS trigger AS $$
DECLARE
    body jsonb := to_jsonb(NEW);
    key jsonb;
    payload text;
BEGIN
    IF TG_TABLE_NAME = 'session_activity_items' THEN
        key := jsonb_build_object(
            'tenant_id', NEW.tenant_id,
            'agent_id', NEW.agent_id,
            'session_id', NEW.session_id,
            'room_id', NEW.room_id,
            'key', body->>'turn_id'
        );
        payload := jsonb_build_object('table', TG_TABLE_NAME, 'key', key)::text;
    ELSE
        key := jsonb_build_object(
            'tenant_id', NEW.tenant_id,
            'agent_id', NEW.agent_id,
            'session_id', NEW.session_id,
            'room_id', NEW.room_id,
            'key', body->>'request_id'
        );
        payload := jsonb_build_object('table', TG_TABLE_NAME, 'row', body)::text;
        IF octet_length(payload) > 7500 THEN
            payload := jsonb_build_object('table', TG_TABLE_NAME, 'key', key)::text;
        END IF;
    END IF;
    PERFORM pg_notify('switch_session_activity', payload);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

# As `c4f7e2a90b13` installed it.
_PREVIOUS_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_session_activity() RETURNS trigger AS $$
DECLARE
    body jsonb := to_jsonb(NEW);
    key jsonb;
    payload text;
BEGIN
    IF TG_TABLE_NAME = 'session_activity_items' THEN
        key := jsonb_build_object(
            'tenant_id', NEW.tenant_id,
            'agent_id', NEW.agent_id,
            'session_id', NEW.session_id,
            'key', body->>'turn_id'
        );
        payload := jsonb_build_object('table', TG_TABLE_NAME, 'key', key)::text;
    ELSE
        key := jsonb_build_object(
            'tenant_id', NEW.tenant_id,
            'agent_id', NEW.agent_id,
            'session_id', NEW.session_id,
            'key', body->>'request_id'
        );
        payload := jsonb_build_object('table', TG_TABLE_NAME, 'row', body)::text;
        IF octet_length(payload) > 7500 THEN
            payload := jsonb_build_object('table', TG_TABLE_NAME, 'key', key)::text;
        END IF;
    END IF;
    PERFORM pg_notify('switch_session_activity', payload);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

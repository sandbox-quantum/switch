"""Session activity announcements name the step

A turn step's announcement now also names the step (`item_id`, `revision`),
so a subscriber showing steps one by one reads only the one that moved, and
none it already sent. Replaces the notify function only.

Revision ID: b7e1d4c9a2f6
Revises: ddd07a1fcdcb
Create Date: 2026-10-28 00:00:00.000000
"""

from alembic import op

revision: str = "b7e1d4c9a2f6"
down_revision: str | None = "ddd07a1fcdcb"
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
            'key', body->>'turn_id',
            'item_id', NEW.item_id,
            'revision', NEW.revision
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

# As `ddd07a1fcdcb` installed it.
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

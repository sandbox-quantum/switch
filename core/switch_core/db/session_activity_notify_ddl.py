"""The database side of session-activity push: triggers that announce changes.

Same shape as `notify_ddl.py` for messages — a trigger, so no writer can forget
to announce, and `NOTIFY`, so the announcement is delivered on commit or not at
all, and reaches every server process rather than only the one that wrote.

An approval request's announcement **carries the row**: the agent stream
pushes an outcome on without reading anything back. `pg_notify` payloads are
capped just under 8000 bytes, so a request too large to fit is announced by key
alone and the subscriber reads that one row.

A turn step's announcement carries only the turn it belongs to
(`agent_id`, `session_id`, `turn_id`). Its subscriber, a bridge, redraws the
whole turn from its rows on every change anyway, and a step's text is too
large to ride along often enough to be worth the branch.

Fires on every insert or update of `session_activity_items`, every insert into
`approval_requests`, and an approval request's change of state (answered,
expired, closed). Recording delivery is not news to anyone and announces
nothing.

The migration that installs this carries its own verbatim copy; this one is
what `create_all` builds for tests.
"""

from __future__ import annotations

SESSION_ACTIVITY_CHANNEL = "switch_session_activity"
SESSION_ACTIVITY_NOTIFY_FUNCTION = "switch_notify_session_activity"
# Room under Postgres's 8000-byte payload limit for the envelope around the row.
MAX_ROW_PAYLOAD_BYTES = 7500

CREATE_SESSION_ACTIVITY_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {SESSION_ACTIVITY_NOTIFY_FUNCTION}() RETURNS trigger AS $$
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
        IF octet_length(payload) > {MAX_ROW_PAYLOAD_BYTES} THEN
            payload := jsonb_build_object('table', TG_TABLE_NAME, 'key', key)::text;
        END IF;
    END IF;
    PERFORM pg_notify('{SESSION_ACTIVITY_CHANNEL}', payload);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_ACTIVITY_TRIGGER = f"""
CREATE TRIGGER session_activity_items_notify
    AFTER INSERT OR UPDATE ON session_activity_items
    FOR EACH ROW EXECUTE FUNCTION {SESSION_ACTIVITY_NOTIFY_FUNCTION}()
"""

CREATE_APPROVAL_INSERT_TRIGGER = f"""
CREATE TRIGGER approval_requests_notify_insert
    AFTER INSERT ON approval_requests
    FOR EACH ROW EXECUTE FUNCTION {SESSION_ACTIVITY_NOTIFY_FUNCTION}()
"""

CREATE_APPROVAL_STATE_TRIGGER = f"""
CREATE TRIGGER approval_requests_notify_state
    AFTER UPDATE OF state ON approval_requests
    FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION {SESSION_ACTIVITY_NOTIFY_FUNCTION}()
"""

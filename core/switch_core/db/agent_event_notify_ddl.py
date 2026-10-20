"""The trigger that sends a Postgres `NOTIFY` for each new row in `agent_events`.

It follows the design `notify_ddl.py` describes for `messages`. The payload
carries only the agent id and the new row's `seq`, never the event itself.
The notification wakes the server process that holds the agent's
connection, and that process reads the new rows from the table, so a lost
notification delays delivery but loses nothing.
`bridges/agent/protocol/agent_event_listener.py` is the process side that
listens on the channel.
"""

AGENT_EVENT_CHANNEL = "switch_agent_event"

AGENT_EVENT_NOTIFY_FUNCTION_NAME = "switch_notify_agent_event"
AGENT_EVENT_NOTIFY_TRIGGER_NAME = "agent_events_notify"

CREATE_AGENT_EVENT_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {AGENT_EVENT_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        '{AGENT_EVENT_CHANNEL}',
        json_build_object('agent_id', NEW.agent_id, 'seq', NEW.seq)::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_AGENT_EVENT_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {AGENT_EVENT_NOTIFY_TRIGGER_NAME}
    AFTER INSERT ON agent_events
    FOR EACH ROW EXECUTE FUNCTION {AGENT_EVENT_NOTIFY_FUNCTION_NAME}()
"""

DROP_AGENT_EVENT_NOTIFY_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {AGENT_EVENT_NOTIFY_TRIGGER_NAME} ON agent_events"
)
DROP_AGENT_EVENT_NOTIFY_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {AGENT_EVENT_NOTIFY_FUNCTION_NAME}()"
)

"""The triggers that announce changes to the rows a controller access token
is authorized with, as signals.

Every process keeps the rows a controller token's requests read
(`ControllerAuthCache`): the controller's, to refuse one revoked while its
token is unexpired, and the row of the agent it acts as. It keeps them for as
long as its signal connection listens and no signal says they changed. An
agent's row is written from several places (a rename, its addressing policy,
a template update, a deletion with its owner or workspace), and a controller's
revocation commits in one process and is announced by it after the commit, so
neither can depend on every writer remembering to say so. A trigger is the one
place none of them can skip, as `membership_notify_ddl.py` argues for
memberships.

`agent.changed` names the tenant and the agent, for any update that changes
the row and for a deletion. `controller.auth_changed` names the tenant and the
controller, when its owner, its credential or its revocation changes and when
it is deleted; the status, connection and assignment columns a controller
writes every few seconds send nothing. Neither carries a sender process, so
every process handles them, the writer's included. `NOTIFY` is delivered on
commit, so a process never hears of a change it could not then read.

The migration that installs these carries its own copy, frozen as it was
written; this copy is what `create_all` builds for the tests.
"""

from __future__ import annotations

from switch_core.signals import SIGNAL_CHANNEL

AGENT_CHANGED_SIGNAL = "agent.changed"
CONTROLLER_AUTH_CHANGED_SIGNAL = "controller.auth_changed"

AGENT_NOTIFY_FUNCTION_NAME = "switch_notify_agent_changed"
AGENT_NOTIFY_TRIGGER_NAME = "agents_notify_changed"
CONTROLLER_NOTIFY_FUNCTION_NAME = "switch_notify_controller_auth_changed"
CONTROLLER_NOTIFY_TRIGGER_NAME = "agent_controllers_notify_auth_changed"

CREATE_AGENT_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {AGENT_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
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
        '{SIGNAL_CHANNEL}',
        json_build_object(
            'kind', '{AGENT_CHANGED_SIGNAL}',
            'tenant_id', changed.tenant_id,
            'agent_id', changed.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_AGENT_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {AGENT_NOTIFY_TRIGGER_NAME}
    AFTER UPDATE OR DELETE ON agents
    FOR EACH ROW EXECUTE FUNCTION {AGENT_NOTIFY_FUNCTION_NAME}()
"""

CREATE_CONTROLLER_NOTIFY_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {CONTROLLER_NOTIFY_FUNCTION_NAME}() RETURNS trigger AS $$
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
        '{SIGNAL_CHANNEL}',
        json_build_object(
            'kind', '{CONTROLLER_AUTH_CHANGED_SIGNAL}',
            'tenant_id', changed.tenant_id,
            'controller_id', changed.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_CONTROLLER_NOTIFY_TRIGGER = f"""
CREATE TRIGGER {CONTROLLER_NOTIFY_TRIGGER_NAME}
    AFTER UPDATE OF owner_id, revoked_at, api_key_id OR DELETE ON agent_controllers
    FOR EACH ROW EXECUTE FUNCTION {CONTROLLER_NOTIFY_FUNCTION_NAME}()
"""

DROP_AGENT_NOTIFY_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {AGENT_NOTIFY_TRIGGER_NAME} ON agents"
)
DROP_AGENT_NOTIFY_FUNCTION = f"DROP FUNCTION IF EXISTS {AGENT_NOTIFY_FUNCTION_NAME}()"
DROP_CONTROLLER_NOTIFY_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {CONTROLLER_NOTIFY_TRIGGER_NAME} ON agent_controllers"
)
DROP_CONTROLLER_NOTIFY_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {CONTROLLER_NOTIFY_FUNCTION_NAME}()"
)

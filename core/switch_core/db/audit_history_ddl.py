"""The one way the runtime role can delete audit rows: purging the history of
workspaces deleted more than `AUDIT_HISTORY_HORIZON` ago.

The runtime role may not delete from `audit_events`
(`db/runtime_role.grant_runtime_role` revokes it), so that a compromised or
buggy process cannot rewrite a tenant's history. Yet a deleted workspace's
history must go once its horizon has passed (`retention/audit_history.py`),
and the serving process has no schema owner's connection to do it with. This
function is the bridge between the two: `SECURITY DEFINER`, owned by the
schema owner, so it deletes as the owner, and narrow enough that holding
`EXECUTE` on it concedes nothing the retention pass would not do anyway.

- **It takes no arguments.** Neither the horizon nor the clock comes from the
  caller: the horizon is written into the body and the time is the database's
  `now()`. A horizon or a "now" passed in would turn the function into a way
  to erase any deleted workspace's history at once, which is exactly what the
  revoke exists to prevent.
- **It deletes only what the policy says is due.** A tenant's `audit_events`
  go only when the server's audit log holds a `workspace.deleted` row for it
  older than the horizon *and* no `tenants` row with that id exists.
  `server_audit_events` and `organization_audit_events` are never touched.
- **It runs outside the row-level-security policies**, and has to: it
  deletes across tenants with none bound. That holds because it runs as the
  owner of `audit_events`, which Postgres exempts from the table's own policy
  as long as `force row level security` is not set — the same property the
  tenant lookups (`db/tenant_lookup.py`) rest on, and which boot refuses to
  start without (`db/runtime_role.py`).
- **Its `search_path` is pinned**, with `pg_temp` last, for the same reason
  as the lookups' (`tenant_lookup.SECURE_SEARCH_PATH`): a caller able to
  create a temporary table must not be able to shadow a table it reads.

`EXECUTE` is revoked from `PUBLIC` where it is created, and granted to the
runtime role by `grant_runtime_role`'s `GRANT EXECUTE ON ALL FUNCTIONS`, which
boot re-issues over the owner's connection.

The horizon lives here, rather than in `retention/audit_history.py`, because
it is part of the function's body: changing `AUDIT_HISTORY_HORIZON` changes
what `create_all` builds, and a real database follows only with a migration
that replaces the function. `test_frozen_ddl_matches_create_all.py` fails
until that migration exists.

The migration that installs this carries its own copy, frozen as it was
written; this copy is what `create_all` builds for the tests.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import DDL, MetaData, event

from switch_core.db.tenant_lookup import SECURE_SEARCH_PATH

#: How long a deleted workspace's audit history is kept after the deletion.
AUDIT_HISTORY_HORIZON = timedelta(days=730)

#: The server audit action deleting a workspace writes. Defined here and taken
#: by `db.audit.ServerAuditAction.WORKSPACE_DELETED`, since `db.audit` imports
#: the models and the models import this module.
WORKSPACE_DELETED_ACTION = "workspace.deleted"

assert AUDIT_HISTORY_HORIZON == timedelta(days=AUDIT_HISTORY_HORIZON.days), (
    "AUDIT_HISTORY_HORIZON is written into the purge function in whole days"
)

PURGE_FUNCTION_NAME = "purge_deleted_workspace_audit_history"

CREATE_PURGE_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {PURGE_FUNCTION_NAME}()
    RETURNS TABLE (purged_tenant_id text, purged_rows bigint)
    LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$
WITH expired AS (
    SELECT DISTINCT deletion.target_id AS tenant_id
    FROM server_audit_events AS deletion
    WHERE deletion.action = '{WORKSPACE_DELETED_ACTION}'
      AND deletion.target_type = 'tenant'
      AND deletion.target_id IS NOT NULL
      AND deletion.occurred_at < now() - interval '{AUDIT_HISTORY_HORIZON.days} days'
      AND NOT EXISTS (SELECT 1 FROM tenants WHERE tenants.id = deletion.target_id)
),
purged AS (
    DELETE FROM audit_events
    USING expired
    WHERE audit_events.tenant_id = expired.tenant_id
    RETURNING audit_events.tenant_id
)
SELECT purged.tenant_id, count(*) FROM purged
GROUP BY purged.tenant_id ORDER BY purged.tenant_id
$$
"""

REVOKE_PURGE_FUNCTION_FROM_PUBLIC = (
    f"REVOKE EXECUTE ON FUNCTION {PURGE_FUNCTION_NAME}() FROM PUBLIC"
)

DROP_PURGE_FUNCTION = f"DROP FUNCTION IF EXISTS {PURGE_FUNCTION_NAME}()"


def attach_audit_history_purge(metadata: MetaData) -> None:
    """Create the function after `create_all`, drop it before `drop_all`.

    After the tables, for the reason `tenant_lookup.attach_tenant_lookups`
    gives: a `LANGUAGE sql` body has its names resolved at creation.
    """
    for statement in (CREATE_PURGE_FUNCTION, REVOKE_PURGE_FUNCTION_FROM_PUBLIC):
        event.listen(
            metadata, "after_create", DDL(statement).execute_if(dialect="postgresql")
        )
    event.listen(
        metadata,
        "before_drop",
        DDL(DROP_PURGE_FUNCTION).execute_if(dialect="postgresql"),
    )

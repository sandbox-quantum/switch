"""audit_history_purge_function: purge deleted workspaces' audit history as the owner

A deleted workspace's `audit_events` are purged once the workspace has been
gone for two years. The runtime role may not delete audit rows
(`grant_runtime_role` revokes `DELETE` on `audit_events`), and the serving
process is not given the schema owner's password, so the purge could not run
where it was meant to.

This installs `purge_deleted_workspace_audit_history()`: `SECURITY DEFINER`,
owned by whoever runs this migration (the schema owner), with the horizon
written into its body and the time taken from `now()`, so it takes no
arguments and can delete nothing the retention policy has not made due. It
deletes a tenant's `audit_events` only when the server audit log holds a
`workspace.deleted` row for that tenant older than 730 days and no `tenants`
row with its id exists. It runs as the owner of `audit_events`, which Postgres
exempts from that table's row-level-security policy because
`force row level security` is not set, so it deletes across tenants with none
bound.

`SET search_path = pg_catalog, public, pg_temp`, with `pg_temp` last, as for
the tenant lookups in `9c41a7b0e5d8`. `EXECUTE` is revoked from `PUBLIC` here;
`grant_runtime_role` grants it to the runtime role by name with every other
function in the schema, at the next boot or migration job.

The DDL below is a verbatim copy of `switch_core/db/audit_history_ddl.py` as it
stood when this migration was written.

Expand only: a release from before this revision never calls the function.

Revision ID: f2c8a4d17e93
Revises: d3a8f1c62b07
Create Date: 2026-11-12 12:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "f2c8a4d17e93"
down_revision: str | None = "d3a8f1c62b07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

CREATE_PURGE_FUNCTION = """
CREATE OR REPLACE FUNCTION purge_deleted_workspace_audit_history()
    RETURNS TABLE (purged_tenant_id text, purged_rows bigint)
    LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
WITH expired AS (
    SELECT DISTINCT deletion.target_id AS tenant_id
    FROM server_audit_events AS deletion
    WHERE deletion.action = 'workspace.deleted'
      AND deletion.target_type = 'tenant'
      AND deletion.target_id IS NOT NULL
      AND deletion.occurred_at < now() - interval '730 days'
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

REVOKE_FROM_PUBLIC = (
    "REVOKE EXECUTE ON FUNCTION purge_deleted_workspace_audit_history() FROM PUBLIC"
)

DROP_PURGE_FUNCTION = "DROP FUNCTION IF EXISTS purge_deleted_workspace_audit_history()"


def upgrade() -> None:
    op.execute(CREATE_PURGE_FUNCTION)
    op.execute(REVOKE_FROM_PUBLIC)


def downgrade() -> None:
    op.execute(DROP_PURGE_FUNCTION)

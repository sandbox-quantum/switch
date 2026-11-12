"""Purging a deleted workspace's audit history once its horizon has passed.

Deleting a workspace keeps its `audit_events`: they outlive the tenant on
purpose, so what was done in it can still be answered for. They are kept for
`AUDIT_HISTORY_HORIZON` after the deletion and then deleted, as part of the
hourly data retention pass (`retention/service.py`).

The deletion's time comes from the server's audit log: deleting a workspace
writes a `workspace.deleted` row there (`accounts/workspace_deletion.py`), and
that log outlives every workspace. A workspace whose `tenants` row still
exists is never touched, whatever its log says. Kept:

- the server's own row recording the deletion, which is what proves when the
  workspace went and so why its history did;
- the organization's audit log, which is the organization's history rather
  than the workspace's, and outlives the organization too.

The runtime role may not delete audit rows (`db/runtime_role.grant_runtime_role`
takes `DELETE` back), so the deleting is done by
`purge_deleted_workspace_audit_history()`, a `SECURITY DEFINER` function owned
by the schema owner that takes no arguments and deletes only what the rules
above make due (`db/audit_history_ddl.py`). This calls it on the ordinary
runtime connection; `check_purge_function` refuses to start a server that
could not.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from switch_core.db.audit_history_ddl import AUDIT_HISTORY_HORIZON, PURGE_FUNCTION_NAME
from switch_core.tenant_context import no_tenant

__all__ = [
    "AUDIT_HISTORY_HORIZON",
    "AuditHistoryPurgeError",
    "check_purge_function",
    "purge_deleted_workspace_history",
]

logger = logging.getLogger(__name__)

_PURGE = text(
    "SELECT purged_tenant_id, purged_rows FROM purge_deleted_workspace_audit_history()"
)


class AuditHistoryPurgeError(RuntimeError):
    """The runtime connection cannot purge deleted workspaces' audit history."""


async def purge_deleted_workspace_history(
    session_factory: async_sessionmaker[AsyncSession],
) -> int:
    """Delete the audit history of every workspace deleted more than
    `AUDIT_HISTORY_HORIZON` ago, and return how many rows went."""
    with no_tenant():
        async with session_factory() as session, session.begin():
            rows = (await session.execute(_PURGE)).all()
    for tenant_id, count in rows:
        logger.info(
            "Purged %d audit rows of workspace %s, deleted more than %s ago",
            count,
            tenant_id,
            AUDIT_HISTORY_HORIZON,
        )
    return sum(int(count) for _, count in rows)


async def check_purge_function(engine: AsyncEngine) -> None:
    """Raise `AuditHistoryPurgeError` unless `engine`'s role can run the purge.

    Asked at startup rather than left to the first retention pass, whose
    failure is only logged: a server that cannot purge would keep the history
    of deleted workspaces forever, and nothing else would say so.
    """
    async with engine.connect() as connection:
        row = (
            await connection.execute(
                text(
                    """
                    SELECT p.prosecdef, has_function_privilege(p.oid, 'EXECUTE')
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = :name
                    """
                ),
                {"name": PURGE_FUNCTION_NAME},
            )
        ).one_or_none()
    if row is None:
        raise AuditHistoryPurgeError(
            f"{PURGE_FUNCTION_NAME}() is not installed in this database, so "
            "deleted workspaces' audit history would never be purged. The "
            "schema is behind the migration that creates it."
        )
    definer, executable = row
    if not definer:
        raise AuditHistoryPurgeError(
            f"{PURGE_FUNCTION_NAME}() is not SECURITY DEFINER, so it would run "
            "as the runtime role, which may not delete audit rows. Reinstall "
            "it from the migration that creates it."
        )
    if not executable:
        raise AuditHistoryPurgeError(
            f"This connection's role may not execute {PURGE_FUNCTION_NAME}(), "
            "so deleted workspaces' audit history would never be purged. Grant "
            "EXECUTE on it to the runtime role, or let the migration job or "
            "boot do it by configuring DB_OWNER_USER / DB_OWNER_PASSWORD there."
        )

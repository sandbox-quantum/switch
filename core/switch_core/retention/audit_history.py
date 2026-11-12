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
  than the workspace's, and goes with the organization.

The runtime role may not delete audit rows (`db/runtime_role.grant_runtime_role`
takes `DELETE` back), so this runs on the schema owner's connection where one
is configured (`SwitchConfig.owner_database_url`). Without one it runs on the
runtime connection, which works only where that role owns the schema;
`check_purge_privilege` says at startup when it cannot.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, delete, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import AuditEvent, ServerAuditEvent, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)

#: How long a deleted workspace's audit history is kept after the deletion.
AUDIT_HISTORY_HORIZON = timedelta(days=730)


async def purge_deleted_workspace_history(
    history_sessions: async_sessionmaker[AsyncSession], now: datetime
) -> int:
    """Delete the audit history of every workspace deleted more than
    `AUDIT_HISTORY_HORIZON` before `now`, and return how many rows went.

    `history_sessions` must be allowed to delete from `audit_events`: the
    owner's connection, or a runtime role that owns the schema.
    """
    with no_tenant():
        async with history_sessions() as session:
            deleted = await session.scalars(
                select(ServerAuditEvent.target_id)
                .where(
                    ServerAuditEvent.action == ServerAuditAction.WORKSPACE_DELETED,
                    ServerAuditEvent.target_type == "tenant",
                    ServerAuditEvent.target_id.is_not(None),
                    ServerAuditEvent.occurred_at < now - AUDIT_HISTORY_HORIZON,
                )
                .distinct()
            )
            tenant_ids = sorted(
                tenant_id for tenant_id in deleted.all() if tenant_id is not None
            )
    purged = 0
    for tenant_id in tenant_ids:
        async with tenant_session(history_sessions, tenant_id) as session:
            async with session.begin():
                if await session.scalar(
                    select(Tenant.id).where(Tenant.id == tenant_id)
                ):
                    continue
                result = await session.execute(
                    delete(AuditEvent).where(AuditEvent.tenant_id == tenant_id)
                )
        count = cast("CursorResult[Any]", result).rowcount
        if count:
            logger.info(
                "Purged %d audit rows of workspace %s, deleted more than %s ago",
                count,
                tenant_id,
                AUDIT_HISTORY_HORIZON,
            )
        purged += count
    return purged


async def check_purge_privilege(engine: AsyncEngine, *, owner: bool) -> bool:
    """Whether `engine`'s role may delete audit rows, logged as an error when
    not: the history of deleted workspaces would then be kept forever."""
    async with engine.connect() as connection:
        allowed = bool(
            await connection.scalar(
                text(
                    "SELECT has_table_privilege(current_user, 'audit_events', 'DELETE')"
                )
            )
        )
    if not allowed:
        logger.error(
            "Deleted workspaces' audit history will NOT be purged after %s: the "
            "%s connection may not delete from audit_events. Configure the schema "
            "owner's connection (DB_OWNER_USER and DB_OWNER_PASSWORD) so the "
            "retention pass can run it.",
            AUDIT_HISTORY_HORIZON,
            "owner's" if owner else "runtime",
        )
    return allowed

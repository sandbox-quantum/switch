"""The platform operator's admin rights outside a gateway request, on record.

An agent acts as its owner, and a chat account linked to a Switch user acts
as that user (`authz.py`). Where that person is the platform operator and
holds no role that administers the workspace, an admin decision made for
them rests on the operator flag alone: `platform_access`, which the
workspace's audit log records, as the gateway records the operator's own
writes (`gateway/auth.py`). Recorded where the decision is made rather than
per request, because only the decision uses the flag: an agent posting in a
room it belongs to does not, and its keepalives would bury the record.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore


async def administers_on_record(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user: User,
    *,
    target_type: str,
    target_id: str | None,
    details: dict[str, Any],
) -> bool:
    """`UserStore.administers` for the workspace bound to `session`, recording
    `platform_access` when only the operator flag makes it true.

    Recorded on a session of its own and committed at once, so a read-only
    caller that never commits still leaves the record, and a caller whose
    transaction fails later does too.
    """
    tenant_id = require_tenant_id()
    if await user_store.administers_by_role(session, tenant_id, user.id):
        return True
    if user.role != "admin":
        return False
    async with tenant_session(session_factory, tenant_id) as record:
        await record_audit_event(
            record,
            tenant_id=tenant_id,
            actor_user_id=user.id,
            action=AuditAction.PLATFORM_ACCESS,
            target_type=target_type,
            target_id=target_id,
            details=details,
        )
        await record.commit()
    return True

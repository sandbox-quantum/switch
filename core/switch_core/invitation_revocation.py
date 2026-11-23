"""An invitation stops working when whoever made it no longer administers its
workspace: it grants, at most, the standing its maker held, and only while
they hold it.

Each way of losing that standing revokes what they made there, recorded in
the workspace's audit log: being demoted from its admin, being removed from
it, no longer being its organization's `org_admin` where nothing else made
them its admin, and deleting the account. Accepting an invitation checks the
maker's standing again (`gateway/tenants.py`), which covers any made before
these revocations existed.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.stores.invitation_store import InvitationStore


async def revoke_invitations_made_by(
    session: AsyncSession,
    *,
    tenant_id: str,
    user_id: str,
    actor_id: str | None,
    reason: str,
) -> int:
    """Revoke what `user_id` made in `tenant_id`, bound on `session`, that
    could still be accepted, each recorded as revoked by `actor_id` for
    `reason`. Returns how many. Lands when the caller commits."""
    revoked = await InvitationStore().revoke_made_by(session, tenant_id, user_id)
    for invitation in revoked:
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=actor_id,
            action=AuditAction.INVITATION_REVOKED,
            target_type="invitation",
            target_id=invitation.id,
            details={"reason": reason, "created_by": user_id},
        )
    return len(revoked)

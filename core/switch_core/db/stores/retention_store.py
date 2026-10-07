"""What data retention reads and deletes, for the bound tenant.

The workspace's policy lives here, and so does every deletion retention makes
apart from messages themselves, which `MessageStore.delete_sent_before` owns
because deleting them has to keep the room's numbering intact.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, Result, delete, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    ApprovalRequest,
    BridgeMessageMap,
    Invitation,
    Message,
    MessagingInstallState,
    TenantRetentionPolicy,
    require_tenant_id,
)

# A blob is written before the message that carries it, in a separate
# transaction, and a hosted cutover may hold one for an import it has not
# queued yet. Both are referenced by something other than an attachment row,
# so a blob is only a candidate once it has had time to gain one, and is
# never one while a live import names it.
_UNREFERENCED_BLOBS = """
    SELECT b.id FROM media_blobs b
    WHERE b.tenant_id = :tenant_id
      AND b.created_at < :created_before
      AND NOT EXISTS (
          SELECT 1 FROM message_attachments a
          WHERE a.tenant_id = b.tenant_id AND a.uri = b.uri)
      AND NOT EXISTS (
          SELECT 1 FROM hosted_cutover_items i
          JOIN hosted_launches l ON l.tenant_id = i.tenant_id AND l.id = i.launch_id
            AND l.state NOT IN ('deleting', 'deleted')
          CROSS JOIN LATERAL jsonb_array_elements(
              COALESCE(i.payload->'payload'->'attachments', '[]'::jsonb)) f
          WHERE i.tenant_id = b.tenant_id AND i.disposition = 'import'
            AND f->>'mxc' = b.uri)
    ORDER BY b.created_at
    LIMIT :limit
"""


def _rowcount(result: Result[Any]) -> int:
    return cast("CursorResult[Any]", result).rowcount


class RetentionStore:
    async def get_policy(self, session: AsyncSession) -> TenantRetentionPolicy | None:
        return await session.get(TenantRetentionPolicy, require_tenant_id())

    async def set_policy(
        self, session: AsyncSession, *, message_retention_days: int, user_id: str
    ) -> TenantRetentionPolicy:
        """Set the window, creating the policy or replacing it in one statement,
        so two people saving a first policy at once do not collide."""
        statement = (
            insert(TenantRetentionPolicy)
            .values(
                tenant_id=require_tenant_id(),
                message_retention_days=message_retention_days,
                updated_by_user_id=user_id,
            )
            .on_conflict_do_update(
                index_elements=[TenantRetentionPolicy.tenant_id],
                set_={
                    "message_retention_days": message_retention_days,
                    "updated_by_user_id": user_id,
                    "updated_at": func.now(),
                },
            )
            .returning(TenantRetentionPolicy)
        )
        result = await session.execute(
            statement, execution_options={"populate_existing": True}
        )
        return result.scalar_one()

    async def clear_policy(self, session: AsyncSession) -> bool:
        """Remove the policy, so messages are kept forever. Whether there was one."""
        result = await session.execute(
            delete(TenantRetentionPolicy).where(
                TenantRetentionPolicy.tenant_id == require_tenant_id()
            )
        )
        return _rowcount(result) > 0

    async def count_messages_before(
        self, session: AsyncSession, cutoff: datetime
    ) -> int:
        """How many of the bound tenant's messages a cutoff would delete."""
        result = await session.execute(
            select(func.count())
            .select_from(Message)
            .where(Message.tenant_id == require_tenant_id(), Message.sent_at < cutoff)
        )
        return int(result.scalar_one())

    async def delete_bridge_mappings(
        self, session: AsyncSession, transport_event_ids: Collection[str]
    ) -> int:
        """Forget which platform posts carried these (deleted) messages."""
        if not transport_event_ids:
            return 0
        result = await session.execute(
            delete(BridgeMessageMap).where(
                BridgeMessageMap.tenant_id == require_tenant_id(),
                BridgeMessageMap.transport_event_id.in_(list(transport_event_ids)),
            )
        )
        return _rowcount(result)

    async def delete_unreferenced_media(
        self, session: AsyncSession, *, created_before: datetime, limit: int
    ) -> int:
        """Delete up to `limit` stored files nothing refers to any more."""
        ids = list(
            (
                await session.execute(
                    text(_UNREFERENCED_BLOBS),
                    {
                        "tenant_id": require_tenant_id(),
                        "created_before": created_before,
                        "limit": limit,
                    },
                )
            ).scalars()
        )
        if not ids:
            return 0
        await session.execute(
            text("DELETE FROM media_blobs WHERE id = ANY(:ids)"), {"ids": ids}
        )
        return len(ids)

    async def delete_settled_approvals(
        self, session: AsyncSession, before: datetime
    ) -> int:
        """Delete approval requests that were settled before `before`.

        Settled means nothing still waits on the row: closed, or answered or
        expired and already delivered to the agent. An answer still owed to an
        agent is kept however old it is.
        """
        result = await session.execute(
            delete(ApprovalRequest).where(
                ApprovalRequest.tenant_id == require_tenant_id(),
                ApprovalRequest.updated_at < before,
                (ApprovalRequest.state == "closed")
                | (
                    ApprovalRequest.state.in_(("answered", "expired"))
                    & ApprovalRequest.delivered_at.is_not(None)
                ),
            )
        )
        await session.execute(
            text(
                """
                DELETE FROM approval_request_posts p
                WHERE p.tenant_id = :tenant_id AND p.created_at < :before
                  AND NOT EXISTS (
                      SELECT 1 FROM approval_requests r
                      WHERE r.tenant_id = p.tenant_id AND r.agent_id = p.agent_id
                        AND r.session_id = p.session_id
                        AND r.request_id = p.request_id)
                """
            ),
            {"tenant_id": require_tenant_id(), "before": before},
        )
        return _rowcount(result)

    async def delete_lapsed_invitations(
        self, session: AsyncSession, before: datetime
    ) -> int:
        """Delete invitations that expired or were revoked before `before`."""
        result = await session.execute(
            delete(Invitation).where(
                Invitation.tenant_id == require_tenant_id(),
                (Invitation.expires_at < before) | (Invitation.revoked_at < before),
            )
        )
        return _rowcount(result)

    async def delete_expired_install_states(
        self, session: AsyncSession, before: datetime
    ) -> int:
        """Delete messaging install states that expired before `before`.

        A state is single-use evidence only while its signed token could still
        be presented; once it has expired a replay is refused whether or not
        the row is there.
        """
        result = await session.execute(
            delete(MessagingInstallState).where(
                MessagingInstallState.tenant_id == require_tenant_id(),
                MessagingInstallState.expires_at < before,
            )
        )
        return _rowcount(result)

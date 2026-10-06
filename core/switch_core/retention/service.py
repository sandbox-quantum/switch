"""Data retention: deleting what a workspace no longer keeps.

One pass over the bound tenant does three things, each in its own short
transactions so a large backlog never holds a long lock:

1. If the workspace has a retention policy, deletes room messages older than
   its window, from every room, archived ones included. Their attachment rows
   go with them, and the record of which platform post carried each.
2. Deletes stored files nothing refers to any more, whether their messages
   were deleted by step 1 or by deleting a room. This runs whatever the
   policy: an orphaned file is not something any workspace chose to keep.
3. Deletes settled approval requests, lapsed invitations and expired install
   links once `SETTLED_GRACE` has passed.

The audit log and usage records are never touched; `docs/design/data-retention.md`
says why, and what retention does not yet cover.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.retention_store import RetentionStore

logger = logging.getLogger(__name__)

#: How long a settled approval, lapsed invitation or expired install link is
#: kept, so an operator asking what happened to one can still see it.
SETTLED_GRACE = timedelta(days=30)
#: How old an unreferenced file must be before it is deleted; see
#: `retention_store._UNREFERENCED_BLOBS`.
MEDIA_GRACE = timedelta(days=1)
MESSAGE_BATCH = 1000
MEDIA_BATCH = 100
#: Batches of each kind per pass. A backlog larger than this (the first pass
#: after a short window is set on a long-lived workspace) is finished by the
#: passes after it rather than by one that runs for an hour.
MAX_BATCHES = 50


@dataclass(frozen=True)
class RetentionPass:
    messages: int
    media: int
    approvals: int
    invitations: int
    install_states: int
    backlog: bool


class RetentionService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory
        self._messages = MessageStore()
        self._retention = RetentionStore()

    async def apply(self, now: datetime) -> RetentionPass:
        """One retention pass over the bound tenant."""
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db:
            policy = await self._retention.get_policy(db)
            days = None if policy is None else policy.message_retention_days

        messages, message_backlog = (
            (0, False)
            if days is None
            else await self._delete_messages(tenant_id, now - timedelta(days=days))
        )
        media, media_backlog = await self._delete_media(tenant_id, now - MEDIA_GRACE)

        settled_before = now - SETTLED_GRACE
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            approvals = await self._retention.delete_settled_approvals(
                db, settled_before
            )
            invitations = await self._retention.delete_lapsed_invitations(
                db, settled_before
            )
            install_states = await self._retention.delete_expired_install_states(
                db, settled_before
            )

        result = RetentionPass(
            messages=messages,
            media=media,
            approvals=approvals,
            invitations=invitations,
            install_states=install_states,
            backlog=message_backlog or media_backlog,
        )
        if result.backlog:
            logger.warning(
                "Retention in tenant %s stopped at its per-pass limit with more "
                "to delete; the next pass continues (%s)",
                tenant_id,
                result,
            )
        elif messages or media or approvals or invitations or install_states:
            logger.info("Retention in tenant %s: %s", tenant_id, result)
        return result

    async def _delete_messages(
        self, tenant_id: str, cutoff: datetime
    ) -> tuple[int, bool]:
        deleted = 0
        for _ in range(MAX_BATCHES):
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                event_ids = await self._messages.delete_sent_before(
                    db, cutoff, limit=MESSAGE_BATCH
                )
                await self._retention.delete_bridge_mappings(db, event_ids)
            deleted += len(event_ids)
            if len(event_ids) < MESSAGE_BATCH:
                return deleted, False
        return deleted, True

    async def _delete_media(
        self, tenant_id: str, created_before: datetime
    ) -> tuple[int, bool]:
        deleted = 0
        for _ in range(MAX_BATCHES):
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                count = await self._retention.delete_unreferenced_media(
                    db, created_before=created_before, limit=MEDIA_BATCH
                )
            deleted += count
            if count < MEDIA_BATCH:
                return deleted, False
        return deleted, True

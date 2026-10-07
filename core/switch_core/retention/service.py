"""Data retention: deleting what a workspace no longer keeps.

A pass runs hourly as a task of its own (`retention_loop`). Over each tenant
it does three things, each in its own short transactions so a large backlog
never holds a long lock, and each whether or not the others failed:

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

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.retention_store import RetentionStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.tenant_context import no_tenant, tenant_scope

logger = logging.getLogger(__name__)

#: How long a settled approval, lapsed invitation or expired install link is
#: kept, so an operator asking what happened to one can still see it.
SETTLED_GRACE = timedelta(days=30)
#: How old an unreferenced file must be before it is deleted; see
#: `retention_store._UNREFERENCED_BLOBS`.
MEDIA_GRACE = timedelta(days=1)
MESSAGE_BATCH = 1000
MEDIA_BATCH = 100
#: How long one tenant's pass may spend deleting before it stops and leaves
#: the rest to the next pass, so one workspace with a large backlog (the first
#: pass after a short window is set on a long-lived workspace) does not hold
#: up every other workspace's.
TENANT_BUDGET = timedelta(minutes=2)
PASS_EVERY_SECONDS = 3600.0


@dataclass(frozen=True)
class RetentionPass:
    messages: int
    media: int
    approvals: int
    invitations: int
    install_states: int
    backlog: bool
    failed: tuple[str, ...]


class RetentionService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory
        self._messages = MessageStore()
        self._retention = RetentionStore()

    async def apply(self, now: datetime, budget: timedelta) -> RetentionPass:
        """One retention pass over the bound tenant.

        Each step runs whether or not the one before it failed: a message
        deletion that keeps failing must not also stop files and leftovers
        being cleaned up. A failure is logged with its traceback and named in
        the result.
        """
        tenant_id = require_tenant_id()
        deadline = time.monotonic() + budget.total_seconds()
        failed: list[str] = []

        messages, message_backlog = 0, False
        try:
            async with tenant_session(self._sessions, tenant_id) as db:
                policy = await self._retention.get_policy(db)
            if policy is not None:
                messages, message_backlog = await self._delete_messages(
                    tenant_id,
                    now - timedelta(days=policy.message_retention_days),
                    deadline,
                )
        except Exception:
            logger.exception(
                "Retention could not delete messages in tenant %s", tenant_id
            )
            failed.append("messages")

        media, media_backlog = 0, False
        try:
            media, media_backlog = await self._delete_media(
                tenant_id, now - MEDIA_GRACE, deadline
            )
        except Exception:
            logger.exception("Retention could not sweep files in tenant %s", tenant_id)
            failed.append("media")

        approvals = invitations = install_states = 0
        settled_before = now - SETTLED_GRACE
        try:
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
        except Exception:
            logger.exception(
                "Retention could not prune leftover records in tenant %s", tenant_id
            )
            failed.append("leftovers")

        result = RetentionPass(
            messages=messages,
            media=media,
            approvals=approvals,
            invitations=invitations,
            install_states=install_states,
            backlog=message_backlog or media_backlog,
            failed=tuple(failed),
        )
        if result.backlog:
            logger.warning(
                "Retention in tenant %s ran out of time with more to delete; "
                "the next pass continues (%s)",
                tenant_id,
                result,
            )
        elif messages or media or approvals or invitations or install_states:
            logger.info("Retention in tenant %s: %s", tenant_id, result)
        return result

    async def _delete_messages(
        self, tenant_id: str, cutoff: datetime, deadline: float
    ) -> tuple[int, bool]:
        deleted = 0
        while True:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                event_ids = await self._messages.delete_sent_before(
                    db, cutoff, limit=MESSAGE_BATCH
                )
                await self._retention.delete_bridge_mappings(db, event_ids)
            deleted += len(event_ids)
            if len(event_ids) < MESSAGE_BATCH:
                return deleted, False
            if time.monotonic() >= deadline:
                return deleted, True

    async def _delete_media(
        self, tenant_id: str, created_before: datetime, deadline: float
    ) -> tuple[int, bool]:
        deleted = 0
        while True:
            async with tenant_session(self._sessions, tenant_id) as db, db.begin():
                count = await self._retention.delete_unreferenced_media(
                    db, created_before=created_before, limit=MEDIA_BATCH
                )
            deleted += count
            if count < MEDIA_BATCH:
                return deleted, False
            if time.monotonic() >= deadline:
                return deleted, True


async def retain_once(
    session_factory: async_sessionmaker[AsyncSession], now: datetime
) -> None:
    """One pass over every tenant, each bound before it is touched."""
    service = RetentionService(session_factory)
    for tenant_id in await all_tenant_ids(session_factory):
        with tenant_scope(tenant_id):
            try:
                await service.apply(now, TENANT_BUDGET)
            except Exception:
                # One tenant's failure must not stop the others' retention.
                logger.exception("Data retention failed for tenant %s", tenant_id)


async def retention_loop(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """Retention at start and hourly, as a task of its own.

    Not in the session-activity upkeep loop, which also expires approval
    requests every few seconds: a long retention pass there would hold up
    what unblocks a stuck session.
    """
    with no_tenant():
        while True:
            try:
                await retain_once(session_factory, datetime.now(UTC))
            except Exception:
                logger.exception("Data retention could not list tenants")
            await asyncio.sleep(PASS_EVERY_SECONDS)

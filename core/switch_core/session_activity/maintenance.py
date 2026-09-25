"""Timed upkeep for session activity: expiring requests, pruning old lines.

Expiry is what unblocks a session nobody answers, so it runs often; each
expired request is announced like any other change and pushed to the agent.
Activity lines exist for platforms to show what is happening now, so they are
kept for a bounded window and pruned rarely.

Tenants are worked through one at a time, each bound before it is touched,
like every other background task that spans them.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.session_activity.service import SessionActivityService
from switch_core.tenant_context import no_tenant, tenant_scope

logger = logging.getLogger(__name__)

EXPIRY_INTERVAL_SECONDS = 5.0
PRUNE_EVERY_SECONDS = 3600.0
ACTIVITY_RETENTION = timedelta(days=7)
#: How often the hosted wake mailbox is reclaimed, expired, pruned and re-offered.
MAILBOX_EVERY_SECONDS = 30.0

#: One wake mailbox pass over the bound tenant; given the time of the previous
#: pass, for its metrics.
MailboxUpkeep = Callable[[datetime], Awaitable[None]]


async def maintain_once(
    session_factory: async_sessionmaker[AsyncSession], *, prune: bool
) -> None:
    """One pass over every tenant: expire overdue requests, and prune if asked."""
    service = SessionActivityService(session_factory)
    for tenant_id in await all_tenant_ids(session_factory):
        with tenant_scope(tenant_id):
            try:
                expired = await service.expire_due()
                if expired:
                    logger.info(
                        "Expired %d unanswered approval request(s) in tenant %s",
                        len(expired),
                        tenant_id,
                    )
                if prune:
                    await service.prune_activity(ACTIVITY_RETENTION)
            except Exception:
                # One tenant's failure must not stop the others' requests expiring.
                logger.exception(
                    "Session-activity upkeep failed for tenant %s", tenant_id
                )


async def _mailbox_pass(
    session_factory: async_sessionmaker[AsyncSession],
    mailbox_upkeep: MailboxUpkeep,
    since: datetime,
) -> datetime:
    started = datetime.now(UTC)
    try:
        tenant_ids = await all_tenant_ids(session_factory)
    except Exception:
        logger.exception("Wake mailbox upkeep could not list tenants")
        return started
    for tenant_id in tenant_ids:
        with tenant_scope(tenant_id):
            try:
                await mailbox_upkeep(since)
            except Exception:
                logger.exception("Wake mailbox upkeep failed for tenant %s", tenant_id)
    return started


async def maintenance_loop(
    session_factory: async_sessionmaker[AsyncSession], mailbox_upkeep: MailboxUpkeep
) -> None:
    """Session-activity upkeep every 5 s; the wake mailbox at start and every 30 s."""
    with no_tenant():
        mailbox_since = await _mailbox_pass(
            session_factory, mailbox_upkeep, datetime.now(UTC)
        )
        since_mailbox = 0.0
        since_prune = PRUNE_EVERY_SECONDS
        while True:
            await asyncio.sleep(EXPIRY_INTERVAL_SECONDS)
            since_prune += EXPIRY_INTERVAL_SECONDS
            since_mailbox += EXPIRY_INTERVAL_SECONDS
            prune = since_prune >= PRUNE_EVERY_SECONDS
            try:
                await maintain_once(session_factory, prune=prune)
            except Exception:
                logger.exception("Session-activity upkeep failed")
            else:
                if prune:
                    since_prune = 0.0
            if since_mailbox >= MAILBOX_EVERY_SECONDS:
                mailbox_since = await _mailbox_pass(
                    session_factory, mailbox_upkeep, mailbox_since
                )
                since_mailbox = 0.0

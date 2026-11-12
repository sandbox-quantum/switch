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
import contextlib
import logging
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.ownership import Fence, OwnedKind, Ownership
from switch_core.session_activity.restart_sweep import (
    OFFLINE_AFTER,
    CutOffTurn,
    PostAsAgent,
    sweep_tenant,
)
from switch_core.session_activity.service import AgentSessionActivityService
from switch_core.tenant_context import no_tenant, tenant_scope

logger = logging.getLogger(__name__)

EXPIRY_INTERVAL_SECONDS = 5.0
PRUNE_EVERY_SECONDS = 3600.0
ORPHANS_EVERY_SECONDS = 60.0
ACTIVITY_RETENTION = timedelta(days=7)


async def maintain_once(
    session_factory: async_sessionmaker[AsyncSession], *, prune: bool
) -> None:
    """One pass over every tenant: expire overdue requests, and prune if asked."""
    service = AgentSessionActivityService(session_factory)
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


async def end_orphaned_turns_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """One pass over every tenant: end the turns no host is left to finish."""
    service = AgentSessionActivityService(session_factory)
    for tenant_id in await all_tenant_ids(session_factory):
        with tenant_scope(tenant_id):
            try:
                ended = await service.end_orphaned_turns()
                if ended:
                    logger.info(
                        "Ended or settled the steps of %d turn(s) in tenant %s "
                        "whose agent went away before reporting their end",
                        len(ended),
                        tenant_id,
                    )
            except Exception:
                logger.exception(
                    "Ending orphaned turns failed for tenant %s", tenant_id
                )


async def maintenance_loop(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """Session-activity upkeep every 5 s; orphaned turns every minute."""
    with no_tenant():
        since_prune = PRUNE_EVERY_SECONDS
        since_orphans = 0.0
        while True:
            await asyncio.sleep(EXPIRY_INTERVAL_SECONDS)
            since_orphans += EXPIRY_INTERVAL_SECONDS
            since_prune += EXPIRY_INTERVAL_SECONDS
            prune = since_prune >= PRUNE_EVERY_SECONDS
            try:
                if since_orphans >= ORPHANS_EVERY_SECONDS:
                    since_orphans = 0.0
                    await end_orphaned_turns_once(session_factory)
                await maintain_once(session_factory, prune=prune)
            except Exception:
                logger.exception("Session-activity upkeep failed")
            else:
                if prune:
                    since_prune = 0.0


# The sweeps are owned work (`ownership.py`): one process runs them for every
# tenant, and the next takes over when it stops or dies, rather than each
# process sweeping every tenant on its own clock.
SWEEP_KIND = "session_activity_sweep"
SWEEP_KEY = "all"


def own_maintenance(
    ownership: Ownership, session_factory: async_sessionmaker[AsyncSession]
) -> OwnedKind:
    """Register the session-activity sweeps as owned work, wanted by this
    process; they run here only while it holds them."""
    running: dict[str, asyncio.Task[None]] = {}

    def launch(key: str) -> None:
        task = asyncio.create_task(
            maintenance_loop(session_factory), name="session-activity-sweeps"
        )
        running[key] = task
        task.add_done_callback(lambda done: ended(key, done))

    def ended(key: str, task: asyncio.Task[None]) -> None:
        if task.cancelled() or running.get(key) is not task:
            return
        logger.error(
            "Session-activity sweeps stopped unexpectedly; restarting",
            exc_info=task.exception(),
        )
        launch(key)

    async def start(key: str, fence: Fence) -> None:
        launch(key)

    async def stop(key: str) -> None:
        task = running.pop(key, None)
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    kind = ownership.kind(SWEEP_KIND, start=start, stop=stop)
    kind.want(SWEEP_KEY)
    return kind


# ── Turns of boxes that never came back ─────────────────────────

RESTART_SWEEP_EVERY_SECONDS = 60.0


async def sweep_once(
    session_factory: async_sessionmaker[AsyncSession],
    post_as_agent: PostAsAgent,
    *,
    offline_after: timedelta = OFFLINE_AFTER,
    now: datetime | None = None,
) -> list[CutOffTurn]:
    """One restart sweep over every tenant (`restart_sweep.py`)."""
    interrupted: list[CutOffTurn] = []
    for tenant_id in await all_tenant_ids(session_factory):
        with tenant_scope(tenant_id):
            try:
                interrupted.extend(
                    await sweep_tenant(
                        session_factory,
                        tenant_id,
                        post_as_agent,
                        offline_after=offline_after,
                        now=now,
                    )
                )
            except Exception:
                # One tenant's failure must not stop the others' turns closing.
                logger.exception("Restart sweep failed for tenant %s", tenant_id)
    return interrupted


async def restart_sweep_loop(
    session_factory: async_sessionmaker[AsyncSession], post_as_agent: PostAsAgent
) -> None:
    """The restart sweep every minute, for the life of the process."""
    with no_tenant():
        while True:
            await asyncio.sleep(RESTART_SWEEP_EVERY_SECONDS)
            try:
                await sweep_once(session_factory, post_as_agent)
            except Exception:
                logger.exception("Restart sweep failed")


# The restart sweep is owned work too: one process sweeps
# every tenant, as upstream's sweeps, so two processes never both post the
# restart line for one turn. It's registered only with hosted agents v2 on.
RESTART_SWEEP_KIND = "restart_sweep"


def own_restart_sweep(
    ownership: Ownership,
    session_factory: async_sessionmaker[AsyncSession],
    post_as_agent: PostAsAgent,
) -> OwnedKind:
    """Register the restart sweep as owned work, wanted by this process; it
    runs here only while it holds it."""
    running: dict[str, asyncio.Task[None]] = {}

    def launch(key: str) -> None:
        task = asyncio.create_task(
            restart_sweep_loop(session_factory, post_as_agent), name="restart-sweep"
        )
        running[key] = task
        task.add_done_callback(lambda done: ended(key, done))

    def ended(key: str, task: asyncio.Task[None]) -> None:
        if task.cancelled() or running.get(key) is not task:
            return
        logger.error(
            "Restart sweep stopped unexpectedly; restarting",
            exc_info=task.exception(),
        )
        launch(key)

    async def start(key: str, fence: Fence) -> None:
        launch(key)

    async def stop(key: str) -> None:
        task = running.pop(key, None)
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    kind = ownership.kind(RESTART_SWEEP_KIND, start=start, stop=stop)
    kind.want(SWEEP_KEY)
    return kind

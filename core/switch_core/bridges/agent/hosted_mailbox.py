"""Delivering the wake mailbox to a hosted agent's worker, and keeping it tidy.

Delivery is always mark offered, then send: a row is leased to one worker
stream in a committed transaction before its `wake` frame is queued, so a
stream that dies or a Core that restarts leaves a lease that reclaim returns
to `pending`, never an event nobody holds.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api.hosted_worker_routes import post_mailbox_notices
from switch_core.bridges.agent.hosted_cutover import post_owed_cutover_notices
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.hosted_workers import (
    FrameSlot,
    WorkerBusyError,
    attached_worker_for,
    frame_size,
    offer_key,
)
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import HostedLaunch, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_mailbox_store import (
    WAKE_ENTRIES_PER_FRAME,
    HostedMailboxStore,
    MailboxEntry,
)

logger = logging.getLogger(__name__)


async def offer_pending(
    session: AsyncSession, registry: ConnectionRegistry, boot: int, launch: HostedLaunch
) -> int:
    """Lease the agent's `pending` rows to its worker, then queue them as `wake` frames.

    Oldest first, up to 50 entries a frame. A frame that does not fit the
    worker's queue is not offered: its rows stay `pending` for the next pass.
    Commits the session. Returns how many rows were sent.
    """
    conn = attached_worker_for(registry, launch)
    if conn is None or launch.agent_id is None:
        await session.commit()
        return 0
    rows = await HostedMailboxStore().pending(session, launch.agent_id)
    frames: list[tuple[FrameSlot, list[MailboxEntry]]] = []
    for start in range(0, len(rows), WAKE_ENTRIES_PER_FRAME):
        entries = [
            MailboxEntry.of_row(row)
            for row in rows[start : start + WAKE_ENTRIES_PER_FRAME]
        ]
        try:
            slot = conn.worker_frames.reserve(
                frame_size({"entries": [entry.wire() for entry in entries]})
            )
        except WorkerBusyError:
            logger.warning(
                "Worker queue of agent %s is full; %d mailbox row(s) stay pending",
                launch.agent_id,
                len(rows) - start,
            )
            break
        frames.append((slot, entries))
    try:
        offered = await HostedMailboxStore().mark_offered(
            session,
            launch.agent_id,
            [
                (entry.room_id, entry.message_id)
                for _, group in frames
                for entry in group
            ],
            offer_key(boot, conn),
        )
        await session.commit()
    except BaseException:
        for slot, _ in frames:
            slot.release()
        raise
    sent = 0
    for slot, group in frames:
        entries = [e for e in group if (e.room_id, e.message_id) in offered]
        if not entries:
            slot.release()
            continue
        slot.put("wake", {"entries": [entry.wire() for entry in entries]})
        sent += len(entries)
    return sent


async def deliver_on_attach(
    session: AsyncSession, protocol: ProtocolService, launch: HostedLaunch
) -> int:
    """At attach: take back every offer of the agent's, then offer all `pending` rows.

    The attaching stream is the only one that can hold a lease from now on,
    so every earlier offer (another boot, an older generation) is reclaimed.
    """
    assert launch.agent_id is not None
    conn = attached_worker_for(protocol.connections, launch)
    await HostedMailboxStore().reclaim(
        session,
        launch.agent_id,
        {}
        if conn is None
        else {launch.agent_id: offer_key(protocol.event_buffer.boot, conn)},
    )
    return await offer_pending(
        session, protocol.connections, protocol.event_buffer.boot, launch
    )


async def mailbox_upkeep(protocol: ProtocolService, since: datetime) -> None:
    """One pass over the bound tenant: reclaim, expire, prune, re-offer, log the backlog and post owed cutover notices."""
    store = HostedMailboxStore()
    registry = protocol.connections
    boot = protocol.event_buffer.boot
    now = datetime.now(UTC)
    async with tenant_session(protocol.session_factory, require_tenant_id()) as session:
        launches = list(
            await session.scalars(
                select(HostedLaunch).where(
                    HostedLaunch.tenant_id == require_tenant_id(),
                    HostedLaunch.agent_id.is_not(None),
                )
            )
        )
        live: dict[str, str] = {}
        for launch in launches:
            conn = attached_worker_for(registry, launch)
            if conn is not None and launch.agent_id is not None:
                live[launch.agent_id] = offer_key(boot, conn)
        reclaimed = await store.reclaim(session, None, live)
        notices, tombstoned = await store.expire(session, now)
        pruned = await store.prune(session, now)
        backlog = await store.backlog(session, since)
        waiting = await store.agents_with_pending(session)
        await session.commit()
    if reclaimed or notices or tombstoned or pruned:
        logger.info(
            "Wake mailbox upkeep in tenant %s: reclaimed=%d expired=%d "
            "tombstoned=%d pruned=%d",
            require_tenant_id(),
            reclaimed,
            len(notices),
            tombstoned,
            pruned,
        )
    for agent in backlog:
        logger.info(
            "Wake mailbox backlog agent=%s waiting=%d oldest=%s refused=%d",
            agent.agent_id,
            agent.waiting,
            agent.oldest.isoformat() if agent.oldest else "-",
            agent.refused,
        )
    await post_mailbox_notices(protocol, notices)
    by_agent = {launch.agent_id: launch.id for launch in launches}
    for agent_id in waiting:
        launch_id = by_agent.get(agent_id)
        if launch_id is None or agent_id not in live:
            continue
        async with tenant_session(
            protocol.session_factory, require_tenant_id()
        ) as session:
            current = await HostedLaunchStore().locked(session, launch_id)
            if current is not None:
                await offer_pending(session, registry, boot, current)
    await post_owed_cutover_notices(protocol)

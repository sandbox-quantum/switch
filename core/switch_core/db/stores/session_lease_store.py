"""Who owns a session's execution, and under which epoch."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from switch_core.db.models import SessionLease
from switch_core.db.stores.constraint_violations import violated_constraint

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class LeaseHeld(Exception):
    """Someone already holds this session's lease."""


class LeaseMoved(Exception):
    """The lease changed hands between reading it and displacing it."""


class SessionLeaseStore:
    # A lease counts as live while its heartbeat is within this window, and a
    # stale one is logically free — computed at read time, the way
    # `RoomRoleStore` does it, so no reaper has to run for a dead host to give
    # up its session. Longer than a role lease because the holder is a host
    # process doing real work rather than a channel loop: at a 30s renew
    # cadence this tolerates two fully missed renews, and the cost of being
    # wrong is displacing a host that is merely slow.
    LEASE_TTL = timedelta(seconds=90)

    async def acquire(
        self,
        session: AsyncSession,
        session_id: str,
        agent_id: str,
        host_id: str,
        epoch: str,
    ) -> SessionLease:
        """Take the lease on a session that has none.

        Refused by the primary key when the session already has one. That is
        the point: deciding whether the holder may be displaced is a policy
        question about liveness and ownership, and a store that silently
        replaced the row would answer it by accident. Use `take_over` once
        something has decided.

        The refusal is named and taken in a savepoint, because the caller has
        to answer the host and the losing side of a race between two first
        acquisitions is an ordinary outcome rather than a broken transaction.
        """
        lease = SessionLease(
            session_id=session_id,
            agent_id=agent_id,
            host_id=host_id,
            epoch=epoch,
        )
        try:
            async with session.begin_nested():
                session.add(lease)
                await session.flush()
        except IntegrityError as error:
            if violated_constraint(error) == "session_leases_pkey":
                raise LeaseHeld(
                    f"Session {session_id!r} already has a lease."
                ) from error
            raise
        return lease

    async def get(self, session: AsyncSession, session_id: str) -> SessionLease | None:
        result = await session.execute(
            select(SessionLease).where(SessionLease.session_id == session_id)
        )
        return result.scalar_one_or_none()

    async def get_held(
        self, session: AsyncSession, session_id: str
    ) -> SessionLease | None:
        """The lease, held against change until this transaction ends.

        A caller that reads the lease and then acts on what it found needs the
        generation to still be the one it read when it commits. An ordinary
        `get` cannot promise that: `take_over` and `renew` are single UPDATEs
        that will happily land in the gap, and the reader would commit work
        under an epoch the row no longer carries.

        This is a fence rather than an optimisation, so it belongs in the
        reader that depends on it rather than in `get`. Nothing that only wants
        to look at the lease should be made to queue behind a writer.
        """
        result = await session.execute(
            select(SessionLease)
            .where(SessionLease.session_id == session_id)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    def is_live(self, lease: SessionLease) -> bool:
        """Whether this lease's holder has heartbeated recently enough to count.

        Read-time liveness. A lease row outlives the process that took it, so
        the row's existence is not the question — whether anyone is still
        behind it is.
        """
        return lease.last_seen_at > datetime.now(UTC) - self.LEASE_TTL

    async def take_over(
        self,
        session: AsyncSession,
        session_id: str,
        displacing: str,
        agent_id: str,
        host_id: str,
        epoch: str,
    ) -> SessionLease:
        """Hand a session's lease to a new holder under a new epoch.

        Separate from `acquire`, which refuses rather than displaces. Whether
        the incumbent may be displaced is a policy question about liveness and
        ownership; this is what the answer looks like once something else has
        made it.

        `displacing` is the epoch the caller read and decided against, so the
        swap is conditional on the lease still being the one it judged. Two
        hosts deciding at once that the same dead holder is displaceable would
        otherwise both write, both be told they hold the session, and only one
        of them be right — the loser emitting under an epoch the row no longer
        carries.

        The row is updated rather than deleted and re-inserted for the same
        reason: no instant where the session has no holder at all.
        """
        now = datetime.now(UTC)
        result = await session.execute(
            update(SessionLease)
            .where(
                SessionLease.session_id == session_id,
                SessionLease.epoch == displacing,
            )
            .values(
                agent_id=agent_id,
                host_id=host_id,
                epoch=epoch,
                acquired_at=now,
                last_seen_at=now,
            )
            .returning(SessionLease)
        )
        lease = result.scalar_one_or_none()
        if lease is None:
            raise LeaseMoved(
                f"Session {session_id!r} is no longer held under epoch {displacing!r}."
            )
        return lease

    async def renew(
        self, session: AsyncSession, session_id: str, host_id: str, epoch: str
    ) -> None:
        """Mark the holder as still alive, keeping its epoch.

        Renewal is not re-acquisition. A host that renews carries on emitting
        under the epoch it already has, so nothing downstream is invalidated by
        a heartbeat.

        The holder has to name itself, because a displaced host does not know
        it has been displaced: keyed on the session alone, its last heartbeat
        would keep its successor's lease looking alive under the wrong host.
        Renewing a lease this host does not hold is an error, not a no-op.
        """
        result = await session.execute(
            update(SessionLease)
            .where(
                SessionLease.session_id == session_id,
                SessionLease.host_id == host_id,
                SessionLease.epoch == epoch,
            )
            .values(last_seen_at=datetime.now(UTC))
        )
        if result.rowcount == 0:  # type: ignore[attr-defined]
            raise LookupError(
                f"Host {host_id!r} holds no lease on session {session_id!r} "
                f"under epoch {epoch!r}."
            )

    async def release(
        self, session: AsyncSession, session_id: str, host_id: str, epoch: str
    ) -> None:
        """Give up the lease, leaving the session free for the next holder.

        Named for the same reason as `renew`: a displaced host shutting down
        must not delete the lease its successor now holds, which would strand a
        live session by refusing every event it sends.
        """
        result = await session.execute(
            delete(SessionLease).where(
                SessionLease.session_id == session_id,
                SessionLease.host_id == host_id,
                SessionLease.epoch == epoch,
            )
        )
        if result.rowcount == 0:  # type: ignore[attr-defined]
            raise LookupError(
                f"Host {host_id!r} holds no lease on session {session_id!r} "
                f"under epoch {epoch!r}."
            )
        await session.flush()

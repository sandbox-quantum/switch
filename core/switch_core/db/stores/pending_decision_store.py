"""Messages waiting for the decision service (`pending_decisions`).

The router adds a row in the transaction that writes the message; the
decision worker (`MessageRouter.decide_pending`) claims, expires and finishes
them. Every query runs in the caller's tenant-bound session.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from switch_core.db.models import PendingDecision


@dataclass(frozen=True)
class Pending:
    """One claimed or expired row."""

    room_id: str
    room_seq: int
    message_key: str


class PendingDecisionStore:
    async def add(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        room_id: str,
        room_seq: int,
        message_key: str,
    ) -> None:
        session.add(
            PendingDecision(
                tenant_id=tenant_id,
                room_id=room_id,
                room_seq=room_seq,
                message_key=message_key,
            )
        )
        await session.flush()

    async def expire(
        self, session: AsyncSession, *, tenant_id: str, max_age_seconds: float
    ) -> list[Pending]:
        """Delete and return the rows older than `max_age_seconds`, on the
        database's clock, the one that stamped them."""
        rows = await session.execute(
            delete(PendingDecision)
            .where(
                PendingDecision.tenant_id == tenant_id,
                PendingDecision.created_at
                < func.now() - func.make_interval(0, 0, 0, 0, 0, 0, max_age_seconds),
            )
            .returning(
                PendingDecision.room_id,
                PendingDecision.room_seq,
                PendingDecision.message_key,
            )
        )
        return [Pending(*row) for row in rows.all()]

    async def claim(
        self, session: AsyncSession, *, tenant_id: str, lease_seconds: float, limit: int
    ) -> list[Pending]:
        """Lease the oldest row of up to `limit` rooms whose oldest row is
        not leased already, and return them.

        One row per room at a time keeps a room's decisions in the order of
        its messages. `SKIP LOCKED` lets every process claim at once without
        any two taking the same row; the lease outlives this transaction, so
        nothing is held open across the call to the service, and a row whose
        process stopped mid-decision is claimed again once it lapses.
        """
        earlier = aliased(PendingDecision)
        due = (
            select(PendingDecision.room_id, PendingDecision.room_seq)
            .where(
                PendingDecision.tenant_id == tenant_id,
                (PendingDecision.claimed_until.is_(None))
                | (PendingDecision.claimed_until < func.now()),
                ~exists().where(
                    earlier.tenant_id == PendingDecision.tenant_id,
                    earlier.room_id == PendingDecision.room_id,
                    earlier.room_seq < PendingDecision.room_seq,
                ),
            )
            .order_by(PendingDecision.created_at)
            .limit(limit)
            .with_for_update(skip_locked=True, of=PendingDecision)
            .subquery()
        )
        rows = await session.execute(
            update(PendingDecision)
            .where(
                PendingDecision.tenant_id == tenant_id,
                PendingDecision.room_id == due.c.room_id,
                PendingDecision.room_seq == due.c.room_seq,
            )
            .values(
                claimed_until=func.now()
                + func.make_interval(0, 0, 0, 0, 0, 0, lease_seconds)
            )
            .returning(
                PendingDecision.room_id,
                PendingDecision.room_seq,
                PendingDecision.message_key,
            )
            .execution_options(synchronize_session=False)
        )
        return [Pending(*row) for row in rows.all()]

    async def finish(
        self, session: AsyncSession, *, tenant_id: str, pending: Pending
    ) -> bool:
        """Delete the row, and say whether it was still there: False when
        another process finished it after this one's lease lapsed, so this
        one must not deliver it again."""
        deleted = await session.scalar(
            delete(PendingDecision)
            .where(
                PendingDecision.tenant_id == tenant_id,
                PendingDecision.room_id == pending.room_id,
                PendingDecision.room_seq == pending.room_seq,
            )
            .returning(PendingDecision.room_seq)
        )
        return deleted is not None

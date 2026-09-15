from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import MessagingEventReceipt

#: How long a handled event is remembered.
#:
#: Two different needs, and the longer one sets it. Deduplication needs only to
#: outlast the platform's retry schedule, which is tens of minutes — Slack has
#: given up long before an hour. `handled_at` is the reason for days: a claimed
#: receipt that never completed is an event that reached nobody, and an hour is
#: not long enough for anyone to notice and come looking. A week of one row per
#: inbound event is a table Postgres does not notice.
RECEIPT_RETENTION = timedelta(days=7)


class MessagingEventReceiptStore:
    """Who has already taken an inbound event, and whether they finished it."""

    async def claim(
        self, session: AsyncSession, *, platform: str, external_event_id: str
    ) -> MessagingEventReceipt | None:
        """Take an event to handle, or return `None` because someone else has.

        The insert *is* the claim. Reading for an existing receipt and then
        writing one would leave the window this exists to close: two retries
        arriving together both read nothing, both write, and the customer gets
        two answers. Here the unique index decides, and the loser learns it did
        by failing.

        `None` rather than an exception because a duplicate is the ordinary
        case this is built for, not a fault — platforms deliver at least once
        by design, and a caller that treats the second one as an error would
        fill the log with the system working correctly.

        **Commit before doing the work.** An uncommitted claim still holds the
        index entry, so a concurrent retry's insert blocks on it rather than
        failing — and would stay blocked for as long as the first delivery
        takes, which is the length of an agent's turn. Committing straight away
        turns that wait into the immediate refusal it should be.
        """
        receipt = MessagingEventReceipt(
            platform=platform, external_event_id=external_event_id
        )
        session.add(receipt)
        try:
            await session.flush()
        except IntegrityError as exc:
            if "uq_messaging_event_receipts_event" not in str(exc.orig):
                raise
            await session.rollback()
            return None
        return receipt

    async def mark_handled(self, session: AsyncSession, *, receipt_id: str) -> None:
        """Record that the claimed event was seen all the way through.

        Its absence is the useful half. A receipt still unhandled long after it
        was claimed is an event the platform was told we had and nobody ever
        answered — a process that died mid-turn — and without this column that
        is indistinguishable from an event handled perfectly.
        """
        await session.execute(
            update(MessagingEventReceipt)
            .where(MessagingEventReceipt.id == receipt_id)
            .values(handled_at=datetime.now(UTC))
        )

    async def prune(self, session: AsyncSession) -> int:
        """Drop the bound tenant's receipts older than the retention window.

        Opportunistic rather than scheduled, the way stale role leases are
        cleared when the next agent takes a role. This backend has no janitor
        to hang a sweep on, and inventing one for a single table would be a
        larger change than the table deserves; running it off the traffic that
        creates the rows keeps the work proportional to that traffic and needs
        nothing started at boot.

        Called after the event has been dispatched, not before it. A prune in
        the claiming transaction would sit between a retry and the refusal it
        is waiting for.
        """
        result = await session.execute(
            delete(MessagingEventReceipt).where(
                MessagingEventReceipt.received_at
                < datetime.now(UTC) - RECEIPT_RETENTION
            )
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

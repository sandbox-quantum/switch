"""The session log: appending to it in order, and reading it back."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from switch_core.db.models import SessionEvent
from switch_core.db.stores.constraint_violations import violated_constraint

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class DuplicateEventId(Exception):
    """This event has already been accepted for this session."""


class HostSequenceTaken(Exception):
    """A different event already holds this position in the host's log."""


class SessionEventStore:
    async def append(self, session: AsyncSession, event: SessionEvent) -> SessionEvent:
        """Add an event to the log, numbering it.

        A host retrying from its outbox and a host that has miscounted are
        different problems — the first is already accepted and the second is a
        conflict — so the two refusals are raised apart, in a savepoint that
        leaves the caller able to say which. Everything else propagates.

        The caller must not have set `sequence`; this assigns it.
        """
        event.sequence = await self._next_sequence(session, event.session_id)
        try:
            async with session.begin_nested():
                session.add(event)
                await session.flush()
        except IntegrityError as error:
            constraint = violated_constraint(error)
            if constraint == "uq_session_events_event":
                raise DuplicateEventId(
                    f"Event {event.event_id!r} is already in the log for "
                    f"session {event.session_id!r}."
                ) from error
            if constraint == "uq_session_events_host_sequence":
                raise HostSequenceTaken(
                    f"Position {event.host_sequence!r} of epoch {event.epoch!r} "
                    f"is already taken for session {event.session_id!r}."
                ) from error
            raise
        return event

    async def read_after(
        self, session: AsyncSession, session_id: str, after: int, limit: int
    ) -> list[SessionEvent]:
        """The next page of the log, oldest first.

        `after` is a position and not a count, so re-reading from the same
        cursor returns the same events. A caller that has read nothing passes
        0, because positions start at 1.
        """
        result = await session.execute(
            select(SessionEvent)
            .where(
                SessionEvent.session_id == session_id,
                SessionEvent.sequence > after,
            )
            .order_by(SessionEvent.sequence)
            .limit(limit)
        )
        return list(result.scalars())

    async def read_host_range(
        self,
        session: AsyncSession,
        session_id: str,
        epoch: str,
        first: int,
        last: int,
    ) -> dict[int, SessionEvent]:
        """What is already logged at these positions of one host generation.

        Keyed by `host_sequence`, because the caller is comparing a batch it was
        just sent against what it already holds and only cares about the
        positions that overlap. A position with nothing at it is absent rather
        than `None`.
        """
        result = await session.execute(
            select(SessionEvent).where(
                SessionEvent.session_id == session_id,
                SessionEvent.epoch == epoch,
                SessionEvent.host_sequence >= first,
                SessionEvent.host_sequence <= last,
            )
        )
        return {
            row.host_sequence: row
            for row in result.scalars()
            if row.host_sequence is not None
        }

    async def head_host_sequence(
        self, session: AsyncSession, session_id: str, epoch: str
    ) -> int:
        """How far this generation of the host's log has been accepted, or 0.

        The maximum is the contiguous maximum: a gap is refused on the way in,
        so the log cannot hold position 7 without holding 6. Scoped to one
        epoch because host numbering restarts with each generation.
        """
        result = await session.execute(
            select(func.max(SessionEvent.host_sequence)).where(
                SessionEvent.session_id == session_id,
                SessionEvent.epoch == epoch,
            )
        )
        head: int | None = result.scalar_one()
        return 0 if head is None else head

    async def head_sequence(self, session: AsyncSession, session_id: str) -> int:
        """The session's current position, or 0 when nothing has been logged.

        What a snapshot is taken at, and what a subscriber that wants only what
        happens next starts from.
        """
        result = await session.execute(
            select(func.coalesce(func.max(SessionEvent.sequence), 0)).where(
                SessionEvent.session_id == session_id
            )
        )
        return int(result.scalar_one())

    async def lock(self, session: AsyncSession, session_id: str) -> None:
        """Serialise writers to this session's log for the rest of the transaction.

        Held to commit, not from a database sequence, for the reason
        `MessageStore._next_seq` sets out in full: a sequence numbers a row when
        its INSERT runs rather than when it commits, so a reader paging on
        `sequence > n` can advance past a number that is still in flight and
        never come back for it. A session's log has exactly that reader — the
        gateway stream — so it needs exactly that guarantee.

        Public because a caller that reads the log and then appends to it needs
        the read inside the same lock. Deciding whether a host event is a repeat
        or the next one is exactly that, and doing it outside the lock leaves a
        window where two batches both read the same position as free. Advisory
        locks are re-entrant within a transaction, so `append` taking it again
        costs nothing.

        Writers to one session serialise. Sessions do not contend with each
        other, beyond two whose ids collide in the hash.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:session_id))"),
            {"session_id": session_id},
        )

    async def _next_sequence(self, session: AsyncSession, session_id: str) -> int:
        """The next position in this session's log, allocated in commit order."""
        await self.lock(session, session_id)
        return await self.head_sequence(session, session_id) + 1

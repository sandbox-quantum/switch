"""The session log: appending to it in order, and reading it back."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select, text

from switch_core.db.models import SessionEvent

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionEventStore:
    async def append(self, session: AsyncSession, event: SessionEvent) -> SessionEvent:
        """Add an event to the log, numbering it.

        The caller must not have set `sequence`; this assigns it.
        """
        event.sequence = await self._next_sequence(session, event.session_id)
        session.add(event)
        await session.flush()
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

    async def _next_sequence(self, session: AsyncSession, session_id: str) -> int:
        """The next position in this session's log, allocated in commit order.

        Under an advisory lock held to commit, not from a database sequence,
        for the reason `MessageStore._next_seq` sets out in full: a sequence
        numbers a row when its INSERT runs rather than when it commits, so a
        reader paging on `sequence > n` can advance past a number that is still
        in flight and never come back for it. A session's log has exactly that
        reader — the gateway stream — so it needs exactly that guarantee.

        Writers to one session serialise. Sessions do not contend with each
        other, beyond two whose ids collide in the hash.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:session_id))"),
            {"session_id": session_id},
        )
        return await self.head_sequence(session, session_id) + 1

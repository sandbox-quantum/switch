"""Sessions someone signed out of (`revoked_sessions`).

A global table, read and written with no tenant bound. When a session counts
as signed out, and for how long, is `gateway/auth.py`'s.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import RevokedSession

# Rows any one sign-out deletes once they have expired: enough to keep up
# with the sign-outs that leave them, never a long statement in front of one.
_PRUNE_BATCH = 500


class RevokedSessionStore:
    async def revoke(
        self, session: AsyncSession, session_id: str, expires_at: datetime
    ) -> None:
        await session.execute(
            insert(RevokedSession)
            .values(session_id=session_id, expires_at=expires_at)
            .on_conflict_do_nothing(index_elements=["session_id"])
        )

    async def is_revoked(self, session: AsyncSession, session_id: str) -> bool:
        found = await session.scalar(
            select(RevokedSession.session_id).where(
                RevokedSession.session_id == session_id
            )
        )
        return found is not None

    async def prune(self, session: AsyncSession, now: datetime) -> None:
        """Delete rows past their expiry, skipping any another sign-out has
        locked, so a prune never waits on the sign-outs around it."""
        expired = (
            select(RevokedSession.session_id)
            .where(RevokedSession.expires_at < now)
            .limit(_PRUNE_BATCH)
            .with_for_update(skip_locked=True)
        )
        await session.execute(
            delete(RevokedSession).where(RevokedSession.session_id.in_(expired))
        )

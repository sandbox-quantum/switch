"""Who owns a session's execution, and under which epoch."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import delete, select, update

from switch_core.db.models import SessionLease

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionLeaseStore:
    async def acquire(
        self,
        session: AsyncSession,
        session_id: str,
        agent_id: str,
        host_id: str,
        epoch: str,
    ) -> SessionLease:
        """Take the lease on a session.

        Refused by the primary key when the session already has one. That is
        the point: deciding whether the holder may be displaced is a policy
        question about liveness and ownership, and a store that silently
        replaced the row would answer it by accident.
        """
        lease = SessionLease(
            session_id=session_id,
            agent_id=agent_id,
            host_id=host_id,
            epoch=epoch,
        )
        session.add(lease)
        await session.flush()
        return lease

    async def get(self, session: AsyncSession, session_id: str) -> SessionLease | None:
        result = await session.execute(
            select(SessionLease).where(SessionLease.session_id == session_id)
        )
        return result.scalar_one_or_none()

    async def renew(self, session: AsyncSession, session_id: str) -> None:
        """Mark the holder as still alive, keeping its epoch.

        Renewal is not re-acquisition. A host that renews carries on emitting
        under the epoch it already has, so nothing downstream is invalidated by
        a heartbeat. Renewing a lease nobody holds is an error and not a
        no-op — the caller believes it owns a session it does not.
        """
        result = await session.execute(
            update(SessionLease)
            .where(SessionLease.session_id == session_id)
            .values(last_seen_at=datetime.now(UTC))
        )
        if result.rowcount == 0:  # type: ignore[attr-defined]
            raise LookupError(f"No lease held on session {session_id!r}.")

    async def release(self, session: AsyncSession, session_id: str) -> None:
        """Give up the lease, leaving the session free for the next holder."""
        await session.execute(
            delete(SessionLease).where(SessionLease.session_id == session_id)
        )
        await session.flush()

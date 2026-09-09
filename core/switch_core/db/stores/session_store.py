"""The session itself: registering one, and what the host says about it."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select

from switch_core.db.models import HostSession

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionStore:
    async def register(
        self, session: AsyncSession, session_id: str, agent_id: str
    ) -> HostSession:
        """Record a session against the agent whose credential presented it.

        Called when a session first takes a lease, which is the only point the
        server has an authenticated agent to bind it to. A second registration
        of the same id is refused by the primary key rather than quietly
        rebinding the session to whoever asked last.

        `starting` is the contract's own word for a session that exists and has
        not reported anything yet, so it is written rather than left empty.
        """
        record = HostSession(
            id=session_id,
            agent_id=agent_id,
            status="starting",
        )
        session.add(record)
        await session.flush()
        return record

    async def get(self, session: AsyncSession, session_id: str) -> HostSession | None:
        result = await session.execute(
            select(HostSession).where(HostSession.id == session_id)
        )
        return result.scalar_one_or_none()

    async def record_reported_state(
        self,
        session: AsyncSession,
        session_id: str,
        provider: str,
        capabilities: dict,
        status: str,
    ) -> HostSession:
        """Store what the host said about itself in a `session.upsert`.

        Capabilities are kept at rest because the server enforces them on every
        command, and re-folding the log to find out what a session can do would
        make that check depend on history rather than on state. Nothing here is
        inferred from the provider name.
        """
        record = await self.get(session, session_id)
        if record is None:
            raise LookupError(f"No session registered as {session_id!r}.")
        record.provider = provider
        record.capabilities = capabilities
        record.status = status
        await session.flush()
        return record

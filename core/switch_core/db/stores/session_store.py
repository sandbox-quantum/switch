"""The session itself: registering one, and what the host says about it."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from switch_core.db.models import HostSession
from switch_core.db.stores.constraint_violations import violated_constraint

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionAlreadyRegistered(Exception):
    """This session id is already bound to an agent."""


class SessionStore:
    async def register(
        self, session: AsyncSession, session_id: str, agent_id: str, host_id: str
    ) -> HostSession:
        """Record a session against the agent whose credential presented it.

        Called when a session first takes a lease, which is the only point the
        server has an authenticated agent to bind it to. A second registration
        of the same id is refused by the primary key rather than quietly
        rebinding the session to whoever asked last, and the refusal is named
        because two hosts starting the same id at once is a conflict the caller
        has to report rather than a broken transaction.

        `starting` is the contract's own word for a session that exists and has
        not reported anything yet, so it is written rather than left empty.
        """
        record = HostSession(
            id=session_id,
            agent_id=agent_id,
            host_id=host_id,
            status="starting",
        )
        try:
            async with session.begin_nested():
                session.add(record)
                await session.flush()
        except IntegrityError as error:
            if violated_constraint(error) == "sessions_pkey":
                raise SessionAlreadyRegistered(
                    f"Session {session_id!r} is already registered."
                ) from error
            raise
        return record

    async def record_host(
        self, session: AsyncSession, session_id: str, host_id: str
    ) -> HostSession:
        """Note which host is running this session now.

        Kept on the session as well as on the lease because the lease is
        deleted when a host lets go, and a stopped session still has to say
        which host ran it. Written on every acquisition, so it names the last
        holder rather than the first.
        """
        record = await self.get(session, session_id)
        if record is None:
            raise LookupError(f"No session registered as {session_id!r}.")
        record.host_id = host_id
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

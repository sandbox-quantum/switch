"""Commands the server accepted: reserving, saving and reading them back."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select, text

from switch_core.db.models import SessionCommand

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionCommandStore:
    async def create(
        self, session: AsyncSession, command: SessionCommand
    ) -> SessionCommand:
        """Save an accepted command, taking its reservation with it.

        For an answer — a command carrying `request_id` and
        `expected_revision` — this insert *is* the reservation the contract
        asks be taken atomically. A competing answer to the same request at the
        same revision fails here, and it fails before anything has been
        delivered, which is what the caller turns into `REQUEST_BUSY`. There is
        no separate reservation to leak if the save then fails.

        The caller must not have set `delivery_position`; this assigns it.
        """
        command.delivery_position = await self._next_position(
            session, command.session_id
        )
        session.add(command)
        await session.flush()
        return command

    async def get_by_command_id(
        self, session: AsyncSession, session_id: str, command_id: str
    ) -> SessionCommand | None:
        """The command an id names, for the idempotency check.

        A repeat with the same actor and body is answered with this row; a
        repeat with either different is `IDEMPOTENCY_CONFLICT`, and the caller
        needs the saved one in hand to tell those apart.
        """
        result = await session.execute(
            select(SessionCommand).where(
                SessionCommand.session_id == session_id,
                SessionCommand.command_id == command_id,
            )
        )
        return result.scalar_one_or_none()

    async def read_after(
        self, session: AsyncSession, session_id: str, after: int, limit: int
    ) -> list[SessionCommand]:
        """The next commands to deliver, oldest first.

        The route of record behind `commands?after=`. It reads the table and
        nothing else, so it answers the same way for a host that has been
        offline for an hour as for one waiting on a notification.
        """
        result = await session.execute(
            select(SessionCommand)
            .where(
                SessionCommand.session_id == session_id,
                SessionCommand.delivery_position > after,
            )
            .order_by(SessionCommand.delivery_position)
            .limit(limit)
        )
        return list(result.scalars())

    async def set_status(
        self,
        session: AsyncSession,
        session_id: str,
        command_id: str,
        status: str,
        code: str | None,
        message: str | None,
    ) -> SessionCommand:
        """Move a command along, recording why where the host said why.

        Status is never dropped on the floor: a command whose outcome is
        genuinely not known is written as `unknown` rather than left looking
        dispatched.
        """
        command = await self.get_by_command_id(session, session_id, command_id)
        if command is None:
            raise LookupError(
                f"No command {command_id!r} accepted for session {session_id!r}."
            )
        command.status = status
        command.code = code
        command.message = message
        await session.flush()
        return command

    async def _next_position(self, session: AsyncSession, session_id: str) -> int:
        """The next delivery position for this session, in commit order.

        Same lock and same argument as `SessionEventStore._next_sequence`: this
        is what a host pages on, so a position that commits after one the host
        has already passed would be a command nobody ever delivers.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:session_id))"),
            {"session_id": session_id},
        )
        result = await session.execute(
            select(func.coalesce(func.max(SessionCommand.delivery_position), 0)).where(
                SessionCommand.session_id == session_id
            )
        )
        return int(result.scalar_one()) + 1

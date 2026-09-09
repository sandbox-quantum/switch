"""Commands the server accepted: reserving, saving and reading them back."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from switch_core.db.models import SessionCommand
from switch_core.db.stores.constraint_violations import violated_constraint

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class DuplicateCommandId(Exception):
    """This command id has already been accepted for this session."""


class RequestAlreadyReserved(Exception):
    """Someone else is already answering this request at this revision."""


class SessionCommandStore:
    async def create(
        self, session: AsyncSession, command: SessionCommand
    ) -> SessionCommand:
        """Save an accepted command, taking its reservation with it.

        For an answer — a command carrying `request_id` and
        `expected_revision` — this insert *is* the reservation the contract
        asks be taken atomically. A competing answer to the same request at the
        same revision fails here, and it fails before anything has been
        delivered. There is no separate reservation to leak if the save then
        fails.

        The two ways it can be refused mean different things and the contract
        answers them differently — a repeated command id is idempotency and a
        taken reservation is `REQUEST_BUSY` — so they are raised apart rather
        than left as one `IntegrityError` whose meaning depends on which index
        Postgres happened to check first. The insert runs in a savepoint so a
        refusal leaves the caller's transaction usable enough to answer.

        The caller must not have set `delivery_position`; this assigns it. The
        position is allocated outside the savepoint, because the lock has to be
        held to commit, and a refused insert leaves the number unused.
        """
        command.delivery_position = await self._next_position(
            session, command.session_id
        )
        try:
            async with session.begin_nested():
                session.add(command)
                await session.flush()
        except IntegrityError as error:
            constraint = violated_constraint(error)
            if constraint == "uq_session_commands_id":
                raise DuplicateCommandId(
                    f"Command {command.command_id!r} is already accepted for "
                    f"session {command.session_id!r}."
                ) from error
            if constraint == "uq_session_commands_reservation":
                raise RequestAlreadyReserved(
                    f"Request {command.request_id!r} at revision "
                    f"{command.expected_revision!r} is already being answered."
                ) from error
            raise
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

"""Which room a session may publish into."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from switch_core.db.models import SessionRoomAssociation
from switch_core.db.stores.constraint_violations import violated_constraint

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionAlreadyAssociated(Exception):
    """This session already publishes into a room."""


class SessionRoomAssociationStore:
    async def associate(
        self, session: AsyncSession, association: SessionRoomAssociation
    ) -> SessionRoomAssociation:
        """Give a session a room to publish into.

        Refused by the primary key when the session already has one. Moving a
        session to another room is a decision about a room someone is already
        watching, so it is not something a second call makes silently.

        The refusal is named and taken in a savepoint for the reason
        `SessionLeaseStore.acquire` gives: the caller has to tell the difference
        between "already associated" and a broken write, and it still has a
        transaction to answer in.
        """
        try:
            async with session.begin_nested():
                session.add(association)
                await session.flush()
        except IntegrityError as error:
            if violated_constraint(error) == "session_room_associations_pkey":
                raise SessionAlreadyAssociated(
                    f"Session {association.session_id!r} already publishes into a room."
                ) from error
            raise
        return association

    async def get(
        self, session: AsyncSession, session_id: str
    ) -> SessionRoomAssociation | None:
        """The room this session publishes into, or nothing.

        Nothing is the answer for every Console-started session, and it means
        no publication anywhere rather than publication somewhere sensible.
        """
        result = await session.execute(
            select(SessionRoomAssociation).where(
                SessionRoomAssociation.session_id == session_id
            )
        )
        return result.scalar_one_or_none()

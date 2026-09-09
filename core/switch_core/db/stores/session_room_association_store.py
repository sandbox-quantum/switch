"""Which room a session may publish into."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select

from switch_core.db.models import SessionRoomAssociation

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionRoomAssociationStore:
    async def associate(
        self, session: AsyncSession, association: SessionRoomAssociation
    ) -> SessionRoomAssociation:
        """Give a session a room to publish into.

        Refused by the primary key when the session already has one. Moving a
        session to another room is a decision about a room someone is already
        watching, so it is not something a second call makes silently.
        """
        session.add(association)
        await session.flush()
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

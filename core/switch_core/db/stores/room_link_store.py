from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Room, RoomLink


class RoomLinkStore:
    """Storage for directed room-to-room pointers (`room_links`)."""

    async def attach(
        self,
        session: AsyncSession,
        source_room_id: str,
        target_room_id: str,
        label: str,
    ) -> None:
        await session.execute(
            insert(RoomLink).values(
                source_room_id=source_room_id,
                target_room_id=target_room_id,
                label=label,
            )
        )
        await session.flush()

    async def detach(
        self,
        session: AsyncSession,
        source_room_id: str,
        target_room_id: str,
    ) -> bool:
        existed = await self.exists(session, source_room_id, target_room_id)
        if not existed:
            return False
        await session.execute(
            delete(RoomLink).where(
                RoomLink.source_room_id == source_room_id,
                RoomLink.target_room_id == target_room_id,
            )
        )
        await session.flush()
        return True

    async def exists(
        self,
        session: AsyncSession,
        source_room_id: str,
        target_room_id: str,
    ) -> bool:
        result = await session.execute(
            select(RoomLink.source_room_id).where(
                RoomLink.source_room_id == source_room_id,
                RoomLink.target_room_id == target_room_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def list_outbound(
        self, session: AsyncSession, source_room_id: str
    ) -> list[tuple[str, str, str, str]]:
        """Return outbound links from `source_room_id`, joined with the target
        room's name and description.

        Each tuple: ``(target_room_id, target_room_name, target_room_description, label)``.

        Archived target rooms are excluded — a pointer to an archived room is
        dead weight (the agent cannot connect to it), and mirrors the
        archived-filtering `RoomStore` queries.
        """
        result = await session.execute(
            select(Room.id, Room.name, Room.description, RoomLink.label)
            .join(RoomLink, RoomLink.target_room_id == Room.id)
            .where(RoomLink.source_room_id == source_room_id)
            .where(Room.archived_at.is_(None))
            .order_by(RoomLink.created_at)
        )
        return [(rid, name, desc, label) for rid, name, desc, label in result.all()]

    async def list_all(self, session: AsyncSession) -> list[tuple[str, str, str]]:
        """Return every link as ``(source_room_id, target_room_id, label)``."""
        result = await session.execute(
            select(
                RoomLink.source_room_id, RoomLink.target_room_id, RoomLink.label
            ).order_by(RoomLink.created_at)
        )
        return [(s, t, lbl) for s, t, lbl in result.all()]

    async def list_inbound(
        self, session: AsyncSession, target_room_id: str
    ) -> list[tuple[str, str, str, str]]:
        """Return inbound links pointing at `target_room_id`, joined with the
        source room's name and description.

        Each tuple: ``(source_room_id, source_room_name, source_room_description, label)``.

        Archived source rooms are excluded, mirroring ``list_outbound``.
        """
        result = await session.execute(
            select(Room.id, Room.name, Room.description, RoomLink.label)
            .join(RoomLink, RoomLink.source_room_id == Room.id)
            .where(RoomLink.target_room_id == target_room_id)
            .where(Room.archived_at.is_(None))
            .order_by(RoomLink.created_at)
        )
        return [(rid, name, desc, label) for rid, name, desc, label in result.all()]

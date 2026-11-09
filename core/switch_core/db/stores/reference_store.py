from typing import Any, cast

from sqlalchemy import CursorResult, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Reference,
    Room,
    User,
    package_references,
    room_references,
)
from switch_core.db.stores.room_store import AttachedRooms, readable_by

_LIKE_ESCAPE = "\\"


def _like_needle(text: str) -> str:
    escaped = (
        text.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", f"{_LIKE_ESCAPE}%")
        .replace("_", f"{_LIKE_ESCAPE}_")
    )
    return f"%{escaped}%"


class ReferenceStore:
    async def create(self, session: AsyncSession, reference: Reference) -> Reference:
        session.add(reference)
        await session.flush()
        return reference

    async def get(self, session: AsyncSession, reference_id: str) -> Reference | None:
        return await session.get(Reference, reference_id)

    async def get_for_update(
        self, session: AsyncSession, reference_id: str
    ) -> Reference | None:
        """Load the row locked until the transaction ends, for a caller that
        checks it and then writes it.

        ``populate_existing`` refreshes a copy already in the session, so the
        check sees the committed row rather than an earlier read of it.
        """
        return await session.get(
            Reference, reference_id, with_for_update=True, populate_existing=True
        )

    async def list_for_user(
        self, session: AsyncSession, user_id: str
    ) -> list[Reference]:
        """Return refs the user owns plus all publicly readable refs."""
        result = await session.execute(
            select(Reference).where(
                or_(
                    Reference.owner_id == user_id,
                    Reference.read_visibility == "public",
                )
            )
        )
        return list(result.scalars().all())

    async def list_readable_with_owner_names(
        self,
        session: AsyncSession,
        user_id: str,
        *,
        is_admin: bool,
        name_contains: str | None = None,
        type: str | None = None,
        owner_name: str | None = None,
    ) -> list[tuple[Reference, str]]:
        """Return (reference, owner_name) pairs the user may read, newest first.

        An admin reads every reference; anyone else reads the ones they own
        plus the publicly readable ones. The optional filters are ANDed on top
        of that; a None filter is ignored. `name_contains` is a
        case-insensitive substring match, `type` and `owner_name` are exact.
        """
        query = select(Reference, User.name).join(User, Reference.owner_id == User.id)
        if not is_admin:
            query = query.where(
                or_(
                    Reference.owner_id == user_id,
                    Reference.read_visibility == "public",
                )
            )
        if name_contains is not None:
            query = query.where(
                Reference.name.ilike(_like_needle(name_contains), escape=_LIKE_ESCAPE)
            )
        if type is not None:
            query = query.where(Reference.type == type)
        if owner_name is not None:
            query = query.where(User.name == owner_name)
        result = await session.execute(
            query.order_by(Reference.created_at.desc(), Reference.id.asc())
        )
        return [(ref, name) for ref, name in result.all()]

    async def update_fields(
        self,
        session: AsyncSession,
        reference_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
        value: dict | None = None,
    ) -> Reference:
        ref = await session.get(Reference, reference_id)
        if ref is None:
            raise ValueError(f"Reference not found: {reference_id}")
        if name is not None:
            ref.name = name
        if description is not None:
            ref.description = description
        if instructions is not None:
            ref.instructions = instructions
        if read_visibility is not None:
            ref.read_visibility = read_visibility
        if write_visibility is not None:
            ref.write_visibility = write_visibility
        if value is not None:
            ref.value = value
        await session.flush()
        return ref

    async def delete(self, session: AsyncSession, reference_id: str) -> list[str]:
        """Delete a reference, taking it out of every room and package it is
        in. Returns the list of room_ids it was attached to.

        Package membership has no cascade, so it is removed here: without it a
        packaged reference cannot be deleted at all."""
        await session.execute(
            delete(package_references).where(
                package_references.c.reference_id == reference_id
            )
        )
        room_id_result = await session.execute(
            select(room_references.c.room_id).where(
                room_references.c.reference_id == reference_id
            )
        )
        affected_rooms = list(room_id_result.scalars().all())
        await session.execute(
            delete(room_references).where(
                room_references.c.reference_id == reference_id
            )
        )
        ref = await session.get(Reference, reference_id)
        if ref:
            await session.delete(ref)
        await session.flush()
        return affected_rooms

    async def attach_to_room(
        self, session: AsyncSession, room_id: str, reference_id: str
    ) -> bool:
        """Attach a reference to a room, saying whether it was attached now.
        Idempotent: attaching one that is already attached is a no-op, not a
        primary-key violation."""
        result = await session.execute(
            pg_insert(room_references)
            .values(room_id=room_id, reference_id=reference_id)
            .on_conflict_do_nothing(
                index_elements=[
                    room_references.c.room_id,
                    room_references.c.reference_id,
                ]
            )
        )
        await session.flush()
        return cast("CursorResult[Any]", result).rowcount == 1

    async def detach_from_room(
        self, session: AsyncSession, room_id: str, reference_id: str
    ) -> bool:
        """Detach it from a room, saying whether it was attached."""
        result = await session.execute(
            delete(room_references).where(
                room_references.c.room_id == room_id,
                room_references.c.reference_id == reference_id,
            )
        )
        await session.flush()
        return cast("CursorResult[Any]", result).rowcount == 1

    async def list_for_room(
        self, session: AsyncSession, room_id: str
    ) -> list[Reference]:
        result = await session.execute(
            select(Reference)
            .join(
                room_references,
                Reference.id == room_references.c.reference_id,
            )
            .where(room_references.c.room_id == room_id)
        )
        return list(result.scalars().all())

    async def list_ids_for_room(self, session: AsyncSession, room_id: str) -> set[str]:
        """Return the ids of the references attached to a room."""
        result = await session.execute(
            select(room_references.c.reference_id).where(
                room_references.c.room_id == room_id
            )
        )
        return set(result.scalars().all())

    async def is_attached_to_room(
        self, session: AsyncSession, room_id: str, reference_id: str
    ) -> bool:
        result = await session.execute(
            select(room_references.c.room_id).where(
                room_references.c.room_id == room_id,
                room_references.c.reference_id == reference_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def get_attached_counts(
        self,
        session: AsyncSession,
        reference_ids: list[str],
        *,
        reader_id: str | None,
        reader_is_admin: bool,
    ) -> dict[str, AttachedRooms]:
        """How many rooms each is attached to: every one, and those the reader
        may read."""
        if not reference_ids:
            return {}
        result = await session.execute(
            select(
                room_references.c.reference_id,
                func.count(room_references.c.room_id),
                func.count(room_references.c.room_id).filter(
                    readable_by(reader_id, is_admin=reader_is_admin)
                ),
            )
            .join(Room, Room.id == room_references.c.room_id)
            .where(room_references.c.reference_id.in_(reference_ids))
            .group_by(room_references.c.reference_id)
        )
        counts = {
            rid: AttachedRooms(every=int(every), readable=int(readable))
            for rid, every, readable in result.all()
        }
        return {rid: counts.get(rid, AttachedRooms(0, 0)) for rid in reference_ids}

    async def list_rooms_for_reference(
        self,
        session: AsyncSession,
        reference_id: str,
        *,
        reader_id: str | None,
        reader_is_admin: bool,
    ) -> list[tuple[str, str]]:
        """The rooms it is attached to, of those the reader may read."""
        result = await session.execute(
            select(Room.id, Room.name)
            .join(room_references, Room.id == room_references.c.room_id)
            .where(room_references.c.reference_id == reference_id)
            .where(readable_by(reader_id, is_admin=reader_is_admin))
        )
        return [(rid, name) for rid, name in result.all()]

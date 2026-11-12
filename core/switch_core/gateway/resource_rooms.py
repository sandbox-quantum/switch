"""The rooms a reference, document or package is in, as told to the person
looking at it.

A room the viewer may not read is never named to them. Whoever may manage the
resource (its owner, or a tenant admin) is still told how many such rooms it
is in, so they can see how widely it is used and what deleting it touches.
"""

from __future__ import annotations

from collections.abc import Awaitable, Sequence
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Authorizable, Principal, can, can_unlink_from_room
from switch_core.db.stores.room_store import AttachedRooms, RoomStore
from switch_core.gateway.schemas import ResourceRoom


class _Resource(Authorizable, Protocol):
    @property
    def id(self) -> str: ...


class _CountAttached(Protocol):
    """`ResourceService.get_{reference,document,package}_attached_counts`."""

    def __call__(
        self,
        session: AsyncSession,
        ids: list[str],
        /,
        *,
        reader_id: str | None,
        reader_is_admin: bool,
    ) -> Awaitable[dict[str, AttachedRooms]]: ...


@dataclass(frozen=True)
class RoomCounts:
    # The rooms the viewer is told the resource is in.
    attached: int
    # Of those, how many the viewer may not read. Never more than zero for
    # someone who may not manage the resource, since those rooms are not
    # counted for them at all.
    hidden: int


async def room_counts(
    session: AsyncSession,
    resources: Sequence[_Resource],
    reader: Principal,
    count: _CountAttached,
) -> dict[str, RoomCounts]:
    attached = await count(
        session,
        [r.id for r in resources],
        reader_id=reader.id,
        reader_is_admin=reader.is_admin,
    )
    counts: dict[str, RoomCounts] = {}
    for r in resources:
        rooms = attached[r.id]
        if can(reader, "delete", r):
            counts[r.id] = RoomCounts(rooms.every, rooms.every - rooms.readable)
        else:
            counts[r.id] = RoomCounts(rooms.readable, 0)
    return counts


async def resource_rooms(
    session: AsyncSession,
    room_store: RoomStore,
    rooms: list[tuple[str, str]],
    reader: Principal,
) -> list[ResourceRoom]:
    """`rooms` (id, name), already limited to those `reader` may read, each
    saying whether `reader` may unlink the resource from it."""
    taking_part: set[str] = set()
    if not reader.is_admin and reader.id is not None:
        taking_part = await room_store.involved_room_ids(
            session, reader.id, [rid for rid, _ in rooms]
        )
    return [
        ResourceRoom(
            room_id=rid,
            room_name=name,
            can_unlink=can_unlink_from_room(reader, takes_part=rid in taking_part),
        )
        for rid, name in rooms
    ]

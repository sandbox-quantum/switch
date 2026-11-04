"""How many rooms a reference, document or package is attached to, as told to
the person looking at it.

A room the viewer may not read is never named to them. Whoever may manage the
resource (its owner, or a tenant admin) is still told how many such rooms it
is in, so they can see how widely it is used and what deleting it touches.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from switch_core.authz import Authorizable, Principal, can


class _Resource(Authorizable, Protocol):
    @property
    def id(self) -> str: ...


# (resource ids, reader id, reader is admin) -> rooms each is in that the
# reader may read; every room, for an admin.
CountRooms = Callable[[list[str], str | None, bool], Awaitable[dict[str, int]]]


@dataclass(frozen=True)
class RoomCounts:
    # The rooms the viewer is told the resource is in.
    attached: int
    # Of those, how many the viewer may not read. Never more than zero for
    # someone who may not manage the resource, since those rooms are not
    # counted for them at all.
    hidden: int


async def room_counts(
    resources: Sequence[_Resource], reader: Principal, count: CountRooms
) -> dict[str, RoomCounts]:
    ids = [r.id for r in resources]
    readable = await count(ids, reader.id, reader.is_admin)
    managed = (
        [] if reader.is_admin else [r.id for r in resources if can(reader, "delete", r)]
    )
    # Counted as an admin would, which is every room.
    every = await count(managed, None, True) if managed else {}
    counts: dict[str, RoomCounts] = {}
    for rid in ids:
        attached = every.get(rid, readable[rid])
        counts[rid] = RoomCounts(attached=attached, hidden=attached - readable[rid])
    return counts

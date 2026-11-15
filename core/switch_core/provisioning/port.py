"""The provisioning port: accounts, rooms and membership.

`MessageTransport` covers what a participant does once it exists. This covers
bringing rooms and memberships into existence in the first place. The two are
separate ports because they are used by different callers at different times:
the transport by every client for the life of the process, this once per room
or membership change, by room provisioning and the client/bridge lifecycles.

Membership is expressed as invite/kick because that is what the operations
mean. `invite_to_room` promises the user ends up in the room, and callers rely
on that rather than on an invitation being separately accepted.

Both operations are idempotent by contract: inviting a member who is already
in, or kicking one who is already out, is success and not an error. Every other
failure raises.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


@runtime_checkable
class Provisioning(Protocol):
    """Creates the rooms and memberships the transport then talks over."""

    async def create_room(self, name: str, topic: str) -> str:
        """Create a room and return its transport-side id."""
        ...

    async def invite_to_room(
        self, room_id: str, user_id: str, *, quiet: bool = False
    ) -> None:
        """Put a user in a room. Already a member is success. A `quiet`
        arrival is written to history but wakes no agent."""
        ...

    async def record_join(
        self, session: AsyncSession, room_id: str, user_id: str
    ) -> Callable[[], None]:
        """Put a client that is never live in a room within the caller's
        transaction; what to run once the caller has committed. Already a
        member is success."""
        ...

    async def record_leave(
        self,
        session: AsyncSession,
        room_id: str,
        user_id: str,
        *,
        removed_by: str | None = None,
    ) -> Callable[[], None]:
        """Remove a membership and write its departure in the caller's
        transaction, so it commits with whatever else the caller removes. The
        caller still calls `kick_user` after committing, to stop a live
        client's delivery. Returns what to run once the caller has committed.
        Already out is success, with nothing to run."""
        ...

    async def kick_user(
        self,
        room_id: str,
        user_id: str,
        *,
        removed_by: str | None = None,
        announce: bool = True,
    ) -> bool | None:
        """Take a user out of a room. Already out is success. Returns whether
        this call removed the membership (None from an implementation that
        cannot say, read as removed).

        The departure is written into the room's history ("X left the room"),
        naming `removed_by` when someone took them out, unless `announce` is
        False: for a room about to be deleted, where nobody is left to read
        it."""
        ...

    async def delete_room(self, room_id: str) -> None:
        """Discard a room. Callers remove the other members first."""
        ...

    async def close(self) -> None:
        """Release whatever the implementation holds open."""
        ...

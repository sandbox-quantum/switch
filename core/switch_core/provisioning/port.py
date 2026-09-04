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

from typing import Protocol, runtime_checkable


@runtime_checkable
class Provisioning(Protocol):
    """Creates the rooms and memberships the transport then talks over."""

    async def create_room(self, name: str, topic: str) -> str:
        """Create a room and return its transport-side id."""
        ...

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        """Put a user in a room. Already a member is success."""
        ...

    async def kick_user(self, room_id: str, user_id: str) -> None:
        """Take a user out of a room. Already out is success."""
        ...

    async def delete_room(self, room_id: str) -> None:
        """Discard a room. Callers remove the other members first."""
        ...

    async def close(self) -> None:
        """Release whatever the implementation holds open."""
        ...

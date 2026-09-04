"""The provisioning port: accounts, rooms and membership.

`MessageTransport` covers what a participant does once it exists. This covers
bringing participants and rooms into existence in the first place — the second
and last thing switch-core asks a homeserver for. The two are separate ports
because they are used by different callers at different times: the transport by
every client for the life of the process, this once per account, room or
membership change, by room provisioning and the client/bridge lifecycles.

The contract is derived from the call sites, not from the endpoints behind it:
create an account, create a room, add and remove a member, discard a room, and
check a password. `verify_login` is the odd one — it exists so a cutover can
tell an empty target server from one that already has accounts under the same
names — and it is the operation most likely to have no counterpart in a future
implementation.

Membership is expressed as invite/kick because that is what the operations
mean, not because of how a homeserver spells them. An implementation that can
simply write a row is free to do so; `invite_to_room` promises the user ends up
in the room, and callers already rely on that rather than on an invitation
being separately accepted.

Both operations are idempotent by contract: inviting a member who is already
in, or kicking one who is already out, is success and not an error. Every other
failure raises.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Provisioning(Protocol):
    """Creates the accounts and rooms the transport then talks over."""

    async def register_user(
        self,
        user_id: str,
        password: str,
        display_name: str | None = None,
        is_admin: bool = False,
    ) -> None:
        """Create an account, or do nothing if it already exists."""
        ...

    async def verify_login(self, user_id: str, password: str) -> bool:
        """Whether `password` authenticates `user_id`."""
        ...

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

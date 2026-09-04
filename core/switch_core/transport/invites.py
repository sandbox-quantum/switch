"""How a client is told it has been added to a room.

Over Matrix this was an event: the admin invited a user, the user's sync loop
saw the invitation and `ClientBase.on_invite` joined. Nothing else had to know
the order things happened in, because the invitation was durable and the client
picked it up whenever it next synced.

A Postgres transport watches the rooms it knew about when it started, so a
membership written underneath it would be a room it never reads — a client
sitting in a room in silence, which is precisely the failure this stack keeps
refusing to ship. This is the missing signal, in the shape the clients already
handle: an invitation, delivered to a live client, auto-accepted by the same
code path as before.

**It is in-process, and that is a real limitation.** A client running in
another replica of switch-core would not hear it. That is the same constraint
Matrix sync sessions imposed and the reason switch-core is single-replica
today; lifting it is its own step, and until then this is no worse than what it
replaces. When nobody is listening for a user the caller writes the membership
itself, so the room is still joined the next time that client starts — the
invitation is a wake-up, never the record.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

InviteHandler = Callable[[str], Awaitable[None]]


class InviteBus:
    """Routes an invitation to the live transport for a user, if there is one."""

    def __init__(self) -> None:
        self._handlers: dict[str, InviteHandler] = {}

    def register(self, user_id: str, handler: InviteHandler) -> None:
        self._handlers[user_id] = handler

    def unregister(self, user_id: str) -> None:
        self._handlers.pop(user_id, None)

    async def invite(self, user_id: str, transport_room_id: str) -> bool:
        """Tell `user_id` it is in `transport_room_id`.

        Returns whether anyone was listening. False is not an error — a client
        that is not running has nothing to wake — but the caller then owns
        writing the membership, so the answer must not be ignored.
        """
        handler = self._handlers.get(user_id)
        if handler is None:
            return False
        await handler(transport_room_id)
        return True

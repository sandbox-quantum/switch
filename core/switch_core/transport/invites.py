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
        """Make `handler` the live listener for `user_id`, displacing any other.

        One slot per user, so a client that starts while an older instance of
        itself is still unwinding takes the slot from it. That is the right
        answer — the newer one is the client with a live receive loop — and it
        is why `unregister` wants the handler back.
        """
        self._handlers[user_id] = handler

    def unregister(self, user_id: str, handler: InviteHandler) -> None:
        """Give the slot up, but only if `handler` still holds it.

        A transport unregisters from the `finally` of its receive loop, which
        runs whenever that loop ends — including long after a newer client for
        the same user took the slot. Clearing by user id alone would deafen
        that newer client: `invite` would find nobody listening, the caller
        would write the membership row itself, and the client would sit in a
        room it was never told it was in until something restarted it.
        """
        if self._handlers.get(user_id) == handler:
            del self._handlers[user_id]

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

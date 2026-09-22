"""How a client is told its membership of a room changed.

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

Removal is the same signal in reverse, and it is not optional. The homeserver
used to enforce a kick: a removed client's sync simply stopped returning the
room. Here the subscription is the client's own, so deleting the membership row
leaves it reading a room it is no longer in. A removal must therefore be rung
as well as written.

**It is in-process, and that is a real limitation.** A client running in
another replica of switch-core would not hear it. That is the same constraint
Matrix sync sessions imposed and the reason switch-core is single-replica
today; lifting it is its own step, and until then this is no worse than what it
replaces. When nobody is listening for a client the caller writes the
membership itself, so the room is still joined the next time that client
starts — the invitation is a wake-up, never the record.

**Keyed by client id, which is a primary key.** It used to be keyed by
`matrix_user_id`, and that was wrong the moment a second tenant existed:
`clients.matrix_user_id` is unique *per tenant*, not globally, and
`ensure_system_client` deliberately gives every tenant's admin client the same
`@switch-admin:<server>` handle. Two tenants running an admin client meant one
slot and one winner, so an invitation for tenant A's admin woke tenant B's,
which could not resolve the room and logged a swallowed error — while `invite`
returned True, telling the caller a live client had joined itself, so the
membership row was never written either. A tenant's rooms silently had no admin
participant. `clients.id` is a uuid primary key, so there is nothing for a
tenant to disambiguate and the collision is unrepresentable.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

InviteHandler = Callable[[str], Awaitable[None]]


class InviteBus:
    """Routes a membership change to the live transport for a client, if any.

    Named for the signal it carried first. It now carries removals too, since
    both are the same thing: telling a running client that the set of rooms it
    should be reading has changed underneath it.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, InviteHandler] = {}
        self._removal_handlers: dict[str, InviteHandler] = {}

    def register(
        self, client_id: str, handler: InviteHandler, removal_handler: InviteHandler
    ) -> None:
        """Make this pair the live listeners for `client_id`, displacing any other.

        One slot per client, so a client that starts while an older instance of
        itself is still unwinding takes the slot from it. That is the right
        answer — the newer one is the client with a live receive loop — and it
        is why `unregister` wants the handlers back.

        Both arms are taken together and never separately. A client registered
        for invitations but not removals is the shape of a leak — it would be
        told about every room it gains and none it loses — so the state is made
        unrepresentable here rather than guarded against at every use.
        """
        self._handlers[client_id] = handler
        self._removal_handlers[client_id] = removal_handler

    def unregister(
        self, client_id: str, handler: InviteHandler, removal_handler: InviteHandler
    ) -> None:
        """Give the slot up, but only if these handlers still hold it.

        A transport unregisters from the `finally` of its receive loop, which
        runs whenever that loop ends — including long after a newer instance of
        the same client took the slot. Clearing by id alone would deafen that
        newer one: `invite` would find nobody listening, the caller would write
        the membership row itself, and the client would sit in a room it was
        never told it was in until something restarted it. For a removal the
        same mistake is worse, because there is no membership row for a caller
        to fall back to — the newer client would simply keep delivering a room
        it had been taken out of.
        """
        if self._handlers.get(client_id) == handler:
            del self._handlers[client_id]
        if self._removal_handlers.get(client_id) == removal_handler:
            del self._removal_handlers[client_id]

    async def invite(self, client_id: str, transport_room_id: str) -> bool:
        """Tell `client_id` it is in `transport_room_id`.

        Returns whether anyone was listening. False is not an error — a client
        that is not running has nothing to wake — but the caller then owns
        writing the membership, so the answer must not be ignored.
        """
        handler = self._handlers.get(client_id)
        if handler is None:
            return False
        await handler(transport_room_id)
        return True

    async def remove(self, client_id: str, transport_room_id: str) -> None:
        """Tell `client_id` it is no longer in `transport_room_id`.

        Nothing is returned, unlike `invite`: the caller has nothing to fall
        back to. A client that is not running holds no subscription to drop,
        and one that starts later reads its rooms from the table the removal
        already updated, so "nobody was listening" is the expected answer.

        A client listening for invitations but not removals is not expected —
        `register` makes it unrepresentable — and is reported rather than left
        to surface as a room quietly delivered to someone no longer in it.
        """
        handler = self._removal_handlers.get(client_id)
        if handler is None:
            if client_id in self._handlers:
                logger.error(
                    "Client %s is listening for invitations but not for removals; "
                    "it will keep delivering %s after being taken out of it",
                    client_id,
                    transport_room_id,
                )
            return
        await handler(transport_room_id)

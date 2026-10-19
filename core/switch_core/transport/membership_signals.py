"""Room membership changes, reaching the copy of each client in every process.

Every switch-core process runs its own copy of each client, and each copy
reads the rooms its client is a member of. `InviteBus` wakes only the copy in
the process that served the change. The others hear of it from the
`membership.changed` signal that a trigger on `client_rooms` sends for every
row inserted or deleted (`db/membership_notify_ddl.py`), and the copy here
re-reads its client's rows and starts or stops reading the rooms that differ
(`PostgresTransport._reconcile_membership`). The process that wrote the row
hears its own signal too; its copy already reads the room, or is joining it,
so the re-read changes nothing.

A removed member has to stop receiving the room on every process, so a missed
signal must not be the end of it. A re-read that fails is kept and tried
again, every client running here is re-read when the signal connection comes
back, and again on each periodic re-check.

An agent reads no room, so it has no copy here to wake. What an agent's
membership changes in this process is what is held in its memory: the room
claims of the agent's connections held here, and the rooms of a controller
streaming it from here. Every change is handed to the router for that
(`MessageRouter.membership_changed`), and retried the same way when it fails.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from switch_core.db.membership_notify_ddl import MEMBERSHIP_CHANGED_SIGNAL

if TYPE_CHECKING:
    from switch_core.delivery.router import MessageRouter
    from switch_core.signals import SignalBus
    from switch_core.transport.invites import InviteBus

logger = logging.getLogger(__name__)


class MembershipSignals:
    def __init__(
        self, *, invites: InviteBus, bus: SignalBus, router: MessageRouter
    ) -> None:
        self._invites = invites
        self._owed = bus.pending_work("memberships", invites.reconcile)
        self._agents_owed = bus.pending_work(
            "agent memberships", router.membership_changed
        )
        bus.handle(MEMBERSHIP_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(self.reconcile_all)
        bus.on_recheck(self.reconcile_all)

    def _on_changed(self, signal: dict[str, Any]) -> None:
        client_id = signal["client_id"]
        if self._invites.is_listening(client_id):
            self._owed.add(client_id)
            return
        # Not a client that reads rooms here: an agent, whose connections and
        # controller this process may hold, or a person's actor, which the
        # router finds is no agent and leaves alone.
        self._agents_owed.add((signal["tenant_id"], client_id, signal["room_id"]))

    async def reconcile_all(self) -> None:
        """Re-read every client running here, one after another so a
        re-check never asks the pool for more than one connection."""
        for client_id in self._invites.client_ids():
            try:
                await self._invites.reconcile(client_id)
            except Exception:
                logger.warning(
                    "Could not re-read the memberships of client %s; retrying",
                    client_id,
                    exc_info=True,
                )
                self._owed.add(client_id)

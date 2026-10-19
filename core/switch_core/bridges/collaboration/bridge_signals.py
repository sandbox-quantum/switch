"""Bridges registered, edited or removed in one process, reaching every other.

Every switch-core process runs its own copy of each collaboration bridge:
listening in the one that holds it, quiet in the rest
(`lifecycle_service.py`). A bridge registered, edited or removed through one
process changed only that process's copy, so the holder elsewhere kept an old
config, a removed bridge kept its socket and kept relaying, and a new one ran
nowhere else until a restart.

So a registration, an edit or a removal, once committed, announces
`bridge.changed` naming the bridge. Every other process re-reads the bridge's
row and brings its copy in line (`CollaborationBridgeLifecycleService.
reconcile_bridge`): starting it, restarting it with the new config, or
stopping it and letting go of its lease. A re-read that fails is kept and
tried again, and every bridge is re-read when the signal connection comes back
and on each periodic re-check, so a missed signal costs a delay rather than a
stale bridge until a restart.

A room bridged to a channel, or unbridged from one, is announced the same way,
as `bridge.rooms_changed`: the processes running the bridge map its rooms
again (`reload_rooms`), so the one listening to the platform stops carrying
the channel into a room that no longer has it. A room bridged elsewhere is
also found on the spot when a message reaches a process that has not mapped
it yet (`CollaborationCore._channel_for_room`).

Work only the holder does that reached a quiet copy instead, such as a Teams
webhook saying a Graph subscription needs renewing, is relayed to the holder
as `bridge.for_holder` (`PlatformAdapter.set_holder_relay`). Every process
hears it and only the one holding the bridge acts on it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.lifecycle_service import (
        CollaborationBridgeLifecycleService,
    )
    from switch_core.signals import SignalBus

BRIDGE_CHANGED_SIGNAL = "bridge.changed"
BRIDGE_ROOMS_CHANGED_SIGNAL = "bridge.rooms_changed"
BRIDGE_FOR_HOLDER_SIGNAL = "bridge.for_holder"

# A relayed request as `PendingWork` keeps it: the bridge, then the request's
# fields in order, so the same request relayed twice is one piece of work.
_Relayed = tuple[str, tuple[tuple[str, str], ...]]


class BridgeSignals:
    def __init__(
        self, *, lifecycle: CollaborationBridgeLifecycleService, bus: SignalBus
    ) -> None:
        self._bus = bus
        self._owed = bus.pending_work("bridges", lifecycle.reconcile_bridge)
        self._rooms_owed = bus.pending_work("bridge-rooms", lifecycle.reload_rooms)
        self._lifecycle = lifecycle
        self._relayed = bus.pending_work("bridge-for-holder", self._receive_relayed)
        bus.handle(BRIDGE_CHANGED_SIGNAL, self._on_changed)
        bus.handle(BRIDGE_ROOMS_CHANGED_SIGNAL, self._on_rooms_changed)
        bus.handle(BRIDGE_FOR_HOLDER_SIGNAL, self._on_for_holder)
        bus.on_resync(lifecycle.reconcile_all)
        bus.on_recheck(lifecycle.reconcile_all)
        bus.on_resync(lifecycle.reload_all_rooms)
        bus.on_recheck(lifecycle.reload_all_rooms)
        lifecycle.use_signals(self)

    def changed(self, bridge_id: str) -> None:
        """The bridge's row changed and has committed: every other process
        re-reads it. This one has already applied the change itself."""
        self._bus.publish(BRIDGE_CHANGED_SIGNAL, bridge_id=bridge_id)

    def rooms_changed(self, bridge_id: str) -> None:
        """A room was bridged to the bridge or unbridged from it, and that has
        committed: every other process maps the bridge's rooms again."""
        self._bus.publish(BRIDGE_ROOMS_CHANGED_SIGNAL, bridge_id=bridge_id)

    def for_holder(self, bridge_id: str, request: dict[str, str]) -> None:
        """A quiet copy here has work for the process holding the bridge."""
        self._bus.publish(
            BRIDGE_FOR_HOLDER_SIGNAL, bridge_id=bridge_id, request=request
        )

    def _on_for_holder(self, signal: dict[str, Any]) -> None:
        request = signal["request"]
        self._relayed.add((signal["bridge_id"], tuple(sorted(request.items()))))

    async def _receive_relayed(self, relayed: _Relayed) -> None:
        bridge_id, request = relayed
        await self._lifecycle.receive_relayed(bridge_id, dict(request))

    def _on_changed(self, signal: dict[str, Any]) -> None:
        self._owed.add(signal["bridge_id"])

    def _on_rooms_changed(self, signal: dict[str, Any]) -> None:
        self._rooms_owed.add(signal["bridge_id"])

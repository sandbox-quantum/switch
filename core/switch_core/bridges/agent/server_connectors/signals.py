"""Server-side connectors registered or removed in one process, reaching every other.

A server-side connector runs in the one switch-core process that holds it
(`lifecycle.py`). Registering or removing one is served by whichever process
the request reached, and changed only that process: a connector removed there
went on polling its agents in the holder, and one registered there was run
nowhere else, so another process that should hold it never claimed it.

So a registration or a removal, once committed, announces `connector.changed`
naming the connector. Every other process re-reads the connector's row
(`ServerSideConnectorLifecycleService.reconcile_connector`): wanting a new one,
so the process that should hold it claims it, or stopping and letting go of
one that is gone. A re-read that fails is kept and tried again, and every
connector is re-read when the signal connection comes back and on each
periodic re-check.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from switch_core.bridges.agent.server_connectors.lifecycle import (
        ServerSideConnectorLifecycleService,
    )
    from switch_core.signals import SignalBus

CONNECTOR_CHANGED_SIGNAL = "connector.changed"


class ConnectorSignals:
    def __init__(
        self, *, lifecycle: ServerSideConnectorLifecycleService, bus: SignalBus
    ) -> None:
        self._bus = bus
        self._owed = bus.pending_work("connectors", lifecycle.reconcile_connector)
        bus.handle(CONNECTOR_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(lifecycle.reconcile_all)
        bus.on_recheck(lifecycle.reconcile_all)
        lifecycle.use_signals(self)

    def changed(self, connector_id: str) -> None:
        """The connector's row changed and has committed: every other process
        re-reads it. This one has already applied the change itself."""
        self._bus.publish(CONNECTOR_CHANGED_SIGNAL, connector_id=connector_id)

    def _on_changed(self, signal: dict[str, Any]) -> None:
        self._owed.add(signal["connector_id"])

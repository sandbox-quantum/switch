"""Clients registered or deleted after boot, reaching every process.

Every switch-core process runs its own copy of each agent and admin client:
`ClientLifecycleService.start_all` starts them all at boot. A client
registered later started only in the process that served the registration, so
any other process answered that agent's requests with "not running" and read
nothing for it; a client deleted kept its copies running everywhere else, on a
row that no longer exists.

So a registration or deletion, once committed, announces `client.changed` for
its tenant. Every process, the announcing one included, then re-reads the
tenant's clients and starts or stops its copies to match
(`ClientLifecycleService.reconcile_tenant`). The announcing process has
already started or stopped its own, so for it the re-read is a check that
changes nothing. A re-read that fails is kept and tried again, and every
tenant is re-read when the signal connection comes back and on each periodic
re-check, so a missed signal costs a delay rather than a client missing from
a process until it restarts.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.signals import SignalBus

CLIENT_CHANGED_SIGNAL = "client.changed"


class ClientSignals:
    def __init__(self, *, lifecycle: ClientLifecycleService, bus: SignalBus) -> None:
        self._bus = bus
        self._owed = bus.pending_work("clients", lifecycle.reconcile_tenant)
        bus.handle(CLIENT_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(lifecycle.reconcile_all)
        bus.on_recheck(lifecycle.reconcile_all)
        lifecycle.use_signals(self)

    def changed(self, tenant_id: str) -> None:
        self._owed.add(tenant_id)
        self._bus.publish(CLIENT_CHANGED_SIGNAL, tenant_id=tenant_id)

    def _on_changed(self, signal: dict[str, Any]) -> None:
        self._owed.add(signal["tenant_id"])

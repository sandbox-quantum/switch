"""Clients registered or deleted after boot, reaching every process.

Every switch-core process runs its own copy of each agent and admin client:
`ClientLifecycleService.start_all` starts them all at boot. A client
registered later started only in the process that served the registration, so
any other process answered that agent's requests with "not running" and read
nothing for it; a client deleted kept its copies running everywhere else, on a
row that no longer exists.

So a registration, rename or deletion, once committed, announces
`client.changed` for its tenant, naming the clients it changed. Every process,
the announcing one included, then re-reads those clients' rows and starts,
stops or renames its copies to match (`ClientLifecycleService.
reconcile_clients`). The announcing process has already done so for its own,
so for it the re-read is a check that changes nothing. A signal naming no
clients, which a process from before they were named sends, re-reads every
client of the tenant (`reconcile_tenant`).

A re-read that fails is kept and tried again. Every tenant is re-read when the
signal connection comes back, and each periodic re-check reads in full any
tenant whose clients have changed since its last full read
(`ClientLifecycleService.recheck_all`), so a missed signal costs a delay rather
than a client missing from a process until it restarts.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable
from typing import TYPE_CHECKING, Any

from switch_core.signals import payload_chunks

if TYPE_CHECKING:
    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.signals import SignalBus

CLIENT_CHANGED_SIGNAL = "client.changed"

# Room kept in every signal for what it carries beside its list of clients:
# its kind, the sending process's id and the tenant, about 200 bytes at most.
_SIGNAL_ENVELOPE_BYTES = 400


class ClientSignals:
    def __init__(self, *, lifecycle: ClientLifecycleService, bus: SignalBus) -> None:
        self._bus = bus
        self._lifecycle = lifecycle
        # The clients each tenant with work pending has to read again, or None
        # where every client of the tenant has to be.
        self._owed_clients: dict[str, set[str] | None] = {}
        self._owed = bus.pending_work("clients", self._reconcile)
        bus.handle(CLIENT_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(lifecycle.reconcile_all)
        bus.on_recheck(lifecycle.recheck_all)
        lifecycle.use_signals(self)

    def changed(self, tenant_id: str, client_ids: Collection[str] | None) -> None:
        if client_ids is None:
            self._owe(tenant_id, None)
            self._bus.publish(CLIENT_CHANGED_SIGNAL, tenant_id=tenant_id)
            return
        named = sorted(set(client_ids))
        self._owe(tenant_id, named)
        for chunk in payload_chunks(named, _SIGNAL_ENVELOPE_BYTES):
            self._bus.publish(
                CLIENT_CHANGED_SIGNAL, tenant_id=tenant_id, client_ids=chunk
            )

    def _on_changed(self, signal: dict[str, Any]) -> None:
        client_ids = signal.get("client_ids")
        self._owe(
            signal["tenant_id"], client_ids if isinstance(client_ids, list) else None
        )

    def _owe(self, tenant_id: str, client_ids: Iterable[str] | None) -> None:
        self._keep(tenant_id, client_ids)
        self._owed.add(tenant_id)

    def _keep(self, tenant_id: str, client_ids: Iterable[str] | None) -> None:
        if client_ids is None:
            self._owed_clients[tenant_id] = None
            return
        owed = self._owed_clients.setdefault(tenant_id, set())
        if owed is not None:
            owed.update(client_ids)

    async def _reconcile(self, tenant_id: str) -> None:
        # No entry reads every client: nothing is lost by reading too much.
        client_ids = self._owed_clients.pop(tenant_id, None)
        try:
            if client_ids is None:
                await self._lifecycle.reconcile_tenant(tenant_id)
            else:
                await self._lifecycle.reconcile_clients(tenant_id, client_ids)
        except BaseException:
            # Kept for the retry `PendingWork` makes of the tenant, which it
            # schedules itself: adding the tenant again here would retry at
            # once instead.
            self._keep(tenant_id, client_ids)
            raise

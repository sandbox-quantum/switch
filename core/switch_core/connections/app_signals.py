"""A connector app saved or removed in one process, put to work in every one.

Every switch-core process resolves each connector's app at boot and holds
what it resolved: the broker's adapter, and for GitHub the App on the
gateway's state (`app_credentials.py`). The operator's save or removal is
handled by one process, which applies it at once; every other process kept
the app it had until a restart, so a sign-in or a token served elsewhere
went through the old app.

So the process that made the change announces `connector_app.changed` for
the service once it has committed, and every other process applies it on
hearing so (`ConnectorApps.apply`), which reads the row again rather than
trusting the signal. A process skips its own signals: it applied the change
before announcing it. An apply that fails is kept and tried again, and every
process re-checks on reconnecting and every `RECHECK_SECONDS` which rows
changed since it resolved them, so a missed signal costs a delay rather than
a process using an old app until it restarts.

An organization's own app (`organization_apps.py`) is announced the same way,
with the organization's id beside the service. A process hearing it forgets
the adapter it kept for that organization and service, and builds it again
from the row the next time one of the organization's workspaces needs it.
Forgetting reads nothing, so there is nothing to retry; and the kept adapters
are trusted only for a while, which covers a missed announcement. On
reconnecting, a process forgets them all.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from starlette.datastructures import State

    from switch_core.connections.app_credentials import ConnectorApps
    from switch_core.connections.broker import ServiceBroker
    from switch_core.connections.organization_apps import OrganizationApps
    from switch_core.signals import SignalBus

CONNECTOR_APP_CHANGED_SIGNAL = "connector_app.changed"


class ConnectorAppSignals:
    def __init__(
        self,
        *,
        apps: ConnectorApps,
        organization_apps: OrganizationApps | None,
        broker: ServiceBroker,
        state: State,
        bus: SignalBus,
    ) -> None:
        self._apps = apps
        self._organization_apps = organization_apps
        self._broker = broker
        self._state = state
        self._bus = bus
        self._owed = bus.pending_work("connector apps", self._apply)
        bus.handle(CONNECTOR_APP_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(self.recheck)
        bus.on_resync(self._forget_organizations)
        bus.on_recheck(self.recheck)
        apps.use_signals(self)
        if organization_apps is not None:
            organization_apps.use_signals(self)

    def changed(self, service: str) -> None:
        self._bus.publish(CONNECTOR_APP_CHANGED_SIGNAL, service=service)

    def organization_changed(self, organization_id: str, service: str) -> None:
        self._bus.publish(
            CONNECTOR_APP_CHANGED_SIGNAL,
            service=service,
            organization_id=organization_id,
        )

    async def _forget_organizations(self) -> None:
        if self._organization_apps is not None:
            self._organization_apps.forget_all()

    async def recheck(self) -> None:
        """Apply again every app whose saved row changed since this process
        resolved it."""
        for service in await self._apps.changed_since_resolved():
            self._owed.add(service)

    def _on_changed(self, signal: dict[str, Any]) -> None:
        service = signal["service"]
        # A service this build has no app for, from a newer process mid-roll.
        if service not in self._apps.specs:
            return
        organization_id = signal.get("organization_id")
        if organization_id is None:
            self._owed.add(service)
        elif self._organization_apps is not None:
            self._organization_apps.forget(organization_id, service)

    async def _apply(self, service: str) -> None:
        await self._apps.apply(service, broker=self._broker, state=self._state)

"""Telling every process an organization's Switch Trust settings changed.

Each organization's settings are one row that every check in its workspaces
reads, and each process keeps what it read (`DynamicTrustClient`). The
gateway route that changes them calls `changed` once the change has
committed: this process forgets that organization's settings at once, and
every other process when the signal reaches it. A process whose listening
connection was down forgets every organization's once it is back, and a signal
lost some other way costs at most `SETTINGS_MAX_AGE_SECONDS`.
"""

from __future__ import annotations

from typing import Any

from switch_core.signals import SignalBus
from switch_core.trust.client import DynamicTrustClient

TRUST_SETTINGS_CHANGED_SIGNAL = "trust.settings_changed"


class TrustSettingsSignals:
    def __init__(self, *, client: DynamicTrustClient, bus: SignalBus) -> None:
        self._client = client
        self._bus = bus
        bus.handle(TRUST_SETTINGS_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(self._forget_all)

    def changed(self, organization_id: str) -> None:
        """The organization's settings changed and the change has committed."""
        self._client.forget(organization_id)
        self._bus.publish(
            TRUST_SETTINGS_CHANGED_SIGNAL, organization_id=organization_id
        )

    def _on_changed(self, signal: dict[str, Any]) -> None:
        organization_id = signal.get("organization_id")
        # Sent by a release from before each organization had its own, which
        # changed the server-wide setting this one no longer reads; forgetting
        # everything costs a read per organization and nothing else.
        if organization_id is None:
            self._client.forget_all()
        else:
            self._client.forget(organization_id)

    async def _forget_all(self) -> None:
        self._client.forget_all()

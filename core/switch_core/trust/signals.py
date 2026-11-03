"""Telling every process the Switch Trust settings changed.

The settings are one server-global row that every check reads, and each
process keeps what it read (`DynamicTrustClient`). The gateway route that
changes them calls `changed` once the change has committed: this process
forgets its settings at once, and every other process when the signal reaches
it. A process whose listening connection was down forgets them once it is back,
and a signal lost some other way costs at most `SETTINGS_MAX_AGE_SECONDS`.
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
        bus.on_resync(self._forget)

    def changed(self) -> None:
        """The settings changed and the change has committed."""
        self._client.forget()
        self._bus.publish(TRUST_SETTINGS_CHANGED_SIGNAL)

    def _on_changed(self, _signal: dict[str, Any]) -> None:
        self._client.forget()

    async def _forget(self) -> None:
        self._client.forget()

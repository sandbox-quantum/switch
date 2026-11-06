"""Every process forgets the Switch Trust settings it read once they change,
however it hears of it: from its own gateway route, from another process's
signal, or by reconnecting after it may have missed one."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from switch_core.trust.signals import (
    TRUST_SETTINGS_CHANGED_SIGNAL,
    TrustSettingsSignals,
)


class _Client:
    def __init__(self) -> None:
        self.forgotten = 0

    def forget(self) -> None:
        self.forgotten += 1


class _Bus:
    def __init__(self) -> None:
        self.handlers: dict[str, Callable[[dict[str, Any]], None]] = {}
        self.resyncs: list[Callable[[], Awaitable[None]]] = []
        self.published: list[str] = []

    def handle(self, kind: str, handler: Callable[[dict[str, Any]], None]) -> None:
        self.handlers[kind] = handler

    def on_resync(self, resync: Callable[[], Awaitable[None]]) -> None:
        self.resyncs.append(resync)

    def publish(self, kind: str, **fields: Any) -> None:
        self.published.append(kind)


def _signals() -> tuple[TrustSettingsSignals, _Client, _Bus]:
    client, bus = _Client(), _Bus()
    signals = TrustSettingsSignals(client=client, bus=bus)  # type: ignore[arg-type]
    return signals, client, bus


def test_a_change_here_is_forgotten_here_and_sent_to_the_others() -> None:
    signals, client, bus = _signals()

    signals.changed()

    assert client.forgotten == 1
    assert bus.published == [TRUST_SETTINGS_CHANGED_SIGNAL]


def test_a_change_elsewhere_is_forgotten_here() -> None:
    _, client, bus = _signals()

    bus.handlers[TRUST_SETTINGS_CHANGED_SIGNAL]({"kind": TRUST_SETTINGS_CHANGED_SIGNAL})

    assert client.forgotten == 1


async def test_reconnecting_forgets_what_a_lost_signal_would_have() -> None:
    _, client, bus = _signals()

    for resync in bus.resyncs:
        await resync()

    assert client.forgotten == 1

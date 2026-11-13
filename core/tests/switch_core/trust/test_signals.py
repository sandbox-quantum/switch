"""Every process forgets an organization's Switch Trust settings once they
change, however it hears of it: from its own gateway route, from another
process's signal, or by reconnecting after it may have missed one."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from switch_core.trust.signals import (
    TRUST_SETTINGS_CHANGED_SIGNAL,
    TrustSettingsSignals,
)


class _Client:
    def __init__(self) -> None:
        self.forgotten: list[str] = []
        self.forgot_all = 0

    def forget(self, organization_id: str) -> None:
        self.forgotten.append(organization_id)

    def forget_all(self) -> None:
        self.forgot_all += 1


class _Bus:
    def __init__(self) -> None:
        self.handlers: dict[str, Callable[[dict[str, Any]], None]] = {}
        self.resyncs: list[Callable[[], Awaitable[None]]] = []
        self.published: list[tuple[str, dict[str, Any]]] = []

    def handle(self, kind: str, handler: Callable[[dict[str, Any]], None]) -> None:
        self.handlers[kind] = handler

    def on_resync(self, resync: Callable[[], Awaitable[None]]) -> None:
        self.resyncs.append(resync)

    def publish(self, kind: str, **fields: Any) -> None:
        self.published.append((kind, fields))


def _signals() -> tuple[TrustSettingsSignals, _Client, _Bus]:
    client, bus = _Client(), _Bus()
    signals = TrustSettingsSignals(client=client, bus=bus)  # type: ignore[arg-type]
    return signals, client, bus


def test_a_change_here_is_forgotten_here_and_sent_to_the_others() -> None:
    signals, client, bus = _signals()

    signals.changed("org-1")

    assert client.forgotten == ["org-1"]
    assert bus.published == [
        (TRUST_SETTINGS_CHANGED_SIGNAL, {"organization_id": "org-1"})
    ]


def test_a_change_elsewhere_is_forgotten_here() -> None:
    _, client, bus = _signals()

    bus.handlers[TRUST_SETTINGS_CHANGED_SIGNAL](
        {"kind": TRUST_SETTINGS_CHANGED_SIGNAL, "organization_id": "org-1"}
    )

    assert (client.forgotten, client.forgot_all) == (["org-1"], 0)


def test_a_change_from_an_older_release_forgets_every_organizations() -> None:
    """It changed the server-wide setting, which nothing reads now."""
    _, client, bus = _signals()

    bus.handlers[TRUST_SETTINGS_CHANGED_SIGNAL]({"kind": TRUST_SETTINGS_CHANGED_SIGNAL})

    assert (client.forgotten, client.forgot_all) == ([], 1)


async def test_reconnecting_forgets_every_organizations() -> None:
    _, client, bus = _signals()

    for resync in bus.resyncs:
        await resync()

    assert client.forgot_all == 1

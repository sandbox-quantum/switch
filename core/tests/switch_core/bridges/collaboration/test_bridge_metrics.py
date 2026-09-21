"""What a bridge reports about its own traffic.

Inbound at `_traced`, the choke point every platform event goes through;
outbound at the relay rather than the top of the handler, which returns early
for a puppet's own echo and for a room with no channel mapping.

The failure counters matter more than the volume ones: an inbound failure is a
message a person sent that nobody received.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.observability.metrics import MetricsRegistry, install, uninstall

BRIDGE_TENANT = "tenant-bridge"


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _bridge() -> BridgeCore:
    bridge = BridgeCore.__new__(BridgeCore)
    bridge._bridge_id = "bridge-1"
    bridge._bridge_tenant_id = BRIDGE_TENANT
    bridge._bridge_type = "slack"
    bridge._channel_to_room = {}
    bridge._room_to_channel = {}
    bridge._room_tenants = {}
    return bridge


def _event(channel_id: str = "C1") -> SimpleNamespace:
    return SimpleNamespace(channel_id=channel_id)


def _collect(registry: MetricsRegistry) -> dict[str, dict[tuple, float]]:
    """Every counter this interval, by name. One call: collecting resets."""
    return {
        payload.name: {
            tuple(sorted(point.attributes.items())): point.value
            for point in payload.numbers
        }
        for payload in registry.collect()
    }


def _points(registry: MetricsRegistry, name: str) -> dict[tuple, float]:
    return _collect(registry).get(name, {})


async def test_each_inbound_event_kind_is_counted_separately(registry) -> None:
    bridge = _bridge()

    async def _handler(event: object) -> None:
        return None

    await bridge._traced("message", _handler)(_event())
    await bridge._traced("message", _handler)(_event())
    await bridge._traced("command", _handler)(_event())

    assert _points(registry, "switch.bridge.events_in") == {
        (("event", "message"), ("platform", "slack")): 2.0,
        (("event", "command"), ("platform", "slack")): 1.0,
    }


async def test_a_failing_inbound_handler_is_counted_and_still_raises(
    registry,
) -> None:
    bridge = _bridge()

    async def _handler(event: object) -> None:
        raise RuntimeError("the handler is broken")

    with pytest.raises(RuntimeError, match="broken"):
        await bridge._traced("message", _handler)(_event())

    # Counted and re-raised unchanged: whoever handled it before still does.
    assert _points(registry, "switch.bridge.errors") == {
        (("direction", "inbound"), ("platform", "slack")): 1.0
    }


def test_an_outbound_relay_is_counted(registry) -> None:
    bridge = _bridge()

    with bridge._counted_outbound("message"):
        pass

    assert _points(registry, "switch.bridge.events_out") == {
        (("kind", "message"), ("platform", "slack")): 1.0
    }


def test_a_failing_outbound_relay_is_counted_and_still_raises(registry) -> None:
    bridge = _bridge()

    with pytest.raises(RuntimeError, match="slack is down"):
        with bridge._counted_outbound("media"):
            raise RuntimeError("slack is down")

    collected = _collect(registry)
    assert collected["switch.bridge.errors"] == {
        (("direction", "outbound"), ("platform", "slack")): 1.0
    }
    # Still counted as attempted: the rate of attempts is what the failure
    # rate is a fraction of.
    assert collected["switch.bridge.events_out"] == {
        (("kind", "media"), ("platform", "slack")): 1.0
    }


async def test_nothing_is_recorded_when_observability_is_off() -> None:
    uninstall()
    bridge = _bridge()

    async def _handler(event: object) -> None:
        return None

    # The no-op registry has to accept the same calls, or an unconfigured
    # deployment breaks where a configured one works.
    await bridge._traced("message", _handler)(_event())
    with bridge._counted_outbound("message"):
        pass


def test_the_platform_label_comes_from_the_bridge_not_the_caller(registry) -> None:
    """Bounded by the code: five registered adapter types, not a free string."""
    bridge = _bridge()
    bridge._bridge_type = "telegram"

    with bridge._counted_outbound("message"):
        pass

    attributes: dict[str, Any] = dict(
        next(iter(_points(registry, "switch.bridge.events_out")))
    )
    assert attributes["platform"] == "telegram"

"""How long garbage collection stops the process.

The event-loop lag gauge only sees a stall that overlaps the sweep timer's
wake, so a full collection freezing the server for hundreds of milliseconds
can pass unrecorded. These pauses are measured from inside the collector.
"""

from __future__ import annotations

import gc
from collections.abc import Iterator

import pytest

from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.runtime import EventLoopLag, GcPauses, RuntimeMetrics


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


@pytest.fixture
def gc_pauses() -> Iterator[GcPauses]:
    pauses = GcPauses()
    pauses.install()
    yield pauses
    pauses.uninstall()


def _pause_counts(registry: MetricsRegistry) -> dict[str, int]:
    payload = next(
        (p for p in registry.collect() if p.name == "switch.runtime.gc_pause"), None
    )
    if payload is None:
        return {}
    return {
        str(point.attributes["generation"]): point.count for point in payload.histograms
    }


def test_each_collection_is_timed_under_its_generation(gc_pauses: GcPauses) -> None:
    gc_pauses.drain()

    gc.collect(2)

    pauses = gc_pauses.drain()
    full = [pause_ms for generation, pause_ms in pauses if generation == 2]
    assert len(full) == 1
    assert full[0] >= 0.0
    assert gc_pauses.drain() == []


def test_uninstalling_stops_the_timing(gc_pauses: GcPauses) -> None:
    gc_pauses.uninstall()
    gc_pauses.drain()

    gc.collect(2)

    assert gc_pauses.drain() == []


def test_pauses_reach_the_registry_on_collection(
    registry: MetricsRegistry, gc_pauses: GcPauses
) -> None:
    RuntimeMetrics(EventLoopLag(), gc_pauses).install(registry)
    registry.collect()

    gc.collect(2)

    assert _pause_counts(registry).get("2") == 1

import asyncio
import contextlib
import time
from collections.abc import Iterator

import pytest

from switch_core.observability.catalogue import RUNTIME_EVENT_LOOP_STALLS
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.runtime import EventLoopLag, watch_event_loop


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


async def _probe_while(lag: EventLoopLag, block_seconds: float) -> None:
    probe = asyncio.create_task(watch_event_loop(lag, interval_seconds=0.02))
    # Let the probe start its first sleep, then hold the loop the way a
    # synchronous call or a garbage collection would.
    await asyncio.sleep(0.05)
    time.sleep(block_seconds)
    await asyncio.sleep(0.05)
    probe.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await probe


async def test_a_stall_is_read_at_its_full_length(registry: MetricsRegistry):
    lag = EventLoopLag()
    await _probe_while(lag, block_seconds=0.3)

    # The probe's own interval is the most it can under-read by.
    assert lag.take() >= 300 - 20


async def test_a_stall_is_counted_with_its_duration(registry: MetricsRegistry):
    lag = EventLoopLag()
    await _probe_while(lag, block_seconds=0.3)

    stalls = {payload.name: payload for payload in registry.collect()}[
        RUNTIME_EVENT_LOOP_STALLS.name
    ]
    point = stalls.histograms[0]
    assert point.count == 1
    assert point.total >= 300 - 20


async def test_scheduling_jitter_is_not_a_stall(registry: MetricsRegistry):
    lag = EventLoopLag()
    await _probe_while(lag, block_seconds=0.0)

    names = {payload.name for payload in registry.collect()}
    assert RUNTIME_EVENT_LOOP_STALLS.name not in names

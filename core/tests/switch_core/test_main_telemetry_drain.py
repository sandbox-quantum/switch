"""Telemetry at shutdown: bounded, and the sink always gets its turn."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

from switch_core import main


class _Step:
    def __init__(self, *, hangs: bool) -> None:
        self.hangs = hangs
        self.closed = False

    async def aclose(self) -> None:
        if self.hangs:
            await asyncio.sleep(10)
        self.closed = True


async def test_a_message_worker_that_overruns_does_not_cost_the_sink_its_flush() -> (
    None
):
    """The sink's final flush carries every kind of event, so the per-message
    worker using up a shared budget would lose far more than its own queue."""
    message_telemetry = _Step(hangs=True)
    telemetry = _Step(hangs=False)
    http = SimpleNamespace(closed=False)

    async def _close_http() -> None:
        http.closed = True

    http.aclose = _close_http

    started = time.monotonic()
    await main._drain_telemetry(telemetry, message_telemetry, http)  # type: ignore[arg-type]
    elapsed = time.monotonic() - started

    assert telemetry.closed
    assert http.closed
    assert elapsed < main._TELEMETRY_DRAIN_SECONDS + 0.2


async def test_the_whole_drain_stays_inside_its_budget() -> None:
    started = time.monotonic()
    await main._drain_telemetry(
        _Step(hangs=True),  # type: ignore[arg-type]
        _Step(hangs=True),  # type: ignore[arg-type]
        None,
    )

    assert time.monotonic() - started < main._TELEMETRY_DRAIN_SECONDS + 0.2

"""Telemetry at shutdown: bounded, and the sink always gets its turn."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from switch_core import main


class _Step:
    def __init__(self, *, hangs: bool, takes: float = 0.0) -> None:
        self.hangs = hangs
        self.takes = takes
        self.closed = False

    async def aclose(self) -> None:
        if self.hangs:
            await asyncio.sleep(10)
        await asyncio.sleep(self.takes)
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


async def test_the_sink_has_the_time_the_message_worker_did_not_use() -> None:
    """A fixed split would cut the sink off at its share however little of
    the second the worker took."""
    sink_takes = (
        main._TELEMETRY_DRAIN_SECONDS - main._MESSAGE_TELEMETRY_DRAIN_SECONDS + 0.2
    )
    telemetry = _Step(hangs=False, takes=sink_takes)

    await main._drain_telemetry(
        telemetry,  # type: ignore[arg-type]
        _Step(hangs=False),  # type: ignore[arg-type]
        None,
    )

    assert telemetry.closed


async def test_the_whole_drain_stays_inside_its_budget() -> None:
    started = time.monotonic()
    await main._drain_telemetry(
        _Step(hangs=True),  # type: ignore[arg-type]
        _Step(hangs=True),  # type: ignore[arg-type]
        None,
    )

    assert time.monotonic() - started < main._TELEMETRY_DRAIN_SECONDS + 0.2


async def test_a_step_that_fails_is_disclosed_and_the_sink_still_closes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _Broken:
        async def aclose(self) -> None:
            raise RuntimeError("bug in closing")

    telemetry = _Step(hangs=False)

    with caplog.at_level("WARNING"):
        await main._drain_telemetry(telemetry, _Broken(), None)  # type: ignore[arg-type]

    assert telemetry.closed
    assert "Reporting queued message events at shutdown failed" in caplog.text

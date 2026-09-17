"""The metrics export loop: interval arithmetic, failure escalation, shutdown."""

import asyncio
import logging

import pytest

from switch_core.observability.catalogue import HTTP_REQUESTS
from switch_core.observability.exporter import (
    _FAILURES_BEFORE_ERROR,
    MetricsExporter,
)
from switch_core.observability.metrics import MetricsRegistry
from switch_core.observability.otlp import OtlpResource, OtlpSendError

RESOURCE = OtlpResource(
    service_name="switch-core",
    service_version="1.0.0",
    environment="pilot",
    deployment_id="0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10",
)

ATTRS = {"route": "/health", "method": "GET", "status_class": "2xx"}


class _Client:
    def __init__(self, fail_times: int = 0) -> None:
        self.posted: list[dict] = []
        self._fail_times = fail_times

    async def post(self, signal: str, payload: dict) -> None:
        if self._fail_times > 0:
            self._fail_times -= 1
            raise OtlpSendError("collector is down")
        self.posted.append(payload)


def _exporter(registry: MetricsRegistry, client: _Client) -> MetricsExporter:
    return MetricsExporter(registry, client, RESOURCE, interval_seconds=0.01)


def _window(payload: dict) -> tuple[str, str]:
    point = payload["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["sum"][
        "dataPoints"
    ][0]
    return point["startTimeUnixNano"], point["timeUnixNano"]


@pytest.mark.asyncio
async def test_intervals_abut_without_gap_or_overlap():
    registry = MetricsRegistry()
    client = _Client()
    exporter = _exporter(registry, client)

    registry.increment(HTTP_REQUESTS, ATTRS)
    await exporter.flush_once()
    registry.increment(HTTP_REQUESTS, ATTRS)
    await exporter.flush_once()

    first_start, first_end = _window(client.posted[0])
    second_start, second_end = _window(client.posted[1])
    # Each interval begins exactly where the last ended: a gap would lose
    # traffic, an overlap would count it twice.
    assert second_start == first_end
    assert int(first_start) < int(first_end) <= int(second_end)


@pytest.mark.asyncio
async def test_a_failed_interval_is_dropped_not_folded_into_the_next():
    registry = MetricsRegistry()
    client = _Client(fail_times=1)
    exporter = _exporter(registry, client)

    registry.increment(HTTP_REQUESTS, ATTRS, 10.0)
    await exporter.flush_once()  # fails; that interval is gone
    registry.increment(HTTP_REQUESTS, ATTRS, 3.0)
    await exporter.flush_once()

    metric = client.posted[0]["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]
    # Not 13: folding the lost interval in would report a minute of traffic as
    # though it had happened in the following one.
    assert metric["sum"]["dataPoints"][0]["asDouble"] == 3.0


@pytest.mark.asyncio
async def test_nothing_recorded_means_nothing_posted():
    client = _Client()
    await _exporter(MetricsRegistry(), client).flush_once()
    assert client.posted == []


@pytest.mark.asyncio
async def test_repeated_failures_escalate_from_warning_to_error(caplog):
    registry = MetricsRegistry()
    client = _Client(fail_times=_FAILURES_BEFORE_ERROR)
    exporter = _exporter(registry, client)

    with caplog.at_level(logging.WARNING):
        for _ in range(_FAILURES_BEFORE_ERROR):
            registry.increment(HTTP_REQUESTS, ATTRS)
            await exporter.flush_once()

    levels = [r.levelno for r in caplog.records]
    # One failure is a flaky network and says nothing; a run of them means the
    # dashboards are stale and somebody is about to be misled by them.
    assert logging.WARNING in levels
    assert logging.ERROR in levels


@pytest.mark.asyncio
async def test_recovery_is_reported_and_resets_the_count(caplog):
    registry = MetricsRegistry()
    client = _Client(fail_times=1)
    exporter = _exporter(registry, client)

    registry.increment(HTTP_REQUESTS, ATTRS)
    await exporter.flush_once()
    with caplog.at_level(logging.INFO):
        registry.increment(HTTP_REQUESTS, ATTRS)
        await exporter.flush_once()

    assert "recovered" in caplog.text


@pytest.mark.asyncio
async def test_the_loop_survives_a_raising_flush(caplog):
    class _Broken(MetricsRegistry):
        def collect(self):
            raise RuntimeError("registry is broken")

    exporter = MetricsExporter(_Broken(), _Client(), RESOURCE, interval_seconds=0.01)
    task = asyncio.create_task(exporter.run_forever())
    try:
        with caplog.at_level(logging.ERROR):
            await asyncio.sleep(0.08)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    # A metrics exporter that can take the server down with it is worse than no
    # metrics exporter.
    assert "Metrics export loop raised" in caplog.text


@pytest.mark.asyncio
async def test_cancelling_flushes_the_final_window():
    registry = MetricsRegistry()
    client = _Client()
    exporter = MetricsExporter(registry, client, RESOURCE, interval_seconds=30.0)

    task = asyncio.create_task(exporter.run_forever())
    await asyncio.sleep(0)
    registry.increment(HTTP_REQUESTS, ATTRS)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # A clean shutdown reports what it did rather than discarding its last
    # interval.
    assert len(client.posted) == 1

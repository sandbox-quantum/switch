import asyncio
import logging
import time

import pytest

from switch_core.logging_context import LogContextFilter, log_context
from switch_core.observability.logs import (
    LogExporter,
    OtlpLogHandler,
    severity_of,
)
from switch_core.observability.otlp import OtlpResource, OtlpSendError

RESOURCE = OtlpResource(
    service_name="switch-core",
    service_version="1.0.0",
    environment="pilot",
    deployment_id="0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10",
)


def _record(
    name: str = "switch_core.rooms",
    level: int = logging.INFO,
    message: str = "hello %s",
    args: tuple = (),
    exc_info=None,
) -> logging.LogRecord:
    return logging.LogRecord(
        name=name,
        level=level,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=args,
        exc_info=exc_info,
    )


@pytest.mark.parametrize(
    ("level", "number", "text"),
    [
        (logging.DEBUG, 5, "DEBUG"),
        (logging.INFO, 9, "INFO"),
        (logging.WARNING, 13, "WARN"),
        (logging.ERROR, 17, "ERROR"),
        (logging.CRITICAL, 21, "FATAL"),
        (1, 1, "TRACE"),
    ],
)
def test_python_levels_map_onto_otlp_severity(level, number, text):
    """A receiver filtering by severity is filtering on OTLP's scale, not ours."""
    assert severity_of(level) == (number, text)


def test_a_record_becomes_a_formatted_body():
    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(args=("world",)))

    batch, dropped = handler.take(10)
    assert dropped == 0
    assert batch[0].body == "hello world"
    assert batch[0].severity_text == "INFO"
    assert batch[0].attributes["logger.name"] == "switch_core.rooms"


def test_the_log_context_travels_with_the_record():
    """The whole reason to ship logs: a line you can tie to a tenant."""
    handler = OtlpLogHandler(capacity=10)
    handler.addFilter(LogContextFilter("default"))

    with log_context(request_id="req-1", agent_id="agent-7"):
        record = _record(args=("world",))
        for filter_ in handler.filters:
            filter_.filter(record)
        handler.emit(record)

    attributes = handler.take(10)[0][0].attributes
    assert attributes["request_id"] == "req-1"
    assert attributes["agent_id"] == "agent-7"
    assert attributes["tenant_id"] == "default"


def test_an_exception_becomes_datadog_error_attributes():
    handler = OtlpLogHandler(capacity=10)
    try:
        raise ValueError("it broke")
    except ValueError:
        import sys

        handler.emit(
            _record(level=logging.ERROR, args=("world",), exc_info=sys.exc_info())
        )

    attributes = handler.take(10)[0][0].attributes
    assert attributes["error.kind"] == "ValueError"
    assert attributes["error.message"] == "it broke"
    assert "ValueError: it broke" in str(attributes["error.stack"])


def test_the_exporters_own_records_are_never_shipped():
    """Otherwise a failing collector generates the traffic that is failing."""
    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(name="switch_core.observability.logs", message="failed"))
    handler.emit(_record(name="switch_core.observability.exporter", message="failed"))
    handler.emit(_record(name="switch_core.rooms", message="kept"))

    batch, _ = handler.take(10)
    assert [entry.body for entry in batch] == ["kept"]


def test_a_full_queue_drops_the_oldest_and_counts_it():
    handler = OtlpLogHandler(capacity=3)
    for index in range(5):
        handler.emit(_record(message="line %d", args=(index,)))

    batch, dropped = handler.take(10)
    # A bounded queue is the difference between losing records and losing the
    # server; the count is what stops the loss being silent.
    assert [entry.body for entry in batch] == ["line 2", "line 3", "line 4"]
    assert dropped == 2


def test_the_dropped_count_resets_once_reported():
    handler = OtlpLogHandler(capacity=1)
    handler.emit(_record(message="a"))
    handler.emit(_record(message="b"))
    assert handler.take(10)[1] == 1
    assert handler.take(10)[1] == 0


def test_take_is_bounded_by_the_batch_size():
    handler = OtlpLogHandler(capacity=100)
    for index in range(10):
        handler.emit(_record(message="line %d", args=(index,)))

    batch, _ = handler.take(4)
    assert len(batch) == 4
    assert handler.pending() == 6


class _Client:
    def __init__(self, fail: bool = False) -> None:
        self.posted: list[tuple[str, dict]] = []
        self._fail = fail

    async def post(self, signal: str, payload: dict) -> None:
        if self._fail:
            raise OtlpSendError("collector is down")
        self.posted.append((signal, payload))


@pytest.mark.asyncio
async def test_a_flush_posts_the_batch_as_logs():
    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(message="one"))
    handler.emit(_record(message="two"))
    client = _Client()

    await LogExporter(handler, client, RESOURCE, 1.0, 500).flush_once()

    signal, payload = client.posted[0]
    assert signal == "logs"
    records = payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
    assert [entry["body"]["stringValue"] for entry in records] == ["one", "two"]


@pytest.mark.asyncio
async def test_an_empty_queue_posts_nothing():
    client = _Client()
    await LogExporter(OtlpLogHandler(10), client, RESOURCE, 1.0, 500).flush_once()
    assert client.posted == []


@pytest.mark.asyncio
async def test_a_failed_post_is_reported_and_does_not_raise(caplog):
    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(message="one"))
    exporter = LogExporter(handler, _Client(fail=True), RESOURCE, 1.0, 500)

    with caplog.at_level(logging.WARNING):
        await exporter.flush_once()

    assert "Log export failed" in caplog.text


@pytest.mark.asyncio
async def test_dropped_records_are_reported_at_error(caplog):
    handler = OtlpLogHandler(capacity=1)
    handler.emit(_record(message="a"))
    handler.emit(_record(message="b"))
    exporter = LogExporter(handler, _Client(), RESOURCE, 1.0, 500)

    with caplog.at_level(logging.ERROR):
        await exporter.flush_once()

    assert "Dropped 1 log record" in caplog.text


def test_records_logged_during_an_export_are_not_queued():
    """The feedback loop: `httpcore` logs a line per connection at DEBUG, so
    without this each export manufactures the records the next one sends."""
    from switch_core.observability.otlp import _exporting_window

    handler = OtlpLogHandler(capacity=10)

    with _exporting_window():
        handler.emit(_record(name="httpcore.connection", message="connect_tcp"))
    handler.emit(_record(name="httpcore.connection", message="a real request"))

    batch, _ = handler.take(10)
    # Outside the window the same logger is shipped normally: this suppresses
    # the exporter's own traffic, not a whole library.
    assert [entry.body for entry in batch] == ["a real request"]


def test_the_self_exclusion_is_anchored_on_a_name_boundary():
    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(name="switch_core.observability", message="dropped"))
    handler.emit(_record(name="switch_core.observability.logs", message="dropped"))
    # A bare prefix test would swallow this one too, and it is not ours.
    handler.emit(_record(name="switch_core.observability_extras", message="kept"))

    batch, _ = handler.take(10)
    assert [entry.body for entry in batch] == ["kept"]


@pytest.mark.asyncio
async def test_shutdown_drains_the_whole_queue_not_one_batch():
    """A single batch is 500 of a queue that holds 10,000.

    Flushing once on shutdown silently discarded the rest — no counter, no
    line, which is the exact shape of loss this module exists to avoid.
    """
    handler = OtlpLogHandler(capacity=2000)
    for index in range(1200):
        handler.emit(_record(message="line %d", args=(index,)))
    client = _Client()

    exporter = LogExporter(handler, client, RESOURCE, 1.0, 500)
    await exporter._flush_on_shutdown()

    assert handler.pending() == 0
    shipped = sum(
        len(p["resourceLogs"][0]["scopeLogs"][0]["logRecords"])
        for _, p in client.posted
    )
    assert shipped == 1200


@pytest.mark.asyncio
async def test_a_dead_collector_at_shutdown_reports_every_lost_record(caplog):
    """The records are lost either way; what matters is that they are counted.

    Counted from what was taken, not from what is left in the queue: a batch
    is removed before it is posted, so a queue that has been drained into a
    collector that refused it all looks identical to one that sent everything.
    """
    handler = OtlpLogHandler(capacity=2000)
    for index in range(1200):
        handler.emit(_record(message="line %d", args=(index,)))
    exporter = LogExporter(handler, _Client(fail=True), RESOURCE, 1.0, 500)

    with caplog.at_level(logging.ERROR):
        await exporter._flush_on_shutdown()

    # It stops at the first refusal rather than feeding the rest to a collector
    # that has already said no — but the count covers the batch it lost as well
    # as the ones still queued.
    assert handler.pending() == 700
    assert "1200 log record(s) never exported" in caplog.text


@pytest.mark.asyncio
async def test_shutdown_gives_up_on_a_hanging_collector_and_reports_the_rest(
    caplog, monkeypatch
):
    """Shutdown is not the moment to block on a collector that stopped answering."""
    monkeypatch.setattr("switch_core.observability.logs.SHUTDOWN_FLUSH_SECONDS", 0.05)

    class _Slow(_Client):
        async def post(self, signal: str, payload: dict) -> None:
            await asyncio.sleep(0.04)
            await super().post(signal, payload)

    handler = OtlpLogHandler(capacity=5000)
    for index in range(3000):
        handler.emit(_record(message="line %d", args=(index,)))
    exporter = LogExporter(handler, _Slow(), RESOURCE, 1.0, 100)

    with caplog.at_level(logging.ERROR):
        await exporter._flush_on_shutdown()

    assert handler.pending() > 0
    # What could not be sent leaves a number behind rather than vanishing.
    assert "never exported" in caplog.text


@pytest.mark.asyncio
async def test_the_shutdown_deadline_bounds_a_single_hanging_request(
    caplog, monkeypatch
):
    """One post can outlast the whole budget, so the budget has to cut it off.

    Checking only between attempts bounds how many are made, not how long they
    take.
    """
    monkeypatch.setattr("switch_core.observability.logs.SHUTDOWN_FLUSH_SECONDS", 0.05)

    class _Hangs(_Client):
        async def post(self, signal: str, payload: dict) -> None:
            await asyncio.sleep(30)

    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(message="one"))
    exporter = LogExporter(handler, _Hangs(), RESOURCE, 1.0, 500)

    started = time.monotonic()
    with caplog.at_level(logging.ERROR):
        await exporter._flush_on_shutdown()
    elapsed = time.monotonic() - started

    assert elapsed < 1.0, f"shutdown waited {elapsed:.1f}s on a hanging collector"
    assert "never exported" in caplog.text


@pytest.mark.asyncio
async def test_the_deadline_holds_when_the_task_is_already_being_cancelled(
    caplog, monkeypatch
):
    """The real path: the drain runs inside `except CancelledError`.

    `asyncio.timeout` cancels the task it guards, and here that task is already
    unwinding from a cancellation.
    """
    monkeypatch.setattr("switch_core.observability.logs.SHUTDOWN_FLUSH_SECONDS", 0.05)

    class _Hangs(_Client):
        async def post(self, signal: str, payload: dict) -> None:
            await asyncio.sleep(30)

    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(message="one"))
    exporter = LogExporter(
        handler, _Hangs(), RESOURCE, interval_seconds=30.0, batch_size=500
    )

    task = asyncio.create_task(exporter.run_forever())
    await asyncio.sleep(0)
    started = time.monotonic()
    task.cancel()
    with caplog.at_level(logging.ERROR):
        with pytest.raises(asyncio.CancelledError):
            await task
    elapsed = time.monotonic() - started

    # Cancellation still propagates, and it is not held up by the drain.
    assert elapsed < 1.0, f"cancellation took {elapsed:.1f}s"
    assert "never exported" in caplog.text

"""Shipping log records to the collector, alongside writing them to stderr.

The server has always written Datadog-shaped JSON to its own output, and in
this deployment nothing collects it: there is no log agent in the cluster, so
those lines reach the container and stop. This is the other end of that.

**stderr is not replaced.** The handler installed here is additional. `kubectl
logs` keeps working, a log agent added later still reads the same stream, and
a collector outage costs a copy rather than the record.

Three things make a log exporter different from a metrics one:

**It must never block.** `logger.info` is called from anywhere, including the
OS thread the Mattermost adapter dispatches on, and a network write inside it
would stall whatever was logging. So the handler only enqueues, and a task
drains.

**It must never grow without bound.** A collector that stops answering while
the server keeps logging is a memory leak in the observability of the thing it
is observing. The queue is capped and drops the oldest, and says how many it
dropped — a gap that announces itself, rather than one nobody can see.

**It must not feed itself.** Export failures are logged, and if those lines
were themselves queued for export a failing collector would generate exactly
the traffic that is failing. Records from this package are written to stderr
and never shipped.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections import deque

from switch_core.logging_context import CONTEXT_FIELDS
from switch_core.observability.otlp import (
    AttributeValue,
    LogRecord,
    OtlpClient,
    OtlpResource,
    OtlpSendError,
    build_logs_payload,
)

logger = logging.getLogger(__name__)

# Records from this package are never shipped; see the module docstring.
_SELF = "switch_core.observability"

# OTLP's severity numbers. Python's levels are a different scale, and a
# receiver that filters on severity is filtering on this one.
_SEVERITY = (
    (logging.CRITICAL, 21, "FATAL"),
    (logging.ERROR, 17, "ERROR"),
    (logging.WARNING, 13, "WARN"),
    (logging.INFO, 9, "INFO"),
    (logging.DEBUG, 5, "DEBUG"),
)

# How many records may wait to be sent. Roughly a minute of a busy server at
# the interval below; past that the collector is not keeping up and the
# alternative to dropping is growing.
DEFAULT_QUEUE_CAPACITY = 10_000

# Records per request. Large enough that a busy interval is one or two posts,
# small enough that a single payload stays a reasonable size.
DEFAULT_BATCH_SIZE = 500


def severity_of(level: int) -> tuple[int, str]:
    for threshold, number, text in _SEVERITY:
        if level >= threshold:
            return number, text
    return 1, "TRACE"


class OtlpLogHandler(logging.Handler):
    """Enqueues records. Sends nothing itself.

    A `logging.Handler` runs on whatever thread called `logger.info`, so this
    one does the least it can: format, and append under a lock.
    """

    def __init__(self, capacity: int) -> None:
        super().__init__()
        self._capacity = capacity
        self._lock = threading.Lock()
        self._records: deque[LogRecord] = deque()
        self._dropped = 0

    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith(_SELF):
            return
        try:
            entry = self._convert(record)
        except Exception:
            # `handleError` respects `logging.raiseExceptions` and writes to
            # stderr rather than recursing through this handler.
            self.handleError(record)
            return

        with self._lock:
            while len(self._records) >= self._capacity:
                self._records.popleft()
                self._dropped += 1
            self._records.append(entry)

    def _convert(self, record: logging.LogRecord) -> LogRecord:
        number, text = severity_of(record.levelno)
        attributes: dict[str, AttributeValue] = {
            # Datadog's standard attribute for the source logger, matching what
            # the JSON written to stderr already uses.
            "logger.name": record.name,
            "logger.thread_name": record.threadName or "",
        }
        # The fields the log context stamps — tenant, request, agent, user.
        # They are the reason shipping logs is worth anything: without them a
        # line cannot be tied to the request or the customer it belongs to.
        for field in CONTEXT_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                attributes[field] = str(value)

        if record.exc_info:
            exc_type, exc_value, _ = record.exc_info
            attributes["error.kind"] = (
                exc_type.__name__ if exc_type is not None else "Exception"
            )
            attributes["error.message"] = str(exc_value)
            attributes["error.stack"] = self.format_exception(record)

        return LogRecord(
            body=record.getMessage(),
            severity_text=text,
            severity_number=number,
            time_nanos=int(record.created * 1_000_000_000),
            attributes=attributes,
        )

    def format_exception(self, record: logging.LogRecord) -> str:
        formatter = self.formatter or logging.Formatter()
        return formatter.formatException(record.exc_info)  # type: ignore[arg-type]

    def take(self, limit: int) -> tuple[list[LogRecord], int]:
        """Up to `limit` records, and how many were dropped since the last take."""
        with self._lock:
            batch = [
                self._records.popleft() for _ in range(min(limit, len(self._records)))
            ]
            dropped = self._dropped
            self._dropped = 0
        return batch, dropped

    def pending(self) -> int:
        with self._lock:
            return len(self._records)


class LogExporter:
    """Drains the handler on an interval and posts what it found."""

    def __init__(
        self,
        handler: OtlpLogHandler,
        client: OtlpClient,
        resource: OtlpResource,
        interval_seconds: float,
        batch_size: int,
    ) -> None:
        self._handler = handler
        self._client = client
        self._resource = resource
        self._interval_seconds = interval_seconds
        self._batch_size = batch_size

    async def flush_once(self) -> None:
        batch, dropped = self._handler.take(self._batch_size)
        if dropped:
            # Loud, and carried in the log stream that is still working. A
            # dropped record is a hole in the evidence, and the one thing worse
            # than the hole is not knowing it is there.
            logger.error(
                "Dropped %d log record(s) waiting to be exported: the collector "
                "is not keeping up with this server's log volume. Those lines "
                "are in the container's output and nowhere else.",
                dropped,
            )
        if not batch:
            return

        try:
            await self._client.post("logs", build_logs_payload(batch, self._resource))
        except OtlpSendError as error:
            logger.warning(
                "Log export failed, dropping %d record(s): %s", len(batch), error
            )

    async def run_forever(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._interval_seconds)
                await self.flush_once()
            except asyncio.CancelledError:
                await self._flush_on_shutdown()
                raise
            except Exception:
                logger.exception("Log export loop raised; continuing.")

    async def _flush_on_shutdown(self) -> None:
        try:
            await self.flush_once()
        except Exception:
            logger.warning("Final log flush failed.", exc_info=True)

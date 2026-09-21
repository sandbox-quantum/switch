"""Shipping log records to the collector, alongside writing them to stderr.

stderr is never replaced — this handler is additional, so `kubectl logs` keeps
working and a collector outage costs a copy rather than the record.

Three constraints shape it:

**It must never block.** `logger.info` is called from anywhere, including the
OS thread the Mattermost adapter dispatches on, so the handler only enqueues
and a task drains.

**It must never grow without bound.** A collector that stops answering while
the server keeps logging would be a memory leak in the observability of the
thing being observed. The queue is capped, drops the oldest, and reports how
many.

**It must not feed itself.** Export failures are logged, and the HTTP client
underneath logs a line per connection at DEBUG. Shipping either would make a
failing collector generate the traffic that is failing, so records from this
package and anything logged during an export go to stderr only.
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
    exporting_now,
)

logger = logging.getLogger(__name__)

_SELF = "switch_core.observability"

# OTLP's own scale, which is what a receiver filters on — not Python's.
_SEVERITY = (
    (logging.CRITICAL, 21, "FATAL"),
    (logging.ERROR, 17, "ERROR"),
    (logging.WARNING, 13, "WARN"),
    (logging.INFO, 9, "INFO"),
    (logging.DEBUG, 5, "DEBUG"),
)

# Past this the collector is not keeping up, and the alternative to dropping
# is growing.
DEFAULT_QUEUE_CAPACITY = 10_000

# Records per request.
DEFAULT_BATCH_SIZE = 500

# Must stay under `main._FORCED_EXIT_GRACE_SECONDS`, the whole window teardown
# gets before the process is killed. Longer and the flush is not merely cut
# short — the line reporting what was lost never runs either.
SHUTDOWN_FLUSH_SECONDS = 2.0


def severity_of(level: int) -> tuple[int, str]:
    for threshold, number, text in _SEVERITY:
        if level >= threshold:
            return number, text
    return 1, "TRACE"


def _is_own_traffic(record: logging.LogRecord) -> bool:
    """Whether shipping this record would help generate the next one.

    This package's own loggers, matched on a dotted-name boundary so a sibling
    package is not swallowed with them; and anything logged inside an export's
    window, which is how `httpcore`'s per-connection DEBUG lines stay out.
    """
    if record.name == _SELF or record.name.startswith(f"{_SELF}."):
        return True
    return exporting_now()


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
        if _is_own_traffic(record):
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
            "logger.name": record.name,
            "logger.thread_name": record.threadName or "",
        }
        # Tenant, request, agent, user: without these a shipped line cannot be
        # tied to the request or the customer it belongs to.
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
        """Drain the queue under a deadline, and report whatever did not go.

        The deadline wraps the whole loop rather than being checked between
        attempts: one post can take the full export timeout, which an operator
        may raise, and overrunning the pod's grace period would take the line
        below with it.

        Written out rather than looping on :meth:`flush_once` because the
        accounting differs. A batch leaves the queue before it is posted, so
        counting what is left would report nothing lost for records abandoned
        mid-request.
        """
        lost = 0
        try:
            async with asyncio.timeout(SHUTDOWN_FLUSH_SECONDS):
                while True:
                    batch, dropped = self._handler.take(self._batch_size)
                    lost += dropped
                    if not batch:
                        break
                    sent = False
                    try:
                        await self._client.post(
                            "logs", build_logs_payload(batch, self._resource)
                        )
                        sent = True
                    except OtlpSendError:
                        # Feeding the rest to a collector that has already
                        # refused would spend the budget losing them slower.
                        break
                    finally:
                        # `finally`, not `except`: cancellation at the deadline
                        # is a BaseException and loses the batch just the same.
                        if not sent:
                            lost += len(batch)
        except TimeoutError:
            pass
        except Exception:
            logger.warning("Final log flush failed.", exc_info=True)

        lost += self._handler.pending()
        if lost:
            logger.error(
                "Shut down with %d log record(s) never exported. They are in "
                "this container's output and nowhere else.",
                lost,
            )

"""Shipping log records to an OTLP/HTTP collector, alongside stderr.

A trimmed copy of switch-core's `observability/otlp.py` (the logs payload and
the client) and `observability/logs.py` (the handler and the exporter), so the
decision service ships with the same settings and in the same wire shape.
Hand-built JSON over httpx, not the OpenTelemetry SDK. 64-bit integers are
strings in OTLP JSON, so timestamps are sent as strings.

stderr stays the primary copy. The handler never blocks the caller (it only
appends to a capped queue, dropping the oldest and counting the drops), and
never ships its own records or anything logged during an export, so a failing
collector cannot generate the traffic that is failing.
"""

import asyncio
import logging
import os
import threading
import uuid
from collections import deque
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from switch_decision.logging_setup import RequestIdFilter

logger = logging.getLogger(__name__)

_SELF = __name__

_SEVERITY = (
    (logging.CRITICAL, 21, "FATAL"),
    (logging.ERROR, 17, "ERROR"),
    (logging.WARNING, 13, "WARN"),
    (logging.INFO, 9, "INFO"),
    (logging.DEBUG, 5, "DEBUG"),
)

QUEUE_CAPACITY = 10_000
BATCH_SIZE = 500
EXPORT_INTERVAL_SECONDS = 5.0
# Kept well inside the pod's termination grace period, so the line reporting
# what was lost is written before the process is killed.
SHUTDOWN_FLUSH_SECONDS = 2.0

CONTEXT_FIELDS = ("request_id",)

AttributeValue = str | bool | int | float

# pydantic's reading of a bool, which is how switch-core parses the same
# variable.
_TRUE = {"1", "on", "t", "true", "y", "yes"}
_FALSE = {"0", "off", "f", "false", "n", "no"}

_exporting: ContextVar[bool] = ContextVar("switch_decision_exporting", default=False)


def exporting_now() -> bool:
    return _exporting.get()


@contextmanager
def exporting_window() -> Iterator[None]:
    token = _exporting.set(True)
    try:
        yield
    finally:
        _exporting.reset(token)


# ── settings ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class OtlpLogSettings:
    endpoint: str | None
    logs_enabled: bool
    headers: Mapping[str, str]
    timeout_seconds: float
    deployment_id: str | None

    @property
    def shipping(self) -> bool:
        return self.endpoint is not None and self.logs_enabled


def _parse_bool(name: str, raw: str) -> bool:
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise ValueError(f"{name} must be true or false, got {raw!r}.")


def parse_otlp_headers(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    headers: dict[str, str] = {}
    for pair in raw.split(","):
        if not pair.strip():
            continue
        key, separator, value = pair.partition("=")
        if not separator or not key.strip():
            raise ValueError(
                f"OTLP_HEADERS must be comma-separated key=value pairs, got {pair!r}."
            )
        headers[key.strip()] = value.strip()
    return headers


def _validate_endpoint(endpoint: str) -> None:
    if endpoint != endpoint.strip():
        raise ValueError(
            f"OTLP_ENDPOINT has leading or trailing whitespace: {endpoint!r}."
        )
    parts = urlsplit(endpoint)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"OTLP_ENDPOINT must be an http(s) URL, got {endpoint!r}.")
    if not parts.netloc:
        raise ValueError(f"OTLP_ENDPOINT must include a host, got {endpoint!r}.")
    if parts.path.strip("/"):
        raise ValueError(
            "OTLP_ENDPOINT is the collector's base URL and the signal path is "
            f"appended to it, so it must have no path of its own. Got {endpoint!r}."
        )
    if parts.query or parts.fragment:
        raise ValueError(
            "OTLP_ENDPOINT must not carry a query string or fragment: both are "
            f"discarded when the signal path is appended. Got {endpoint!r}. Put a "
            "credential in OTLP_HEADERS instead."
        )


def load_otlp_settings() -> OtlpLogSettings:
    """The same variables, defaults and checks as switch-core.

    DEPLOYMENT_ID is required only when logs are actually shipped: the
    collector drops a payload without one silently, but a service that ships
    nothing has no use for it.
    """
    endpoint = os.environ.get("OTLP_ENDPOINT")
    raw_enabled = os.environ.get("OTLP_LOGS_ENABLED")
    logs_enabled = (
        False if raw_enabled is None else _parse_bool("OTLP_LOGS_ENABLED", raw_enabled)
    )
    timeout_seconds = float(os.environ.get("OTLP_TIMEOUT_SECONDS", "10"))
    deployment_id = os.environ.get("DEPLOYMENT_ID")
    headers = parse_otlp_headers(os.environ.get("OTLP_HEADERS"))

    if deployment_id is not None:
        try:
            uuid.UUID(deployment_id)
        except ValueError as error:
            raise ValueError(
                f"DEPLOYMENT_ID must be a UUID, got {deployment_id!r}."
            ) from error
    if endpoint is not None:
        _validate_endpoint(endpoint)
        if timeout_seconds <= 0:
            raise ValueError(
                f"OTLP_TIMEOUT_SECONDS must be greater than 0, got {timeout_seconds!r}."
            )
        if logs_enabled and not deployment_id:
            raise ValueError(
                "DEPLOYMENT_ID must be set when OTLP_ENDPOINT and OTLP_LOGS_ENABLED "
                "are: the collector drops payloads that do not identify the "
                "deployment, silently."
            )
    return OtlpLogSettings(
        endpoint=endpoint,
        logs_enabled=logs_enabled,
        headers=headers,
        timeout_seconds=timeout_seconds,
        deployment_id=deployment_id,
    )


# ── wire format ────────────────────────────────────────────────────────────


def _otlp_value(value: AttributeValue) -> dict[str, Any]:
    # bool first: it subclasses int.
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int | float):
        return {"doubleValue": float(value)}
    return {"stringValue": value}


def otlp_attributes(values: Mapping[str, AttributeValue]) -> list[dict[str, Any]]:
    return [{"key": key, "value": _otlp_value(values[key])} for key in sorted(values)]


@dataclass(frozen=True)
class OtlpResource:
    service_name: str
    service_version: str | None
    environment: str | None
    deployment_id: str
    instance_id: str | None

    def attributes(self) -> dict[str, AttributeValue]:
        values: dict[str, AttributeValue] = {
            "service.name": self.service_name,
            # The collector drops payloads without it, silently.
            "switch_trust.client_id": self.deployment_id,
        }
        if self.service_version:
            values["service.version"] = self.service_version
        if self.instance_id:
            values["service.instance.id"] = self.instance_id
        if self.environment:
            values["deployment.environment"] = self.environment
        return values


@dataclass(frozen=True)
class LogRecord:
    body: str
    severity_text: str
    severity_number: int
    time_nanos: int
    attributes: Mapping[str, AttributeValue]


def build_logs_payload(
    records: Sequence[LogRecord], resource: OtlpResource
) -> dict[str, Any]:
    scope: dict[str, Any] = {"name": resource.service_name}
    if resource.service_version:
        scope["version"] = resource.service_version
    return {
        "resourceLogs": [
            {
                "resource": {"attributes": otlp_attributes(resource.attributes())},
                "scopeLogs": [
                    {
                        "scope": scope,
                        "logRecords": [
                            {
                                "timeUnixNano": str(record.time_nanos),
                                "observedTimeUnixNano": str(record.time_nanos),
                                "severityNumber": record.severity_number,
                                "severityText": record.severity_text,
                                "body": {"stringValue": record.body},
                                "attributes": otlp_attributes(record.attributes),
                            }
                            for record in records
                        ],
                    }
                ],
            }
        ]
    }


class OtlpSendError(RuntimeError):
    """A payload did not reach the collector."""


class OtlpClient:
    """Posts payloads to the collector. No retry: a lost batch leaves a visible
    hole rather than a queue growing behind a struggling collector."""

    def __init__(
        self,
        base_endpoint: str,
        timeout_seconds: float,
        headers: Mapping[str, str],
        client: httpx.AsyncClient,
    ) -> None:
        self._base_endpoint = base_endpoint
        self._timeout_seconds = timeout_seconds
        self._headers = {
            "Content-Type": "application/json",
            "User-Agent": "switch-decision",
            **headers,
        }
        self._client = client

    def url_for(self, signal: str) -> str:
        return urljoin(self._base_endpoint.rstrip("/") + "/", f"v1/{signal}")

    async def post(self, signal: str, payload: Mapping[str, Any]) -> None:
        url = self.url_for(signal)
        with exporting_window():
            try:
                response = await self._client.post(
                    url,
                    json=payload,
                    headers=self._headers,
                    timeout=self._timeout_seconds,
                )
            except httpx.HTTPError as error:
                raise OtlpSendError(f"POST {url} failed: {error!r}") from error
            if response.status_code >= 400:
                raise OtlpSendError(f"POST {url} answered {response.status_code}")
            _raise_on_partial_rejection(url, response)


def _raise_on_partial_rejection(url: str, response: httpx.Response) -> None:
    """A 200 may still say some records were refused."""
    try:
        body = response.json()
    except ValueError:
        return
    if not isinstance(body, dict):
        return
    partial = body.get("partialSuccess")
    if not isinstance(partial, dict):
        return
    rejected = partial.get("rejectedLogRecords")
    if not rejected or int(rejected) == 0:
        return
    raise OtlpSendError(
        f"POST {url} rejected {int(rejected)} record(s): "
        f"{partial.get('errorMessage') or 'no reason given'}"
    )


# ── handler and exporter ───────────────────────────────────────────────────


def severity_of(level: int) -> tuple[int, str]:
    for threshold, number, text in _SEVERITY:
        if level >= threshold:
            return number, text
    return 1, "TRACE"


def _is_own_traffic(record: logging.LogRecord) -> bool:
    if record.name == _SELF or record.name.startswith(f"{_SELF}."):
        return True
    return exporting_now()


class OtlpLogHandler(logging.Handler):
    """Converts and enqueues records. Sends nothing itself."""

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
            attributes["error.stack"] = (
                self.formatter or logging.Formatter()
            ).formatException(record.exc_info)
        return LogRecord(
            body=record.getMessage(),
            severity_text=text,
            severity_number=number,
            time_nanos=int(record.created * 1_000_000_000),
            attributes=attributes,
        )

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
                "is not keeping up. Those lines are in the container's output "
                "and nowhere else.",
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
                await self.flush_on_shutdown()
                raise
            except Exception:
                logger.exception("Log export loop raised; continuing.")

    async def flush_on_shutdown(self) -> None:
        """Drain the queue under one deadline and report whatever did not go.

        A batch leaves the queue before it is posted, so the loss is counted
        from what was taken, not from what is left.
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
                        break
                    finally:
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


class LogShipping:
    """The running handler and exporter; `aclose` detaches, flushes and stops."""

    def __init__(
        self,
        handler: OtlpLogHandler,
        task: asyncio.Task[None],
        http_client: httpx.AsyncClient,
    ) -> None:
        self._handler = handler
        self._task = task
        self._http_client = http_client

    async def aclose(self) -> None:
        logging.getLogger().removeHandler(self._handler)
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        await self._http_client.aclose()


def start_log_shipping(
    settings: OtlpLogSettings,
    service_name: str,
    service_version: str | None,
    environment: str | None,
    instance_id: str,
) -> LogShipping | None:
    """Attach the handler to the root logger and start the exporter, when
    `OTLP_ENDPOINT` and `OTLP_LOGS_ENABLED` are both set. Call from a running
    event loop."""
    if settings.endpoint is None:
        return None
    if not settings.logs_enabled:
        logger.info(
            "OTLP_ENDPOINT is set but OTLP_LOGS_ENABLED is false, so logs are "
            "written to this container's output only."
        )
        return None
    resource = OtlpResource(
        service_name=service_name,
        service_version=service_version,
        environment=environment,
        deployment_id=str(settings.deployment_id),
        instance_id=instance_id,
    )
    http_client = httpx.AsyncClient()
    client = OtlpClient(
        base_endpoint=settings.endpoint,
        timeout_seconds=settings.timeout_seconds,
        headers=settings.headers,
        client=http_client,
    )
    handler = OtlpLogHandler(capacity=QUEUE_CAPACITY)
    handler.addFilter(RequestIdFilter())
    logging.getLogger().addHandler(handler)
    exporter = LogExporter(
        handler=handler,
        client=client,
        resource=resource,
        interval_seconds=EXPORT_INTERVAL_SECONDS,
        batch_size=BATCH_SIZE,
    )
    task = asyncio.create_task(exporter.run_forever(), name="otlp-log-exporter")
    logger.info(
        "Also shipping logs to %s. They are still written to this container's "
        "output, which remains the primary copy.",
        client.url_for("logs"),
    )
    return LogShipping(handler, task, http_client)

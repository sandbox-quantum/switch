"""The OTLP/HTTP wire format, and the one place anything leaves the deployment.

Hand-built JSON over ``httpx`` rather than the OpenTelemetry SDK, following
Switch Console's telemetry client: everything a deployment sends is visible in
one file, which matters for something self-hosted. The cost is owning the wire
format, which is what ``test_otlp.py`` is for.

Its sharp edge is protobuf's JSON mapping of 64-bit integers as **strings** —
timestamps, histogram counts, bucket counts. A strict receiver rejects a
payload that sends them as numbers and the relay answers 200 either way.
Doubles stay numbers.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx

logger = logging.getLogger(__name__)

# True while this task is inside an export request, so the log handler can
# decline to ship what the export itself logs. A context variable rather than a
# flag: it must be this task's window, not the process's.
_exporting: ContextVar[bool] = ContextVar("switch_otlp_exporting", default=False)


def exporting_now() -> bool:
    return _exporting.get()


@contextmanager
def _exporting_window() -> Iterator[None]:
    token = _exporting.set(True)
    try:
        yield
    finally:
        _exporting.reset(token)


# Delta rather than cumulative: Datadog reads it directly, and a restart loses
# one interval instead of resetting a climbing series to zero.
AGGREGATION_TEMPORALITY_DELTA = 1

# OpenTelemetry's defaults, in milliseconds. Left untuned: bounds chosen for
# today's latencies stop answering the question the day they change.
DEFAULT_LATENCY_BOUNDS_MS: tuple[float, ...] = (
    5.0,
    10.0,
    25.0,
    50.0,
    75.0,
    100.0,
    250.0,
    500.0,
    750.0,
    1000.0,
    2500.0,
    5000.0,
    7500.0,
    10000.0,
)

# For what a single database round trip costs, which is a different scale
# entirely: measured against Postgres 16 on this schema, an ordinary statement
# is 0.1–0.2 ms, so every one of it lands in the first bucket above and a p95
# reads "≤5 ms" until something is already badly wrong. Bounds that cannot
# resolve the normal case cannot show it degrading, which is the whole job.
# Extends to the same ceiling, because a statement that takes ten seconds is
# the thing you most want to see.
SUB_MILLISECOND_BOUNDS_MS: tuple[float, ...] = (
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    25.0,
    50.0,
    100.0,
    250.0,
    500.0,
    1000.0,
    5000.0,
    10000.0,
)

AttributeValue = str | bool | int | float


class OtlpSendError(RuntimeError):
    """A payload did not reach the collector."""


def _otlp_value(value: AttributeValue) -> dict[str, Any]:
    # `bool` first: it subclasses `int`, and as 1/0 a yes/no becomes something
    # a receiver will average.
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int | float):
        return {"doubleValue": float(value)}
    return {"stringValue": value}


def otlp_attributes(values: Mapping[str, AttributeValue]) -> list[dict[str, Any]]:
    """Attributes in OTLP's key/value shape, sorted so payloads compare equal."""
    return [{"key": key, "value": _otlp_value(values[key])} for key in sorted(values)]


@dataclass(frozen=True)
class OtlpResource:
    """What this process calls itself to the collector, and to Datadog beyond it.

    ``service_version`` is ``None`` when switch-core cannot read its own
    version, and is then omitted rather than placeheld — a dashboard filtered
    by version should show the record missing, not attribute it to a release
    nobody built.
    """

    service_name: str
    service_version: str | None
    environment: str | None
    deployment_id: str

    def attributes(self) -> dict[str, AttributeValue]:
        values: dict[str, AttributeValue] = {
            "service.name": self.service_name,
            # The relay's guard: it drops payloads without one, in silence and
            # with a 200. `SwitchConfig` refuses to start without it.
            "flint.client_id": self.deployment_id,
        }
        if self.service_version:
            values["service.version"] = self.service_version
        if self.environment:
            # Datadog maps this onto `env`.
            values["deployment.environment"] = self.environment
        return values


@dataclass(frozen=True)
class NumberPoint:
    attributes: Mapping[str, AttributeValue]
    value: float


@dataclass(frozen=True)
class HistogramPoint:
    attributes: Mapping[str, AttributeValue]
    count: int
    total: float
    bucket_counts: Sequence[int]
    bounds: Sequence[float]


@dataclass(frozen=True)
class MetricPayload:
    """One metric's points, ready to encode."""

    name: str
    unit: str
    description: str
    kind: str  # "sum" | "gauge" | "histogram"
    numbers: Sequence[NumberPoint]
    histograms: Sequence[HistogramPoint]


def _number_data_point(
    point: NumberPoint, start_nanos: int, end_nanos: int
) -> dict[str, Any]:
    return {
        "attributes": otlp_attributes(point.attributes),
        "startTimeUnixNano": str(start_nanos),
        "timeUnixNano": str(end_nanos),
        # `asDouble`, not `asInt`: int64 is a JSON string, which invites a
        # receiver to treat a count as text.
        "asDouble": point.value,
    }


def _histogram_data_point(
    point: HistogramPoint, start_nanos: int, end_nanos: int
) -> dict[str, Any]:
    return {
        "attributes": otlp_attributes(point.attributes),
        "startTimeUnixNano": str(start_nanos),
        "timeUnixNano": str(end_nanos),
        # fixed64 on the wire, so strings in JSON.
        "count": str(point.count),
        "sum": point.total,
        "bucketCounts": [str(count) for count in point.bucket_counts],
        "explicitBounds": list(point.bounds),
    }


def _encode_metric(
    metric: MetricPayload, start_nanos: int, end_nanos: int
) -> dict[str, Any]:
    encoded: dict[str, Any] = {
        "name": metric.name,
        "unit": metric.unit,
        "description": metric.description,
    }
    if metric.kind == "gauge":
        # A reading, not an interval: no start time, no temporality.
        encoded["gauge"] = {
            "dataPoints": [
                {
                    "attributes": otlp_attributes(point.attributes),
                    "timeUnixNano": str(end_nanos),
                    "asDouble": point.value,
                }
                for point in metric.numbers
            ]
        }
    elif metric.kind == "sum":
        encoded["sum"] = {
            "dataPoints": [
                _number_data_point(point, start_nanos, end_nanos)
                for point in metric.numbers
            ],
            "aggregationTemporality": AGGREGATION_TEMPORALITY_DELTA,
            "isMonotonic": True,
        }
    elif metric.kind == "histogram":
        encoded["histogram"] = {
            "dataPoints": [
                _histogram_data_point(point, start_nanos, end_nanos)
                for point in metric.histograms
            ],
            "aggregationTemporality": AGGREGATION_TEMPORALITY_DELTA,
        }
    else:
        raise ValueError(f"Unknown metric kind {metric.kind!r} for {metric.name!r}.")
    return encoded


def build_metrics_payload(
    metrics: Sequence[MetricPayload],
    resource: OtlpResource,
    start_nanos: int,
    end_nanos: int,
) -> dict[str, Any]:
    """One export interval's metrics as a single OTLP request body."""
    return {
        "resourceMetrics": [
            {
                "resource": {"attributes": otlp_attributes(resource.attributes())},
                "scopeMetrics": [
                    {
                        "scope": {
                            "name": resource.service_name,
                            **(
                                {"version": resource.service_version}
                                if resource.service_version
                                else {}
                            ),
                        },
                        "metrics": [
                            _encode_metric(metric, start_nanos, end_nanos)
                            for metric in metrics
                        ],
                    }
                ],
            }
        ]
    }


@dataclass(frozen=True)
class LogRecord:
    """One log line, on its way to the collector."""

    body: str
    severity_text: str
    severity_number: int
    time_nanos: int
    attributes: Mapping[str, AttributeValue]
    # Set when the record was emitted inside a span, so Datadog can pivot from
    # the log to the trace it belongs to. Hex strings, as OTLP JSON wants them.
    trace_id: str | None = None
    span_id: str | None = None


def build_logs_payload(
    records: Sequence[LogRecord], resource: OtlpResource
) -> dict[str, Any]:
    """A batch of log records as a single OTLP request body."""
    encoded: list[dict[str, Any]] = []
    for record in records:
        entry: dict[str, Any] = {
            "timeUnixNano": str(record.time_nanos),
            "observedTimeUnixNano": str(record.time_nanos),
            "severityNumber": record.severity_number,
            "severityText": record.severity_text,
            "body": {"stringValue": record.body},
            "attributes": otlp_attributes(record.attributes),
        }
        if record.trace_id:
            entry["traceId"] = record.trace_id
        if record.span_id:
            entry["spanId"] = record.span_id
        encoded.append(entry)

    return {
        "resourceLogs": [
            {
                "resource": {"attributes": otlp_attributes(resource.attributes())},
                "scopeLogs": [
                    {
                        "scope": {
                            "name": resource.service_name,
                            **(
                                {"version": resource.service_version}
                                if resource.service_version
                                else {}
                            ),
                        },
                        "logRecords": encoded,
                    }
                ],
            }
        ]
    }


def now_nanos() -> int:
    return time.time_ns()


class OtlpClient:
    """Posts payloads to an OTLP/HTTP collector. One client, reused.

    No retry: it would queue work behind a struggling collector and turn an
    observability outage into a memory leak in the thing being observed. A lost
    interval leaves a visible hole, which is the property that matters.
    """

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
            "User-Agent": "switch-core",
            **headers,
        }
        self._client = client

    def url_for(self, signal: str) -> str:
        """The endpoint for a signal, by the `OTEL_EXPORTER_OTLP_ENDPOINT` rule."""
        return urljoin(self._base_endpoint.rstrip("/") + "/", f"v1/{signal}")

    async def post(self, signal: str, payload: Mapping[str, Any]) -> None:
        """Send one payload. Raises :class:`OtlpSendError` on any failure."""
        url = self.url_for(signal)
        with _exporting_window():
            try:
                response = await self._client.post(
                    url,
                    json=payload,
                    headers=self._headers,
                    timeout=self._timeout_seconds,
                )
            except httpx.HTTPError as error:
                raise OtlpSendError(f"POST {url} failed: {error}") from error

            if response.status_code >= 400:
                raise OtlpSendError(
                    f"POST {url} answered {response.status_code}: {response.text[:200]}"
                )

            _raise_on_partial_rejection(url, response)


def _raise_on_partial_rejection(url: str, response: httpx.Response) -> None:
    """OTLP allows a 200 to carry a count of records the receiver would not take.

    The only channel through which a rejection is visible at all, since a
    collector that drops a record still answers 200.
    """
    try:
        body = response.json()
    except ValueError:
        return
    if not isinstance(body, dict):
        return

    partial = body.get("partialSuccess")
    if not isinstance(partial, dict):
        return

    rejected = partial.get("rejectedDataPoints") or partial.get("rejectedLogRecords")
    if not rejected or int(rejected) == 0:
        return

    raise OtlpSendError(
        f"POST {url} rejected {rejected} record(s): "
        f"{partial.get('errorMessage') or 'no reason given'}"
    )

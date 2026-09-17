"""The OTLP/HTTP wire format, and the one place anything leaves the deployment.

Hand-built JSON posted with ``httpx`` rather than the OpenTelemetry SDK, for
the same reason Switch Console hand-builds its own (see
``console/.../telemetry/relay-client.ts``): everything this deployment sends is
visible in one file, and an SDK brings its own batching, retry and identity
behaviour that would then have to be argued down. Switch is self-hosted by
people who are entitled to read exactly what their server reports and to whom.
The cost is that the wire format is ours to keep correct, which is what
``test_otlp.py`` is for.

The encoding is protobuf's canonical JSON mapping, and its one sharp edge is
that 64-bit integers are **strings** — timestamps, histogram counts and bucket
counts. A receiver that parses strictly rejects a payload that sends them as
numbers, and the relay answers 200 either way, so nothing here would ever see
it happen. Doubles stay numbers.
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

# True while this task is inside an export request.
#
# Sending anything costs an HTTP call, and an HTTP client logs — `httpcore`
# emits a line per connection at DEBUG, which is a supported log level here.
# Shipping those lines would mean each export generating the records the next
# export has to send, for ever. The log handler reads this and declines to
# queue anything emitted inside the window.
#
# A context variable rather than a flag because it has to be exactly this
# task's window: another request logging at the same moment is in its own
# context and must still be shipped.
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


# OTLP's own enum, sent as an integer. Delta rather than cumulative: Datadog
# reads delta sums and histograms directly, whereas a cumulative series has to
# be differenced at query time and reads as a permanently climbing line until
# it is. Delta also means this process keeps no running totals, so a restart
# loses one interval rather than resetting every counter to zero.
AGGREGATION_TEMPORALITY_DELTA = 1

# OpenTelemetry's default explicit bucket boundaries, in milliseconds. Kept as
# the library's defaults rather than tuned to Switch: a bound set chosen for
# today's latencies silently stops answering the question the day they change,
# and these already straddle the range that matters (a fast local query to a
# request nobody should be waiting on).
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

AttributeValue = str | bool | int | float


class OtlpSendError(RuntimeError):
    """A payload did not reach the collector."""


def _otlp_value(value: AttributeValue) -> dict[str, Any]:
    # `bool` before the numbers: it is a subclass of `int` and would otherwise
    # serialise as 1/0, turning a yes/no into something a receiver will average.
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int | float):
        return {"doubleValue": float(value)}
    return {"stringValue": value}


def otlp_attributes(values: Mapping[str, AttributeValue]) -> list[dict[str, Any]]:
    """Attributes in OTLP's key/value shape, ordered so payloads are comparable.

    Sorted by key because an unordered dict makes two identical payloads
    compare unequal, which is only ever felt in a test diff — but it is felt
    there constantly.
    """
    return [{"key": key, "value": _otlp_value(values[key])} for key in sorted(values)]


@dataclass(frozen=True)
class OtlpResource:
    """What this process calls itself to the collector, and to Datadog beyond it.

    ``service_version`` is ``None`` when switch-core cannot read its own
    version (see :mod:`switch_core.version`); it is then omitted rather than
    sent as a placeholder, so a dashboard filtered by version shows the record
    missing instead of attributing it to a release nobody built.
    """

    service_name: str
    service_version: str | None
    environment: str | None
    deployment_id: str

    def attributes(self) -> dict[str, AttributeValue]:
        values: dict[str, AttributeValue] = {
            "service.name": self.service_name,
            # The relay's guard. It requires a canonical UUID on every payload
            # and drops what arrives without one, in silence and with a 200 —
            # so an absent id is not a degraded send, it is no send at all.
            # `SwitchConfig` refuses to start with export on and this unset.
            "flint.client_id": self.deployment_id,
        }
        if self.service_version:
            values["service.version"] = self.service_version
        if self.environment:
            # Datadog's unified service tagging reads `deployment.environment`
            # from OTLP and maps it onto `env`.
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
        # `asDouble` rather than `asInt`: OTLP's int64 is a JSON string, which
        # invites a receiver to treat a count as text and makes it useless to
        # average. Every value here is exact as a double.
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
        # A gauge is the current reading and carries no interval, so it gets no
        # start time and no temporality.
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

    No retry, deliberately. A metric interval lost to a flaky network is lost;
    retrying would queue work behind a collector that is already struggling and
    turn an observability outage into a memory leak in the thing being
    observed. The loss is visible — the series has a hole — which is the
    property that matters.
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
            # Sent in place of whatever httpx would otherwise volunteer, so the
            # collector's operators can see which client their traffic is from.
            "User-Agent": "switch-core",
            **headers,
        }
        self._client = client

    def url_for(self, signal: str) -> str:
        """The endpoint for a signal, by OTLP's own base-plus-path convention.

        The same rule ``OTEL_EXPORTER_OTLP_ENDPOINT`` follows, so an operator
        who has configured any other OTLP client already knows what to set.
        """
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

    It is the only channel through which a rejection becomes visible at all —
    a collector that drops a record for failing its own guard still answers
    200 — so the small body is worth one parse. A response that is not JSON is
    not worth a second failure on top of the first.
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

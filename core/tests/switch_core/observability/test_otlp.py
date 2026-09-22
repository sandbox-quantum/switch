"""The OTLP wire format is ours to keep correct, so it is tested directly.

The encoding's sharp edge is protobuf JSON's rule that 64-bit integers travel
as strings. A receiver that parses strictly rejects a payload that sends them
as numbers, and the relay answers 200 either way — so nothing but a test will
ever notice.
"""

import json

import httpx
import pytest

from switch_core.observability.otlp import (
    AGGREGATION_TEMPORALITY_DELTA,
    HistogramPoint,
    LogRecord,
    MetricPayload,
    NumberPoint,
    OtlpClient,
    OtlpResource,
    OtlpSendError,
    build_logs_payload,
    build_metrics_payload,
    otlp_attributes,
)

RESOURCE = OtlpResource(
    service_name="switch-core",
    service_version="1.2.3",
    environment="pilot",
    deployment_id="0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10",
)

START_NANOS = 1_700_000_000_000_000_000
END_NANOS = 1_700_000_060_000_000_000


def _sum_metric() -> MetricPayload:
    return MetricPayload(
        name="switch.http.requests",
        unit="{request}",
        description="HTTP requests served.",
        kind="sum",
        numbers=[NumberPoint(attributes={"route": "/health"}, value=3.0)],
        histograms=(),
    )


def test_attribute_values_keep_their_type():
    encoded = otlp_attributes({"text": "a", "flag": True, "count": 2})
    by_key = {entry["key"]: entry["value"] for entry in encoded}

    assert by_key["text"] == {"stringValue": "a"}
    # bool is a subclass of int; encoding it as a number would turn a yes/no
    # into something a receiver will happily average.
    assert by_key["flag"] == {"boolValue": True}
    assert by_key["count"] == {"doubleValue": 2.0}


def test_attributes_are_ordered_by_key():
    encoded = otlp_attributes({"b": "1", "a": "2"})
    assert [entry["key"] for entry in encoded] == ["a", "b"]


def test_resource_carries_the_deployment_id_the_relay_guards_on():
    attributes = RESOURCE.attributes()
    assert attributes["flint.client_id"] == RESOURCE.deployment_id
    assert attributes["service.name"] == "switch-core"
    assert attributes["deployment.environment"] == "pilot"


def test_unknown_version_is_omitted_rather_than_placeheld():
    resource = OtlpResource(
        service_name="switch-core",
        service_version=None,
        environment=None,
        deployment_id=RESOURCE.deployment_id,
    )
    attributes = resource.attributes()

    assert "service.version" not in attributes
    assert "deployment.environment" not in attributes


def test_sum_points_are_delta_and_monotonic():
    payload = build_metrics_payload([_sum_metric()], RESOURCE, START_NANOS, END_NANOS)
    metric = payload["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]

    assert metric["sum"]["aggregationTemporality"] == AGGREGATION_TEMPORALITY_DELTA
    assert metric["sum"]["isMonotonic"] is True

    point = metric["sum"]["dataPoints"][0]
    assert point["asDouble"] == 3.0
    # The whole point of the test file.
    assert point["startTimeUnixNano"] == str(START_NANOS)
    assert point["timeUnixNano"] == str(END_NANOS)
    assert isinstance(point["startTimeUnixNano"], str)


def test_gauge_points_carry_no_interval():
    gauge = MetricPayload(
        name="switch.agents.connected",
        unit="{agent}",
        description="Agents connected.",
        kind="gauge",
        numbers=[NumberPoint(attributes={}, value=7.0)],
        histograms=(),
    )
    payload = build_metrics_payload([gauge], RESOURCE, START_NANOS, END_NANOS)
    metric = payload["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]

    point = metric["gauge"]["dataPoints"][0]
    assert point["asDouble"] == 7.0
    # A reading, not an interval: a start time would claim the value held for
    # the whole window, which is exactly what a gauge does not say.
    assert "startTimeUnixNano" not in point
    assert "aggregationTemporality" not in metric["gauge"]


def test_histogram_counts_are_strings_and_bounds_are_numbers():
    histogram = MetricPayload(
        name="switch.http.request.duration",
        unit="ms",
        description="Request duration.",
        kind="histogram",
        numbers=(),
        histograms=[
            HistogramPoint(
                attributes={"route": "/health"},
                count=2,
                total=12.5,
                bucket_counts=[1, 1, 0],
                bounds=[5.0, 10.0],
            )
        ],
    )
    payload = build_metrics_payload([histogram], RESOURCE, START_NANOS, END_NANOS)
    metric = payload["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]
    point = metric["histogram"]["dataPoints"][0]

    assert point["count"] == "2"
    assert point["bucketCounts"] == ["1", "1", "0"]
    # Doubles stay numbers; only the 64-bit integers become strings.
    assert point["explicitBounds"] == [5.0, 10.0]
    assert point["sum"] == 12.5


def test_unknown_metric_kind_is_refused():
    broken = MetricPayload(
        name="switch.bogus",
        unit="1",
        description="",
        kind="summary",
        numbers=(),
        histograms=(),
    )
    with pytest.raises(ValueError, match="Unknown metric kind"):
        build_metrics_payload([broken], RESOURCE, START_NANOS, END_NANOS)


def test_metrics_payload_is_json_serialisable():
    payload = build_metrics_payload([_sum_metric()], RESOURCE, START_NANOS, END_NANOS)
    # A payload that cannot be serialised fails inside httpx, one layer below
    # anything that could report it usefully.
    json.dumps(payload)


def test_log_records_carry_trace_ids_only_when_present():
    records = [
        LogRecord(
            body="hello",
            severity_text="INFO",
            severity_number=9,
            time_nanos=END_NANOS,
            attributes={"logger.name": "switch_core.test"},
        ),
        LogRecord(
            body="traced",
            severity_text="ERROR",
            severity_number=17,
            time_nanos=END_NANOS,
            attributes={},
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
        ),
    ]
    payload = build_logs_payload(records, RESOURCE)
    encoded = payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"]

    assert "traceId" not in encoded[0]
    assert encoded[1]["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert encoded[1]["spanId"] == "00f067aa0ba902b7"
    assert encoded[0]["timeUnixNano"] == str(END_NANOS)


def _client(handler) -> OtlpClient:
    transport = httpx.MockTransport(handler)
    return OtlpClient(
        base_endpoint="https://collector.example",
        timeout_seconds=1.0,
        headers={},
        client=httpx.AsyncClient(transport=transport),
    )


def test_signal_url_follows_the_otlp_base_convention():
    client = _client(lambda request: httpx.Response(200, json={}))
    assert client.url_for("metrics") == "https://collector.example/v1/metrics"

    trailing = OtlpClient(
        base_endpoint="https://collector.example/",
        timeout_seconds=1.0,
        headers={},
        client=httpx.AsyncClient(),
    )
    assert trailing.url_for("logs") == "https://collector.example/v1/logs"


@pytest.mark.asyncio
async def test_post_sends_headers_and_body():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("dd-api-key")
        seen["agent"] = request.headers.get("user-agent")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"partialSuccess": {}})

    client = OtlpClient(
        base_endpoint="https://collector.example",
        timeout_seconds=1.0,
        headers={"dd-api-key": "k"},
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await client.post("metrics", {"resourceMetrics": []})

    assert seen["url"] == "https://collector.example/v1/metrics"
    assert seen["auth"] == "k"
    assert seen["agent"] == "switch-core"
    assert seen["body"] == {"resourceMetrics": []}


@pytest.mark.asyncio
async def test_http_error_is_raised_not_swallowed():
    client = _client(lambda request: httpx.Response(503, text="unavailable"))
    with pytest.raises(OtlpSendError, match="503"):
        await client.post("metrics", {})


@pytest.mark.asyncio
async def test_network_failure_is_raised():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = _client(handler)
    with pytest.raises(OtlpSendError, match="failed"):
        await client.post("metrics", {})


@pytest.mark.asyncio
async def test_partial_rejection_inside_a_200_is_raised():
    """A 200 does not prove the records were kept, so the body is read."""
    body = {
        "partialSuccess": {"rejectedDataPoints": "4", "errorMessage": "bad resource"}
    }
    client = _client(lambda request: httpx.Response(200, json=body))

    with pytest.raises(OtlpSendError, match="rejected 4"):
        await client.post("metrics", {})


@pytest.mark.asyncio
async def test_empty_partial_success_is_not_a_failure():
    client = _client(lambda request: httpx.Response(200, json={"partialSuccess": {}}))
    await client.post("metrics", {})


@pytest.mark.asyncio
async def test_non_json_success_body_is_tolerated():
    client = _client(lambda request: httpx.Response(200, text="OK"))
    await client.post("metrics", {})

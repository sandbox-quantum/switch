"""OTLP log shipping: the wire format (against the payload switch-core's own
encoder produces), the bounded handler, the exporter, the settings, and the
service with a collector that is working, failing, hanging or absent."""

import asyncio
import json
import logging
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from switch_decision import app as app_module
from switch_decision import otlp_logs
from switch_decision.logging_setup import (
    RequestIdFilter,
    bind_request_id,
    unbind_request_id,
)
from switch_decision.otlp_logs import (
    LogExporter,
    LogRecord,
    OtlpClient,
    OtlpLogHandler,
    OtlpLogSettings,
    OtlpResource,
    OtlpSendError,
    build_logs_payload,
    exporting_window,
    load_otlp_settings,
    otlp_attributes,
    severity_of,
)
from tests.helpers import BODY, SECRETS, logprobs, settings_for

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "otlp_logs_payload.json").read_text()
)
DEPLOYMENT_ID = "0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10"
RESOURCE = OtlpResource(
    service_name="switch-decision",
    service_version="0.1.0",
    environment="pilot",
    deployment_id=DEPLOYMENT_ID,
    instance_id=None,
)


def _record(
    name: str = "switch_decision",
    level: int = logging.INFO,
    message: str = "hello %s",
    args: tuple = (),
    exc_info=None,
) -> logging.LogRecord:
    return logging.LogRecord(name, level, __file__, 1, message, args, exc_info)


# ── wire format ────────────────────────────────────────────────────────────


def test_payload_matches_switch_cores_encoding():
    resource = OtlpResource(**FIXTURE["resource"])
    records = [LogRecord(**r) for r in FIXTURE["records"]]
    assert build_logs_payload(records, resource) == FIXTURE["payload"]


def test_timestamps_are_int64_strings_and_severity_a_number():
    payload = build_logs_payload(
        [LogRecord("x", "INFO", 9, 1_700_000_060_000_000_000, {})], RESOURCE
    )
    entry = payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]
    assert entry["timeUnixNano"] == "1700000060000000000"
    assert entry["observedTimeUnixNano"] == "1700000060000000000"
    assert entry["severityNumber"] == 9


def test_attribute_values_keep_their_type_and_order():
    encoded = otlp_attributes({"text": "a", "flag": True, "count": 2})
    assert [e["key"] for e in encoded] == ["count", "flag", "text"]
    by_key = {e["key"]: e["value"] for e in encoded}
    assert by_key == {
        "text": {"stringValue": "a"},
        "flag": {"boolValue": True},
        "count": {"doubleValue": 2.0},
    }


def test_resource_carries_the_deployment_id_and_omits_what_is_unknown():
    full = OtlpResource(
        service_name="switch-decision",
        service_version="0.1.0",
        environment="pilot",
        deployment_id=DEPLOYMENT_ID,
        instance_id="decision-0-abcd1234",
    ).attributes()
    assert full == {
        "service.name": "switch-decision",
        "switch_trust.client_id": DEPLOYMENT_ID,
        "service.version": "0.1.0",
        "service.instance.id": "decision-0-abcd1234",
        "deployment.environment": "pilot",
    }
    bare = OtlpResource("switch-decision", None, None, DEPLOYMENT_ID, None)
    assert set(bare.attributes()) == {"service.name", "switch_trust.client_id"}
    scope = build_logs_payload([], bare)["resourceLogs"][0]["scopeLogs"][0]["scope"]
    assert scope == {"name": "switch-decision"}


def _client(handler, headers=None) -> OtlpClient:
    return OtlpClient(
        base_endpoint="https://collector.example",
        timeout_seconds=1.0,
        headers=headers or {},
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_signal_url_follows_the_otlp_base_convention():
    assert _client(None).url_for("logs") == "https://collector.example/v1/logs"
    trailing = OtlpClient("https://collector.example/", 1.0, {}, httpx.AsyncClient())
    assert trailing.url_for("logs") == "https://collector.example/v1/logs"


def test_post_sends_headers_and_body():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("dd-api-key")
        seen["agent"] = request.headers.get("user-agent")
        seen["type"] = request.headers.get("content-type")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"partialSuccess": {}})

    asyncio.run(
        _client(handler, {"dd-api-key": "placeholder"}).post(
            "logs", {"resourceLogs": []}
        )
    )
    assert seen == {
        "url": "https://collector.example/v1/logs",
        "auth": "placeholder",
        "agent": "switch-decision",
        "type": "application/json",
        "body": {"resourceLogs": []},
    }


@pytest.mark.parametrize(
    ("handler", "match"),
    [
        (lambda r: httpx.Response(503, text="unavailable"), "503"),
        (
            lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")),
            "failed",
        ),
        (
            lambda r: httpx.Response(
                200,
                json={
                    "partialSuccess": {
                        "rejectedLogRecords": "2",
                        "errorMessage": "too big",
                    }
                },
            ),
            "rejected 2 record",
        ),
    ],
    ids=["http-error", "network", "partial-rejection"],
)
def test_a_failed_post_raises(handler, match):
    with pytest.raises(OtlpSendError, match=match):
        asyncio.run(_client(handler).post("logs", {}))


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json={"partialSuccess": {}}),
        httpx.Response(200, text="OK"),
        httpx.Response(200, json={"partialSuccess": {"rejectedLogRecords": "0"}}),
    ],
)
def test_a_successful_post_does_not_raise(response):
    asyncio.run(_client(lambda r: response).post("logs", {}))


# ── handler ────────────────────────────────────────────────────────────────


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
    assert severity_of(level) == (number, text)


def test_a_record_becomes_a_formatted_body_with_its_request_id():
    handler = OtlpLogHandler(capacity=10)
    handler.addFilter(RequestIdFilter())
    token = bind_request_id("req-1")
    try:
        handler.handle(_record(args=("world",)))
    finally:
        unbind_request_id(token)
    batch, dropped = handler.take(10)
    assert dropped == 0
    assert batch[0].body == "hello world"
    assert batch[0].severity_text == "INFO"
    assert dict(batch[0].attributes) == {
        "logger.name": "switch_decision",
        "logger.thread_name": "MainThread",
        "request_id": "req-1",
    }


def test_an_exception_becomes_error_attributes():
    handler = OtlpLogHandler(capacity=10)
    try:
        raise ValueError("it broke")
    except ValueError:
        handler.emit(_record(level=logging.ERROR, exc_info=sys.exc_info()))
    attributes = handler.take(10)[0][0].attributes
    assert attributes["error.kind"] == "ValueError"
    assert attributes["error.message"] == "it broke"
    assert "ValueError: it broke" in str(attributes["error.stack"])


def test_the_exporters_own_records_are_never_shipped():
    handler = OtlpLogHandler(capacity=10)
    handler.emit(_record(name="switch_decision.otlp_logs", message="failed"))
    handler.emit(_record(name="switch_decision.otlp_logs.x", message="failed"))
    handler.emit(_record(name="switch_decision.otlp_logs_extra", message="kept"))
    handler.emit(_record(name="switch_decision", message="kept too"))
    assert [e.body for e in handler.take(10)[0]] == ["kept", "kept too"]


def test_records_logged_during_an_export_are_not_queued():
    handler = OtlpLogHandler(capacity=10)
    with exporting_window():
        handler.emit(_record(name="httpcore.connection", message="connect_tcp"))
    handler.emit(_record(name="httpcore.connection", message="a real request"))
    assert [e.body for e in handler.take(10)[0]] == ["a real request"]


def test_a_full_queue_drops_the_oldest_and_counts_it():
    handler = OtlpLogHandler(capacity=3)
    for index in range(5):
        handler.emit(_record(message="line %d", args=(index,)))
    batch, dropped = handler.take(10)
    assert [e.body for e in batch] == ["line 2", "line 3", "line 4"]
    assert dropped == 2
    assert handler.take(10)[1] == 0


def test_take_is_bounded_by_the_batch_size():
    handler = OtlpLogHandler(capacity=100)
    for index in range(10):
        handler.emit(_record(message="line %d", args=(index,)))
    assert len(handler.take(4)[0]) == 4
    assert handler.pending() == 6


# ── exporter ───────────────────────────────────────────────────────────────


class _Client:
    def __init__(self, fail: bool = False, delay: float = 0.0) -> None:
        self.posted: list[tuple[str, dict]] = []
        self._fail = fail
        self._delay = delay

    async def post(self, signal: str, payload: dict) -> None:
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail:
            raise OtlpSendError("collector is down")
        self.posted.append((signal, payload))


def _filled(count: int, capacity: int = 5000) -> OtlpLogHandler:
    handler = OtlpLogHandler(capacity=capacity)
    for index in range(count):
        handler.emit(_record(message="line %d", args=(index,)))
    return handler


def test_a_flush_posts_the_batch_as_logs():
    client = _Client()
    asyncio.run(LogExporter(_filled(2), client, RESOURCE, 1.0, 500).flush_once())
    signal, payload = client.posted[0]
    records = payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
    assert signal == "logs"
    assert [r["body"]["stringValue"] for r in records] == ["line 0", "line 1"]


def test_an_empty_queue_posts_nothing():
    client = _Client()
    asyncio.run(LogExporter(_filled(0), client, RESOURCE, 1.0, 500).flush_once())
    assert client.posted == []


def test_a_failed_post_is_reported_and_does_not_raise(caplog):
    exporter = LogExporter(_filled(1), _Client(fail=True), RESOURCE, 1.0, 500)
    with caplog.at_level(logging.WARNING):
        asyncio.run(exporter.flush_once())
    assert "Log export failed, dropping 1 record" in caplog.text


def test_dropped_records_are_reported_at_error(caplog):
    exporter = LogExporter(_filled(2, capacity=1), _Client(), RESOURCE, 1.0, 500)
    with caplog.at_level(logging.ERROR):
        asyncio.run(exporter.flush_once())
    assert "Dropped 1 log record" in caplog.text


def test_shutdown_drains_the_whole_queue():
    handler, client = _filled(1200), _Client()
    asyncio.run(LogExporter(handler, client, RESOURCE, 1.0, 500).flush_on_shutdown())
    shipped = sum(
        len(p["resourceLogs"][0]["scopeLogs"][0]["logRecords"])
        for _, p in client.posted
    )
    assert shipped == 1200 and handler.pending() == 0


def test_a_dead_collector_at_shutdown_reports_every_lost_record(caplog):
    handler = _filled(1200)
    exporter = LogExporter(handler, _Client(fail=True), RESOURCE, 1.0, 500)
    with caplog.at_level(logging.ERROR):
        asyncio.run(exporter.flush_on_shutdown())
    assert handler.pending() == 700
    assert "1200 log record(s) never exported" in caplog.text


def test_shutdown_is_bounded_by_a_hanging_collector(caplog, monkeypatch):
    monkeypatch.setattr(otlp_logs, "SHUTDOWN_FLUSH_SECONDS", 0.05)

    async def cancel_while_hanging() -> None:
        exporter = LogExporter(_filled(1), _Client(delay=30), RESOURCE, 30.0, 500)
        task = asyncio.create_task(exporter.run_forever())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    started = time.monotonic()
    with caplog.at_level(logging.ERROR):
        asyncio.run(cancel_while_hanging())
    assert time.monotonic() - started < 1.0
    assert "never exported" in caplog.text


# ── settings ───────────────────────────────────────────────────────────────

OTLP_VARS = (
    "OTLP_ENDPOINT",
    "OTLP_LOGS_ENABLED",
    "OTLP_HEADERS",
    "OTLP_TIMEOUT_SECONDS",
    "DEPLOYMENT_ID",
)


@pytest.fixture
def otlp_env(monkeypatch):
    for name in OTLP_VARS:
        monkeypatch.delenv(name, raising=False)

    def set_env(**values: str) -> None:
        for name, value in values.items():
            monkeypatch.setenv(name, value)

    return set_env


def test_nothing_is_shipped_by_default(otlp_env):
    settings = load_otlp_settings()
    assert settings == OtlpLogSettings(
        endpoint=None,
        logs_enabled=False,
        headers={},
        timeout_seconds=10.0,
        deployment_id=None,
    )
    assert not settings.shipping


def test_shipping_needs_the_endpoint_and_the_flag(otlp_env):
    otlp_env(
        OTLP_ENDPOINT="https://collector.example",
        OTLP_LOGS_ENABLED="true",
        DEPLOYMENT_ID=DEPLOYMENT_ID,
        OTLP_HEADERS="dd-api-key=placeholder, x-other = 1",
        OTLP_TIMEOUT_SECONDS="3",
    )
    settings = load_otlp_settings()
    assert settings.shipping
    assert settings.headers == {"dd-api-key": "placeholder", "x-other": "1"}
    assert settings.timeout_seconds == 3.0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("true", True), ("1", True), ("YES", True), ("false", False), ("0", False)],
)
def test_the_flag_is_read_as_switch_core_reads_it(otlp_env, raw, expected):
    otlp_env(OTLP_LOGS_ENABLED=raw)
    assert load_otlp_settings().logs_enabled is expected


def test_metrics_only_settings_need_no_deployment_id(otlp_env):
    otlp_env(OTLP_ENDPOINT="https://collector.example", OTLP_LOGS_ENABLED="false")
    assert not load_otlp_settings().shipping


@pytest.mark.parametrize(
    ("values", "match"),
    [
        ({"OTLP_LOGS_ENABLED": "sometimes"}, "OTLP_LOGS_ENABLED"),
        ({"OTLP_ENDPOINT": "collector.example"}, "http"),
        ({"OTLP_ENDPOINT": "https://collector.example/v1/logs"}, "no path"),
        ({"OTLP_ENDPOINT": "https://collector.example?key=x"}, "query"),
        ({"OTLP_ENDPOINT": "https://collector.example "}, "whitespace"),
        (
            {"OTLP_ENDPOINT": "https://collector.example", "OTLP_HEADERS": "novalue"},
            "key=value",
        ),
        (
            {"OTLP_ENDPOINT": "https://collector.example", "OTLP_TIMEOUT_SECONDS": "0"},
            "greater than 0",
        ),
        (
            {"OTLP_ENDPOINT": "https://collector.example", "OTLP_LOGS_ENABLED": "1"},
            "DEPLOYMENT_ID must be set",
        ),
        ({"DEPLOYMENT_ID": "deployment-1"}, "UUID"),
    ],
    ids=[
        "bad-flag",
        "no-scheme",
        "path",
        "query",
        "whitespace",
        "bad-header",
        "zero-timeout",
        "no-deployment-id",
        "bad-deployment-id",
    ],
)
def test_a_bad_setting_refuses_to_start(otlp_env, values, match):
    otlp_env(**values)
    with pytest.raises(ValueError, match=match):
        load_otlp_settings()


# ── the running service ────────────────────────────────────────────────────


def _shipping_to(url: str) -> OtlpLogSettings:
    return OtlpLogSettings(
        endpoint=url,
        logs_enabled=True,
        headers={"dd-api-key": "placeholder"},
        timeout_seconds=5.0,
        deployment_id=DEPLOYMENT_ID,
    )


@contextmanager
def _service(monkeypatch, otlp: OtlpLogSettings, handler=None):
    monkeypatch.setattr(app_module, "settings", settings_for())
    monkeypatch.setattr(app_module, "otlp_settings", otlp)
    with TestClient(app_module.app) as tc:
        monkeypatch.setattr(
            app_module,
            "client",
            httpx.AsyncClient(
                transport=httpx.MockTransport(
                    handler or (lambda r: httpx.Response(200, json=logprobs("A")))
                )
            ),
        )
        yield tc


def _otlp_handlers() -> list[logging.Handler]:
    return [h for h in logging.getLogger().handlers if isinstance(h, OtlpLogHandler)]


def test_decide_lines_reach_the_collector_with_their_request_id(monkeypatch, collector):
    with _service(monkeypatch, _shipping_to(collector.url)) as tc:
        assert len(_otlp_handlers()) == 1
        r = tc.post("/decide", json=BODY, headers={"X-Request-Id": "decision-0001"})
        assert r.status_code == 200
    assert _otlp_handlers() == []

    decide = [
        r for r in collector.records() if r["body"]["stringValue"].startswith("decide ")
    ]
    assert len(decide) == 1
    attributes = {a["key"]: a["value"] for a in decide[0]["attributes"]}
    assert attributes["request_id"] == {"stringValue": "decision-0001"}
    assert decide[0]["severityText"] == "INFO"

    resource = {
        a["key"]: a["value"]["stringValue"]
        for a in collector.posts[0]["resourceLogs"][0]["resource"]["attributes"]
    }
    assert resource["service.name"] == app_module.log_settings.service_name
    assert resource["switch_trust.client_id"] == DEPLOYMENT_ID
    assert resource["service.instance.id"] == app_module.process_id
    assert collector.headers[0]["dd-api-key"] == "placeholder"
    assert collector.headers[0]["User-Agent"] == "switch-decision"

    shipped = json.dumps(collector.posts)
    for secret in SECRETS:
        assert secret not in shipped
    assert "switch_decision.otlp_logs" not in shipped


def test_a_failing_collector_does_not_slow_decide(monkeypatch, collector, json_log):
    collector.mode = "fail"
    monkeypatch.setattr(otlp_logs, "EXPORT_INTERVAL_SECONDS", 0.02)
    with _service(monkeypatch, _shipping_to(collector.url)) as tc:
        started = time.monotonic()
        for _ in range(10):
            assert tc.post("/decide", json=BODY).status_code == 200
            time.sleep(0.03)
        assert time.monotonic() - started < 3.0
    assert "Log export failed" in json_log.text()


def test_a_hanging_collector_does_not_block_decide_or_shutdown(
    monkeypatch, collector, json_log
):
    collector.mode = "hang"
    monkeypatch.setattr(otlp_logs, "EXPORT_INTERVAL_SECONDS", 0.02)
    monkeypatch.setattr(otlp_logs, "SHUTDOWN_FLUSH_SECONDS", 0.2)
    started = time.monotonic()
    with _service(monkeypatch, _shipping_to(collector.url)) as tc:
        for _ in range(10):
            request_started = time.monotonic()
            assert tc.post("/decide", json=BODY).status_code == 200
            assert time.monotonic() - request_started < 1.0
    assert time.monotonic() - started < 3.0
    assert "never exported" in json_log.text()


def test_without_an_endpoint_nothing_is_shipped_or_said(monkeypatch, json_log):
    otlp = OtlpLogSettings(
        endpoint=None,
        logs_enabled=False,
        headers={},
        timeout_seconds=10.0,
        deployment_id=None,
    )
    with _service(monkeypatch, otlp) as tc:
        assert _otlp_handlers() == []
        assert tc.post("/decide", json=BODY).status_code == 200
    lines = json_log.lines()
    assert any(line["message"].startswith("decide ") for line in lines)
    for line in lines:
        assert line["logger"]["name"] != "switch_decision.otlp_logs"
        assert "export" not in line["message"].lower()
        assert "otlp" not in line["message"].lower()


def test_an_endpoint_with_logs_off_sends_nothing(monkeypatch, collector):
    otlp = OtlpLogSettings(
        endpoint=collector.url,
        logs_enabled=False,
        headers={},
        timeout_seconds=10.0,
        deployment_id=None,
    )
    with _service(monkeypatch, otlp) as tc:
        assert _otlp_handlers() == []
        assert tc.post("/decide", json=BODY).status_code == 200
    assert collector.posts == []

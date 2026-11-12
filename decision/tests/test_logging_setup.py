"""The service's log lines: switch-core's JSON layout, the request id, the
access log filter, and what is never written."""

import io
import json
import logging
import re
import sys
from types import SimpleNamespace

import httpx
import pytest

from switch_decision import backends
from switch_decision.logging_setup import (
    AccessLogFilter,
    JsonFormatter,
    LogSettings,
    RequestIdFilter,
    TextFormatter,
    adopt_uvicorn_loggers,
    bind_request_id,
    build_handler,
    configure_logging,
    load_log_settings,
    new_process_id,
    request_id_from_header,
    unbind_request_id,
)
from tests.conftest import PROCESS_ID
from tests.helpers import ANTHROPIC_KEY, BODY, SECRETS, logprobs, settings_for

TIMESTAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00")
GENERATED_ID = re.compile(r"[0-9a-f]{32}")


def _record(
    message: str = "hello %s",
    args: tuple = ("world",),
    name: str = "switch_decision",
    level: int = logging.INFO,
    exc_info=None,
) -> logging.LogRecord:
    return logging.LogRecord(name, level, __file__, 1, message, args, exc_info)


def _json_formatter(environment: str | None, version: str | None) -> JsonFormatter:
    return JsonFormatter(
        service="switch-decision",
        environment=environment,
        version=version,
        process_id=PROCESS_ID,
    )


def _stamped(record: logging.LogRecord) -> logging.LogRecord:
    RequestIdFilter().filter(record)
    return record


# ── settings ───────────────────────────────────────────────────────────────


def test_defaults_match_switch_core(monkeypatch):
    for name in ("LOG_FORMAT", "LOG_LEVEL", "SERVICE_NAME", "ENVIRONMENT", "POD_NAME"):
        monkeypatch.delenv(name, raising=False)
    assert load_log_settings() == LogSettings(
        log_format="text",
        log_level="INFO",
        service_name="switch-decision",
        environment=None,
        pod_name=None,
    )


def test_settings_are_read_from_the_same_variables(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "warning")
    monkeypatch.setenv("SERVICE_NAME", "decision-eu")
    monkeypatch.setenv("ENVIRONMENT", "pilot")
    monkeypatch.setenv("POD_NAME", "switch-decision-7d9f")
    assert load_log_settings() == LogSettings(
        log_format="json",
        log_level="WARNING",
        service_name="decision-eu",
        environment="pilot",
        pod_name="switch-decision-7d9f",
    )


@pytest.mark.parametrize(
    ("name", "value"), [("LOG_FORMAT", "logfmt"), ("LOG_LEVEL", "LOUD")]
)
def test_a_bad_setting_refuses_to_start(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        load_log_settings()


def test_process_id_is_the_pod_and_a_suffix_per_start():
    first, second = new_process_id("decision-0"), new_process_id("decision-0")
    assert re.fullmatch(r"decision-0-[0-9a-f]{8}", first)
    assert first != second


def test_process_id_falls_back_to_the_host_name(monkeypatch):
    monkeypatch.setattr("socket.gethostname", lambda: "laptop")
    assert re.fullmatch(r"laptop-[0-9a-f]{8}", new_process_id(None))


# ── JSON layout ────────────────────────────────────────────────────────────


def test_json_line_has_switch_cores_fields():
    token = bind_request_id("req-123")
    try:
        record = _stamped(_record())
    finally:
        unbind_request_id(token)
    line = json.loads(_json_formatter("pilot", "0.1.0").format(record))
    assert set(line) == {
        "timestamp",
        "status",
        "message",
        "logger",
        "service",
        "process_id",
        "env",
        "version",
        "request_id",
    }
    assert TIMESTAMP.fullmatch(line["timestamp"])
    assert line["status"] == "info"
    assert line["message"] == "hello world"
    assert line["logger"] == {"name": "switch_decision", "thread_name": "MainThread"}
    assert line["service"] == "switch-decision"
    assert line["process_id"] == PROCESS_ID
    assert line["env"] == "pilot"
    assert line["version"] == "0.1.0"
    assert line["request_id"] == "req-123"


def test_unset_environment_version_and_request_id_are_omitted():
    line = json.loads(_json_formatter(None, None).format(_stamped(_record())))
    assert "env" not in line and "version" not in line and "request_id" not in line


def test_an_exception_becomes_the_error_object():
    try:
        raise ValueError("it broke")
    except ValueError:
        record = _stamped(_record(level=logging.ERROR, exc_info=sys.exc_info()))
    error = json.loads(_json_formatter(None, None).format(record))["error"]
    assert error["kind"] == "ValueError"
    assert error["message"] == "it broke"
    assert "ValueError: it broke" in error["stack"]


def test_text_line_names_the_process_and_request():
    token = bind_request_id("req-9")
    try:
        record = _stamped(_record())
    finally:
        unbind_request_id(token)
    line = TextFormatter(PROCESS_ID).format(record)
    assert f"[process_id={PROCESS_ID} request_id=req-9]" in line
    assert line.endswith("hello world")


# ── request id ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value",
    ["3f2b9c1d-8e7a-4b6c-9d0e-1f2a3b4c5d6e", "abc123", "trace:1.2_x", "a" * 128],
)
def test_a_well_formed_request_id_is_kept(value):
    assert request_id_from_header(value) == value


@pytest.mark.parametrize(
    "value",
    [None, "", "a" * 129, "has space", "new\nline", 'quote"d', "ünï", "a/b"],
)
def test_a_missing_or_malformed_request_id_is_replaced(value):
    assert GENERATED_ID.fullmatch(request_id_from_header(value))


def test_the_header_id_is_on_the_decide_line(make_client, json_log):
    tc = make_client()
    r = tc.post("/decide", json=BODY, headers={"X-Request-Id": "decision-0001"})
    assert r.status_code == 200
    assert r.headers["x-request-id"] == "decision-0001"
    decide = [
        line for line in json_log.lines() if line["message"].startswith("decide ")
    ]
    assert len(decide) == 1
    assert decide[0]["request_id"] == "decision-0001"
    assert decide[0]["logger"]["name"] == "switch_decision"
    assert decide[0]["process_id"] == PROCESS_ID


def test_a_request_without_the_header_gets_a_generated_id(make_client, json_log):
    r = make_client().post("/decide", json=BODY)
    generated = r.headers["x-request-id"]
    assert GENERATED_ID.fullmatch(generated)
    decide = [
        line for line in json_log.lines() if line["message"].startswith("decide ")
    ]
    assert decide[0]["request_id"] == generated


def test_a_malformed_header_is_not_written_to_the_log(make_client, json_log):
    r = make_client().post(
        "/decide", json=BODY, headers={"X-Request-Id": 'evil" injected=1'}
    )
    assert GENERATED_ID.fullmatch(r.headers["x-request-id"])
    assert "injected" not in json_log.text()


def test_the_failure_line_carries_the_id_and_kind(make_client, json_log):
    tc = make_client(handler=lambda r: httpx.Response(503, text="Loading model"))
    r = tc.post("/decide", json=BODY, headers={"X-Request-Id": "decision-0002"})
    assert r.status_code == 502
    failed = [line for line in json_log.lines() if "decide failed" in line["message"]]
    assert failed[0]["request_id"] == "decision-0002"
    assert failed[0]["status"] == "warning"
    assert "error_kind=model_unavailable" in failed[0]["message"]


def test_a_refused_token_still_gets_an_id(make_client):
    tc = make_client(settings_for(service_token="placeholder-service-token"))
    r = tc.post("/decide", json=BODY, headers={"X-Request-Id": "decision-0003"})
    assert r.status_code == 401 and r.headers["x-request-id"] == "decision-0003"


def test_ids_do_not_leak_between_requests(make_client, json_log):
    tc = make_client()
    tc.post("/decide", json=BODY, headers={"X-Request-Id": "first"})
    tc.post("/decide", json=BODY)
    ids = [
        line.get("request_id")
        for line in json_log.lines()
        if line["message"].startswith("decide ")
    ]
    assert ids[0] == "first" and ids[1] != "first" and GENERATED_ID.fullmatch(ids[1])


# ── access log ─────────────────────────────────────────────────────────────


def _access(method: str, target: str) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", method, target, "1.1", 200),
        None,
    )


@pytest.mark.parametrize("target", ["/health", "/health?probe=kubelet"])
def test_health_probes_are_dropped(target):
    assert AccessLogFilter().filter(_access("GET", target)) is False


def test_other_requests_are_kept_with_the_query_cut_off():
    record = _access("POST", "/decide?token=placeholder-secret")
    assert AccessLogFilter().filter(record) is True
    assert record.getMessage() == '127.0.0.1:5000 - "POST /decide HTTP/1.1" 200'


def test_only_the_health_path_is_dropped():
    assert AccessLogFilter().filter(_access("GET", "/healthz")) is True
    assert AccessLogFilter().filter(_access("POST", "/health")) is True


def test_uvicorns_loggers_are_routed_through_the_root_handler():
    access = logging.getLogger("uvicorn.access")
    error = logging.getLogger("uvicorn.error")
    saved = [
        (lg, list(lg.handlers), lg.propagate, list(lg.filters))
        for lg in (access, error, logging.getLogger("uvicorn"))
    ]
    try:
        for lg in (access, logging.getLogger("uvicorn")):
            lg.addHandler(logging.StreamHandler(io.StringIO()))
            lg.propagate = False
        adopt_uvicorn_loggers()
        adopt_uvicorn_loggers()
        for lg in (access, error, logging.getLogger("uvicorn")):
            assert lg.handlers == [] and lg.propagate is True
        assert [type(f) for f in access.filters].count(AccessLogFilter) == 1
    finally:
        for lg, handlers, propagate, filters in saved:
            lg.handlers, lg.propagate, lg.filters = handlers, propagate, filters


def test_debug_never_turns_on_libraries_that_log_request_bodies():
    root = logging.getLogger()
    saved = (list(root.handlers), root.level)
    try:
        configure_logging(
            LogSettings(
                log_format="json",
                log_level="DEBUG",
                service_name="switch-decision",
                environment=None,
                pod_name=None,
            ),
            None,
            PROCESS_ID,
        )
        for name in ("anthropic", "botocore", "httpx", "httpcore", "urllib3"):
            assert not logging.getLogger(name).isEnabledFor(logging.INFO), name
        assert logging.getLogger("switch_decision").isEnabledFor(logging.DEBUG)
    finally:
        root.handlers, root.level = saved


def test_build_handler_picks_the_format():
    settings = LogSettings(
        log_format="text",
        log_level="INFO",
        service_name="switch-decision",
        environment=None,
        pod_name=None,
    )
    assert isinstance(
        build_handler(settings, None, PROCESS_ID).formatter, TextFormatter
    )


# ── never logged ───────────────────────────────────────────────────────────


class _FakeAnthropic:
    def __init__(self, agent: str):
        self.messages = self
        self.agent = agent

    async def create(self, **kw):
        block = SimpleNamespace(
            type="tool_use",
            name="pick_speaker",
            input={"reason": "r", "agent": self.agent, "confidence": 0.9},
        )
        return SimpleNamespace(stop_reason="tool_use", content=[block])


@pytest.mark.parametrize(
    ("handler", "agent"),
    [
        (lambda r: httpx.Response(200, json=logprobs("A")), "deploy-bot"),
        (lambda r: httpx.Response(200, json=logprobs("N")), "deploy-bot"),
        (lambda r: httpx.Response(500, text=f"echo: {BODY}"), "deploy-bot"),
        (lambda r: httpx.Response(200, json=logprobs("A")), "ghost-bot"),
    ],
    ids=["picked", "nobody", "backend-error-echoing-the-room", "invalid-choice"],
)
def test_message_text_room_rules_and_keys_never_reach_a_log_line(
    make_client, json_log, caplog, monkeypatch, handler, agent
):
    monkeypatch.setattr(
        backends, "anthropic_client", lambda s, k=None: _FakeAnthropic(agent)
    )
    tc = make_client(handler=handler)
    with caplog.at_level(logging.DEBUG):
        tc.post("/decide", json=BODY)
        tc.post(
            "/decide",
            json=BODY,
            headers={
                "X-Decision-Backend": "anthropic",
                "X-Decision-Anthropic-Key": ANTHROPIC_KEY,
            },
        )
        tc.post("/decide", json={**BODY, "agents": "not-a-list"})
        tc.post("/decide", json=BODY, headers={"X-Decision-Backend": "vertex"})
    written = json_log.text() + "\n".join(
        f"{rec.getMessage()} {rec.args}" for rec in caplog.records
    )
    assert "decide " in written
    for secret in SECRETS:
        assert secret not in written, f"{secret!r} reached a log line"

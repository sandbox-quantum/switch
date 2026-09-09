import asyncio
import json
import logging

import pytest

from switch_core.config import SwitchConfig
from switch_core.logging_config import build_handler
from switch_core.logging_context import (
    CONTEXT_FIELDS,
    LogContextFilter,
    bind_log_context,
    current_log_context,
    log_context,
    unbind_log_context,
)

BASE_ENV = {
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_USER": "postgres",
    "DB_PASSWORD": "secret",
    "DB_NAME": "switch",
    "MATRIX_SERVER_NAME": "switch.local",
    "AGENT_REGISTRATION_TOKEN": "token",
    "JWT_SECRET_KEY": "jwt",
    "GATEWAY_ADMIN_EMAIL": "admin@example.com",
    "GATEWAY_ADMIN_PASSWORD": "pw",
}


def _config(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> SwitchConfig:
    for key in (*BASE_ENV, *overrides, *(k.upper() for k in overrides)):
        monkeypatch.delenv(key, raising=False)
    for key, value in {**BASE_ENV, **overrides}.items():
        monkeypatch.setenv(key.upper(), value)
    return SwitchConfig()  # type: ignore[call-arg]


class _Capture(logging.Handler):
    """Collects formatted lines from the handler under test."""

    def __init__(self, inner: logging.Handler) -> None:
        super().__init__()
        self.lines: list[str] = []
        self._inner = inner
        for filt in inner.filters:
            self.addFilter(filt)
        self.setFormatter(inner.formatter)

    def emit(self, record: logging.LogRecord) -> None:
        formatter = self.formatter
        assert formatter is not None
        self.lines.append(formatter.format(record))


@pytest.fixture
def json_lines(monkeypatch: pytest.MonkeyPatch):
    config = _config(monkeypatch, LOG_FORMAT="json", ENVIRONMENT="pilot")
    capture = _Capture(build_handler(config, "1.2.3"))
    logger = logging.getLogger("switch_core.test.json")
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    logger.handlers = [capture]
    yield logger, capture.lines
    logger.handlers = []


def _one(lines: list[str]) -> dict:
    assert len(lines) == 1
    parsed: dict = json.loads(lines[0])
    return parsed


def test_json_line_carries_tenant_without_anything_binding_it(json_lines) -> None:
    logger, lines = json_lines
    logger.info("hello")

    entry = _one(lines)
    assert entry["tenant_id"] == "default"
    assert entry["status"] == "info"
    assert entry["message"] == "hello"
    assert entry["service"] == "switch-core"
    assert entry["env"] == "pilot"
    assert entry["version"] == "1.2.3"
    assert entry["logger"]["name"] == "switch_core.test.json"
    assert "timestamp" in entry


def test_configured_tenant_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    config = _config(monkeypatch, LOG_FORMAT="json", TENANT_ID="acme")
    capture = _Capture(build_handler(config, None))
    logger = logging.getLogger("switch_core.test.tenant")
    logger.propagate = False
    logger.handlers = [capture]

    logger.warning("careful")

    entry = _one(capture.lines)
    assert entry["tenant_id"] == "acme"
    assert "version" not in entry


def test_bound_context_appears_and_unbinds(json_lines) -> None:
    logger, lines = json_lines

    with log_context(request_id="req-1", agent_id="agent-1"):
        logger.info("inside")
    logger.info("outside")

    inside, outside = (json.loads(line) for line in lines)
    assert inside["request_id"] == "req-1"
    assert inside["agent_id"] == "agent-1"
    assert "request_id" not in outside
    assert "agent_id" not in outside


def test_inner_bind_inherits_outer_fields(json_lines) -> None:
    logger, lines = json_lines

    with log_context(request_id="req-1"):
        with log_context(user_id="user-1"):
            logger.info("nested")

    entry = _one(lines)
    assert entry["request_id"] == "req-1"
    assert entry["user_id"] == "user-1"


def test_context_reaches_a_spawned_task(json_lines) -> None:
    logger, lines = json_lines

    async def scenario() -> None:
        with log_context(request_id="req-1"):
            await asyncio.gather(asyncio.create_task(_log_in_task(logger)))

    asyncio.run(scenario())

    assert _one(lines)["request_id"] == "req-1"


async def _log_in_task(logger: logging.Logger) -> None:
    logger.info("from a task")


def test_exception_is_rendered_as_error_fields(json_lines) -> None:
    logger, lines = json_lines

    try:
        raise RuntimeError("boom")
    except RuntimeError:
        logger.exception("failed")

    entry = _one(lines)
    assert entry["error"]["kind"] == "RuntimeError"
    assert entry["error"]["message"] == "boom"
    assert "RuntimeError: boom" in entry["error"]["stack"]


def test_unserialisable_value_does_not_lose_the_line(json_lines) -> None:
    logger, lines = json_lines

    logger.info("value=%s", object())

    assert "value=<object object at" in _one(lines)["message"]


def test_text_format_shows_the_context(monkeypatch: pytest.MonkeyPatch) -> None:
    config = _config(monkeypatch, LOG_FORMAT="text")
    capture = _Capture(build_handler(config, "1.2.3"))
    logger = logging.getLogger("switch_core.test.text")
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    logger.handlers = [capture]

    with log_context(request_id="req-1"):
        logger.info("hello")
    logger.info("plain")

    with_context, without = capture.lines
    assert "[tenant_id=default request_id=req-1] hello" in with_context
    assert "[tenant_id=default] plain" in without


def test_a_third_party_logger_gets_the_same_fields(monkeypatch: pytest.MonkeyPatch):
    """The filter is on the handler, so library records carry the fields too."""
    config = _config(monkeypatch, LOG_FORMAT="json")
    capture = _Capture(build_handler(config, None))
    logger = logging.getLogger("uvicorn.access")
    logger.propagate = False
    logger.handlers = [capture]

    with log_context(request_id="req-1"):
        logger.warning("GET /health 200")

    entry = _one(capture.lines)
    assert entry["tenant_id"] == "default"
    assert entry["request_id"] == "req-1"

    logger.handlers = []


def test_binding_an_unknown_field_is_an_error() -> None:
    with pytest.raises(ValueError, match="Unknown log context field"):
        bind_log_context(room_id="room-1")  # type: ignore[call-arg]


def test_unbind_restores_the_previous_context() -> None:
    token = bind_log_context(request_id="req-1")
    assert current_log_context().request_id == "req-1"
    unbind_log_context(token)
    assert current_log_context().request_id is None


def test_a_record_that_missed_the_filter_still_formats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A formatter must not raise on a record from a handler without the filter."""
    config = _config(monkeypatch, LOG_FORMAT="json")
    handler = build_handler(config, None)
    formatter = handler.formatter
    assert formatter is not None
    record = logging.LogRecord(
        "x", logging.INFO, __file__, 1, "bare", args=(), exc_info=None
    )

    entry = json.loads(formatter.format(record))

    assert not set(CONTEXT_FIELDS) & set(entry)


def test_filter_stamps_every_field(monkeypatch: pytest.MonkeyPatch) -> None:
    record = logging.LogRecord(
        "x", logging.INFO, __file__, 1, "m", args=(), exc_info=None
    )

    with log_context(request_id="r", agent_id="a", user_id="u"):
        LogContextFilter("acme").filter(record)

    assert record.tenant_id == "acme"
    assert record.request_id == "r"
    assert record.agent_id == "a"
    assert record.user_id == "u"


def test_bound_tenant_beats_the_deployment_default() -> None:
    """Phase 1 binds a real tenant per request; the default is only a fallback."""
    record = logging.LogRecord(
        "x", logging.INFO, __file__, 1, "m", args=(), exc_info=None
    )

    with log_context(tenant_id="tenant-b"):
        LogContextFilter("default").filter(record)

    assert record.tenant_id == "tenant-b"

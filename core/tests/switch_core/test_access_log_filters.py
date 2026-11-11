"""The filters that keep routine polling and WebSocket chatter out of the logs.

On pilot, successful polls and per-connection WebSocket lines were most of the
1.3M lines a day switch-core wrote. Failures on the same routes still log.
"""

from __future__ import annotations

import logging

import pytest

from switch_core.logging_config import RoutineAccessFilter, WebSocketChatterFilter


def _access(method: str, target: str, status: int) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("10.0.1.43:56148", method, target, "1.1", status),
        None,
    )


CONTROLLER = "c7532777-28b2-4c22-ae30-e80283ea82d0"


@pytest.mark.parametrize(
    ("method", "target", "status"),
    [
        ("GET", "/health", 200),
        ("GET", "/health/ready", 200),
        ("PUT", f"/v1/management/controllers/{CONTROLLER}/status", 200),
        ("GET", f"/v1/management/controllers/{CONTROLLER}/assignment", 304),
        ("GET", f"/v1/management/controllers/{CONTROLLER}/operations", 200),
        ("GET", "/gateway/management/controllers", 200),
        ("GET", "/gateway/management/agents", 200),
        ("GET", "/gateway/hosted-controller/machines", 200),
        ("POST", f"/gateway/hosted-controller/machines/{CONTROLLER}/observation", 200),
        ("POST", f"/agent-sessions/{CONTROLLER}/activity", 200),
        ("GET", "/agent-sessions/approvals/outcomes?since=1", 200),
        ("GET", "/gateway/rooms/r1/events?timeout=30", 200),
    ],
)
def test_successful_routine_polls_are_dropped(method: str, target: str, status: int):
    assert RoutineAccessFilter().filter(_access(method, target, status)) is False


@pytest.mark.parametrize(
    ("method", "target", "status"),
    [
        # The same polls failing are what someone needs to see.
        ("PUT", f"/v1/management/controllers/{CONTROLLER}/status", 500),
        ("GET", f"/v1/management/controllers/{CONTROLLER}/assignment", 401),
        ("GET", "/health/ready", 503),
        ("GET", "/gateway/management/agents", 403),
        ("GET", "/agents/a1/events?timeout=30", 500),
        ("GET", "/gateway/rooms/r1/room-history?limit=50", 502),
        # Anything not on the list, successful or not.
        ("POST", f"/v1/controllers/{CONTROLLER}/connection", 201),
        ("GET", "/gateway/rooms", 200),
        ("POST", "/v1/management/controllers/enroll", 422),
        ("GET", "/healthz-but-not-really", 200),
    ],
)
def test_failures_and_everything_else_still_log(method: str, target: str, status: int):
    assert RoutineAccessFilter().filter(_access(method, target, status)) is True


def test_a_record_not_shaped_like_an_access_line_passes():
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, "hello", None, None
    )
    assert RoutineAccessFilter().filter(record) is True


def _uvicorn_error(message: str, level: int = logging.INFO) -> logging.LogRecord:
    return logging.LogRecord("uvicorn.error", level, __file__, 1, message, None, None)


@pytest.mark.parametrize(
    "message",
    [
        "connection open",
        "connection closed",
        '10.0.1.43:51234 - "WebSocket /v1/controllers/abc/connection/ws?generation=3" [accepted]',
    ],
)
def test_websocket_chatter_is_kept_to_debug(message: str):
    logger = logging.getLogger("uvicorn.error")
    previous = logger.level
    try:
        logger.setLevel(logging.INFO)
        assert WebSocketChatterFilter().filter(_uvicorn_error(message)) is False
        logger.setLevel(logging.DEBUG)
        assert WebSocketChatterFilter().filter(_uvicorn_error(message)) is True
    finally:
        logger.setLevel(previous)


def test_other_uvicorn_lines_pass():
    logger = logging.getLogger("uvicorn.error")
    previous = logger.level
    try:
        logger.setLevel(logging.INFO)
        assert WebSocketChatterFilter().filter(
            _uvicorn_error("Started server process [1]")
        )
        assert WebSocketChatterFilter().filter(
            _uvicorn_error("Exception in ASGI application", logging.ERROR)
        )
        # The same words at a level other than INFO are not uvicorn's chatter.
        assert WebSocketChatterFilter().filter(
            _uvicorn_error("connection closed", logging.WARNING)
        )
    finally:
        logger.setLevel(previous)

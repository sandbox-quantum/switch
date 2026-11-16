"""Unhandled exceptions are counted and named, and the agent bridge's
HTTP error line names the route template, never the path or the detail."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, HTTPException, WebSocket
from starlette.testclient import TestClient

from switch_core.bridges.agent.app import log_http_exceptions
from switch_core.logging_context import STRUCTURED_FIELDS
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.runtime_errors import (
    EVENT,
    UnhandledExceptionMiddleware,
    exception_type,
    install_task_exception_counter,
    record_unhandled,
)

CANARY = "CANARY-runtime-do-not-export"


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _counted(registry: MetricsRegistry) -> dict[tuple[str, str], float]:
    return {
        (str(dict(p.attributes)["component"]), str(dict(p.attributes)["type"])): p.value
        for payload in registry.collect()
        if payload.name == "switch.runtime.unhandled_exceptions"
        for p in payload.numbers
    }


class Broken(RuntimeError):
    pass


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/things/{thing_id}")
    async def thing(thing_id: str) -> dict[str, str]:
        raise Broken(f"{CANARY} {thing_id}")

    @app.get("/refused/{thing_id}")
    async def refused(thing_id: str) -> dict[str, str]:
        raise HTTPException(404, f"{CANARY} {thing_id}")

    @app.websocket("/socket/{thing_id}")
    async def socket(websocket: WebSocket, thing_id: str) -> None:
        await websocket.accept()
        raise Broken(CANARY)

    app.add_middleware(UnhandledExceptionMiddleware)
    return app


async def test_an_exception_escaping_a_request_is_counted_and_named(
    registry: MetricsRegistry, caplog: pytest.LogCaptureFixture
) -> None:
    transport = httpx.ASGITransport(app=_app(), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://x") as client:
        with caplog.at_level(logging.WARNING, logger="switch_core.runtime"):
            answer = await client.get(f"/things/{CANARY}-id")
    assert answer.status_code == 500
    assert _counted(registry) == {("http", "RuntimeError"): 1.0}
    [line] = [r for r in caplog.records if r.name == "switch_core.runtime"]
    groups = getattr(line, STRUCTURED_FIELDS)
    # Never `event.name` or `event_type`, which some pipelines treat as product events.
    assert set(groups) == {"switch"}
    fields = groups["switch"]
    assert fields == {
        "event": EVENT,
        "component": "http",
        "type": "RuntimeError",
        "route": "/things/{thing_id}",
    }
    # Neither the path nor the exception's text, and no stack of its own.
    assert CANARY not in line.getMessage() and line.exc_info is None


async def test_a_handled_http_error_is_not_counted(registry: MetricsRegistry) -> None:
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://x") as client:
        answer = await client.get("/refused/x")
    assert answer.status_code == 404
    assert _counted(registry) == {}


def test_an_exception_escaping_a_websocket_is_counted(
    registry: MetricsRegistry,
) -> None:
    with TestClient(_app()) as client, pytest.raises(Broken):
        with client.websocket_connect("/socket/x") as socket:
            socket.receive_text()
    assert _counted(registry) == {("websocket", "RuntimeError"): 1.0}


def test_the_type_is_the_nearest_common_class_or_other(
    registry: MetricsRegistry,
) -> None:
    """A fixed list, so a dependency's own classes can't grow the series."""
    from sqlalchemy.exc import IntegrityError

    class DependencyTimeout(TimeoutError):
        pass

    odd = type(CANARY, (Exception,), {})
    assert exception_type(DependencyTimeout()) == "TimeoutError"
    assert exception_type(IntegrityError("x", {}, Exception())) == "IntegrityError"
    assert exception_type(HTTPException(500)) == "HTTPException"
    assert exception_type(odd()) == "other"
    record_unhandled("somewhere", odd())
    assert _counted(registry) == {("other", "other"): 1.0}


async def test_a_task_exception_nobody_retrieved_is_counted_and_still_reported(
    registry: MetricsRegistry,
) -> None:
    loop = asyncio.get_running_loop()
    before = loop.get_exception_handler()
    seen: list[dict[str, Any]] = []
    loop.set_exception_handler(lambda _loop, context: seen.append(context))
    try:
        install_task_exception_counter(loop)
        loop.call_exception_handler(
            {"message": "Task exception was never retrieved", "exception": Broken()}
        )
        loop.call_exception_handler({"message": "no exception here"})
    finally:
        loop.set_exception_handler(before)
    assert _counted(registry) == {("task", "RuntimeError"): 1.0}
    # The handler before it still gets both reports, unchanged.
    assert [c["message"] for c in seen] == [
        "Task exception was never retrieved",
        "no exception here",
    ]


async def test_the_agent_bridges_http_error_line_names_the_route_not_the_path(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The route template and the status, never the raw path (ids, what
    the caller typed) or the error's detail."""
    app = FastAPI()

    @app.get("/agents/{agent_id}/things")
    async def things(agent_id: str) -> dict[str, str]:
        raise HTTPException(404, f"{CANARY} detail")

    app.add_exception_handler(HTTPException, log_http_exceptions)  # type: ignore[arg-type]
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://x") as client:
        with caplog.at_level(logging.INFO):
            answer = await client.get(f"/agents/{CANARY}-agent/things")
    assert answer.status_code == 404
    assert answer.json() == {"detail": f"{CANARY} detail"}  # the caller still gets it
    [line] = [r for r in caplog.records if "→ 404" in r.getMessage()]
    assert line.getMessage() == "GET /agents/{agent_id}/things → 404"
    assert CANARY not in line.getMessage()


def _uvicorn_like(app: Any) -> Any:
    """Logs as uvicorn does when an exception escapes the app: the one ERROR
    line, with its stack, that the log alerts count."""
    server_logger = logging.getLogger("uvicorn.error")

    async def wrapped(scope: Any, receive: Any, send: Any) -> None:
        try:
            await app(scope, receive, send)
        except Exception:
            server_logger.exception("Exception in ASGI application")
            raise

    return wrapped


async def test_one_unhandled_exception_is_one_error_line(
    registry: MetricsRegistry,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The server's own ERROR line stays the only one, so an error-count alert
    counts each exception once; ours is a WARNING beside it."""
    # A `uvicorn.Config` built earlier in the run (as the signal tests build
    # one) stops the `uvicorn` logger propagating, which would hide the
    # server's line from caplog.
    monkeypatch.setattr(logging.getLogger("uvicorn"), "propagate", True)
    transport = httpx.ASGITransport(
        app=_uvicorn_like(_app()), raise_app_exceptions=False
    )
    async with httpx.AsyncClient(transport=transport, base_url="http://x") as client:
        with caplog.at_level(logging.DEBUG):
            await client.get("/things/one")
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert [r.getMessage() for r in errors] == ["Exception in ASGI application"]
    [ours] = [r for r in caplog.records if r.name == "switch_core.runtime"]
    assert ours.levelno == logging.WARNING
    assert _counted(registry) == {("http", "RuntimeError"): 1.0}


async def test_one_task_exception_is_one_error_line(
    registry: MetricsRegistry, caplog: pytest.LogCaptureFixture
) -> None:
    """asyncio's own "never retrieved" ERROR stays the only one."""
    loop = asyncio.get_running_loop()
    before = loop.get_exception_handler()
    loop.set_exception_handler(None)
    try:
        install_task_exception_counter(loop)
        with caplog.at_level(logging.DEBUG):
            loop.call_exception_handler(
                {"message": "Task exception was never retrieved", "exception": Broken()}
            )
    finally:
        loop.set_exception_handler(before)
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 1 and errors[0].name == "asyncio"
    assert _counted(registry) == {("task", "RuntimeError"): 1.0}

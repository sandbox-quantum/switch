"""Unhandled exceptions, counted and named.

An exception nothing in Core handled reaches the operator today only as a
5xx, and as uvicorn's (or asyncio's) own line with the full message and stack.
That line stays as it is: errors are captured in full. This adds, for each
one:

- **a count**, `switch.runtime.unhandled_exceptions{component, type}`, where
  `component` is where it escaped (`http`, `websocket` or `task`) and `type`
  is the nearest common exception class it is, by name, from a fixed list
  (`EXCEPTION_TYPES`), or `other`;
- **one WARNING line with a fixed event name**, `switch.event` =
  `runtime.unhandled_exception`, with the same two words and, for a request,
  the route *template*. Never the path, the message or anything from the
  request: the stack is in the ERROR line above, which stays the only ERROR
  for the exception, so error-count alerts count it once.

The middleware sits on the one app (the gateway is mounted on it), so every
HTTP request and websocket is covered. The loop's exception handler covers a
background task whose exception nobody awaited. Both pass the exception on
unchanged.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.logging_context import STRUCTURED_FIELDS
from switch_core.observability.catalogue import RUNTIME_UNHANDLED_EXCEPTIONS
from switch_core.observability.http import route_label
from switch_core.observability.metrics import metrics

# Not under `switch_core.observability`, whose own lines are kept out of the
# log export to avoid loops: this line is meant to reach it.
logger = logging.getLogger("switch_core.runtime")

EVENT = "runtime.unhandled_exception"
COMPONENTS = ("http", "websocket", "task")
# The `type` words: common exception classes by name. An exception is named
# by the nearest of these in its class's ancestry (a `ConnectTimeout` reads as
# `TimeoutError` if it is one), and anything else is `other`, so a dependency
# raising its own classes can't grow the series.
EXCEPTION_TYPES = frozenset(
    {
        "TimeoutError",
        "ConnectionError",
        "PermissionError",
        "FileNotFoundError",
        "OSError",
        "ValueError",
        "KeyError",
        "IndexError",
        "TypeError",
        "AttributeError",
        "AssertionError",
        "NotImplementedError",
        "RecursionError",
        "RuntimeError",
        "HTTPException",
        "IntegrityError",
        "OperationalError",
        "DBAPIError",
        "SQLAlchemyError",
        "ValidationError",
        "CancelledError",
        "ExceptionGroup",
    }
)


def exception_type(exc: BaseException) -> str:
    """The nearest common class the exception is, by name, or `other`."""
    for cls in type(exc).__mro__:
        if cls.__name__ in EXCEPTION_TYPES:
            return cls.__name__
    return "other"


def record_unhandled(
    component: str, exc: BaseException, route: str | None = None
) -> None:
    """Count one unhandled exception and write its fixed-name line."""
    where = component if component in COMPONENTS else "other"
    kind = exception_type(exc)
    metrics().increment(
        RUNTIME_UNHANDLED_EXCEPTIONS, {"component": where, "type": kind}
    )
    # Under `switch.*`, never `event.name` or `event_type`: some telemetry
    # pipelines treat a record carrying either of those as a product event.
    fields: dict[str, str | None] = {
        "event": EVENT,
        "component": where,
        "type": kind,
        "route": route,
    }
    # A warning, not an error: uvicorn's "Exception in ASGI application" or
    # asyncio's "Task exception was never retrieved" is already the one ERROR
    # line for this exception, with its stack, and is what the log alerts
    # count. A second ERROR here would count every exception twice.
    logger.warning(
        "%s component=%s type=%s route=%s",
        EVENT,
        where,
        kind,
        route or "-",
        extra={STRUCTURED_FIELDS: {"switch": fields}},
    )


class UnhandledExceptionMiddleware:
    """Counts an exception that escapes the app on an HTTP request or a
    websocket, then lets it go on as before."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        except Exception as exc:
            record_unhandled(scope["type"], exc, route_label(scope))
            raise


LoopHandler = Callable[[asyncio.AbstractEventLoop, dict[str, Any]], object]


def install_task_exception_counter(loop: asyncio.AbstractEventLoop) -> None:
    """Count a background task's exception that nobody retrieved, then hand
    the loop's report to whatever handled it before (asyncio's own logging by
    default), unchanged."""
    previous: LoopHandler | None = loop.get_exception_handler()

    def handler(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        if isinstance(exc, Exception):
            record_unhandled("task", exc)
        if previous is not None:
            previous(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)

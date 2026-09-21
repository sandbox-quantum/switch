"""Server-side observation points for the baseline benchmark.

Everything here wraps objects the harness itself owns — the ASGI app returned
by the real application factory, and the engine the harness built. No module
under `switch_core` is modified, imported differently, or monkeypatched, so a
benchmark run exercises the same server code a deployment runs.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.benchmarks.trace import (
    ADMISSION_RECEIVED,
    ADMISSION_RESPONDED,
    CORE_COMMIT,
    SSE_PUSH,
    TraceCollector,
    correlation_for,
)

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]

_ROOM_MESSAGE = re.compile(r"^/sessions/(?P<session>[^/]+)/room-message$")
_EVENT_STREAM = re.compile(r"^/agents/(?P<agent>[^/]+)/events$")

# The admission request in flight on this task, so an engine-level commit can
# be attributed to the message that caused it. Set by the ASGI wrapper and read
# by the commit listener; unset for every other request, which is how commits
# from unrelated work stay out of the measurement.
_in_flight: ContextVar[str | None] = ContextVar(
    "benchmark_in_flight_correlation", default=None
)


def _sse_correlations(chunk: bytes) -> list[str]:
    """Correlations for every room message in one SSE write.

    A single ASGI body chunk may carry several frames, and most frames are not
    room messages at all — `connection_state`, `gap`, `evicted`,
    `subscription_changed`, keepalive comments. The measured workload is
    addressed room messages, so only `message` frames count; the others have no
    message id to correlate on and are not what the latency figures describe.

    `room_id` sits on the event, `message_id` inside its payload — the shape
    `AgentEvent` and `MessagePayload` define.
    """
    found: list[str] = []
    for block in chunk.split(b"\n\n"):
        if not block.strip() or block.lstrip().startswith(b":"):
            continue
        event = None
        data: dict[str, Any] | None = None
        for line in block.split(b"\n"):
            if line.startswith(b"event: "):
                event = line[len(b"event: ") :].decode()
            elif line.startswith(b"data: "):
                try:
                    parsed = json.loads(line[len(b"data: ") :])
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    data = parsed
        if event != "message" or data is None:
            continue
        room_id = data.get("room_id")
        payload = data.get("payload")
        message_id = payload.get("message_id") if isinstance(payload, dict) else None
        if isinstance(room_id, str) and isinstance(message_id, str):
            found.append(correlation_for(room_id, message_id))
    return found


class TracingMiddleware:
    """Pure-ASGI wrapper recording the three server-side HTTP points.

    Deliberately ASGI rather than a Starlette `BaseHTTPMiddleware`: the latter
    buffers a streaming response through a queue, which would both change the
    timing being measured and defeat the point of an SSE stream.
    """

    def __init__(self, app: Any, collector: TraceCollector) -> None:
        self._app = app
        self._collector = collector

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return
        path = scope.get("path", "")
        if scope.get("method") == "POST" and _ROOM_MESSAGE.match(path):
            await self._admission(scope, receive, send)
            return
        if scope.get("method") == "GET" and _EVENT_STREAM.match(path):
            await self._stream(scope, receive, send)
            return
        await self._app(scope, receive, send)

    async def _admission(self, scope: Scope, receive: Receive, send: Send) -> None:
        body, replay = await _buffer_body(receive)
        correlation = _admission_correlation(body)
        if correlation is None:
            # An admission whose body names no room and message is not part of
            # the measured workload — a malformed or probing request. Pass it
            # through untraced rather than inventing a correlation for it.
            await self._app(scope, replay, send)
            return

        self._collector.record(ADMISSION_RECEIVED, correlation)
        token = _in_flight.set(correlation)

        responded = False

        async def tracing_send(message: dict[str, Any]) -> None:
            nonlocal responded
            await send(message)
            if (
                not responded
                and message.get("type") == "http.response.body"
                and not message.get("more_body", False)
            ):
                responded = True
                self._collector.record(ADMISSION_RESPONDED, correlation)

        try:
            await self._app(scope, replay, tracing_send)
        finally:
            _in_flight.reset(token)

    async def _stream(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def tracing_send(message: dict[str, Any]) -> None:
            if message.get("type") == "http.response.body":
                chunk = message.get("body", b"")
                if chunk:
                    for correlation in _sse_correlations(chunk):
                        self._collector.record(SSE_PUSH, correlation)
            await send(message)

        await self._app(scope, receive, tracing_send)


def _admission_correlation(body: bytes) -> str | None:
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    room_id = payload.get("room_id")
    message_id = payload.get("message_id")
    if isinstance(room_id, str) and isinstance(message_id, str):
        return correlation_for(room_id, message_id)
    return None


async def _buffer_body(receive: Receive) -> tuple[bytes, Receive]:
    """Read the whole request body, and return a `receive` that replays it.

    The body has to be read here to learn which message the admission is for,
    and an ASGI `receive` is single-shot, so the application downstream would
    otherwise find an empty body.
    """
    chunks: list[bytes] = []
    messages: list[dict[str, Any]] = []
    while True:
        message = await receive()
        messages.append(message)
        if message["type"] != "http.request":
            break
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            break

    pending = list(messages)

    async def replay() -> dict[str, Any]:
        if pending:
            return pending.pop(0)
        return await receive()

    return b"".join(chunks), replay


def trace_commits(engine: AsyncEngine, collector: TraceCollector) -> Callable[[], None]:
    """Record the commit of whichever admission is in flight on this task.

    Engine level rather than session level: `commit` on the sync engine is the
    DBAPI commit itself, which is the moment "Core transaction complete"
    actually names. Commits from background work carry no in-flight
    correlation and are ignored.

    Returns a callable that removes the listener.
    """

    def on_commit(_conn: Any) -> None:
        correlation = _in_flight.get()
        if correlation is not None:
            collector.record(CORE_COMMIT, correlation)

    event.listen(engine.sync_engine, "commit", on_commit)

    def remove() -> None:
        event.remove(engine.sync_engine, "commit", on_commit)

    return remove


def in_flight_correlation() -> str | None:
    """Exposed for the harness's own self-check that contextvars propagate."""
    return _in_flight.get()

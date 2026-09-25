"""Server-side observation points for the end-to-end benchmark.

Everything here wraps objects the harness itself owns — the ASGI app returned
by the real application factory, and the engine the harness built. No module
under `switch_core` is modified, imported differently, or monkeypatched, so a
benchmark run exercises the same server code a deployment runs.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.benchmarks.trace import (
    APPROVAL_OPENED,
    REPLY_ACCEPTED,
    REPLY_COMMITTED,
    REPLY_RECEIVED,
    SSE_PUSH,
    TURN_REPORTED,
    TraceCollector,
    correlation_for,
)

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]

_EVENT_STREAM = re.compile(r"^/agents/(?P<agent>[^/]+)/events$")
_POST_MESSAGE = re.compile(r"^/agents/(?P<agent>[^/]+)/ops/post_message$")
_ACTIVITY = re.compile(r"^/agent-sessions/(?P<session>[^/]+)/activity$")
_APPROVALS = re.compile(r"^/agent-sessions/(?P<session>[^/]+)/approvals$")

#: The reply the benchmark provider posts, as `bench/adapter.ts` writes it. The
#: room and message are the ones its prompt named, so the reply can be matched
#: to the message it answers; the room it lands in is read back separately.
REPLY = re.compile(
    r"switch-bench-reply:(?P<marker>\S+) room=(?P<room>\S+) message=(?P<message>\S+)"
)

#: Statuses a turn row ends on.
_TURN_ENDED = frozenset({"completed", "interrupted", "error"})

# The reply request in flight on this task, so an engine-level commit can be
# attributed to the message it answers. Set by the ASGI wrapper and read by the
# commit listener; unset for every other request, which is how commits from
# unrelated work stay out of the measurement.
_in_flight: ContextVar[str | None] = ContextVar(
    "benchmark_in_flight_correlation", default=None
)


def reply_correlation(text: str) -> str | None:
    """The message a benchmark reply answers, or None for any other text."""
    matched = REPLY.search(text)
    if matched is None:
        return None
    return correlation_for(matched["room"], matched["message"])


def _sse_correlations(chunk: bytes) -> list[str]:
    """Correlations for every room message in one SSE write.

    A single ASGI body chunk may carry several frames, and most frames are not
    room messages at all — `connection_state`, `gap`, `evicted`,
    `room_released`, keepalive comments. The measured workload is addressed
    room messages, so only `message` frames count; the others have no message
    id to correlate on and are not what the latency figures describe.

    `room_id` sits on the event, `message_id` inside its payload — the shape
    `AgentEvent` and `MessagePayload` define.
    """
    found: list[str] = []
    for block in chunk.split(b"\n\n"):
        if not block.strip() or block.lstrip().startswith(b":"):
            continue
        name = None
        data: dict[str, Any] | None = None
        for line in block.split(b"\n"):
            if line.startswith(b"event: "):
                name = line[len(b"event: ") :].decode()
            elif line.startswith(b"data: "):
                try:
                    parsed = json.loads(line[len(b"data: ") :])
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    data = parsed
        if name != "message" or data is None:
            continue
        room_id = data.get("room_id")
        payload = data.get("payload")
        message_id = payload.get("message_id") if isinstance(payload, dict) else None
        if isinstance(room_id, str) and isinstance(message_id, str):
            found.append(correlation_for(room_id, message_id))
    return found


class TracingMiddleware:
    """Pure-ASGI wrapper recording the server-side HTTP points.

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
        method = scope.get("method")
        if method == "GET" and _EVENT_STREAM.match(path):
            await self._stream(scope, receive, send)
        elif method == "POST" and _POST_MESSAGE.match(path):
            await self._reply(scope, receive, send)
        elif method == "POST" and _ACTIVITY.match(path):
            await self._activity(scope, receive, send)
        elif method == "POST" and _APPROVALS.match(path):
            await self._approval(scope, receive, send)
        else:
            await self._app(scope, receive, send)

    async def _reply(self, scope: Scope, receive: Receive, send: Send) -> None:
        body, replay = await _buffer_body(receive)
        payload = _json_object(body)
        text = payload.get("body") if payload is not None else None
        correlation = reply_correlation(text) if isinstance(text, str) else None
        if correlation is None:
            # A post that is not a benchmark reply is not part of the measured
            # workload. Pass it through untraced rather than inventing one.
            await self._app(scope, replay, send)
            return

        self._collector.record(REPLY_RECEIVED, correlation)
        token = _in_flight.set(correlation)
        status: int | None = None

        async def tracing_send(message: dict[str, Any]) -> None:
            nonlocal status
            if message.get("type") == "http.response.start":
                status = int(message["status"])
            await send(message)
            if (
                message.get("type") == "http.response.body"
                and not message.get("more_body", False)
                and status == 200
            ):
                self._collector.record(REPLY_ACCEPTED, correlation)

        try:
            await self._app(scope, replay, tracing_send)
        finally:
            _in_flight.reset(token)

    async def _activity(self, scope: Scope, receive: Receive, send: Send) -> None:
        body, replay = await _buffer_body(receive)
        row = _json_object(body)
        await self._app(scope, replay, send)
        if (
            row is None
            or row.get("kind") != "turn"
            or row.get("status") not in _TURN_ENDED
        ):
            return
        room_id, message_id = row.get("room_id"), row.get("message_id")
        if isinstance(room_id, str) and isinstance(message_id, str):
            self._collector.record(
                TURN_REPORTED,
                correlation_for(room_id, message_id),
                detail={"status": row["status"], "turn_id": row.get("turn_id")},
            )

    async def _approval(self, scope: Scope, receive: Receive, send: Send) -> None:
        body, replay = await _buffer_body(receive)
        request = _json_object(body)
        await self._app(scope, replay, send)
        if request is None:
            return
        # A request carries its turn's origin thread, which for a message that
        # started no thread is the message itself.
        room_id, thread_id = request.get("room_id"), request.get("thread_id")
        if isinstance(room_id, str) and isinstance(thread_id, str):
            self._collector.record(
                APPROVAL_OPENED,
                correlation_for(room_id, thread_id),
                detail={"request_id": request.get("request_id")},
            )

    async def _stream(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def tracing_send(message: dict[str, Any]) -> None:
            if message.get("type") == "http.response.body":
                chunk = message.get("body", b"")
                if chunk:
                    for correlation in _sse_correlations(chunk):
                        self._collector.record(SSE_PUSH, correlation)
            await send(message)

        await self._app(scope, receive, tracing_send)


class RequestCounter:
    """Every HTTP request the server is sent, counted by route.

    A route is named without the ids in its path, so fifty sessions reporting
    count as fifty reports rather than fifty different routes. Counted in
    front of the application: what a client asked for is the measure,
    whatever the server made of it.
    """

    def __init__(self, app: Any) -> None:
        self._app = app
        self.counts: Counter[str] = Counter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") == "http":
            self.counts[route_of(scope.get("path", ""))] += 1
        await self._app(scope, receive, send)


def route_of(path: str) -> str:
    """The path with the agent or session id it names left out."""
    parts = path.strip("/").split("/")
    if len(parts) >= 3 and parts[0] == "agents":
        return "/".join([parts[0], *parts[2:]])
    if len(parts) >= 3 and parts[0] == "agent-sessions" and parts[1] != "approvals":
        return "/".join([parts[0], *parts[2:]])
    return "/".join(parts)


def count_statements(engine: AsyncEngine) -> tuple[Counter[str], Callable[[], None]]:
    """Count the statements the server sends its database, for the life of a run.

    Everything on the engine, background work included: an idle server's cost
    is mostly background work. Returns the running count and a callable that
    removes the listener.
    """
    counts: Counter[str] = Counter()

    def on_execute(*_args: Any) -> None:
        counts["statements"] += 1

    event.listen(engine.sync_engine, "before_cursor_execute", on_execute)

    def remove() -> None:
        event.remove(engine.sync_engine, "before_cursor_execute", on_execute)

    return counts, remove


def _json_object(body: bytes) -> dict[str, Any] | None:
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


async def _buffer_body(receive: Receive) -> tuple[bytes, Receive]:
    """Read the whole request body, and return a `receive` that replays it.

    The body has to be read here to learn which message the request is about,
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
    """Record the commit of whichever reply is in flight on this task.

    Engine level rather than session level: `commit` on the sync engine is the
    DBAPI commit itself, which is the moment the reply is stored. Commits from
    background work carry no in-flight correlation and are ignored.

    Returns a callable that removes the listener.
    """

    def on_commit(_conn: Any) -> None:
        correlation = _in_flight.get()
        if correlation is not None:
            collector.record(REPLY_COMMITTED, correlation)

    event.listen(engine.sync_engine, "commit", on_commit)

    def remove() -> None:
        event.remove(engine.sync_engine, "commit", on_commit)

    return remove

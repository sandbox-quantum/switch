"""Server-side observation points for the baseline benchmark.

Everything here wraps objects the harness itself owns — the ASGI app returned
by the real application factory, and the engine the harness built. No module
under `switch_core` is modified, imported differently, or monkeypatched, so a
benchmark run exercises the same server code a deployment runs.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass
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
_ROOM_RESERVATIONS = re.compile(r"^/sessions/(?P<session>[^/]+)/room-reservations$")

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


@dataclass(slots=True)
class Hold:
    """One ask held open, and what became of the client that made it."""

    arrived: float
    abandoned: float | None = None

    def live_at(self, moment: float) -> bool:
        """Was this client still waiting on its own request at `moment`?"""
        if moment < self.arrived:
            return False
        return self.abandoned is None or moment < self.abandoned


class StallGate:
    """Holds a session's ask for its own room work open, on demand.

    A session asks Switch what its rooms owe it; that request can be answered
    slowly or not at all — a server under load, a connection that has gone away
    without saying so — and what a scenario needs is for the rest of the
    session to carry on regardless: what the server pushes it, and the commands
    it is given, both arrive by other requests.

    The hold is taken here, in front of the application, rather than anywhere
    inside it. The request never reaches a route, so no transaction, row lock
    or connection is held open by it, and nothing about the server's own
    behaviour is altered — from its side the client simply has a request
    outstanding. That keeps the fault in the harness, where a benchmark's
    fault injection belongs.

    Held is not the same as waited on, and the difference is the whole
    evidence: a client with its own timeout gives up long before a gate that
    never let go would notice, and a count of holds would still read the same
    afterwards. So each hold watches for the disconnect its client sends when
    it abandons the request, and records when it came. A scenario can then say
    of a given moment whether the session was still waiting on an answer, which
    is what makes the rest of its progress mean anything.

    A hold whose client has gone is not passed on when the gate is released.
    The request is nobody's now, and the work it asks for is work the server
    would hand out to a session that cannot receive it.
    """

    def __init__(self, app: Any) -> None:
        self._app = app
        self._open: asyncio.Event | None = None
        self._holds: list[Hold] = []
        self._arrived = asyncio.Event()
        self._gave_up = asyncio.Event()

    def arm(self) -> None:
        """Hold every ask that arrives from now until `release`."""
        if self._open is not None:
            raise RuntimeError("the stall gate is already armed")
        self._arrived.clear()
        self._gave_up.clear()
        self._holds.clear()
        self._open = asyncio.Event()

    def release(self) -> None:
        """Let go of what is held, and stop holding what arrives next."""
        if self._open is None:
            raise RuntimeError("the stall gate is not armed")
        self._open.set()
        self._open = None

    def holds(self) -> tuple[Hold, ...]:
        """Every ask held since the gate was armed, oldest first."""
        return tuple(self._holds)

    def live_at(self, moment: float) -> bool:
        """Was any held ask still being waited on at `moment`?"""
        return any(hold.live_at(moment) for hold in self._holds)

    def concurrent_peak(self) -> int:
        """The most asks ever being waited on at once.

        A session that started another ask while one was outstanding would be
        piling requests on a server already failing to answer; one that starts
        the next only after its own timeout has ended the last never exceeds
        one, however long the stall runs.
        """
        edges = sorted(
            [(hold.arrived, 1) for hold in self._holds]
            + [
                (hold.abandoned, -1)
                for hold in self._holds
                if hold.abandoned is not None
            ]
        )
        live = 0
        peak = 0
        for _, step in edges:
            live += step
            peak = max(peak, live)
        return peak

    async def await_held(self, timeout: float) -> float:
        """Wait until an ask is actually being held, and say when it arrived.

        The scenario that arms the gate has to know the stall it is testing
        against is real before it does anything else; a session's ask is on its
        own cadence, so the alternative is a sleep long enough to be a guess.
        """
        await asyncio.wait_for(self._arrived.wait(), timeout)
        return self._holds[0].arrived

    async def await_abandoned(self, timeout: float) -> float:
        """Wait until a client gives up on an ask, and say when it did.

        The counterpart to `await_held`, and the reason either can be believed:
        a gate that reported a wait it was not watching would report one here
        too, where the client is known to have gone.
        """
        await asyncio.wait_for(self._gave_up.wait(), timeout)
        return min(hold.abandoned for hold in self._holds if hold.abandoned is not None)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        opened = self._open
        if (
            opened is None
            or scope.get("type") != "http"
            or scope.get("method") != "POST"
            or not _ROOM_RESERVATIONS.match(scope.get("path", ""))
        ):
            await self._app(scope, receive, send)
            return

        # Read before holding, so watching for the client's disconnect cannot
        # swallow the body the application still has to be given.
        _, replay = await _buffer_body(receive)
        hold = Hold(arrived=asyncio.get_running_loop().time())
        self._holds.append(hold)
        self._arrived.set()

        watching: asyncio.Future[dict[str, Any]] = asyncio.ensure_future(receive())
        waiting: asyncio.Future[bool] = asyncio.ensure_future(opened.wait())
        try:
            while True:
                racing: set[asyncio.Future[Any]] = {watching, waiting}
                await asyncio.wait(racing, return_when=asyncio.FIRST_COMPLETED)
                if waiting.done():
                    break
                if watching.result().get("type") == "http.disconnect":
                    hold.abandoned = asyncio.get_running_loop().time()
                    self._gave_up.set()
                    return
                watching = asyncio.ensure_future(receive())
        finally:
            watching.cancel()
            waiting.cancel()

        await self._app(scope, replay, send)


class RequestCounter:
    """Every HTTP request the server is sent, counted by route.

    A route is named without the ids in its path, so fifty sessions renewing
    count as fifty renewals rather than fifty different routes. Counted in
    front of the application for the same reason the stall gate holds there:
    what a client asked for is the measure, whatever the server made of it.
    """

    def __init__(self, app: Any) -> None:
        self._app = app
        self.counts: Counter[str] = Counter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") == "http":
            self.counts[_route(scope.get("path", ""))] += 1
        await self._app(scope, receive, send)


def _route(path: str) -> str:
    parts = path.strip("/").split("/")
    if len(parts) >= 3 and parts[0] in ("sessions", "agents"):
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

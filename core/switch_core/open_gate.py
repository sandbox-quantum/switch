"""Paces connection opens, so a reconnect storm becomes a queue.

When a pod goes away, every agent and controller it held opens a connection on
the pods that are left, all within a few seconds. Each open authenticates,
makes a new incarnation of the connection and reads where the stream starts:
dozens of transactions, on the same pool the process's requests and its own
lease renewal use. Measured on staging (two pods, 1,000 agents, one pod
deleted), the opens took the whole pool: thousands of pool timeouts, opens
that failed after their incarnation was made, and the surviving pod's lease
lapsing, which made it drop agents of its own.

This middleware runs at most `limit` opens at once in this process. An open
that finds every slot taken waits up to `WAIT_S` for one. Past that, or when
more opens are waiting already than can get a slot within `WAIT_S`, it is
refused before authentication or the database, with `retry_after_s`: its place
in the line. The line moves one slot every median open time over `limit` (the
median of the last `limit` opens), so a storm comes back spread over the time
the process needs to take it, at the pace opens are going here, and the line
slows down when the database does. A caller refused again before its time
keeps that time, so a client that retries at once cannot push everyone else's
back.

An open is done when its first frame or response body goes out (the
`connection_state`, or a refusal) or the request ends. What follows is the
stream, which the event buffer's own cap paces. The state is this process's
own: each pod paces its own opens, as each has its own pool.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import random
import re
import statistics
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.observability.catalogue import AGENT_OPENS_DEFERRED
from switch_core.observability.metrics import metrics
from switch_core.refusal_breaker import bearer_caller

logger = logging.getLogger(__name__)

# How long an open waits for a slot before it is told when to come back. The
# wait and the open after it have to fit well inside the timeout of the
# proxies in front of switch-core: the tailnet ingress gives up on a request
# after about 10 s (measured on dev-abel, 29 Oct 2026). An open that outwaits
# a proxy still runs here after the proxy has given up, which moves the
# connection on behind its client's back, and today's agent runtime gives up
# for good on the refusal that follows. 2 s leaves most of the 10 s to the open
# itself and to proxies that give up sooner.
WAIT_S = 2.0
# The callers whose come-back time is remembered, which bounds this memory to a
# few MB. The gate answers before authentication, so a caller that never
# authenticates takes a place in the line too; the line given out goes no
# further than these callers' worth of slots, which bounds how far such
# callers can push back the times real ones are given. 10,000 is about the
# most agents one deployment has been tested with.
MAX_TRACKED = 10_000

BUSY = "busy"
_STATUS = 503

# The opens it paces, by the label its metric carries.
_ROUTES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^/agents/[^/]+/connection/ws$"), "agent_socket"),
    (re.compile(r"^/agents/[^/]+/events$"), "agent_event_stream"),
    (re.compile(r"^/v1/controllers/[^/]+/connection$"), "controller_open"),
    (re.compile(r"^/v1/controllers/[^/]+/connection/ws$"), "controller_socket"),
)
# Controllers read refusals from the management error envelope; everything
# else on this app reads FastAPI's `detail`.
_MANAGEMENT_PREFIXES = ("/v1/controllers/", "/v1/management/")


def _route(scope: Scope) -> str | None:
    if scope["type"] not in ("http", "websocket"):
        return None
    path = scope.get("path", "")
    if scope["type"] == "http" and scope.get("method") not in ("GET", "POST"):
        return None
    for pattern, label in _ROUTES:
        if pattern.match(path):
            return label
    return None


@dataclass(eq=False)
class _Waiter:
    caller: str | None
    # Set when a slot is handed to this open.
    slot: asyncio.Future[None]


class OpenGate:
    def __init__(
        self,
        app: ASGIApp,
        *,
        limit: int,
        clock: Callable[[], float],
        rand: Callable[[], float] = random.random,
    ) -> None:
        self.app = app
        self.limit = limit
        self._clock = clock
        self._rand = rand
        self._slots = max(limit, 1)
        self._running = 0
        self._waiting: deque[_Waiter] = deque()
        # How long the last `limit` opens took, from taking a slot to their
        # first frame or response.
        self._open_s: deque[float] = deque(maxlen=self._slots)
        # The end of the line of callers told when to come back.
        self._next_at = 0.0
        self._given: OrderedDict[str, float] = OrderedDict()
        self._refusing_since: float | None = None
        self._refused = 0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        route = _route(scope) if self.limit > 0 else None
        if route is None:
            await self.app(scope, receive, send)
            return
        retry_after_s = await self._enter(bearer_caller(scope))
        if retry_after_s is not None:
            metrics().increment(AGENT_OPENS_DEFERRED, {"route": route})
            self._note_refused(retry_after_s)
            await _refuse(scope, receive, send, retry_after_s)
            return

        started = self._clock()
        released = False

        def release() -> None:
            nonlocal released
            if not released:
                released = True
                self._release(max(self._clock() - started, 0.0))

        async def done_on_first_output(message: Message) -> None:
            if message["type"] in (
                "websocket.send",
                "websocket.close",
                "http.response.body",
            ):
                release()
            await send(message)

        try:
            await self.app(scope, receive, done_on_first_output)
        finally:
            release()

    async def _enter(self, caller: str | None) -> float | None:
        """Take a slot, waiting up to `WAIT_S` for one. None once the open holds
        a slot; otherwise when it is to come back, in seconds."""
        if self._running < self._slots and not self._waiting:
            self._running += 1
            self._forget(caller)
            return None
        if len(self._waiting) >= self._most_waiting():
            return self._retry_after(caller, self._clock())

        waiter = _Waiter(caller, asyncio.get_running_loop().create_future())
        self._waiting.append(waiter)
        try:
            async with asyncio.timeout(WAIT_S):
                await waiter.slot
        except TimeoutError:
            if not waiter.slot.done() or waiter.slot.cancelled():
                with contextlib.suppress(ValueError):
                    self._waiting.remove(waiter)
                return self._retry_after(caller, self._clock())
            # Handed a slot as the wait ran out: it is this open's.
        except asyncio.CancelledError:
            if waiter.slot.cancelled():
                with contextlib.suppress(ValueError):
                    self._waiting.remove(waiter)
            else:
                # Handed a slot as the request went away: the next one has it.
                self._pass_slot()
            raise
        self._forget(caller)
        return None

    def _release(self, took: float) -> None:
        self._open_s.append(took)
        self._pass_slot()
        self._note_line_through()

    def _pass_slot(self) -> None:
        while self._waiting:
            waiter = self._waiting.popleft()
            if not waiter.slot.done():
                waiter.slot.set_result(None)
                return
        self._running -= 1

    def _open_time(self) -> float:
        """How long an open takes here: the median of the last `limit`. Before
        any has finished, at least `WAIT_S`, the time an open has just waited
        with every slot taken and none of them done."""
        return statistics.median(self._open_s) if self._open_s else WAIT_S

    def _most_waiting(self) -> float:
        """The most opens worth keeping waiting: as many as get a slot within
        `WAIT_S` at the pace opens are going here. An open past them would
        wait out `WAIT_S` and be refused anyway, so it is refused at once.
        Before any open has finished there is no pace to go by, and `WAIT_S`
        alone bounds the wait."""
        if not self._open_s or self._open_time() <= 0:
            return math.inf
        return WAIT_S * self._slots / self._open_time()

    def _retry_after(self, caller: str | None, now: float) -> float:
        """When this caller is to come back, in seconds: its place in the line.

        The line moves one slot every open time over `limit`. The first caller
        told to come back is behind the opens waiting here, each one after it a
        slot later, at a random point within its slot. The line reaches no
        further than `MAX_TRACKED` callers' worth of slots; past that, a caller
        is given a random point within it. A caller already given a time that
        has not come keeps it."""
        if caller is not None:
            at = self._given.get(caller)
            if at is not None and at > now:
                self._given.move_to_end(caller)
                return at - now
        spacing = self._open_time() / self._slots
        end = now + MAX_TRACKED * spacing
        start = max(now + (len(self._waiting) + 1) * spacing, self._next_at)
        if start < end:
            self._next_at = start + spacing
            at = start + spacing * self._rand()
        else:
            # Past the end of the line: a random point within it, so callers
            # refused together do not come back together.
            self._next_at = end
            at = now + spacing + (end - now - spacing) * self._rand()
        if caller is not None:
            self._given[caller] = at
            self._given.move_to_end(caller)
            while len(self._given) > MAX_TRACKED:
                self._given.popitem(last=False)
        return at - now

    def _forget(self, caller: str | None) -> None:
        if caller is not None:
            self._given.pop(caller, None)

    def _note_refused(self, retry_after_s: float) -> None:
        self._refused += 1
        if self._refusing_since is not None:
            return
        self._refusing_since = self._clock()
        logger.warning(
            "Opening connections more slowly than they arrive: %d opening and %d "
            "waiting for a slot, the rest told when to come back, the first in %.1f s",
            self._running,
            len(self._waiting),
            retry_after_s,
        )

    def _note_line_through(self) -> None:
        now = self._clock()
        if self._refusing_since is None or self._waiting or self._next_at > now:
            return
        logger.warning(
            "Caught up with connection opens: %d were told to come back later "
            "over %.0f s",
            self._refused,
            now - self._refusing_since,
        )
        self._refusing_since = None
        self._refused = 0


async def _refuse(
    scope: Scope, receive: Receive, send: Send, retry_after_s: float
) -> None:
    """Refuse the open in the form its client reads refusals in, with when to
    come back."""
    # Rounded up to the millisecond clients wait in, so none comes back early.
    seconds = math.ceil(retry_after_s * 1000) / 1000
    message = (
        "This server is opening as many connections as it can take right now. "
        f"Open again in {seconds:g} s."
    )
    path = scope.get("path", "")
    if scope["type"] == "websocket":
        # As every refused agent or controller socket: accepted, a `refused`
        # frame with the status and detail, then closed with 4000 plus it.
        await receive()  # the client's websocket.connect
        await send({"type": "websocket.accept"})
        frame = {
            "event": "refused",
            "data": {
                "status": _STATUS,
                "detail": {
                    "code": BUSY,
                    "message": message,
                    "retry_after_s": seconds,
                },
            },
        }
        await send({"type": "websocket.send", "text": json.dumps(frame)})
        await send({"type": "websocket.close", "code": 4000 + _STATUS})
        return
    if path.startswith(_MANAGEMENT_PREFIXES):
        body: dict[str, object] = {
            "error": {
                "code": BUSY,
                "message": message,
                "retryable": True,
                "retry_after_s": seconds,
            }
        }
    else:
        body = {"detail": {"code": BUSY, "message": message, "retry_after_s": seconds}}
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": _STATUS,
            "headers": [
                (b"content-type", b"application/json"),
                (b"retry-after", str(math.ceil(retry_after_s)).encode()),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})

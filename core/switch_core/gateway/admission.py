"""Keeps people's requests from taking a process's database pool.

Every gateway request that reads or writes takes a connection from the pool
the process's own work uses: renewing its lease, recording its controllers'
connections, storing and delivering agents' events. Nothing else bounds how
many requests a client runs at once, so a client that sends enough of them
together fills the pool, and the process's own work waits behind them. A
lease that lapses drops the agents the process holds. Switch Console's
sidebar did it by accident, reading every agent at once (switch #1983); a
client could do it on purpose.

This middleware lets at most `limit` gateway requests run at once in this
process, which leaves the rest of the pool to the process's own work, and at
most `per_caller` of them for any one caller, so one caller cannot take the
share everyone's requests run in. A request past either waits its turn, in
order, for up to `WAIT_S`. Past that it is answered at once: 429 when its
caller has too many running, 503 when the process does. Long-lived streams
are not counted: they hold no connection while they wait for news.

A read (GET or HEAD) also runs under a statement timeout
(`db/statement_timeout.py`), which every session it opens gets, and a read
stopped by it is answered 503. A read that slow is a bug or someone loading
the database on purpose, and its client gave up long before. Writes run
without one: some do a workspace's worth of work in one statement.

The caller is the person a session cookie names, once its signature checks
out, or a bearer token, hashed, or else the address the request came from.
Behind a proxy every request without a valid session comes from the proxy's
address and they share one line. That only slows sign-ins on this process:
the requests of signed-in people run in lines of their own. The state is this
process's own, as its pool is.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.db.statement_timeout import statement_timeout, timed_out
from switch_core.gateway.auth import session_subject
from switch_core.keys import Keyring
from switch_core.observability.catalogue import GATEWAY_TURNED_AWAY
from switch_core.observability.metrics import metrics
from switch_core.refusal_breaker import bearer_caller

logger = logging.getLogger(__name__)

# How long a request waits for its turn before it is answered at once. The
# wait and the request after it have to fit inside the timeout of the proxies
# in front of switch-core: the tailnet's ingress gives up after about 10 s.
WAIT_S = 3.0
RETRY_AFTER_S = 1
# How often a caller that keeps being turned away is named in the log.
_LOG_EVERY_S = 60.0

# Routes that stay open for as long as their client is there, relative to the
# gateway's mount. They wait for news holding no connection.
_STREAMS = frozenset({"/chats/events", "/chats/activity/events"})
_READS = frozenset({"GET", "HEAD"})


@dataclass(eq=False)
class _Line:
    """`slots` turns, handed out in the order they were asked for."""

    slots: int
    running: int = 0
    waiting: deque[asyncio.Future[None]] = field(default_factory=deque)

    async def take(self, wait_s: float) -> bool:
        """Take a turn, waiting up to `wait_s` for one. False when none came."""
        if self.running < self.slots and not self.waiting:
            self.running += 1
            return True
        if wait_s <= 0:
            return False
        turn = asyncio.get_running_loop().create_future()
        self.waiting.append(turn)
        try:
            async with asyncio.timeout(wait_s):
                await turn
        except TimeoutError:
            if turn.done() and not turn.cancelled():
                # Handed a turn as the wait ran out: it is this request's.
                return True
            with contextlib.suppress(ValueError):
                self.waiting.remove(turn)
            return False
        except asyncio.CancelledError:
            if turn.done() and not turn.cancelled():
                # Handed a turn as the request went away: the next one has it.
                self.give_back()
            else:
                with contextlib.suppress(ValueError):
                    self.waiting.remove(turn)
            raise
        return True

    def give_back(self) -> None:
        while self.waiting:
            turn = self.waiting.popleft()
            if not turn.done():
                turn.set_result(None)
                return
        self.running -= 1

    @property
    def idle(self) -> bool:
        return self.running == 0 and not self.waiting


def route_path(scope: Scope) -> str:
    """The path below the gateway's mount (`/gateway`)."""
    path = scope.get("path") or ""
    root = scope.get("root_path") or ""
    return path[len(root) :] if root and path.startswith(root) else path


class GatewayAdmission:
    def __init__(
        self,
        app: ASGIApp,
        *,
        limit: int,
        per_caller: int,
        read_timeout: str,
        keyring: Keyring,
    ) -> None:
        self.app = app
        self.limit = limit
        self.per_caller = per_caller
        self.read_timeout = read_timeout
        self._keyring = keyring
        self._process = _Line(limit)
        self._callers: dict[str, _Line] = {}
        self._named: dict[str, float] = {}

    def caller(self, scope: Scope) -> str:
        """Who a request's turns are counted against."""
        token = HTTPConnection(scope).cookies.get("switch_auth")
        if token:
            subject = session_subject(token, self._keyring)
            if subject is not None:
                return f"user:{subject}"
        bearer = bearer_caller(scope)
        if bearer is not None:
            return f"token:{bearer}"
        client = scope.get("client")
        return f"address:{client[0] if client else 'unknown'}"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or route_path(scope) in _STREAMS:
            await self.app(scope, receive, send)
            return
        caller = self.caller(scope)
        started = time.monotonic()
        line = self._callers.get(caller)
        if line is None:
            line = self._callers[caller] = _Line(self.per_caller)
        try:
            if not await line.take(WAIT_S):
                await self._turn_away(scope, send, caller, "caller")
                return
            try:
                left = WAIT_S - (time.monotonic() - started)
                if not await self._process.take(left):
                    await self._turn_away(scope, send, caller, "process")
                    return
                try:
                    await self._serve(scope, receive, send)
                finally:
                    self._process.give_back()
            finally:
                line.give_back()
        finally:
            if line.idle and self._callers.get(caller) is line:
                del self._callers[caller]

    async def _serve(self, scope: Scope, receive: Receive, send: Send) -> None:
        started = False

        async def noting_start(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        limit = self.read_timeout if scope.get("method") in _READS else None
        try:
            with statement_timeout(limit):
                await self.app(scope, receive, noting_start)
        except Exception as exc:
            if limit is None or started or not timed_out(exc):
                raise
            logger.warning(
                "A read of %s ran past its statement timeout (%s) and was stopped",
                route_path(scope),
                limit,
            )
            await _answer(
                send,
                503,
                "This read took longer than Switch allows, so it was stopped. "
                "Try again in a moment.",
            )

    async def _turn_away(
        self, scope: Scope, send: Send, caller: str, reason: str
    ) -> None:
        metrics().increment(GATEWAY_TURNED_AWAY, {"reason": reason})
        now = time.monotonic()
        if now - self._named.get(caller, -_LOG_EVERY_S) >= _LOG_EVERY_S:
            self._named[caller] = now
            # Bounded by the callers turned away in the last minute.
            self._named = {
                c: t for c, t in self._named.items() if now - t < _LOG_EVERY_S
            }
            logger.warning(
                "Turned away a request to %s from %s: %s",
                route_path(scope),
                caller,
                f"it already had {self.per_caller} running"
                if reason == "caller"
                else f"this process already had {self.limit} gateway requests running",
            )
        if reason == "caller":
            await _answer(
                send,
                429,
                "You have too many requests running at once. Try again in a moment.",
            )
        else:
            await _answer(send, 503, "Switch is busy right now. Try again in a moment.")


async def _answer(send: Send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"retry-after", str(RETRY_AFTER_S).encode()),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})

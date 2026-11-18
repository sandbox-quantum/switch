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
process, which leaves the rest of the pool to the process's own work. Each
caller may always run `share` of them. While no other caller is waiting, one
may run more, up to `burst`, so a caller alone on the process isn't slowed
for nothing; `burst` stays well under `limit`, so a caller that arrives finds
a turn free rather than waiting behind requests already running. A turn that
comes free goes to the waiting caller with the fewest running, the earliest
of them first, so a caller that just arrived goes ahead of one already
running many. A request waits for up to `WAIT_S`. Past that it is answered at
once: 429 when its caller had its share running, 503 when the process was
full. Long-lived streams are not counted: they hold no connection while they
wait for news.

A read (GET or HEAD) also runs under a statement timeout
(`db/statement_timeout.py`), which every session it opens gets. A read that
slow is a bug or someone loading the database on purpose, and its client gave
up long before. Writes run without one: some do a workspace's worth of work in
one statement. So do the few GET routes that write, which carry
`writes_on_get`: the sign-in and connection callbacks, which a sign-in
provider sends the browser back to with a GET, as OAuth and OIDC do. A
request a statement timeout stopped is answered 503.

The caller is the person a session cookie names, once its signature checks
out, or the cloud controller when its bearer token is the one configured, or
else the address the request came from. No other gateway route takes a
bearer token, so any other one is counted against its address: a client that
sends a new random token with every request still waits in one line.
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
import secrets
import time
from dataclasses import dataclass

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.db.statement_timeout import (
    lift_statement_timeout,
    statement_timeout,
    timed_out,
)
from switch_core.gateway.auth import session_subject
from switch_core.keys import Keyring
from switch_core.observability.catalogue import GATEWAY_TURNED_AWAY
from switch_core.observability.metrics import metrics

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
class _Waiter:
    caller: str
    turn: asyncio.Future[None]


class _Turns:
    """The process's `limit` turns, shared between callers as the module says."""

    def __init__(self, limit: int, share: int, burst: int) -> None:
        self.limit = limit
        self.share = share
        self.burst = max(share, burst)
        self.running_total = 0
        self.running: dict[str, int] = {}
        # In the order they arrived.
        self.waiting: list[_Waiter] = []

    def _may_run(self, caller: str) -> bool:
        if self.running_total >= self.limit:
            return False
        running = self.running.get(caller, 0)
        if running < self.share:
            return True
        if running >= self.burst:
            return False
        return all(w.caller == caller for w in self.waiting)

    def _start(self, caller: str) -> None:
        self.running_total += 1
        self.running[caller] = self.running.get(caller, 0) + 1

    def _hand_out(self) -> None:
        """Give free turns to waiters: fewest running first, then earliest."""
        self.waiting = [w for w in self.waiting if not w.turn.done()]
        while self.waiting:
            ready = [
                (self.running.get(w.caller, 0), n, w)
                for n, w in enumerate(self.waiting)
                if self._may_run(w.caller)
            ]
            if not ready:
                return
            _, _, chosen = min(ready, key=lambda r: (r[0], r[1]))
            self.waiting.remove(chosen)
            self._start(chosen.caller)
            chosen.turn.set_result(None)

    async def take(self, caller: str, wait_s: float) -> bool:
        """Take a turn, waiting up to `wait_s` for one. False when none came."""
        if not self.waiting and self._may_run(caller):
            self._start(caller)
            return True
        waiter = _Waiter(caller, asyncio.get_running_loop().create_future())
        self.waiting.append(waiter)
        self._hand_out()
        if waiter.turn.done():
            return True
        if wait_s <= 0:
            self._withdraw(waiter)
            return False
        try:
            async with asyncio.timeout(wait_s):
                await waiter.turn
        except TimeoutError:
            if waiter.turn.done() and not waiter.turn.cancelled():
                # Handed a turn as the wait ran out: it is this request's.
                return True
            self._withdraw(waiter)
            return False
        except asyncio.CancelledError:
            if waiter.turn.done() and not waiter.turn.cancelled():
                # Handed a turn as the request went away: the next one has it.
                self.give_back(caller)
            else:
                self._withdraw(waiter)
            raise
        return True

    def _withdraw(self, waiter: _Waiter) -> None:
        with contextlib.suppress(ValueError):
            self.waiting.remove(waiter)
        # One caller fewer waiting can let another run past its share.
        self._hand_out()

    def give_back(self, caller: str) -> None:
        self.running_total -= 1
        left = self.running[caller] - 1
        if left:
            self.running[caller] = left
        else:
            del self.running[caller]
        self._hand_out()

    def at_share(self, caller: str) -> bool:
        return self.running.get(caller, 0) >= self.share

    @property
    def idle(self) -> bool:
        return self.running_total == 0 and not self.waiting


async def writes_on_get() -> None:
    """Marks a GET route that writes, so it runs without the read timeout.

    A route dependency (`dependencies=[Depends(writes_on_get)]`), which
    FastAPI runs before the route's other dependencies and so before its
    first transaction. `test_admission.py` checks every gateway callback has it.
    """
    lift_statement_timeout()


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
        caller_burst: int | None = None,
        keyring: Keyring,
        controller_token: str | None = None,
    ) -> None:
        self.app = app
        self.limit = limit
        self.per_caller = per_caller
        self.read_timeout = read_timeout
        self._keyring = keyring
        self._controller_auth = (
            f"Bearer {controller_token}".encode() if controller_token else None
        )
        self._turns = _Turns(limit, per_caller, caller_burst or per_caller)
        self._named: dict[str, float] = {}

    def caller(self, scope: Scope) -> str:
        """Who a request's turns are counted against."""
        token = HTTPConnection(scope).cookies.get("switch_auth")
        if token:
            subject = session_subject(token, self._keyring)
            if subject is not None:
                return f"user:{subject}"
        if self._controller_auth is not None:
            for name, value in scope.get("headers", []):
                if name == b"authorization" and secrets.compare_digest(
                    value, self._controller_auth
                ):
                    return "cloud-controller"
        client = scope.get("client")
        return f"address:{client[0] if client else 'unknown'}"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or route_path(scope) in _STREAMS:
            await self.app(scope, receive, send)
            return
        caller = self.caller(scope)
        if not await self._turns.take(caller, WAIT_S):
            reason = "caller" if self._turns.at_share(caller) else "process"
            await self._turn_away(scope, send, caller, reason)
            return
        try:
            await self._serve(scope, receive, send)
        finally:
            self._turns.give_back(caller)

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
            # Whatever bound the limit, the read timeout or Postgres's own: a
            # stopped statement is a busy server to the client, never a 500.
            if started or not timed_out(exc):
                raise
            logger.warning(
                "A statement of %s %s ran past its statement timeout and was stopped",
                scope.get("method"),
                route_path(scope),
            )
            await _answer(
                send,
                503,
                "This took longer than Switch allows, so it was stopped. "
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

"""Answers a caller that keeps repeating a refused request, from memory.

Some clients never update and retry a refusal for as long as they run: an
agent runtime asking for a room it is no longer in, a controller on a
protocol this server no longer speaks, a machine whose credential is gone.
Every retry costs a credential lookup at least, and the clients that do it
are the ones that will never be fixed from their side.

After `REFUSALS_TO_TRIP` identical refusals (the same caller, method, path
and status, with nothing but refusals in between) inside `WINDOW_S`, the
breaker opens: that request is answered 429 with `Retry-After` at once,
without reaching authentication, a handler or the database. When the wait is
over one request goes through. If it is refused again the breaker reopens for
twice as long, up to `MAX_COOLDOWN_S`; any answer that is not a refusal
closes it.

The caller is the bearer token, or, for a controller's token exchange, which
carries its credential in the body, the body. Both are hashed, never kept. A
request that names no caller is never throttled, so one client cannot hold
back another. Only agent and controller routes are covered: the gateway
serves people, whose clients can be told what went wrong. The state is this
process's own, which is right while switch-core runs as a single replica.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.observability.catalogue import HTTP_REFUSALS_THROTTLED
from switch_core.observability.http import route_label
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)

REFUSAL_STATUSES = frozenset({401, 403, 404, 426})
REFUSALS_TO_TRIP = 8
WINDOW_S = 120.0
INITIAL_COOLDOWN_S = 60.0
MAX_COOLDOWN_S = 900.0
# Bounds the memory a caller sending a fresh token per request can take.
MAX_TRACKED = 10_000

_COVERED_PREFIXES = ("/agents/", "/agent-sessions/", "/v1/")
_TOKEN_EXCHANGE = re.compile(r"^/v1/management/controllers/[^/]+/token$")
# Controllers read refusals from the management error envelope; everything
# else on this app reads FastAPI's `detail`.
_MANAGEMENT_PREFIX = "/v1/management/"
_RATE_LIMITED = "rate_limited"


@dataclass
class _Refusals:
    status: int
    count: int
    first_at: float
    route: str
    open_until: float = 0.0
    cooldown_s: float = 0.0


class RefusalBreaker:
    def __init__(self, app: ASGIApp, *, clock: Callable[[], float]) -> None:
        self.app = app
        self._clock = clock
        self._tracked: OrderedDict[tuple[str, str, str], _Refusals] = OrderedDict()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "") if scope["type"] == "http" else ""
        if not path.startswith(_COVERED_PREFIXES):
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "GET")
        caller = _bearer(scope)
        if caller is None and method == "POST" and _TOKEN_EXCHANGE.match(path):
            body = await _read_body(receive)
            caller = hashlib.sha256(body).hexdigest()
            receive = _replay(body)
        if caller is None:
            await self.app(scope, receive, send)
            return

        key = (caller, method, path)
        now = self._clock()
        entry = self._tracked.get(key)
        if entry is not None and entry.open_until > now:
            metrics().increment(HTTP_REFUSALS_THROTTLED, {"route": entry.route})
            await _too_many(send, path, math.ceil(entry.open_until - now))
            return

        statuses: list[int] = []

        async def capture(message: Message) -> None:
            if message["type"] == "http.response.start":
                statuses.append(message["status"])
            await send(message)

        await self.app(scope, receive, capture)
        if statuses:
            self._record(key, statuses[0], route_label(scope), method, path)

    def _record(
        self, key: tuple[str, str, str], status: int, route: str, method: str, path: str
    ) -> None:
        if status not in REFUSAL_STATUSES:
            self._tracked.pop(key, None)
            return
        now = self._clock()
        entry = self._tracked.get(key)
        if entry is not None and entry.cooldown_s:
            # The one request let through after a wait was refused again.
            entry.cooldown_s = min(entry.cooldown_s * 2, MAX_COOLDOWN_S)
            entry.open_until = now + entry.cooldown_s
            self._log_open(entry, method, path)
            return
        if entry is None or entry.status != status or now - entry.first_at > WINDOW_S:
            entry = _Refusals(status=status, count=0, first_at=now, route=route)
            self._tracked[key] = entry
        self._tracked.move_to_end(key)
        entry.count += 1
        if entry.count >= REFUSALS_TO_TRIP:
            entry.cooldown_s = INITIAL_COOLDOWN_S
            entry.open_until = now + entry.cooldown_s
            self._log_open(entry, method, path)
        while len(self._tracked) > MAX_TRACKED:
            self._tracked.popitem(last=False)

    def _log_open(self, entry: _Refusals, method: str, path: str) -> None:
        logger.warning(
            "%s %s was refused %d (%d times) by the same caller; answering it 429 for %d s",
            method,
            path,
            entry.status,
            entry.count,
            entry.cooldown_s,
        )


def _bearer(scope: Scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"authorization" and value.lower().startswith(b"bearer "):
            return hashlib.sha256(value[7:].strip()).hexdigest()
    return None


async def _read_body(receive: Receive) -> bytes:
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] != "http.request":
            return b"".join(chunks)
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            return b"".join(chunks)


def _replay(body: bytes) -> Receive:
    sent = False

    async def receive() -> Message:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


async def _too_many(send: Send, path: str, retry_after_s: int) -> None:
    message = (
        "This request was refused repeatedly and is not retried for "
        f"{retry_after_s} s. Retrying it unchanged will be refused again."
    )
    if path.startswith(_MANAGEMENT_PREFIX):
        body: dict[str, object] = {
            "error": {
                "code": _RATE_LIMITED,
                "message": message,
                "retryable": True,
                "retry_after_s": retry_after_s,
            }
        }
    else:
        body = {"detail": message}
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 429,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
                (b"retry-after", str(retry_after_s).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})

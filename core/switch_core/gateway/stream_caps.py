"""Bounds the long-lived streams one caller and one process hold.

A signed-in person keeps a few gateway streams open for as long as Switch
Console or a browser tab runs: the chats feed (`/chats/events`), the activity
feed (`/chats/activity/events`) and the change notices (`/changes/ws`). Each
holds no database connection while it waits for news, but it holds a task, a
file handle, the reader's state and a subscription, and every one of them
reads the database again whenever its rooms move and on a timer. Gateway
admission (`gateway/admission.py`) does not count them, as they never finish.
So nothing bounded how many one caller opened: a client that opens streams in
a loop without closing them, or a crowd of people arriving on one pod, held as
many as they liked, and each made every message in their rooms cost one more
read.

This middleware bounds both, per kind of stream.

One caller (`caller_key`: the person a session cookie names, else the address
it came from) holds at most `per_caller` streams of each kind in this process.
Console opens one of each per server, so the limit is only met by many windows
or tabs of one person, or by a client that leaks them. Past it, the caller's
oldest stream of that kind is closed to make room for the new one, rather than
the new one refused. A client that lost its network reconnects before the old
stream is noticed gone: the server learns that only when a write to it fails,
and behind a proxy that can take minutes. Refusing the new stream would leave
the person on the dead one, with a feed that never moves; closing the oldest
keeps the one they are reading. A client that leaks streams only closes its
own. The oldest is closed only once it has been open `EVICT_AFTER_S`, so more
live readers than the limit (a person with more tabs than that) do not take
turns closing each other in a loop: the new stream is refused 429 instead, with
`Retry-After` the time until the oldest may be closed.

A stream counts against its caller from the moment it is accepted (its
response starts, or its socket is accepted), never before: a request that
fails authentication closes nothing, so a cookie that was signed out still
cannot close the streams of the person it named.

This process holds at most `per_process` streams of every kind together,
counting those still opening. Past it a new one is refused 503 before any
other work, with a `Retry-After` spread over a few seconds, so the load
balancer sends it to another pod and a crowd turned away does not come back at
once. 0 turns that limit off.

A stream closed here ends as if the server had closed it: a chats feed's
response body ends, a socket gets close code 4429. Clients already reconnect
on both. A refused socket is accepted and closed at once with a `refused`
frame, as the change-notice socket refuses a caller past its own limit, which
is what Console reads.

The counts are this process's own, as the streams are.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import random
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.gateway.admission import STREAMS, caller_key, route_path
from switch_core.keys import Keyring
from switch_core.observability.catalogue import (
    GATEWAY_STREAMS_CLOSED_FOR_NEWER,
    GATEWAY_STREAMS_OPEN,
    GATEWAY_STREAMS_TURNED_AWAY,
)
from switch_core.observability.metrics import GaugeReading, metrics

logger = logging.getLogger(__name__)

# How long a caller's oldest stream must have been open before a new one of
# the same kind closes it. A stream left behind by a lost network is older than
# this by the time its client is back; readers that are all alive and over the
# limit would otherwise close each other as fast as they reconnect.
EVICT_AFTER_S = 30.0
# The range a process refusal's `Retry-After` is drawn from, in seconds.
_PROCESS_RETRY_S = (2, 10)
# How often a caller that keeps being refused is named in the log.
_LOG_EVERY_S = 60.0
# The close code of a socket closed or refused for its caller's limit: 4000
# plus 429, as `gateway/changes.py` closes a socket past its own limit.
_TOO_MANY = 4429
_BUSY = 4503

# The sockets among the streams, by the name their metrics carry. The HTTP
# streams come from `admission.STREAMS`, which admission leaves uncounted.
SOCKETS = {"/changes/ws": "changes"}


class _Refused(Exception):
    """Raised from `send` to stop the app when a stream it accepted may not
    be held."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__(retry_after_s)
        self.retry_after_s = retry_after_s


@dataclass(eq=False)
class _Held:
    """One accepted stream, and how to close it."""

    since: float
    close: Callable[[], None]


def stream_kind(scope: Scope) -> str | None:
    """The kind of long-lived stream a request or socket opens, if any."""
    path = route_path(scope)
    if scope["type"] == "http":
        return STREAMS.get(path)
    if scope["type"] == "websocket":
        return SOCKETS.get(path)
    return None


class GatewayStreamCaps:
    def __init__(
        self,
        app: ASGIApp,
        *,
        per_caller: int,
        per_process: int,
        keyring: Keyring,
    ) -> None:
        self.app = app
        self.per_caller = per_caller
        self.per_process = per_process
        self._keyring = keyring
        # Streams in this process, accepted or still opening.
        self._open = 0
        # Accepted streams by caller and kind, oldest first.
        self._held: dict[tuple[str, str], list[_Held]] = {}
        self._kinds: dict[str, int] = {}
        self._named: dict[str, float] = {}
        metrics().register_observer(self.readings)

    @property
    def open(self) -> int:
        return self._open

    def readings(self) -> Iterable[GaugeReading]:
        for kind, count in self._kinds.items():
            yield GaugeReading(GATEWAY_STREAMS_OPEN, count, {"kind": kind})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = stream_kind(scope)
        if kind is None:
            await self.app(scope, receive, send)
            return
        caller = caller_key(scope, self._keyring)
        if self.per_process and self._open >= self.per_process:
            retry = random.randint(*_PROCESS_RETRY_S)
            self._note_refusal(caller, kind, "process")
            await _refuse(scope, receive, send, 503, retry)
            return
        self._open += 1
        try:
            await self._hold(scope, receive, send, caller, kind)
        finally:
            self._open -= 1

    async def _hold(
        self, scope: Scope, receive: Receive, send: Send, caller: str, kind: str
    ) -> None:
        key = (caller, kind)
        held: _Held | None = None
        closed_here = False
        started = ended = False
        loop = asyncio.get_running_loop()
        try:
            async with asyncio.timeout(None) as deadline:

                def close() -> None:
                    nonlocal closed_here
                    if closed_here:
                        return
                    closed_here = True
                    with contextlib.suppress(RuntimeError):
                        # RuntimeError: the stream ended on its own meanwhile.
                        deadline.reschedule(loop.time())

                async def counted_send(message: Message) -> None:
                    nonlocal held, started, ended
                    if not started and _accepts(message):
                        held = self._take(key, close)
                        if held is None:
                            raise _Refused(self._retry_after(key))
                    if message["type"] in _STARTS:
                        started = True
                    if _ends(message):
                        ended = True
                    await send(message)

                await self.app(scope, receive, counted_send)
        except _Refused as refused:
            self._note_refusal(caller, kind, "caller")
            await _refuse(
                scope, receive, send, 429, refused.retry_after_s, connected=True
            )
        except TimeoutError:
            if not closed_here:
                raise
            if started and not ended:
                # Stopped mid-stream: end it the way the app would have.
                await _end(scope, send)
        finally:
            if held is not None:
                self._give_back(key, held)

    def _take(self, key: tuple[str, str], close: Callable[[], None]) -> _Held | None:
        """Count an accepted stream against its caller, closing the caller's
        oldest of the kind to make room when it may. None when it may not."""
        held = self._held.setdefault(key, [])
        now = time.monotonic()
        if len(held) >= self.per_caller:
            oldest = held[0]
            if now - oldest.since < EVICT_AFTER_S:
                return None
            self._give_back(key, oldest)
            oldest.close()
            metrics().increment(GATEWAY_STREAMS_CLOSED_FOR_NEWER, {"kind": key[1]})
            held = self._held.setdefault(key, [])
        mine = _Held(since=now, close=close)
        held.append(mine)
        self._kinds[key[1]] = self._kinds.get(key[1], 0) + 1
        return mine

    def _give_back(self, key: tuple[str, str], held: _Held) -> None:
        streams = self._held.get(key)
        if streams is None or held not in streams:
            return
        streams.remove(held)
        if not streams:
            del self._held[key]
        self._kinds[key[1]] -= 1

    def _retry_after(self, key: tuple[str, str]) -> int:
        """Seconds until the caller's oldest stream of the kind may be closed."""
        held = self._held.get(key)
        if not held:
            return 1
        left = EVICT_AFTER_S - (time.monotonic() - held[0].since)
        return max(1, math.ceil(left))

    def _note_refusal(self, caller: str, kind: str, reason: str) -> None:
        metrics().increment(
            GATEWAY_STREAMS_TURNED_AWAY, {"kind": kind, "reason": reason}
        )
        now = time.monotonic()
        if now - self._named.get(caller, -_LOG_EVERY_S) < _LOG_EVERY_S:
            return
        self._named[caller] = now
        # Bounded by the callers refused in the last minute.
        self._named = {c: t for c, t in self._named.items() if now - t < _LOG_EVERY_S}
        logger.warning(
            "Refused a %s stream from %s: %s",
            kind,
            caller,
            f"its {self.per_caller} were all opened in the last {EVICT_AFTER_S:.0f} s"
            if reason == "caller"
            else f"this process already holds {self.per_process} streams",
        )


_STARTS = frozenset({"http.response.start", "websocket.accept", "websocket.close"})


def _accepts(message: Message) -> bool:
    """Whether a message the app sends accepts a stream: a successful response
    starting, or a socket accepted."""
    if message["type"] == "websocket.accept":
        return True
    status: int = message.get("status", 0)
    return message["type"] == "http.response.start" and 200 <= status < 300


def _ends(message: Message) -> bool:
    if message["type"] == "http.response.body":
        more: bool = message.get("more_body", False)
        return not more
    return bool(message["type"] == "websocket.close")


async def _end(scope: Scope, send: Send) -> None:
    """End a stream the app was stopped in the middle of."""
    with contextlib.suppress(OSError):
        if scope["type"] == "http":
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        else:
            await send({"type": "websocket.close", "code": _TOO_MANY})


async def _refuse(
    scope: Scope,
    receive: Receive,
    send: Send,
    status: int,
    retry_after_s: int,
    *,
    connected: bool = False,
) -> None:
    """Answer a stream that may not be held. `connected`: a socket's app has
    already read its `websocket.connect`."""
    detail = (
        "You have too many of these streams open. Try again in a moment."
        if status == 429
        else "Switch is busy right now. Try again in a moment."
    )
    if scope["type"] == "websocket":
        # Accepted and closed at once, as `gateway/changes.py` refuses a socket
        # past its own limit, so Console backs off the way it already does.
        if not connected and (await receive())["type"] != "websocket.connect":
            return
        await send({"type": "websocket.accept"})
        await send(
            {
                "type": "websocket.send",
                "text": json.dumps(
                    {
                        "event": "refused",
                        "data": {
                            "status": status,
                            "detail": detail,
                            "retry_after_s": retry_after_s,
                        },
                    }
                ),
            }
        )
        await send(
            {"type": "websocket.close", "code": _TOO_MANY if status == 429 else _BUSY}
        )
        return
    body = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"retry-after", str(retry_after_s).encode()),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})

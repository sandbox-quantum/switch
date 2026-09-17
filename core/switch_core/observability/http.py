"""ASGI middleware counting and timing every request.

Plain ASGI rather than ``BaseHTTPMiddleware``, for the same reason
:mod:`switch_core.request_context` is: that one runs the rest of the app in a
separate task, and this needs to see what the router resolved in the scope the
endpoint actually ran in.

The one thing worth being careful about is the label. A metric keyed by the
request *path* is keyed by an unbounded value — every room id, every agent id,
one series each — which is the cardinality failure the catalogue exists to
prevent, and an HTTP middleware is where it would happen first. So the label is
the route *template* the router matched, and anything unmatched is folded into
a single bucket rather than reported by the path someone happened to ask for.
That also closes the obvious griefing route: an unauthenticated 404 loop would
otherwise mint a series per request.
"""

from __future__ import annotations

import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.observability.catalogue import HTTP_REQUEST_DURATION, HTTP_REQUESTS
from switch_core.observability.metrics import metrics

# Every request the router could not place, under one label. The path is
# deliberately discarded: it is attacker-chosen on a public endpoint.
UNMATCHED_ROUTE = "unmatched"

# A request whose response never started — the client went away mid-flight, or
# the app raised before sending anything.
NO_STATUS = "none"


def route_label(scope: Scope) -> str:
    """The matched route template, or a single bucket for everything else.

    Starlette records what it matched in the scope, and for a request that
    entered a mounted sub-app (the gateway is mounted under ``/gateway``) the
    inner router overwrites it with its own route — whose ``path`` is relative
    to the mount. The mount's own prefix is in ``root_path``, so the two are
    concatenated here; without that, the gateway's ``/rooms`` and the agent
    bridge's ``/rooms`` would be counted as one route.

    Concatenated unconditionally rather than after checking whether the path
    already carries the prefix. That check reads as a safe guard and is not
    one: a route's path is always relative to its mount, so the prefix is never
    already there — but an inner route whose name merely *starts with* the
    mount's own string ("/gatewayish" under "/gateway") satisfies a
    ``startswith`` test and loses its prefix, which is precisely the collision
    this function exists to prevent.
    """
    route = scope.get("route")
    path = getattr(route, "path", None)
    if not isinstance(path, str) or not path:
        return UNMATCHED_ROUTE

    return f"{scope.get('root_path') or ''}{path}"


def status_class(status_code: int) -> str:
    """ "2xx", "4xx", … — the question is "are we failing", not which code.

    The exact code is in the access log and the trace. Keeping it out of the
    metric divides the series count by however many codes a route can return,
    for an answer no dashboard was asking.
    """
    return f"{status_code // 100}xx"


class MetricsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        registry = metrics()
        if not registry.enabled:
            # Nothing configured: not even the clock is read.
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        seen_status: list[int] = []

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                seen_status.append(message["status"])
            await send(message)

        # Starlette's error handler sits *outside* this middleware, so a request
        # that raises past the app never sends a response through `send` here —
        # the 500 is written above us. Without catching it, the one outcome a
        # dashboard most needs would be the one recorded as "no status".
        outcome = NO_STATUS
        try:
            await self.app(scope, receive, send_wrapper)
            if seen_status:
                outcome = status_class(seen_status[0])
        except Exception:
            outcome = "5xx"
            raise
        finally:
            # `finally` rather than the two branches, so a cancelled request —
            # the client hung up mid-response — is still counted, as the
            # unfinished thing it was.
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            method = scope.get("method", "GET")
            # Read after the call: the router fills this in as it dispatches.
            route = route_label(scope)

            registry.increment(
                HTTP_REQUESTS,
                {"route": route, "method": method, "status_class": outcome},
            )
            registry.observe(
                HTTP_REQUEST_DURATION, {"route": route, "method": method}, elapsed_ms
            )

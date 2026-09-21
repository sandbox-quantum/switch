"""ASGI middleware counting and timing every request.

Plain ASGI rather than ``BaseHTTPMiddleware``, which runs the rest of the app
in a separate task and would not see what the router resolved.

The label is the route *template*. The resolved path carries an id per request,
so keying on it would mint a series per room, per agent, per 404.
"""

from __future__ import annotations

import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.observability.catalogue import HTTP_REQUEST_DURATION, HTTP_REQUESTS
from switch_core.observability.metrics import metrics

# Every request the router could not place. The path is discarded: on a public
# endpoint it is attacker-chosen.
UNMATCHED_ROUTE = "unmatched"

# A request whose response never started — the client went away mid-flight, or
# the app raised before sending anything.
NO_STATUS = "none"

# The MCP surface is a mounted Starlette app, and only FastAPI sets
# `scope["route"]`, so without naming it here every MCP call is indistinguishable
# from a 404. One label for the mount: the tool is in the request body, and a
# label read from a body is a label the caller chooses.
MCP_ROUTE = "/mcp"

# Counted but not timed. These are held open until something happens or the
# caller's own timeout expires, so their duration is a client's parameter rather
# than this server's speed — and on a shared axis it flattens every other route.
# `test_every_long_poll_is_untimed` derives this set from the router.
UNTIMED_ROUTES = frozenset(
    {
        "/agents/{agent_id}/events",
        "/agents/{agent_id}/rooms/{room_id}/events",
        "/agents/{agent_id}/notifications",
        MCP_ROUTE,
    }
)


def route_label(scope: Scope) -> str:
    """The matched route template, or a single bucket for everything else.

    A route's path is relative to its mount, and the mount's prefix is in
    ``root_path``; without joining them the gateway's ``/rooms`` and the agent
    bridge's ``/rooms`` are one route. Joined unconditionally — testing whether
    the prefix is "already there" looks like a guard but silently drops it from
    any inner route whose name starts with the mount's own string.
    """
    route = scope.get("route")
    path = getattr(route, "path", None)
    if not isinstance(path, str) or not path:
        raw = scope.get("path", "")
        if raw == MCP_ROUTE or raw.startswith(f"{MCP_ROUTE}/"):
            return MCP_ROUTE
        return UNMATCHED_ROUTE

    return f"{scope.get('root_path') or ''}{path}"


def status_class(status_code: int) -> str:
    """ "2xx", "4xx", … — the question is "are we failing", not which code."""
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
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        seen_status: list[int] = []

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                seen_status.append(message["status"])
            await send(message)

        # Starlette's error handler sits outside this middleware, so a request
        # that raises past the app sends nothing through `send` here — without
        # catching it, the outcome a dashboard most needs reads as "no status".
        outcome = NO_STATUS
        try:
            await self.app(scope, receive, send_wrapper)
            if seen_status:
                outcome = status_class(seen_status[0])
        except Exception:
            outcome = "5xx"
            raise
        finally:
            # `finally` so a cancelled request is still counted, as the
            # unfinished thing it was.
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            method = scope.get("method", "GET")
            route = route_label(scope)

            registry.increment(
                HTTP_REQUESTS,
                {"route": route, "method": method, "status_class": outcome},
            )
            if route not in UNTIMED_ROUTES:
                registry.observe(
                    HTTP_REQUEST_DURATION,
                    {"route": route, "method": method},
                    elapsed_ms,
                )

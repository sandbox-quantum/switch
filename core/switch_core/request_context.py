"""ASGI middleware binding a request id to the log context.

Outermost in the stack, so every line emitted while serving a request — ours,
uvicorn's, a library's — can be tied back to the request that caused it. The
identifiers a request is *about* are bound further in, where they are resolved:
the agent by the bearer middleware, the user by the gateway's authentication
dependency.

Plain ASGI rather than Starlette's ``BaseHTTPMiddleware`` on purpose: that one
runs the rest of the app in a separate task, so a context variable set here
would not be visible to the endpoint.
"""

from __future__ import annotations

from uuid import uuid4

from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.logging_context import log_context

_REQUEST_ID_HEADER = b"x-request-id"
# An id from a caller is untrusted input that ends up in every log line for the
# request, so it is truncated and stripped of anything that could forge a line.
_MAX_REQUEST_ID_LENGTH = 64


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        with log_context(request_id=_request_id(scope)):
            await self.app(scope, receive, send)


def _request_id(scope: Scope) -> str:
    headers = dict(scope.get("headers", []))
    raw = headers.get(_REQUEST_ID_HEADER, b"").decode("utf-8", "replace")
    sanitised = "".join(c for c in raw if c.isprintable() and c not in " \t")
    return sanitised[:_MAX_REQUEST_ID_LENGTH] or uuid4().hex

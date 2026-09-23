"""ASGI middleware binding a request's own identifiers to the log context.

Outermost in the stack, so every line emitted while serving a request — ours,
uvicorn's, a library's — can be tied back to the request that caused it. The
identifiers a request is *about* are bound further in, where they are resolved:
the agent by the bearer middleware, the user by the gateway's authentication
dependency.

Two things are read here, from the request itself:

- **The request id**, from ``X-Request-Id`` or generated.
- **The Switch Console that sent it**, from ``X-Switch-Console-Id`` and
  ``X-Switch-Console-Name``. A server a Console runs for its user on a shared
  VM is signed into by everyone with access to that VM, all as the one account
  the stack was seeded with, so ``user_id`` cannot say which of them acted.
  These two can. They are attribution for someone reading the logs, not
  authentication — any caller can send them — so nothing may be authorised on
  them, and a request without them is served exactly as before.

Plain ASGI rather than Starlette's ``BaseHTTPMiddleware`` on purpose: that one
runs the rest of the app in a separate task, so a context variable set here
would not be visible to the endpoint.
"""

from __future__ import annotations

import string
from uuid import uuid4

from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.logging_context import log_context

_REQUEST_ID_HEADER = b"x-request-id"
_CONSOLE_ID_HEADER = b"x-switch-console-id"
_CONSOLE_NAME_HEADER = b"x-switch-console-name"

# Everything read here is untrusted input that ends up in every log line for
# the request, so each value is truncated and stripped of anything that could
# forge a line or break the `key=value` text format.
_MAX_REQUEST_ID_LENGTH = 64
# A console id is a UUID; the canonical form is 36 characters.
_MAX_CONSOLE_ID_LENGTH = 36
_CONSOLE_ID_CHARACTERS = frozenset(string.hexdigits + "-")
# A console name is `user@host`: POSIX user names and DNS host names both fit
# in this set, and nothing in it can end a field in either log format.
_MAX_CONSOLE_NAME_LENGTH = 64
_CONSOLE_NAME_CHARACTERS = frozenset(string.ascii_letters + string.digits + "._@+-")


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        with log_context(
            request_id=_request_id(headers),
            console_id=_restricted(
                headers,
                _CONSOLE_ID_HEADER,
                _CONSOLE_ID_CHARACTERS,
                _MAX_CONSOLE_ID_LENGTH,
            ),
            console_name=_restricted(
                headers,
                _CONSOLE_NAME_HEADER,
                _CONSOLE_NAME_CHARACTERS,
                _MAX_CONSOLE_NAME_LENGTH,
            ),
        ):
            await self.app(scope, receive, send)


def _header(headers: dict[bytes, bytes], name: bytes) -> str:
    return headers.get(name, b"").decode("utf-8", "replace")


def _request_id(headers: dict[bytes, bytes]) -> str:
    raw = _header(headers, _REQUEST_ID_HEADER)
    sanitised = "".join(c for c in raw if c.isprintable() and c not in " \t")
    return sanitised[:_MAX_REQUEST_ID_LENGTH] or uuid4().hex


def _restricted(
    headers: dict[bytes, bytes], name: bytes, allowed: frozenset[str], limit: int
) -> str | None:
    """The header's value reduced to `allowed` characters and `limit` long, or
    None when nothing is left — an absent header and a wholly hostile one are
    both simply unattributed."""
    kept = "".join(c for c in _header(headers, name) if c in allowed)
    return kept[:limit] or None

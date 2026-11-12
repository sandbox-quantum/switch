"""One shared Origin check for cookie-authenticated changes, and the
frame-blocking headers.

Switch web signs people in with the `switch_auth` cookie (`SameSite=Lax`).
Lax keeps the cookie off a cross-site POST, but not off one from a sibling
subdomain, which is the same site. So every POST, PUT, PATCH and DELETE that
carries the cookie passes only if:

1. `Origin` is present and is one of the server's own origins (`null` never
   is);
2. or there's no `Origin`, and `Referer`'s origin is one of them;
3. or there's neither, and no `Sec-Fetch-Site` either. Every current browser
   sends `Sec-Fetch-Site` on every request and `Origin` on every change, so a
   request with none of the three isn't a browser's, and a forged request
   needs the browser to carry the cookie. That's how Switch Console's main
   process keeps working: Node's fetch sends the cookie with only
   `sec-fetch-mode: cors`. Temporary, until Console sends `Origin` itself.
   A WebSocket handshake follows the same three rules, as Console's change
   socket (`/changes/ws`) is opened the same way.

A cookie request is checked whatever else it carries, an `Authorization`
header included, so a bad or empty bearer can never carry it past the check.
Requests without the cookie (controllers, agents, the operator worker, the
provisioner) aren't checked: a browser can't attach their bearer to a
cross-origin request without a preflight, which fails with no CORS.

**Sign-in is checked even with no cookie**
(`SIGN_IN_PATHS`: password sign-in, sign-up and the OIDC exchange), under the
same three rules, so a foreign page can't sign a browser into another
account. Rule 3 still lets Console's main process sign in. Sign-out and
refresh carry the cookie, so they were already checked.

Anything else is a 403 with one fixed message and one WARN that names the
method and the rule, never the origin, the cookie or the body.

The server's own origins come only from config, built once at start:
`gateway_public_url`, `frontend_base_url`, the host browser sign-in returns
to, and `gateway_extra_origins` (for local development). With none, the
request's own `Host` is the one allowed host, and a WARN says production must
set `GATEWAY_PUBLIC_URL`.
"""

from __future__ import annotations

import ipaddress
import json
import logging
from collections.abc import Iterable
from urllib.parse import urlsplit

from starlette.requests import cookie_parser
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.config import SwitchConfig

logger = logging.getLogger(__name__)

COOKIE = "switch_auth"
CHECKED_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
REFUSAL = "This request didn't come from Switch."
# Checked with or without the cookie: a browser has none yet when it signs in.
SIGN_IN_PATHS = frozenset({"/auth/login", "/auth/signup", "/auth/oidc/exchange"})
_DEFAULT_PORTS = {"http": 80, "https": 443}
_LOOPBACK_NAMES = frozenset({"localhost"})


def normalise_origin(value: str | None) -> str | None:
    """`scheme://host[:port]`, lower case, with the scheme's default port
    dropped and any path, query or trailing slash ignored. None for anything
    that isn't an http(s) URL with a host."""
    if not value:
        return None
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if scheme not in _DEFAULT_PORTS or not host:
        return None
    if ":" in host:
        host = f"[{host}]"
    if port is None or port == _DEFAULT_PORTS[scheme]:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def _is_loopback(host: str) -> bool:
    if host in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def check_extra_origin(entry: str) -> str:
    """One `gateway_extra_origins` entry: scheme, host and optional port only,
    and plain `http://` only for a loopback host. Returns
    the normalised origin; raises ValueError otherwise."""
    origin = normalise_origin(entry)
    parts = urlsplit(entry.strip())
    if origin is None or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError(
            "GATEWAY_EXTRA_ORIGINS entries must be scheme://host[:port], with no path"
        )
    if parts.scheme.lower() == "http" and not _is_loopback(
        (parts.hostname or "").lower()
    ):
        raise ValueError(
            "GATEWAY_EXTRA_ORIGINS may use http:// only for localhost or a "
            "loopback address; use https:// for anything else"
        )
    return origin


def allowed_origins(config: SwitchConfig) -> frozenset[str]:
    """The server's own origins, from config only."""
    found: list[str | None] = [
        normalise_origin(config.gateway_public_url),
        normalise_origin(config.frontend_base_url),
    ]
    if config.gateway_oidc_enabled:
        found.append(normalise_origin(config.gateway_oidc_redirect_url))
    found.extend(check_extra_origin(e) for e in config.gateway_extra_origins)
    return frozenset(o for o in found if o is not None)


def log_origin_setup(config: SwitchConfig, allowed: frozenset[str]) -> None:
    """Once at start: say how the check is running."""
    if not allowed:
        logger.warning(
            "No server origins are configured, so the Origin check allows only "
            "the request's own host. Production must set GATEWAY_PUBLIC_URL."
        )
    if config.gateway_extra_origins:
        logger.warning(
            "GATEWAY_EXTRA_ORIGINS adds %d origin(s) to the Origin check; "
            "it's meant for local development only",
            len(config.gateway_extra_origins),
        )


def _headers(scope: Scope) -> dict[str, str]:
    """The request's headers by lower-case name; a repeated header keeps its
    first value."""
    out: dict[str, str] = {}
    for raw_name, raw_value in scope.get("headers") or []:
        name = raw_name.decode("latin-1").lower()
        out.setdefault(name, raw_value.decode("latin-1"))
    return out


def _has_cookie(cookie_header: str | None) -> bool:
    """Whether the request carries the sign-in cookie, read with the same
    parser sign-in uses (`request.cookies`, Starlette's `cookie_parser`), so
    the two always agree. If the name appears anywhere in the header, the
    request is checked too, so a malformed cookie can't hide it."""
    if not cookie_header:
        return False
    return COOKIE in cookie_parser(cookie_header) or COOKIE in cookie_header


def _is_sign_in(scope: Scope) -> bool:
    """Whether this is one of the sign-in routes, on the gateway app's own
    paths: a mount's prefix (`/gateway`) is taken off first."""
    path = scope.get("path") or ""
    root = scope.get("root_path") or ""
    if root and path.startswith(root):
        path = path[len(root) :]
    return path.rstrip("/") in SIGN_IN_PATHS


def _host_origin(headers: dict[str, str], scope: Scope) -> str | None:
    """With no configured origins: the request's own host, as an origin with
    either scheme (a TLS proxy in front makes the scheme unreliable)."""
    host = headers.get("host")
    if not host:
        return None
    return normalise_origin(f"https://{host}")


def refusal_rule(scope: Scope, allowed: frozenset[str]) -> str | None:
    """Which rule refuses this request, or None when it may pass."""
    if scope["type"] == "http":
        if scope["method"] not in CHECKED_METHODS:
            return None
    elif scope["type"] != "websocket":
        return None
    headers = _headers(scope)
    if not _has_cookie(headers.get("cookie")) and not (
        scope["type"] == "http" and _is_sign_in(scope)
    ):
        return None
    ok = _matcher(allowed, headers, scope)
    origin = headers.get("origin")
    if origin is not None:
        if origin.strip().lower() == "null":
            return "origin_null"
        return None if ok(normalise_origin(origin)) else "origin"
    referer = headers.get("referer")
    if referer is not None:
        return None if ok(normalise_origin(referer)) else "referer"
    if "sec-fetch-site" in headers:
        # A browser: it sends Origin on every change and on every WebSocket
        # handshake, so one without is refused.
        if scope["type"] == "websocket":
            return "websocket_no_origin"
        return "browser_no_origin"
    # Rule 3, for a WebSocket too: Switch Console's main process opens the
    # change socket (`/changes/ws`) with Node's WebSocket, which sends the
    # cookie with no Origin, Referer or Sec-Fetch-Site.
    return None


def _matcher(allowed: frozenset[str], headers: dict[str, str], scope: Scope):
    if allowed:
        return lambda origin: origin is not None and origin in allowed
    own = _host_origin(headers, scope)

    def same_host(origin: str | None) -> bool:
        if origin is None or own is None:
            return False
        return origin.split("://", 1)[1] == own.split("://", 1)[1]

    return same_host


class OriginCheckMiddleware:
    """The Origin check, on the gateway app, plus `X-Frame-Options: DENY` on
    every answer it sends."""

    def __init__(self, app: ASGIApp, allowed: Iterable[str]) -> None:
        self.app = app
        self.allowed = frozenset(allowed)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        rule = refusal_rule(scope, self.allowed)
        if rule is not None:
            logger.warning(
                "Refused a cookie request that didn't come from Switch",
                extra={"method": scope.get("method", "WEBSOCKET"), "rule": rule},
            )
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4403})
                return
            await _send_refusal(send)
            return
        if scope["type"] == "websocket":
            await self.app(scope, receive, send)
            return

        async def send_with_frame_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers") or [])
                if not any(k.lower() == b"x-frame-options" for k, _ in headers):
                    headers.append((b"x-frame-options", b"DENY"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_frame_header)


async def _send_refusal(send: Send) -> None:
    body = json.dumps({"detail": REFUSAL}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"x-frame-options", b"DENY"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})

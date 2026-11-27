"""The operator dashboard, served by switch-core on the API's own origin.

The dashboard is a single-page app: every page is the same `index.html`, and
the browser's router picks what to draw from the path. Serving it here gives a
server one address, the one agents already use, rather than the API on one
origin and the dashboard on another.

It answers ahead of the bearer middleware, because a person loading a page
holds a cookie rather than an agent key. So what it answers is an exact list:
the built files by name, and the dashboard's page paths, which
`test_gateway_ui.py` holds equal to the routes the dashboard declares. The one
fallback is a browser navigating to a path nothing else answers (a mistyped or
retired link): it gets the dashboard with a 404, so the dashboard's own "no
page here" shows rather than the bearer middleware's 401, which reads as a
sign-in problem. Everything else passes through untouched.

Every page carries a Content-Security-Policy and refuses to be framed. Names
and descriptions anyone in a workspace can set are drawn on these pages, so
script the dashboard didn't ship must not run, and another site must not be
able to put a signed-in page under someone's clicks.

The API wins any path both could answer. `/agents` is where they meet: the
dashboard has pages at `/agents` and `/agents/{agent_id}`, while the API
registers agents with a POST to `/agents` and also answers GET
`/agents/feature-flags`. So before serving, the middleware asks the app's
router whether an API route takes the request as a GET or a HEAD, and passes
it on if one does. That holds for routes added after the middleware is built, such as
the management and messaging routes `main.run` installs.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from starlette.responses import FileResponse
from starlette.routing import Match, Router
from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.observability.http import GATEWAY_UI_SCOPE_KEY

logger = logging.getLogger(__name__)

# The dashboard's page routes, as `gateway/src/App.tsx` and its route table
# (`gateway/src/routes/routeTable.tsx`) declare them, the URLs that only
# redirect to a page that moved included.
PAGE_PATHS: tuple[str, ...] = (
    "/",
    "/login",
    "/invite",
    # Where Switch Console's sign-in link opens.
    "/auth/handoff",
    "/ecosystem",
    # Behind `gateway_chats`.
    "/chats",
    "/chats/agents/{agent_id}",
    "/chats/rooms/{room_id}",
    "/chats/{room_id}",
    "/rooms",
    "/rooms/new",
    "/rooms/groups",
    "/rooms/graph",
    "/rooms/{room_id}",
    "/rooms/{room_id}/manage",
    "/rooms/{room_id}/documents/{document_id}",
    "/resources",
    "/resources/references/{id}",
    "/resources/documents/{id}",
    "/resources/packages/{id}",
    "/resources/templates/{id}",
    "/agents",
    "/agents/{agent_id}",
    "/agents/{agent_id}/manage",
    "/machines",
    "/collaborations",
    "/registration-keys",
    "/usage",
    "/connectors",
    "/workspace",
    "/workspace/private-channel-rooms",
    "/organization",
    # Behind `gateway_onboarding`.
    "/get-started",
    "/overview",
    "/templates",
    "/templates/{id}",
    "/connectors/{connector_id}",
    "/settings",
    "/settings/general",
    "/settings/general/private-channel-rooms",
    "/settings/users",
    "/settings/room-groups",
    "/settings/room-graph",
    "/settings/messaging-apps",
    "/settings/connectors",
    "/settings/api-keys",
    "/settings/guardrails",
    "/settings/message-routing",
    "/settings/ai-providers",
    "/settings/devices",
    "/settings/account",
    "/settings/org",
    "/settings/org/general",
    "/settings/org/workspaces",
    "/settings/org/users",
    "/settings/org/connectors",
    "/settings/org/connector-apps",
    "/settings/org/guardrails",
    "/settings/org/devices",
    "/settings/org/audit-log",
    # Pages the dashboard no longer has, which it redirects.
    "/users",
    "/operator/workspaces",
    "/platform",
    "/platform/workspaces",
    "/platform/users",
    "/platform/connectors",
)

_PARAM = re.compile(r"\{[^/}]+\}")

_PAGE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(
        "^"
        + "/".join(
            "[^/]+" if _PARAM.fullmatch(segment) else re.escape(segment)
            for segment in path.split("/")
        )
        + "$"
    )
    for path in PAGE_PATHS
)

# Vite names every file under `assets/` by its content hash, so a cached copy
# can never be stale. Everything else, `index.html` above all, names whichever
# build is current and must be revalidated.
_HASHED_PREFIX = "/assets/"
_IMMUTABLE = "public, max-age=31536000, immutable"
_REVALIDATE = "no-cache"

# Styles inline because MUI writes its styles into the page at runtime. Images
# from anywhere over HTTPS because connector logos and agent icons are hosted
# by their vendors. Everything else only from this origin.
_CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    )
)
_PAGE_HEADERS = {
    "Content-Security-Policy": _CONTENT_SECURITY_POLICY,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
}


def is_page(path: str) -> bool:
    """Whether `path` is one of the dashboard's pages."""
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return any(pattern.match(path) for pattern in _PAGE_PATTERNS)


class GatewayUiNotBuiltError(RuntimeError):
    """The configured directory holds no built dashboard."""


@dataclass(frozen=True)
class GatewayUi:
    """A built dashboard: its `index.html` and every file beside it, by URL path."""

    index: Path
    files: dict[str, Path]

    @classmethod
    def load(cls, directory: Path) -> GatewayUi:
        """Read the build in `directory` (the dashboard's `dist/`).

        Raises rather than serving nothing: a server told where its dashboard
        is, and finding none, would otherwise answer every page with a 401 from
        the bearer middleware, which reads as a sign-in problem.
        """
        index = directory / "index.html"
        if not index.is_file():
            raise GatewayUiNotBuiltError(
                f"GATEWAY_UI_DIR is {directory}, which has no index.html. Point "
                "it at the dashboard's build output (`npm run build` in "
                "gateway/ writes gateway/dist), or unset it to serve no dashboard."
            )
        files = {
            "/" + path.relative_to(directory).as_posix(): path
            for path in sorted(directory.rglob("*"))
            if path.is_file()
        }
        logger.info("serving the dashboard from %s (%d files)", directory, len(files))
        return cls(index=index, files=files)

    def resolve(self, path: str) -> tuple[Path, str] | None:
        """The file answering `path` and its Cache-Control, or None to pass it on."""
        file = self.files.get(path)
        if file is not None:
            return file, _IMMUTABLE if path.startswith(_HASHED_PREFIX) else _REVALIDATE
        if is_page(path):
            return self.index, _REVALIDATE
        return None


def _is_navigation(scope: Scope) -> bool:
    """Whether a browser is loading this path as a page, not an API call."""
    headers: list[tuple[bytes, bytes]] = scope.get("headers", [])
    for name, value in headers:
        if name == b"sec-fetch-mode":
            return value == b"navigate"
        if name == b"accept" and b"text/html" in value:
            return True
    return False


def _api_answers(router: Router, scope: Scope) -> bool:
    """Whether a route on `router` would take this request as a GET or a HEAD.

    Both, whatever the request's own method: FastAPI gives a GET route no HEAD
    of its own, so a HEAD for an API path would otherwise match only partially
    and be taken for a page, and a route declared for HEAD alone would be
    missed by asking only for GET.
    """
    return any(
        route.matches({**scope, "method": method})[0] is Match.FULL
        for method in ("GET", "HEAD")
        for route in router.routes
    )


class GatewayUiMiddleware:
    """Answers a GET or HEAD for a dashboard file or page; passes on the rest.

    `router` is the app's own, read on every request rather than copied, so a
    route added once the app is built still takes precedence over a page.
    """

    def __init__(self, app: ASGIApp, ui: GatewayUi, router: Router) -> None:
        self.app = app
        self.ui = ui
        self.router = router

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in ("GET", "HEAD"):
            await self.app(scope, receive, send)
            return
        resolved = self.ui.resolve(scope["path"])
        status_code = 200
        if resolved is None and _is_navigation(scope):
            resolved = (self.ui.index, _REVALIDATE)
            status_code = 404
        if resolved is None or _api_answers(self.router, scope):
            await self.app(scope, receive, send)
            return
        file, cache_control = resolved
        scope[GATEWAY_UI_SCOPE_KEY] = True
        response = FileResponse(
            file,
            status_code=status_code,
            headers={"Cache-Control": cache_control, **_PAGE_HEADERS},
        )
        await response(scope, receive, send)

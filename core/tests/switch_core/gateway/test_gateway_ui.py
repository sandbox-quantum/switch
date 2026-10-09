"""switch-core serves the operator dashboard on the API's own origin.

What matters most is what it must not do: answer a request the API owns. The
dashboard runs ahead of the bearer middleware, so a page path that shadowed an
API route would serve HTML where an agent expects JSON, and would do it without
asking for credentials.
"""

import re
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.gateway.ui import (
    PAGE_PATHS,
    GatewayUi,
    GatewayUiMiddleware,
    GatewayUiNotBuiltError,
    is_page,
)
from switch_core.keys import Keyring
from switch_core.observability.catalogue import HTTP_REQUESTS
from switch_core.observability.http import GATEWAY_UI_ROUTE, MetricsMiddleware
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.trust.client import NullTrustClient

_APP_TSX = Path(__file__).resolve().parents[4] / "gateway/src/App.tsx"

_INDEX = "<!doctype html><title>dashboard</title>"
_SCRIPT = "console.log('dashboard')"
_LOGO = "<svg/>"


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text(_INDEX)
    (tmp_path / "assets/index-3f9a1c.js").write_text(_SCRIPT)
    (tmp_path / "switch_logo_dark.svg").write_text(_LOGO)
    return tmp_path


class _RejectEverything:
    """Stands in for the bearer middleware: nothing gets past without a key."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        await JSONResponse({"detail": "unauthorized"}, status_code=401)(
            scope, receive, send
        )


def _app(dist: Path) -> FastAPI:
    app = FastAPI()

    @app.post("/agents")
    async def register(request: Request) -> dict[str, str]:
        return {"registered": "yes"}

    @app.get("/rooms/special")
    async def special() -> dict[str, str]:
        return {"api": "yes"}

    app.add_middleware(_RejectEverything)
    app.add_middleware(GatewayUiMiddleware, ui=GatewayUi.load(dist), router=app.router)
    return app


def _client(dist: Path) -> TestClient:
    return TestClient(_app(dist))


# ── Which paths are pages ────────────────────────────────────────────────────


def _normalized(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "{}", path)


def _app_tsx_routes() -> set[str]:
    """Every page route `gateway/src/App.tsx` declares, as an absolute template."""
    source = _APP_TSX.read_text()
    routes = {"/"} if re.search(r"<Route\s+index\b", source) else set()
    for path in re.findall(r'<Route\b[^>]*?\bpath="([^"]+)"', source, re.DOTALL):
        if path == "*":
            continue
        absolute = path if path.startswith("/") else f"/{path}"
        routes.add(re.sub(r":[A-Za-z_]+", "{}", absolute))
    return routes


def test_the_page_list_is_exactly_the_dashboards_routes() -> None:
    declared = _app_tsx_routes()
    listed = {_normalized(path) for path in PAGE_PATHS}
    assert declared, "found no routes in gateway/src/App.tsx; has it moved?"
    assert listed == declared, (
        "PAGE_PATHS in switch_core/gateway/ui.py must match the routes in "
        f"gateway/src/App.tsx. Missing: {sorted(declared - listed)}; "
        f"not in the dashboard: {sorted(listed - declared)}."
    )


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/login",
        "/rooms",
        "/rooms/",
        "/rooms/new",
        "/rooms/4b1d",
        "/rooms/4b1d/documents/77",
        "/resources/templates/9",
        "/agents",
        "/agents/4b1d",
        "/workspace",
    ],
)
def test_a_dashboard_path_is_a_page(path: str) -> None:
    assert is_page(path)


@pytest.mark.parametrize(
    "path",
    [
        "/agents/4b1d/events",
        "/agents/4b1d/connection/ws",
        "/rooms/4b1d/members",
        "/health",
        "/mcp",
        "/gateway/rooms",
        "/v1/management/controllers",
        "/version",
        "",
    ],
)
def test_any_other_path_is_not_a_page(path: str) -> None:
    assert not is_page(path)


def _agent_bridge_app(gateway_ui: GatewayUi | None) -> FastAPI:
    class _Config:
        agent_auth_cache_ttl_seconds = 1
        agent_auth_cache_max_entries = 16
        keyring = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
        oauth_issuer_url = None
        oauth_audience = None
        oauth_verify_issuer = True
        id_server_name = "test"

    app, _ = create_agent_bridge_app(
        agent_store=object(),  # type: ignore[arg-type]
        agent_session_store=object(),  # type: ignore[arg-type]
        room_store=object(),  # type: ignore[arg-type]
        room_service=object(),  # type: ignore[arg-type]
        client_lifecycle=object(),  # type: ignore[arg-type]
        collab_lifecycle=object(),  # type: ignore[arg-type]
        event_buffer=EventBuffer(sequence_base=0),
        task_store=object(),  # type: ignore[arg-type]
        resource_service=object(),  # type: ignore[arg-type]
        api_key_store=object(),  # type: ignore[arg-type]
        external_user_store=object(),  # type: ignore[arg-type]
        bridge_store=object(),  # type: ignore[arg-type]
        session_factory=object(),
        config=_Config(),  # type: ignore[arg-type]
        approval_outcomes=object(),  # type: ignore[arg-type]
        controller_auth=None,
        trust_client=NullTrustClient(),
        gateway_ui=gateway_ui,
    )
    return app


def test_the_api_wins_a_path_both_could_answer(dist: Path) -> None:
    # `/rooms/special` fits the dashboard's `/rooms/{room_id}`, but the app has
    # a GET route there, so it reaches the app (here, a rejection) and is never
    # served the page.
    assert _client(dist).get("/rooms/special").status_code == 401
    assert _client(dist).head("/rooms/special").status_code == 401


def test_a_route_added_after_the_middleware_still_wins(dist: Path) -> None:
    app = _app(dist)
    client = TestClient(app)
    assert client.get("/rooms/later").text == _INDEX

    @app.get("/rooms/later")
    async def later() -> dict[str, str]:
        return {"api": "yes"}

    assert client.get("/rooms/later").status_code == 401


def test_the_agent_apis_own_get_under_agents_is_not_a_page(dist: Path) -> None:
    # The one place the API and the dashboard meet today: `/agents/{agent_id}`
    # is a page, and the API answers GET `/agents/feature-flags`.
    client = TestClient(_agent_bridge_app(gateway_ui=GatewayUi.load(dist)))
    response = client.get("/agents/feature-flags")
    assert response.status_code == 401
    assert response.text != _INDEX


# ── Loading a build ──────────────────────────────────────────────────────────


def test_a_directory_with_no_build_is_refused(tmp_path: Path) -> None:
    with pytest.raises(GatewayUiNotBuiltError, match="GATEWAY_UI_DIR"):
        GatewayUi.load(tmp_path)


def test_a_missing_directory_is_refused(tmp_path: Path) -> None:
    with pytest.raises(GatewayUiNotBuiltError, match="no index.html"):
        GatewayUi.load(tmp_path / "absent")


def test_a_path_that_climbs_out_of_the_build_resolves_to_nothing(dist: Path) -> None:
    # Only exact names are served, so there is nothing to climb with; the HTTP
    # client would normalise the dots away before sending, so this asks directly.
    ui = GatewayUi.load(dist)
    assert ui.resolve("/assets/../index.html") is None
    assert ui.resolve("/../index.html") is None


def test_every_built_file_is_indexed_by_its_url_path(dist: Path) -> None:
    ui = GatewayUi.load(dist)
    assert set(ui.files) == {
        "/index.html",
        "/assets/index-3f9a1c.js",
        "/switch_logo_dark.svg",
    }
    assert ui.index == dist / "index.html"


# ── Serving ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path", ["/", "/rooms", "/rooms/4b1d", "/agents", "/agents/4b1d", "/login"]
)
def test_a_page_is_the_index_and_is_always_revalidated(dist: Path, path: str) -> None:
    response = _client(dist).get(path)
    assert response.status_code == 200
    assert response.text == _INDEX
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"


def test_a_hashed_asset_is_cached_for_good(dist: Path) -> None:
    response = _client(dist).get("/assets/index-3f9a1c.js")
    assert response.status_code == 200
    assert response.text == _SCRIPT
    assert "javascript" in response.headers["content-type"]
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_an_unhashed_file_is_revalidated(dist: Path) -> None:
    response = _client(dist).get("/switch_logo_dark.svg")
    assert response.status_code == 200
    assert response.text == _LOGO
    assert response.headers["cache-control"] == "no-cache"


def test_a_head_request_gets_headers_and_no_body(dist: Path) -> None:
    response = _client(dist).head("/rooms")
    assert response.status_code == 200
    assert response.content == b""
    assert response.headers["content-length"] == str(len(_INDEX))


@pytest.mark.parametrize(
    "path",
    [
        "/agents/4b1d/events",
        "/health",
        "/mcp",
        "/assets/missing.js",
        "/rooms/4b1d/members",
    ],
)
def test_a_get_the_dashboard_does_not_own_reaches_the_api(
    dist: Path, path: str
) -> None:
    response = _client(dist).get(path)
    assert response.status_code == 401
    assert response.json() == {"detail": "unauthorized"}


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_only_a_read_is_answered_at_a_page_path(dist: Path, method: str) -> None:
    # `/agents` is where an agent registers, with a POST.
    response = _client(dist).request(method, "/agents")
    assert response.status_code == 401


# ── On the real agent bridge app ─────────────────────────────────────────────


def test_the_agent_bridge_serves_pages_without_a_key(dist: Path) -> None:
    client = TestClient(_agent_bridge_app(gateway_ui=GatewayUi.load(dist)))
    for path in ("/", "/agents", "/agents/4b1d", "/rooms/4b1d"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.text == _INDEX


def test_the_agent_bridge_still_demands_a_key_for_the_api(dist: Path) -> None:
    client = TestClient(_agent_bridge_app(gateway_ui=GatewayUi.load(dist)))
    assert client.post("/agents", json={}).status_code == 401
    assert client.get("/agents/4b1d/events").status_code == 401
    assert client.get("/version").status_code == 401


def test_without_a_build_the_agent_bridge_serves_no_pages() -> None:
    client = TestClient(_agent_bridge_app(gateway_ui=None))
    assert client.get("/").status_code == 401
    assert client.get("/rooms").status_code == 401


# ── Metrics ──────────────────────────────────────────────────────────────────


@pytest.fixture
def registry():
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def test_every_page_load_is_counted_under_one_label(
    dist: Path, registry: MetricsRegistry
) -> None:
    app = FastAPI()
    app.add_middleware(_RejectEverything)
    app.add_middleware(GatewayUiMiddleware, ui=GatewayUi.load(dist), router=app.router)
    app.add_middleware(MetricsMiddleware)
    client = TestClient(app)
    for path in ("/rooms/a", "/rooms/b", "/assets/index-3f9a1c.js", "/agents/c"):
        client.get(path)

    payload = next(p for p in registry.collect() if p.name == HTTP_REQUESTS.name)
    counts = {
        point.attributes["route"]: point.value
        for point in payload.numbers
        if point.attributes["status_class"] == "2xx"
    }
    # A label per page would be a series per room id.
    assert counts == {GATEWAY_UI_ROUTE: 4.0}

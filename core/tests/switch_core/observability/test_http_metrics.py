import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from switch_core.observability.catalogue import HTTP_REQUEST_DURATION, HTTP_REQUESTS
from switch_core.observability.http import MetricsMiddleware
from switch_core.observability.metrics import MetricsRegistry, install, uninstall


@pytest.fixture
def registry():
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _app() -> FastAPI:
    app = FastAPI()
    inner = FastAPI()

    @app.get("/rooms/{room_id}")
    async def room(room_id: str) -> dict[str, str]:
        return {"id": room_id}

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("boom")

    @inner.get("/rooms")
    async def gateway_rooms() -> list[str]:
        return []

    app.mount("/gateway", inner)
    app.add_middleware(MetricsMiddleware)
    return app


def _counts(registry: MetricsRegistry) -> dict[tuple, float]:
    payload = next(p for p in registry.collect() if p.name == HTTP_REQUESTS.name)
    return {
        tuple(sorted(point.attributes.items())): point.value
        for point in payload.numbers
    }


def test_a_path_parameter_does_not_become_a_series(registry):
    with TestClient(_app()) as client:
        for room_id in ("a", "b", "c"):
            client.get(f"/rooms/{room_id}")

    counts = _counts(registry)
    # Three requests, one series: keyed by the template, not the id.
    assert len(counts) == 1
    assert next(iter(counts.values())) == 3.0
    assert dict(next(iter(counts))) == {
        "route": "/rooms/{room_id}",
        "method": "GET",
        "status_class": "2xx",
    }


def test_an_unmatched_path_is_folded_into_one_bucket(registry):
    with TestClient(_app()) as client:
        for index in range(5):
            client.get(f"/nope/{index}")

    counts = _counts(registry)
    # Otherwise an unauthenticated 404 loop mints a series per request.
    assert len(counts) == 1
    attributes = dict(next(iter(counts)))
    assert attributes["route"] == "unmatched"
    assert attributes["status_class"] == "4xx"


def test_a_mounted_route_keeps_its_prefix(registry):
    with TestClient(_app()) as client:
        client.get("/gateway/rooms")

    routes = {dict(key)["route"] for key in _counts(registry)}
    # The gateway's /rooms and the bridge's /rooms are different routes and
    # must not be counted as one.
    assert routes == {"/gateway/rooms"}


def test_an_unhandled_exception_is_still_counted(registry):
    client = TestClient(_app(), raise_server_exceptions=False)
    client.get("/boom")

    counts = _counts(registry)
    attributes = dict(next(iter(counts)))
    assert attributes["route"] == "/boom"
    assert attributes["status_class"] == "5xx"


def test_duration_is_recorded_per_route(registry):
    with TestClient(_app()) as client:
        client.get("/rooms/a")

    payload = next(
        p for p in registry.collect() if p.name == HTTP_REQUEST_DURATION.name
    )
    point = payload.histograms[0]
    assert point.count == 1
    assert point.attributes == {"route": "/rooms/{room_id}", "method": "GET"}


def test_nothing_is_recorded_when_no_registry_is_installed():
    uninstall()
    with TestClient(_app()) as client:
        response = client.get("/rooms/a")
    # The middleware must be transparent when observability is off, which is
    # every test and every unconfigured deployment.
    assert response.status_code == 200


def test_an_inner_route_sharing_the_mounts_name_keeps_its_prefix(registry):
    """The collision a `startswith` check silently allowed.

    `/gatewayish` under a `/gateway` mount starts with the mount's own string,
    so a prefix test that asked "is it already prefixed?" answered yes and
    dropped it — losing exactly the distinction this label exists to keep.
    """
    app = FastAPI()
    inner = FastAPI()

    @inner.get("/gatewayish")
    async def inner_route() -> dict[str, str]:
        return {}

    app.mount("/gateway", inner)
    app.add_middleware(MetricsMiddleware)

    with TestClient(app) as client:
        client.get("/gateway/gatewayish")

    assert {dict(key)["route"] for key in _counts(registry)} == {"/gateway/gatewayish"}


def test_an_unmounted_route_is_not_given_a_prefix(registry):
    with TestClient(_app()) as client:
        client.get("/rooms/a")

    assert {dict(key)["route"] for key in _counts(registry)} == {"/rooms/{room_id}"}


def test_a_long_poll_is_counted_but_not_timed(registry):
    """Its duration is the caller's chosen wait, not the server's speed.

    Timing it would make this route's percentiles describe a client parameter,
    and on a shared axis the tens of seconds it reports flatten every other
    route into the floor.
    """
    app = FastAPI()

    @app.get("/agents/{agent_id}/events")
    async def events(agent_id: str) -> dict[str, str]:
        return {}

    app.add_middleware(MetricsMiddleware)
    with TestClient(app) as client:
        client.get("/agents/a1/events")

    payloads = {p.name: p for p in registry.collect()}
    assert HTTP_REQUESTS.name in payloads
    assert HTTP_REQUEST_DURATION.name not in payloads


def test_every_long_poll_is_untimed():
    """Found by behaviour, not by hand — a list maintained by hand goes stale.

    A long poll here is an endpoint that takes the caller's own `timeout`, and
    that is the property that makes its duration meaningless as latency. The
    first version of this listed two routes and missed a third that had exactly
    the same shape; this cannot miss the fourth.
    """
    import inspect

    from switch_core.bridges.agent.api.handlers import router
    from switch_core.observability.http import UNTIMED_ROUTES

    long_polls = {
        f"/agents{route.path}"
        for route in router.routes
        if (endpoint := getattr(route, "endpoint", None)) is not None
        and "timeout" in inspect.signature(endpoint).parameters
    }
    assert long_polls, "no long-poll endpoints found — has the router moved?"

    untimed = long_polls - UNTIMED_ROUTES
    assert not untimed, (
        f"{sorted(untimed)} take a caller-supplied timeout but are timed into "
        "switch.http.request.duration. Their percentiles would describe the "
        "caller's wait, not this server. Add them to UNTIMED_ROUTES."
    )


def test_untimed_routes_are_real_routes():
    """Every untimed route must still exist under the name given.

    Without this, renaming an endpoint would quietly put its long-poll
    durations back into the latency histogram and nothing would say so. The
    router is checked rather than a built app because constructing the real
    one needs the whole dependency graph, and the prefix it is mounted under
    is a constant of the app module.
    """
    from switch_core.bridges.agent.api.handlers import router
    from switch_core.observability.http import MCP_ROUTE, UNTIMED_ROUTES

    # `app.py` mounts this router at "/agents". The MCP entry is a mount rather
    # than a route, so it is checked by `test_mcp_traffic_is_labelled` instead.
    paths = {f"/agents{getattr(route, 'path', '')}" for route in router.routes}

    missing = UNTIMED_ROUTES - paths - {MCP_ROUTE}
    assert not missing, (
        f"{sorted(missing)} are listed as untimed but are no longer routes on "
        "the agent bridge. Point UNTIMED_ROUTES at the new names, or drop them "
        "if those endpoints stopped being long-lived."
    )


def test_mcp_traffic_is_labelled_rather_than_unmatched(registry):
    """A mount sets no route, so without this every MCP call is a 404's twin.

    That would hide the primary way agents use Switch, and mix its held-open
    sessions into the same bucket as attacker-driven 404 paths.
    """
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse as StarletteJSON
    from starlette.routing import Route

    inner = Starlette(routes=[Route("/{path:path}", lambda r: StarletteJSON({}))])
    app = FastAPI()
    app.mount("/mcp", inner)
    app.add_middleware(MetricsMiddleware)

    with TestClient(app) as client:
        client.post("/mcp/")

    counted = {dict(key)["route"] for key in _counts(registry)}
    assert counted == {"/mcp"}


def test_mcp_traffic_is_counted_but_not_timed(registry):
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse as StarletteJSON
    from starlette.routing import Route

    inner = Starlette(routes=[Route("/{path:path}", lambda r: StarletteJSON({}))])
    app = FastAPI()
    app.mount("/mcp", inner)
    app.add_middleware(MetricsMiddleware)

    with TestClient(app) as client:
        client.post("/mcp/")

    payloads = {p.name for p in registry.collect()}
    assert HTTP_REQUESTS.name in payloads
    assert HTTP_REQUEST_DURATION.name not in payloads

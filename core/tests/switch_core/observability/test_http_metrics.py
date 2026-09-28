import pytest
from fastapi import FastAPI
from sqlalchemy.exc import TimeoutError as PoolCheckoutTimeout
from starlette.testclient import TestClient

from switch_core.observability.catalogue import (
    DB_POOL_TIMEOUTS,
    HTTP_REQUEST_DURATION,
    HTTP_REQUESTS,
)
from switch_core.observability.http import MetricsMiddleware
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.otlp import MetricPayload


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

    @app.get("/pool-timeout")
    async def pool_timeout() -> None:
        # What a saturated pool raises when auth (or a handler) asks for a
        # connection and none comes free within `db_pool_timeout`.
        raise PoolCheckoutTimeout("QueuePool limit reached")

    @inner.get("/rooms")
    async def gateway_rooms() -> list[str]:
        return []

    app.mount("/gateway", inner)
    app.add_middleware(MetricsMiddleware)
    return app


def _counts(payloads: list[MetricPayload]) -> dict[tuple, float]:
    payload = next(p for p in payloads if p.name == HTTP_REQUESTS.name)
    return {
        tuple(sorted(point.attributes.items())): point.value
        for point in payload.numbers
    }


def test_a_path_parameter_does_not_become_a_series(registry):
    with TestClient(_app()) as client:
        for room_id in ("a", "b", "c"):
            client.get(f"/rooms/{room_id}")

    counts = _counts(registry.collect())
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

    counts = _counts(registry.collect())
    # Otherwise an unauthenticated 404 loop mints a series per request.
    assert len(counts) == 1
    attributes = dict(next(iter(counts)))
    assert attributes["route"] == "unmatched"
    assert attributes["status_class"] == "4xx"


def test_a_mounted_route_keeps_its_prefix(registry):
    with TestClient(_app()) as client:
        client.get("/gateway/rooms")

    routes = {dict(key)["route"] for key in _counts(registry.collect())}
    # The gateway's /rooms and the bridge's /rooms are different routes and
    # must not be counted as one.
    assert routes == {"/gateway/rooms"}


def test_an_unhandled_exception_is_still_counted(registry):
    client = TestClient(_app(), raise_server_exceptions=False)
    client.get("/boom")

    counts = _counts(registry.collect())
    attributes = dict(next(iter(counts)))
    assert attributes["route"] == "/boom"
    assert attributes["status_class"] == "5xx"


def _timeout_count(payloads: list[MetricPayload]) -> float:
    matching = [p for p in payloads if p.name == DB_POOL_TIMEOUTS.name]
    if not matching:
        return 0.0
    return sum(point.value for point in matching[0].numbers)


def test_a_pool_checkout_timeout_is_counted(registry):
    client = TestClient(_app(), raise_server_exceptions=False)
    client.get("/pool-timeout")

    # Counted as a 5xx like any failure, and separately as the pool timeout it
    # was — the signal a peak at the pool ceiling only implies. Both readings
    # come from one collection: `collect()` drains and resets, so a second call
    # would find the counters already taken.
    payloads = registry.collect()
    counts = _counts(payloads)
    attributes = dict(next(iter(counts)))
    assert attributes["route"] == "/pool-timeout"
    assert attributes["status_class"] == "5xx"
    assert _timeout_count(payloads) == 1.0


def test_an_ordinary_error_is_not_counted_as_a_pool_timeout(registry):
    client = TestClient(_app(), raise_server_exceptions=False)
    client.get("/boom")

    assert _timeout_count(registry.collect()) == 0.0


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
    """An inner route whose name starts with the mount's own string.

    The case where asking "is the prefix already there?" answers yes and drops
    it, losing the distinction this label exists to keep.
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

    assert {dict(key)["route"] for key in _counts(registry.collect())} == {
        "/gateway/gatewayish"
    }


def test_an_unmounted_route_is_not_given_a_prefix(registry):
    with TestClient(_app()) as client:
        client.get("/rooms/a")

    assert {dict(key)["route"] for key in _counts(registry.collect())} == {
        "/rooms/{room_id}"
    }


def test_a_long_poll_is_counted_but_not_timed(registry):
    """Its duration is the caller's chosen wait, not the server's speed."""
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
    """Found by behaviour, because a hand-kept list goes stale.

    A long poll is an endpoint taking the caller's own `timeout`, which is the
    property that makes its duration meaningless as latency.
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

    The router rather than a built app: constructing the real one needs the
    whole dependency graph, and the mount prefix is a constant of `app.py`.
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
    """A mount sets no route, so without this every MCP call is a 404's twin."""
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse as StarletteJSON
    from starlette.routing import Route

    inner = Starlette(routes=[Route("/{path:path}", lambda r: StarletteJSON({}))])
    app = FastAPI()
    app.mount("/mcp", inner)
    app.add_middleware(MetricsMiddleware)

    with TestClient(app) as client:
        client.post("/mcp/")

    counted = {dict(key)["route"] for key in _counts(registry.collect())}
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

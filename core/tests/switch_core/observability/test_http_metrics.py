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

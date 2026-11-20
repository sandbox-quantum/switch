"""The server default decision service's health check: reported beside the
others, never gating readiness, and saying what is wrong without echoing the
service's body."""

from __future__ import annotations

import httpx
import pytest

from switch_core.observability.health import (
    CheckOutcome,
    HealthCheck,
    HealthMonitor,
    decision_check,
    decision_health_url,
)


def _database() -> HealthCheck:
    async def probe() -> CheckOutcome:
        return CheckOutcome(name="database", healthy=True, detail="")

    return HealthCheck(name="database", gates_readiness=True, probe=probe)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.parametrize(
    ("endpoint", "health"),
    [
        ("http://decision:8230", "http://decision:8230/health"),
        ("http://decision:8230/", "http://decision:8230/health"),
        ("http://decision:8230/decide", "http://decision:8230/health"),
        ("https://proxy.test/route/decide", "https://proxy.test/route/health"),
        ("https://proxy.test/route", "https://proxy.test/route/health"),
    ],
)
def test_the_health_route_is_found_from_the_decision_url(endpoint, health):
    assert decision_health_url(endpoint) == health


@pytest.mark.asyncio
async def test_a_healthy_service_passes_with_the_token():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    async with _client(handler) as client:
        outcome = await decision_check(
            "http://decision:8230/decide", "placeholder-token", client
        ).probe()

    assert outcome == CheckOutcome(name="decision", healthy=True, detail="")
    [request] = seen
    assert str(request.url) == "http://decision:8230/health"
    assert request.headers["authorization"] == "Bearer placeholder-token"


@pytest.mark.asyncio
async def test_a_service_still_loading_fails_and_its_body_is_not_shown():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="the model server says something private")

    async with _client(handler) as client:
        outcome = await decision_check("http://decision:8230", None, client).probe()

    assert not outcome.healthy
    assert "status 503" in outcome.detail
    assert "private" not in outcome.detail


@pytest.mark.asyncio
async def test_a_service_that_is_down_fails():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    async with _client(handler) as client:
        outcome = await decision_check("http://decision:8230", None, client).probe()

    assert not outcome.healthy
    assert "could not be reached (ConnectError)" in outcome.detail


@pytest.mark.asyncio
async def test_a_failing_decision_service_never_takes_core_out_of_service():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    async with _client(handler) as client:
        check = decision_check("http://decision:8230", None, client)
        monitor = HealthMonitor([_database(), check], interval_seconds=1.0)
        report = await monitor.refresh()

    assert not check.gates_readiness
    assert report.ready is True
    assert report.as_response()["status"] == "ready"
    assert report.as_response()["checks"]["decision"]["healthy"] is False

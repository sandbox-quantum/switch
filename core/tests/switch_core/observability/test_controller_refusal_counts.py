"""Refused controller credentials are counted, by reason code and kind of
route only: never the address, the path or any part of the credential."""

from __future__ import annotations

import json
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.auth import _controller_refusal
from switch_core.observability.metrics import MetricsRegistry, install, uninstall

CANARY = "CANARY-refusal-do-not-export"


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _refusals(registry: MetricsRegistry) -> dict[tuple[str, str], float]:
    return {
        (dict(p.attributes)["reason"], dict(p.attributes)["route"]): p.value
        for payload in registry.collect()
        if payload.name == "switch.controller.credential_refusals"
        for p in payload.numbers
    }


async def _answer(code: str, status: int, path: str, kind: str = "http") -> None:
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "websocket.connect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": kind, "path": path, "headers": [], "method": "GET"}
    await _controller_refusal(code, "refused", status)(scope, receive, send)


async def test_a_401_is_counted_by_code_and_route(registry: MetricsRegistry) -> None:
    await _answer("token_expired", 401, f"/v1/controllers/{CANARY}/status")
    await _answer("invalid_credential", 401, "/v1/management/controllers/x/token")
    await _answer("controller_revoked", 401, f"/v1/agents/{CANARY}", kind="websocket")
    await _answer(CANARY, 401, "/v1/controllers/x")
    assert _refusals(registry) == {
        ("token_expired", "controller"): 1.0,
        ("invalid_credential", "management"): 1.0,
        ("controller_revoked", "agent"): 1.0,
        ("other", "controller"): 1.0,
    }
    assert CANARY not in json.dumps(
        [list(p.attributes) for m in registry.collect() for p in m.numbers]
    )


async def test_a_refusal_that_is_not_a_401_is_not_a_credential_refusal(
    registry: MetricsRegistry,
) -> None:
    await _answer("forbidden", 403, "/v1/controllers/x/agents/y")
    assert _refusals(registry) == {}


async def test_the_hosted_controller_services_wrong_token_is_counted(
    registry: MetricsRegistry,
) -> None:
    from switch_core.gateway.hosted_controller import controller_session

    settings = SimpleNamespace(token=SimpleNamespace(get_secret_value=lambda: "t" * 32))
    for header in ({}, {"authorization": f"Bearer {CANARY}"}):
        request = SimpleNamespace(headers=header)
        session = controller_session(request, settings, None)  # type: ignore[arg-type]
        with pytest.raises(HTTPException) as refused:
            await session.__anext__()
        assert refused.value.status_code == 401
    assert _refusals(registry) == {
        ("missing", "hosted_controller"): 1.0,
        ("wrong", "hosted_controller"): 1.0,
    }


async def test_a_refused_token_exchange_or_enrolment_is_counted(
    registry: MetricsRegistry,
) -> None:
    """Exchange and enrolment answer their own refusals (`ManagementRoute`),
    so they are counted there, as `route:management`."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from switch_core.management import reason_codes
    from switch_core.management.errors import ManagementError, ManagementRoute

    app = FastAPI()
    app.router.route_class = ManagementRoute

    @app.post("/v1/management/controllers/{controller_id}/token")
    async def refused(controller_id: str) -> None:
        raise ManagementError(
            401, reason_codes.INVALID_CREDENTIAL, "The credential is not valid."
        )

    @app.post("/v1/management/controllers/enroll")
    async def not_found() -> None:
        raise ManagementError(404, reason_codes.NOT_FOUND, "nothing")

    client = TestClient(app)
    assert client.post(f"/v1/management/controllers/{CANARY}/token").status_code == 401
    assert client.post("/v1/management/controllers/enroll").status_code == 404
    assert _refusals(registry) == {("invalid_credential", "management"): 1.0}


async def test_a_controller_route_refusal_counts_as_controller(
    registry: MetricsRegistry,
) -> None:
    """A 401 on the `/v1/controllers/*` routes is a refused bearer token, so it
    counts as `route:controller` (the paging alert's), not `management`."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from switch_core.management import reason_codes
    from switch_core.management.errors import ManagementError, ManagementRoute

    app = FastAPI()
    app.router.route_class = ManagementRoute

    @app.get("/v1/controllers/{controller_id}/assignment")
    async def refused(controller_id: str) -> None:
        raise ManagementError(
            401, reason_codes.INVALID_CREDENTIAL, "Not authenticated as a controller."
        )

    @app.get("/gateway/management/controllers")
    async def gateway_refused() -> None:
        raise ManagementError(401, reason_codes.INVALID_CREDENTIAL, "Not signed in.")

    client = TestClient(app)
    assert client.get(f"/v1/controllers/{CANARY}/assignment").status_code == 401
    assert client.get("/gateway/management/controllers").status_code == 401
    assert _refusals(registry) == {
        ("invalid_credential", "controller"): 1.0,
        ("invalid_credential", "management"): 1.0,
    }

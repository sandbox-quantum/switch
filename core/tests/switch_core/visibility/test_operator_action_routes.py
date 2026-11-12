"""The restart routes carry the right guard: operators ask for a restart, and only the
operator API's own bearer reaches the operator API."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute

import switch_core.main  # noqa: F401  (import order, as in test_route_guards)
from switch_core.gateway.dependencies import get_session_factory
from switch_core.gateway.hosted_controller import controller_session
from switch_core.gateway.hosted_operator_bearer import require_operator_bearer
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.visibility.guards import require_operator
from switch_core.visibility.operator_action_routes import router
from tests.switch_core.gateway.test_app_route_mounting import _app
from tests.switch_core.visibility.test_hosted_access import KEY
from tests.switch_core.visibility.test_route_guards import _calls, _hosted

TOKEN = "SYNTHETIC-OPERATOR-BEARER-FOR-TESTS"
CONTROLLER_TOKEN = "SYNTHETIC-CONTROLLER-BEARER-FOR-TESTS"


def _route(path: str, method: str) -> APIRoute:
    for route in _app().routes:
        if (
            isinstance(route, APIRoute)
            and route.path == path
            and method in route.methods
        ):
            return route
    raise AssertionError(f"{method} {path} isn't mounted")


def test_restart_is_operators_only_and_under_the_guard_walk() -> None:
    path = "/shared-cloud/boxes/{box_keyed_id}/restart"
    route = _route(path, "POST")
    assert require_operator in set(_calls(route.dependant))
    assert _hosted(path)


def test_drain_is_operators_only_and_under_the_guard_walk() -> None:
    """A drain is asked for on the same guard as restart."""
    path = "/shared-cloud/machines/{machine_keyed_id}/drain"
    route = _route(path, "POST")
    assert require_operator in set(_calls(route.dependant))
    assert _hosted(path)


def test_the_operator_api_needs_the_operators_bearer() -> None:
    for path, method in (
        ("/hosted-controller/actions", "GET"),
        ("/hosted-controller/actions/{action_id}/steps", "POST"),
    ):
        calls = set(_calls(_route(path, method).dependant))
        assert require_operator_bearer in calls
        assert controller_session not in calls


@pytest.fixture
async def client(session_factory):
    app = FastAPI()
    app.include_router(router)
    app.state.hosted_controller_settings = HostedControllerSettings(
        allowed_tenant_ids=[],
        token=CONTROLLER_TOKEN,
        operator_token=TOKEN,
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    app.state.keyed_id_key = KEY
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as c:
        yield c


async def test_a_box_controllers_credentials_are_refused(client) -> None:
    """A box's controller access token (a JWT) or its long-lived credential
    (`swcc_…`) never reaches the operator API."""
    for bearer in (
        "eyJhbGciOiJFZERTQSJ9.e30.c2ln",
        "swcc_synthetic-controller-credential",
    ):
        headers = {"Authorization": f"Bearer {bearer}"}
        listed = await client.get(
            "/hosted-controller/actions?kind=restart", headers=headers
        )
        stepped = await client.post(
            "/hosted-controller/actions/00000000-0000-0000-0000-000000000000/steps",
            json={"step": "claimed", "state": "running"},
            headers=headers,
        )
        # The refusal guard may answer a repeat refusal from one address with 429.
        assert listed.status_code in (401, 429)
        assert stepped.status_code in (401, 429)
    assert (
        await client.get("/hosted-controller/actions?kind=restart")
    ).status_code in (401, 429)


async def test_the_operators_bearer_lists_actions(client) -> None:
    listed = await client.get(
        "/hosted-controller/actions?kind=restart",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert listed.status_code == 200, listed.text
    assert listed.json() == {"actions": []}
    bad = await client.get(
        "/hosted-controller/actions?kind=../x",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert bad.status_code == 422


async def test_the_controller_bearer_is_refused_on_the_operator_api(client) -> None:
    """Outside the move-over window, the controller's bearer no longer reaches
    the operator API."""
    headers = {"Authorization": f"Bearer {CONTROLLER_TOKEN}"}
    listed = await client.get(
        "/hosted-controller/actions?kind=restart", headers=headers
    )
    stepped = await client.post(
        "/hosted-controller/actions/00000000-0000-0000-0000-000000000000/steps",
        json={"step": "claimed", "state": "running"},
        headers=headers,
    )
    assert listed.status_code in (401, 429)
    assert stepped.status_code in (401, 429)

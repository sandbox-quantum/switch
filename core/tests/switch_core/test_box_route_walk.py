"""The box routes' walk: every route Core serves that upstream main
`523ddc4ff` doesn't is a box route, and each must (1) need its caller's
credentials and (2) answer as a route that isn't there on a server with no box
cluster configured. Walked from `app.routes` itself, not the OpenAPI document,
so a route hidden from the schema can't slip through. Upstream's routes, walked
the same way on main's own tree, are `fixtures/upstream-523ddc4ff-routes.json`
(refreshed each time main is merged in: `0f7f96732`, `807a1f94d`, `233649fff`,
`1a0d5002f`, `3eb5ae0eb`, `cc661e536`, `abd523076`, `9a63077d7`, `35b791558`, `268f12b89`,
`483d32234`, `3b503b563`, `908a23b70`, now `523ddc4ff`)."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.routing import Mount

from switch_core.box_cluster import (
    require_box_cluster,
    require_box_cluster_here,
    set_box_cluster,
)
from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.gateway.hosted_controller import controller_session
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.gateway.hosted_operator_bearer import require_operator_bearer
from switch_core.gateway.hosted_provisioner import (
    provisioner_session,
    reaper_session,
    remover_session,
)
from switch_core.management.controller_routes import router as controller_router
from switch_core.management.dependencies import get_controller_principal
from switch_core.management.wiring import mount_gateway_routes
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.trust.client import NullTrustClient
from switch_core.visibility.guards import require_operator, require_workspace_admin
from switch_core.visibility.keyed_id import KeyedIdKey
from tests.db_buffer import QuietRooms
from tests.switch_core.gateway.test_app_route_mounting import _app
from tests.switch_core.test_ingress_agent_api_paths import _config as _bridge_config

UPSTREAM = json.loads(
    (Path(__file__).parent / "fixtures/upstream-523ddc4ff-routes.json").read_text()
)
GATES = {require_box_cluster, require_box_cluster_here}
# Every box route, exactly: a guard on the walk itself, so a change that hid
# them from it can't pass for "nothing new", and a route added or dropped
# without meaning to fails here too.
NEW_ROUTES = {
    (
        "agent_bridge",
        "POST",
        "/v1/management/controllers/{controller_id}/agents/{agent_id}/reset-refused",
    ),
    (
        "agent_bridge",
        "POST",
        "/v1/management/controllers/{controller_id}/agents/{agent_id}/rest-notice",
    ),
    (
        "agent_bridge",
        "POST",
        "/v1/management/controllers/{controller_id}/agents/{agent_id}/restart-notice",
    ),
    ("gateway", "GET", "/hosted-controller/actions"),
    ("gateway", "POST", "/hosted-controller/actions/{action_id}/steps"),
    ("gateway", "POST", "/hosted-controller/cluster"),
    ("gateway", "GET", "/hosted-controller/pool"),
    ("gateway", "GET", "/hosted-provisioner/actions/{action_id}"),
    ("gateway", "POST", "/hosted-provisioner/actions/{action_id}/result"),
    ("gateway", "POST", "/hosted-provisioner/actions/{action_id}/steps"),
    ("gateway", "POST", "/hosted-provisioner/claim"),
    ("gateway", "GET", "/hosted-provisioner/pool/retiring"),
    ("gateway", "POST", "/hosted-provisioner/pool/{pool_box_id}/gone"),
    ("gateway", "POST", "/hosted-provisioner/removals/claim"),
    ("gateway", "POST", "/hosted-provisioner/removals/listed"),
    ("gateway", "GET", "/hosted-provisioner/removals/{machine_id}"),
    ("gateway", "POST", "/hosted-provisioner/removals/{machine_id}/gone"),
    ("gateway", "GET", "/shared-cloud/audit-events"),
    ("gateway", "POST", "/shared-cloud/boxes/{box_keyed_id}/restart"),
    ("gateway", "POST", "/shared-cloud/machines/{machine_keyed_id}/drain"),
    ("gateway", "GET", "/shared-cloud/operators"),
    ("gateway", "GET", "/shared-cloud/overview"),
    ("gateway", "POST", "/shared-cloud/reveal"),
    ("gateway", "POST", "/shared-cloud/users/{user_keyed_id}/pause"),
    ("gateway", "POST", "/shared-cloud/users/{user_keyed_id}/resume"),
    ("gateway", "PUT", "/tenants/{tenant_id}/hosted-people/{user_id}"),
}


def _walk(routes: list[Any], prefix: str = "") -> Iterator[tuple[str, str, Any]]:
    for route in routes:
        if isinstance(route, Mount):
            yield from _walk(route.routes, prefix + route.path)
        elif isinstance(route, APIRoute):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, prefix + route.path, route
        elif isinstance(route, APIWebSocketRoute):
            yield "WS", prefix + route.path, route
        elif getattr(route, "path", None):
            yield "OTHER", prefix + route.path, route


def _gated(dependant: Dependant | None) -> bool:
    if dependant is None:
        return False
    return dependant.call in GATES or any(_gated(sub) for sub in dependant.dependencies)


def _apps() -> dict[str, Any]:
    gateway = _app()
    mount_gateway_routes(gateway)  # as `Management.install` does
    bridge, _ = create_agent_bridge_app(
        agent_store=object(),  # type: ignore[arg-type]
        agent_session_store=object(),  # type: ignore[arg-type]
        room_store=object(),  # type: ignore[arg-type]
        room_service=object(),  # type: ignore[arg-type]
        client_lifecycle=object(),  # type: ignore[arg-type]
        collab_lifecycle=object(),  # type: ignore[arg-type]
        event_buffer=EventBuffer(
            object(), sequence_base=0, rooms=QuietRooms(), session_slots=None
        ),  # type: ignore[arg-type]
        resource_service=object(),  # type: ignore[arg-type]
        api_key_store=object(),  # type: ignore[arg-type]
        external_user_store=object(),  # type: ignore[arg-type]
        bridge_store=object(),  # type: ignore[arg-type]
        session_factory=object(),
        config=_bridge_config(),
        approval_outcomes=object(),  # type: ignore[arg-type]
        controller_auth=None,
        trust_client=NullTrustClient(),
        gateway_ui=None,
    )
    bridge.include_router(controller_router)  # as `Management.install` does
    return {"gateway": gateway, "agent_bridge": bridge}


# The upstream hosted controller routes, which the v1 controller and the box
# workers both call: never behind the box cluster gate, so a server's existing
# v1 machines keep being managed with no box cluster (v1 is frozen, not removed).
SHARED_ROUTES = {
    ("gateway", "GET", "/hosted-controller/machines"),
    ("gateway", "POST", "/hosted-controller/machines/{machine_id}/observation"),
    ("gateway", "POST", "/hosted-controller/machines/{machine_id}/prepare"),
}


def _new_routes() -> list[tuple[str, str, str, Any]]:
    found = []
    for name, app in _apps().items():
        upstream = {tuple(pair) for pair in UPSTREAM[name]}
        for method, path, route in _walk(app.routes):  # type: ignore[attr-defined]
            if (method, path) not in upstream:
                found.append((name, method, path, route))
    return found


def _box_routes() -> list[tuple[str, str, str, Any]]:
    """Every route behind the box cluster gate: the new ones."""
    return _new_routes()


def _shared_routes() -> list[tuple[str, str, str, Any]]:
    found = []
    for name, app in _apps().items():
        for method, path, route in _walk(app.routes):  # type: ignore[attr-defined]
            if (name, method, path) in SHARED_ROUTES:
                found.append((name, method, path, route))
    return found


def test_every_box_route_carries_the_box_cluster_gate() -> None:
    assert {(n, m, p) for n, m, p, _ in _new_routes()} == NEW_ROUTES
    box = _box_routes()
    ungated = [
        (name, method, path)
        for name, method, path, route in box
        if not _gated(getattr(route, "dependant", None))
    ]
    assert ungated == []


def test_the_routes_v1_shares_are_never_behind_the_gate() -> None:
    """The v1 controller's routes stay up with no box cluster (today's
    production): ungated, and answering, not 404."""
    shared = _shared_routes()
    assert {(n, m, p) for n, m, p, _ in shared} == SHARED_ROUTES
    assert [
        (n, m, p) for n, m, p, r in shared if _gated(getattr(r, "dependant", None))
    ] == []
    assert set_box_cluster(None, None) is False
    app = _apps()["gateway"]
    app.dependency_overrides[controller_settings] = _settings
    for (method, path), resp in _answers(app, shared, "gateway").items():
        assert resp.status_code != 404, (method, path)


def test_nothing_upstream_serves_is_gone() -> None:
    """With no box cluster Core serves what upstream does: every route upstream serves still is."""
    for name, app in _apps().items():
        served = {(m, p) for m, p, _ in _walk(app.routes)}  # type: ignore[attr-defined]
        missing = [tuple(pair) for pair in UPSTREAM[name] if tuple(pair) not in served]
        assert missing == [], name


# What signs a caller in on each box route, matched by the function itself: each
# route must carry exactly its own. The hosted workers' routes are listed one by
# one, since each worker has its own bearer; the rest by path prefix.
WORKER_AUTH = {
    ("GET", "/hosted-controller/machines"): controller_session,
    (
        "POST",
        "/hosted-controller/machines/{machine_id}/observation",
    ): controller_session,
    ("POST", "/hosted-controller/machines/{machine_id}/prepare"): controller_session,
    ("GET", "/hosted-controller/actions"): require_operator_bearer,
    ("POST", "/hosted-controller/actions/{action_id}/steps"): require_operator_bearer,
    ("POST", "/hosted-controller/cluster"): controller_session,
    ("GET", "/hosted-controller/pool"): controller_session,
    ("GET", "/hosted-provisioner/actions/{action_id}"): provisioner_session,
    ("POST", "/hosted-provisioner/actions/{action_id}/result"): provisioner_session,
    ("POST", "/hosted-provisioner/actions/{action_id}/steps"): provisioner_session,
    ("POST", "/hosted-provisioner/claim"): provisioner_session,
    ("POST", "/hosted-provisioner/removals/claim"): provisioner_session,
    ("POST", "/hosted-provisioner/removals/{machine_id}/gone"): provisioner_session,
    ("GET", "/hosted-provisioner/pool/retiring"): reaper_session,
    ("POST", "/hosted-provisioner/pool/{pool_box_id}/gone"): reaper_session,
    ("POST", "/hosted-provisioner/removals/listed"): remover_session,
    ("GET", "/hosted-provisioner/removals/{machine_id}"): remover_session,
}
WORKER_SESSIONS = set(WORKER_AUTH.values())
PREFIX_AUTH = [
    ("/v1/management/controllers/", get_controller_principal),
    ("/shared-cloud/", require_operator),
    ("/tenants/", require_workspace_admin),
]


def _calls(dependant: Dependant | None) -> set[Any]:
    if dependant is None:
        return set()
    out: set[Any] = set()
    for sub in dependant.dependencies:
        out.add(sub.call)
        out |= _calls(sub)
    return out


def _expected_auth(method: str, path: str) -> Any:
    if (method, path) in WORKER_AUTH:
        return WORKER_AUTH[(method, path)]
    return next(auth for prefix, auth in PREFIX_AUTH if path.startswith(prefix))


def test_every_new_route_needs_its_callers_credentials() -> None:
    """Each route carries its own credential check, and a worker's route no
    other worker's: a remover route that took the reaper's bearer fails here."""
    wrong = []
    for name, method, path, route in _box_routes():
        calls = _calls(getattr(route, "dependant", None))
        expected = _expected_auth(method, path)
        if expected not in calls or (calls & WORKER_SESSIONS) - {expected}:
            wrong.append((name, method, path))
    assert wrong == []


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


def _answers(app: Any, routes: list[tuple[str, str, str, Any]], name: str) -> dict:
    client = TestClient(app, raise_server_exceptions=False)
    return {
        (method, path): client.request(method, _concrete(path), json={})
        for app_name, method, path, _ in routes
        if app_name == name
    }


def _bare_controller_app() -> FastAPI:
    """The controllers' router on its own, signed in: the bridge's auth
    middleware answers an unsigned request before any route, so the gate is
    seen here past it."""
    app = FastAPI()
    app.include_router(controller_router)
    app.dependency_overrides[get_controller_principal] = lambda: object()
    return app


# A loaded keyed-id key, as a box cluster needs (a placeholder, not a real one).
KEY = KeyedIdKey(b"k" * 32, "k1")


def _settings_values() -> dict[str, Any]:
    return {
        "allowed_tenant_ids": ["*"],
        "token": "c" * 32,
        "provisioner_token": "p" * 32,
        "operator_token": "o" * 32,
        "reaper_token": "r" * 32,
        "remover_token": "m" * 32,
        "agent_api_endpoint": "https://agents.example.test",
    }


def _settings() -> HostedControllerSettings:
    """Every bearer set, each a different placeholder, so each route's own
    credential check is what answers."""
    return HostedControllerSettings(**_settings_values())


def _off_settings(provisioner_token: str | None) -> HostedControllerSettings:
    """The settings with the box operator's bearer missing, empty or short,
    loaded the way Core loads them."""
    return HostedControllerSettings(
        **{**_settings_values(), "provisioner_token": provisioner_token}
    )


@pytest.mark.parametrize(
    ("settings", "key"),
    [
        pytest.param(lambda: None, KEY, id="no hosted settings"),
        pytest.param(lambda: _off_settings(None), KEY, id="no provisioner token"),
        pytest.param(lambda: _off_settings(""), KEY, id="empty provisioner token"),
        pytest.param(
            lambda: _off_settings("p" * 31), KEY, id="short provisioner token"
        ),
        pytest.param(_settings, None, id="provisioner token but no keyed-id key"),
    ],
)
def test_with_no_box_cluster_every_box_route_answers_as_absent(
    settings: Any, key: KeyedIdKey | None
) -> None:
    """Refused by the gate itself, before credentials or any lookup: the same
    404 as a route that doesn't exist, on all of them: no box operator named,
    or one named without the keyed-id key its views and alerts need. Once a box cluster is
    configured, none answers 404, so the 404 is the gate's and not a missing
    route's."""
    box = _box_routes()
    apps = {"gateway": _apps()["gateway"], "agent_bridge": _bare_controller_app()}
    assert set_box_cluster(settings(), key) is False
    for name, app in apps.items():
        for (method, path), resp in _answers(app, box, name).items():
            assert (resp.status_code, resp.json()) == (404, {"detail": "Not Found"}), (
                name,
                method,
                path,
            )
    assert set_box_cluster(_settings(), KEY) is True
    for name, app in apps.items():
        for (method, path), resp in _answers(app, box, name).items():
            assert resp.status_code != 404, (name, method, path)


def test_without_credentials_every_box_route_is_refused() -> None:
    """On a server with a box cluster configured, a caller who presents no
    credentials is refused on every box route (401 or 403), never served."""
    box = _box_routes() + _shared_routes()
    apps = _apps()
    assert set_box_cluster(_settings(), KEY) is True
    for name, app in apps.items():
        app.dependency_overrides[controller_settings] = _settings
        for (method, path), resp in _answers(app, box, name).items():
            assert resp.status_code in (401, 403), (
                name,
                method,
                path,
                resp.status_code,
            )


# Each hosted worker's bearer, as `_settings()` sets it.
BEARERS = {
    controller_session: "c" * 32,
    require_operator_bearer: "o" * 32,
    provisioner_session: "p" * 32,
    reaper_session: "r" * 32,
    remover_session: "m" * 32,
}


def test_no_workers_bearer_opens_another_workers_route() -> None:
    """With a box cluster configured, each worker's real bearer is refused on
    every other worker's routes, so a stray bearer opens nothing but its own."""
    app = _apps()["gateway"]
    assert set_box_cluster(_settings(), KEY) is True
    app.dependency_overrides[controller_settings] = _settings
    client = TestClient(app, raise_server_exceptions=False)
    opened = []
    for (method, path), own in WORKER_AUTH.items():
        for check, bearer in BEARERS.items():
            if check is own:
                continue
            resp = client.request(
                method,
                _concrete(path),
                json={},
                headers={"Authorization": f"Bearer {bearer}"},
            )
            if resp.status_code not in (401, 403):
                opened.append((method, path, check.__name__, resp.status_code))
    assert opened == []

"""The v1/v2 switch's route walk: every route
Core serves that upstream main `908a23b70` doesn't is v2's, so each must carry
the switch's gate. Walked from `app.routes` itself, not the OpenAPI document, so
a route hidden from the schema can't slip through. Upstream's routes, walked the
same way on main's own tree, are `fixtures/upstream-908a23b70-routes.json`
(refreshed each time main is merged in: `0f7f96732`, `807a1f94d`, `233649fff`,
`1a0d5002f`, `3eb5ae0eb`, `cc661e536`, `abd523076`, `9a63077d7`, `35b791558`, `268f12b89`,
`483d32234`, `3b503b563`, now `908a23b70`)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, APIWebSocketRoute
from starlette.routing import Mount

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.hosted_v2 import require_hosted_v2, require_hosted_v2_here
from switch_core.management.controller_routes import router as controller_router
from switch_core.management.wiring import mount_gateway_routes
from switch_core.trust.client import NullTrustClient
from tests.db_buffer import QuietRooms
from tests.switch_core.gateway.test_app_route_mounting import _app
from tests.switch_core.test_ingress_agent_api_paths import _config as _bridge_config

UPSTREAM = json.loads(
    (Path(__file__).parent / "fixtures/upstream-908a23b70-routes.json").read_text()
)
GATES = {require_hosted_v2, require_hosted_v2_here}
# Every route v2 adds, exactly: a guard on the walk itself, so a change that hid
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


def _new_routes() -> list[tuple[str, str, str, Any]]:
    found = []
    for name, app in _apps().items():
        upstream = {tuple(pair) for pair in UPSTREAM[name]}
        for method, path, route in _walk(app.routes):  # type: ignore[attr-defined]
            if (method, path) not in upstream:
                found.append((name, method, path, route))
    return found


def test_every_route_upstream_lacks_carries_the_switchs_gate() -> None:
    new = _new_routes()
    assert {(name, method, path) for name, method, path, _ in new} == NEW_ROUTES
    ungated = [
        (name, method, path)
        for name, method, path, route in new
        if not _gated(getattr(route, "dependant", None))
    ]
    assert ungated == []


def test_nothing_upstream_serves_is_gone() -> None:
    """With v2 off Core is upstream: every route upstream serves still is."""
    for name, app in _apps().items():
        served = {(m, p) for m, p, _ in _walk(app.routes)}  # type: ignore[attr-defined]
        missing = [tuple(pair) for pair in UPSTREAM[name] if tuple(pair) not in served]
        assert missing == [], name

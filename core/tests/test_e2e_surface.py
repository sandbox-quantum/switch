"""The surface snapshot the end-to-end coverage gate reads.

`scripts/e2e_surface.py --check` already fails CI when the committed snapshot
and the server disagree. These tests pin what the snapshot means: which routes
count as taking a session, that flag-gated routes are in it, and that a
setting in the environment cannot change what it says.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_exporter() -> ModuleType:
    """Import scripts/e2e_surface.py, which is not an installed package."""
    path = REPO_ROOT / "scripts" / "e2e_surface.py"
    spec = importlib.util.spec_from_file_location("e2e_surface", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


surface = _load_exporter()


def _routes() -> dict[str, str]:
    rendered = json.loads(surface.render())
    return {entry["route"]: entry["auth"] for entry in rendered["gatewayRoutes"]}


def test_routes_are_classified_by_what_they_authenticate_with() -> None:
    routes = _routes()
    assert routes["POST /gateway/rooms"] == "session"
    # Before a tenant is chosen: authenticated, with no tenant bound.
    assert routes["GET /gateway/tenants"] == "session"
    assert routes["POST /gateway/auth/login"] == "none"
    assert routes["GET /gateway/hosted-controller/machines"] == "operator-token"


def test_flag_gated_routes_are_included() -> None:
    routes = _routes()
    assert "POST /gateway/management/agents" in routes
    assert "GET /gateway/service-connections" in routes


def test_the_environment_does_not_change_the_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Settings the script does not pin, each of which would either fail the
    build or change what it mounts if the environment leaked in."""
    before = surface.render()
    monkeypatch.setenv("GATEWAY_SIGNUP_MODE", "open")
    monkeypatch.setenv("HOSTED_LAUNCH_CAPACITY", "1")
    monkeypatch.setenv("GITHUB_APP_CONFIG_PATH", "/nonexistent/github-app.json")
    assert surface.render() == before


def test_each_route_names_the_flags_it_is_mounted_behind() -> None:
    routes = {
        entry["route"]: entry["flags"]
        for entry in json.loads(surface.render())["gatewayRoutes"]
    }
    assert routes["POST /gateway/rooms"] == []
    assert routes["POST /gateway/management/agents"] == ["agent_management"]
    assert routes["GET /gateway/service-connections"] == ["service_connections"]


def test_routes_behind_the_hosted_v2_gate_name_the_hosted_v2_flag() -> None:
    """With v2 off the gate answers 404 before any authentication, and
    `/feature-flags` doesn't list `hosted_v2`, so the fast lane's session probe
    counts these routes as not mounted rather than expecting a 401."""
    routes = {
        entry["route"]: entry["flags"]
        for entry in json.loads(surface.render())["gatewayRoutes"]
    }
    for route in (
        "GET /gateway/shared-cloud/overview",
        "POST /gateway/shared-cloud/users/{user_keyed_id}/pause",
        "GET /gateway/tenants/{tenant_id}/hosted-people",
    ):
        assert routes[route] == ["hosted_v2"], route
    # A route with no gate keeps no flag, and a feature flag's route keeps only its own.
    assert routes["POST /gateway/rooms"] == []
    assert routes["POST /gateway/management/agents"] == ["agent_management"]


def test_every_route_behind_the_gate_is_tagged() -> None:
    """The same gates as core's route walk: every gateway route that depends on
    either one names `hosted_v2`, and no other route does."""
    app = surface.gateway_app(surface._config(frozenset(surface.KNOWN_FEATURE_FLAGS)))
    gated = {
        key
        for key, route in surface._routes_by_key(app).items()
        if surface._behind_hosted_v2(route)
    }
    tagged = {
        entry["route"]
        for entry in json.loads(surface.render())["gatewayRoutes"]
        if "hosted_v2" in entry["flags"]
    }
    assert gated, "no route found behind the hosted v2 gate"
    assert tagged == gated


def test_operations_include_gated_groups() -> None:
    operations = json.loads(surface.render())["operations"]
    assert "list_rooms" in operations
    assert "create_agent" in operations
    assert operations == sorted(operations)

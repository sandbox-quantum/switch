"""The pause and turn-off routes carry the right role guard: operators pause and resume, a
workspace's admins turn a person on or off. The workspace route sits under
`/tenants/{id}/hosted-…`, so the walk of every hosted route covers it too."""

from __future__ import annotations

from fastapi.routing import APIRoute

import switch_core.main  # noqa: F401  (import order, as in test_route_guards)
from switch_core.visibility.guards import require_operator, require_workspace_admin
from tests.switch_core.gateway.test_app_route_mounting import _app
from tests.switch_core.visibility.test_route_guards import _calls, _hosted


def _route(path: str, method: str) -> APIRoute:
    for route in _app().routes:
        if (
            isinstance(route, APIRoute)
            and route.path == path
            and method in route.methods
        ):
            return route
    raise AssertionError(f"{method} {path} isn't mounted")


def test_pause_and_resume_are_operators_only() -> None:
    for path in (
        "/shared-cloud/users/{user_keyed_id}/pause",
        "/shared-cloud/users/{user_keyed_id}/resume",
    ):
        route = _route(path, "POST")
        assert require_operator in set(_calls(route.dependant))
        assert _hosted(path)


def test_the_per_person_switch_is_the_workspaces_admins_only() -> None:
    path = "/tenants/{tenant_id}/hosted-people/{user_id}"
    route = _route(path, "PUT")
    assert require_workspace_admin in set(_calls(route.dependant))
    assert _hosted(path)


def test_without_agent_management_the_routes_answer_503() -> None:
    """The revoker comes from the wiring (`app.state.controller_revoker`), so a
    server without agent management refuses rather than half-working, and Core
    never imports `switch_core.management` (test_import_boundary)."""
    from types import SimpleNamespace

    import pytest
    from fastapi import HTTPException

    from switch_core.visibility.hosted_access_routes import get_hosted_access

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    with pytest.raises(HTTPException) as refused:
        get_hosted_access(request)  # type: ignore[arg-type]
    assert refused.value.status_code == 503

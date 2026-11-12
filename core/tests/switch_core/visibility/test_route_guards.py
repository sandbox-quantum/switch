"""Every visibility route carries one of the three role guards.

Walks the mounted gateway app, so a hosted route added without a guard fails
here rather than reaching a release. Visibility routes are those under
`/hosted-operator/` and `/shared-cloud/` (the operator and user views), and
a workspace's `/tenants/{id}/hosted-…` routes. The
older `/hosted-machines` and `/hosted-controller` routes have guards of their
own and aren't part of this feature.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from typing import Any

from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute

# Imported first: importing `switch_core.gateway.app` on its own trips an
# import cycle that exists on main (`agent_templates` ↔ `agent_template_ops`);
# `switch_core.main` loads the modules in an order that avoids it.
import switch_core.main  # noqa: F401
from switch_core.visibility.guards import (
    require_operator,
    require_user,
    require_workspace_admin,
)
from tests.switch_core.gateway.test_app_route_mounting import _app

GUARDS: set[Callable[..., Any]] = {
    require_operator,
    require_user,
    require_workspace_admin,
}


def _calls(dependant: Dependant) -> Iterator[Callable[..., Any]]:
    for dep in dependant.dependencies:
        if dep.call is not None:
            yield dep.call
        yield from _calls(dep)


_WORKSPACE_HOSTED = re.compile(r"^/tenants/\{[^}/]+\}/hosted-")


def _hosted(path: str) -> bool:
    return path.startswith(("/hosted-operator/", "/shared-cloud/")) or bool(
        _WORKSPACE_HOSTED.match(path)
    )


def test_the_route_filter() -> None:
    assert _hosted("/hosted-operator/users/{user_id}/pause")
    assert _hosted("/shared-cloud/audit-events")
    assert _hosted("/tenants/{tenant_id}/hosted-people")
    assert _hosted("/shared-cloud/overview")
    assert _hosted("/shared-cloud/agents")
    assert not _hosted("/hosted-machines/{machine_id}")
    assert not _hosted("/hosted-controller/settings")
    assert not _hosted("/tenants/{tenant_id}/members")


def test_every_hosted_route_has_a_role_guard() -> None:
    app = _app()
    hosted = [
        r
        for r in app.routes
        if isinstance(r, APIRoute) and _hosted(r.path)  # type: ignore[attr-defined]
    ]
    assert hosted, "no hosted routes found; the walk would pass vacuously"
    unguarded = [
        f"{sorted(r.methods)} {r.path}"
        for r in hosted
        if not GUARDS & set(_calls(r.dependant))
    ]
    assert unguarded == []


def test_the_operator_audit_log_is_operators_only() -> None:
    app = _app()
    [route] = [
        r
        for r in app.routes  # type: ignore[attr-defined]
        if isinstance(r, APIRoute) and r.path == "/shared-cloud/audit-events"
    ]
    assert route.methods == {"GET"}
    assert require_operator in set(_calls(route.dependant))

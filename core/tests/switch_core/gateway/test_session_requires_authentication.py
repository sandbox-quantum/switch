"""Every gateway route that opens the request session is authenticated.

`get_session` is the tenant-scoped session (`gateway/dependencies.py`): the
tenant is stamped on its transaction by the `after_begin` hook, and what binds
that tenant is `get_current_user`. A route that takes the session without
taking the user therefore runs its whole transaction unscoped — today that
merely reads and writes unscoped, and once the row-level-security policies land
it fails outright. Either way it is not a thing to discover one route at a
time.

FastAPI also resolves an endpoint's dependencies in *declaration order*, so
"authenticated" is necessary but not sufficient: a sibling dependency declared
before `get_current_user` that queried the session during its own resolution
would still open the transaction untenanted. Nothing does — every other
dependency is a plain accessor — but that is not mechanically checkable the way
this is, so it is written down in `get_session`'s docstring and this test holds
the checkable half.

Generalised from `test_collaborations_authz.py`'s per-router check, and derived
from the package rather than a hand-written list, so a new gateway router
module is covered the day it appears.
"""

from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass

from fastapi import APIRouter

import switch_core.gateway as gateway_package
from switch_core.gateway.auth import get_current_user, require_admin
from switch_core.gateway.dependencies import get_session, get_system_session

# The only routes that may open a session with no tenant bound. `get_session`
# is unavailable to them because there is no `get_current_user` to bind one:
# for login and the OIDC callback there is no caller yet at all; for switching
# tenants the caller is authenticated (`get_authenticated_user_id`) but has,
# by construction, not yet selected the tenant this session opens for — see
# `get_system_session`'s docstring. All three take `get_system_session`
# instead, which says so in the signature.
_ROUTES_WITH_NO_TENANT_BOUND = {
    ("POST", "/auth/login"),
    ("GET", "/auth/oidc/callback"),
    ("POST", "/tenants/{tenant_id}/switch"),
}


@dataclass(frozen=True)
class _Route:
    module: str
    method: str
    path: str
    calls: tuple[object, ...]

    def __str__(self) -> str:
        return f"{self.module}: {self.method} {self.path}"

    @property
    def key(self) -> tuple[str, str]:
        return (self.method, self.path)


def _dependency_calls(dependant: object) -> list[object]:
    """All dependency callables reachable from a route, recursively."""
    calls = [dependant.call]  # type: ignore[attr-defined]
    for sub in dependant.dependencies:  # type: ignore[attr-defined]
        calls.extend(_dependency_calls(sub))
    return calls


def _gateway_routes() -> list[_Route]:
    """Every route on every `router` in the `switch_core.gateway` package."""
    routes: list[_Route] = []
    for info in pkgutil.iter_modules(gateway_package.__path__):
        module = importlib.import_module(f"{gateway_package.__name__}.{info.name}")
        router = getattr(module, "router", None)
        if not isinstance(router, APIRouter):
            continue
        for route in router.routes:
            dependant = getattr(route, "dependant", None)
            if dependant is None:
                continue
            calls = tuple(_dependency_calls(dependant))
            for method in sorted(getattr(route, "methods", ()) or ()):
                routes.append(_Route(info.name, method, route.path, calls))
    return routes


ROUTES = _gateway_routes()


def test_the_discovery_finds_the_gateway_routers() -> None:
    """Guard the guard: a broken import or a renamed attribute would make
    every assertion below pass over an empty set."""
    assert {"auth_routes", "rooms", "agents", "collaborations"} <= {
        route.module for route in ROUTES
    }
    assert len([r for r in ROUTES if get_session in r.calls]) > 50


def test_every_route_taking_the_session_also_authenticates() -> None:
    unauthenticated = sorted(
        str(route)
        for route in ROUTES
        if get_session in route.calls
        and route.key not in _ROUTES_WITH_NO_TENANT_BOUND
        and get_current_user not in route.calls
        and require_admin not in route.calls
    )
    assert not unauthenticated, (
        "these routes open the tenant-scoped session without an authenticated "
        f"caller to take a tenant from: {unauthenticated}"
    )


def test_the_routes_with_no_tenant_bound_are_exactly_these_three() -> None:
    """The exemption above is not a list to grow casually: `get_system_session`
    exists so that adding a fourth is a visible act, not a signature nobody
    reads."""
    assert {
        route.key for route in ROUTES if get_system_session in route.calls
    } == _ROUTES_WITH_NO_TENANT_BOUND


def test_the_exempt_routes_do_not_also_take_the_tenant_scoped_session() -> None:
    """A route holding both would be authenticated-looking and unscoped at
    once, which is the worst of the two."""
    assert not [
        str(route)
        for route in ROUTES
        if get_session in route.calls and route.key in _ROUTES_WITH_NO_TENANT_BOUND
    ]

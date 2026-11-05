"""Which workspace a run's admin session is bound to, against a fake gateway."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))

from seed import Admin, NoWorkspace, RequestIds  # noqa: E402

HOME = {"id": "home", "slug": "home", "name": "Main"}
LOAD = {"id": "load", "slug": "load-tests", "name": "load-tests"}


class Gateway:
    """Answers the routes `use_workspace` and `refuse_bridges` call, and
    records each request with the session cookie it carried."""

    def __init__(self, workspaces: list[dict], bridges: list[dict] | None = None):
        self.workspaces = workspaces
        self.bridges = bridges or []
        self.seen: list[tuple[str, str, str | None]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        cookie = request.headers.get("cookie", "").removeprefix("switch_auth=")
        path = request.url.path.removeprefix("/gateway")
        self.seen.append((request.method, path, cookie or None))
        if (request.method, path) == ("GET", "/tenants/current"):
            return httpx.Response(200, json=HOME)
        if (request.method, path) == ("GET", "/tenants"):
            return httpx.Response(200, json=self.workspaces)
        if request.method == "POST" and path.startswith("/tenants/"):
            tenant = path.split("/")[2]
            return httpx.Response(200, json={}, headers=_cookie(tenant))
        if (request.method, path) == ("POST", "/organizations"):
            body = {"organization": {"id": "org"}, "workspace": LOAD}
            return httpx.Response(201, json=body, headers=_cookie("load"))
        if (request.method, path) == ("GET", "/collaborations"):
            return httpx.Response(200, json=self.bridges)
        return httpx.Response(404)


def _cookie(tenant: str) -> dict[str, str]:
    return {"set-cookie": f"switch_auth=cookie-{tenant}; Path=/; HttpOnly; Secure"}


def _admin(gateway: Gateway) -> Admin:
    admin = Admin("https://gateway.test", RequestIds("t"))
    admin.http = httpx.AsyncClient(
        base_url="https://gateway.test", transport=httpx.MockTransport(gateway)
    )
    admin._cookie = "cookie-home"
    return admin


def test_switches_into_the_workspace_and_puts_the_admins_selection_back() -> None:
    gateway = Gateway([HOME, LOAD])
    admin = _admin(gateway)

    async def go() -> dict:
        found = await admin.use_workspace("load-tests")
        await admin.call("GET", "/agents")
        return found

    assert asyncio.run(go()) == {"id": "load", "name": "load-tests", "made": False}
    assert gateway.seen[2:] == [
        ("POST", "/tenants/load/switch", "cookie-home"),
        ("POST", "/tenants/home/switch", "cookie-load"),
        # The session stays in the workspace; the admin's selection went back.
        ("GET", "/agents", "cookie-load"),
    ]


def test_makes_the_workspace_when_the_admin_has_none_of_that_name() -> None:
    gateway = Gateway([HOME])
    admin = _admin(gateway)

    assert asyncio.run(admin.use_workspace("load-tests")) == {
        "id": "load",
        "name": "load-tests",
        "made": True,
    }
    assert ("POST", "/organizations", "cookie-home") in gateway.seen
    assert gateway.seen[-1] == ("POST", "/tenants/home/switch", "cookie-load")
    assert admin._cookie == "cookie-load"


def test_a_run_reusing_kept_agents_never_makes_the_workspace() -> None:
    # Ten reusing workers started together would each make one otherwise.
    gateway = Gateway([HOME])
    admin = _admin(gateway)

    with pytest.raises(NoWorkspace, match="no workspace named load-tests"):
        asyncio.run(admin.use_workspace("load-tests", create=False))
    assert ("POST", "/organizations", "cookie-home") not in gateway.seen


def test_refuses_a_name_two_workspaces_share() -> None:
    admin = _admin(Gateway([HOME, LOAD, {**LOAD, "id": "load-2"}]))

    with pytest.raises(RuntimeError, match="2 workspaces named load-tests"):
        asyncio.run(admin.use_workspace("load-tests"))


def test_refuses_a_workspace_with_an_active_bridge() -> None:
    slack = {"bridge_type": "slack", "display_name": "Team", "status": "active"}
    paused = {"bridge_type": "mattermost", "display_name": "MM", "status": "inactive"}

    with pytest.raises(RuntimeError, match="slack 'Team'"):
        asyncio.run(_admin(Gateway([HOME], [slack, paused])).refuse_bridges())
    asyncio.run(_admin(Gateway([HOME], [paused])).refuse_bridges())

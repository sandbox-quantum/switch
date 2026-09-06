"""The bundled setup script has to authenticate over plain HTTP in-cluster.

A deployment served over HTTPS sets `GATEWAY_COOKIE_SECURE`, so the gateway
marks the `switch_auth` cookie `Secure`. The setup job runs inside the cluster
and talks to `http://<service>:8000` — where a cookie jar will accept a Secure
cookie but never send one back. So login returned 200 with the cookie sitting
visibly in the jar, and every authorized call after it went out bare and came
back 401. That is what made the post-upgrade hook fail on every HTTPS
deployment while passing locally.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[4]
_SETUP_PY = _REPO_ROOT / "deploy" / "shared_resources" / "setup.py"

# setup.py reads its configuration at import time, by design — it is a
# single-shot container entrypoint, not a library.
_ENV = {
    "SWITCH_URL": "http://switch-core:8000",
    "GATEWAY_ADMIN_EMAIL": "admin@example.com",
    "GATEWAY_ADMIN_PASSWORD": "hunter2",
    "MATTERMOST_URL": "http://mattermost:8065",
    "MATTERMOST_ADMIN_USER": "admin",
    "MATTERMOST_ADMIN_PASSWORD": "hunter2",
    "MATTERMOST_TEAM_NAME": "switch",
    "MATTERMOST_USER": "user",
    "MATTERMOST_USER_PASSWORD": "hunter2",
}


@pytest.fixture(scope="module")
def setup_module_() -> Any:
    saved = {k: os.environ.get(k) for k in _ENV}
    os.environ.update(_ENV)
    try:
        spec = importlib.util.spec_from_file_location("_switch_setup", _SETUP_PY)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules["_switch_setup"] = module
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop("_switch_setup", None)
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _login_response(set_cookie: str | None) -> httpx.Response:
    headers = {"set-cookie": set_cookie} if set_cookie else {}
    return httpx.Response(
        200,
        json={"ok": True},
        headers=headers,
        # `Response.cookies` reads the scheme off the originating request, so a
        # response without one cannot be asked about cookies at all.
        request=httpx.Request("POST", "http://switch-core:8000/gateway/auth/login"),
    )


def test_a_secure_cookie_is_stored_over_http_but_never_sent_back() -> None:
    """The premise, pinned rather than assumed — and it is not quite the
    obvious one.

    The cookie jar *accepts* a Secure cookie over http; what it refuses is to
    send one back on a non-https request. So the login looks entirely healthy
    — 200, and the cookie visibly in the jar — and every authorized call after
    it goes out bare. That is why this failed as a 401 rather than as a login
    error, and why it was invisible in the setup job's own output.
    """
    sent: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/gateway/auth/login":
            return _login_response("switch_auth=tok; Path=/; HttpOnly; Secure")
        sent.append(request.headers.get("cookie"))
        return httpx.Response(200, json=[])

    transport = httpx.MockTransport(handler)
    with httpx.Client(base_url="http://switch-core:8000", transport=transport) as c:
        c.post("/gateway/auth/login", json={})
        assert c.cookies.get("switch_auth") == "tok"  # accepted…
        c.get("/gateway/collaborations")

    assert sent == [None]  # …and withheld


def test_the_token_is_read_off_a_secure_cookie_anyway(setup_module_: Any) -> None:
    resp = _login_response(
        "switch_auth=tok-abc; Path=/; HttpOnly; Secure; SameSite=lax"
    )

    assert setup_module_._session_token(resp) == "tok-abc"


def test_the_token_is_read_off_an_ordinary_cookie_too(setup_module_: Any) -> None:
    resp = _login_response("switch_auth=tok-plain; Path=/; HttpOnly")

    assert setup_module_._session_token(resp) == "tok-plain"


def test_no_cookie_at_all_reads_as_no_token(setup_module_: Any) -> None:
    assert setup_module_._session_token(_login_response(None)) is None


def test_the_session_survives_login_and_authorizes_the_next_call(
    setup_module_: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end: log in over http against a Secure-cookie gateway, then make
    an authorized call and confirm it carries the session."""
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/gateway/auth/login":
            return _login_response("switch_auth=tok-xyz; Path=/; HttpOnly; Secure")
        seen.append(request.headers.get("cookie"))
        return httpx.Response(200, json=[])

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def client_with_transport(**kwargs: Any) -> httpx.Client:
        return real_client(**{**kwargs, "transport": transport})

    monkeypatch.setattr(setup_module_.httpx, "Client", client_with_transport)

    client = setup_module_.gateway_login()
    client.get("/gateway/collaborations")

    assert seen == ["switch_auth=tok-xyz"]


def test_a_login_that_sets_no_cookie_stops_rather_than_carrying_on(
    setup_module_: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    transport = httpx.MockTransport(lambda request: _login_response(None))
    real_client = httpx.Client
    monkeypatch.setattr(
        setup_module_.httpx,
        "Client",
        lambda **kw: real_client(**{**kw, "transport": transport}),
    )

    with pytest.raises(SystemExit):
        setup_module_.gateway_login()


def test_an_unauthorized_bridge_read_is_not_read_as_no_bridges(
    setup_module_: Any,
) -> None:
    """The second defect: `if resp.is_success` treated a 401 as an empty list,
    then registered a *second* Mattermost bridge with set_as_default — taking
    the default from whatever held it. A failed read must stop."""
    posted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            posted.append(str(request.url))
            return httpx.Response(200, json={"bridge_id": "should-not-happen"})
        return httpx.Response(401, json={"detail": "Not authenticated"})

    client = httpx.Client(
        base_url="http://switch-core:8000", transport=httpx.MockTransport(handler)
    )

    with pytest.raises(httpx.HTTPStatusError):
        setup_module_.register_bridge(client)
    assert posted == []

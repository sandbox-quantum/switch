"""The shared Origin check for cookie-authenticated changes.
No database: a small app behind the
middleware stands in for the gateway."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from switch_core.gateway.origin_check import (
    REFUSAL,
    OriginCheckMiddleware,
    allowed_origins,
    check_extra_origin,
    log_origin_setup,
    normalise_origin,
)

SERVER = "https://switch.example.com"
COOKIE = {"cookie": "switch_auth=session-token-zz7"}
MARKER = "zz-origin-marker-91c"


def _app(allowed: frozenset[str]) -> tuple[FastAPI, list[str]]:
    calls: list[str] = []
    app = FastAPI()

    @app.post("/change")
    async def change() -> dict[str, bool]:
        calls.append("change")
        return {"ok": True}

    @app.put("/change")
    async def change_put() -> dict[str, bool]:
        calls.append("put")
        return {"ok": True}

    @app.delete("/change")
    async def change_delete() -> dict[str, bool]:
        calls.append("delete")
        return {"ok": True}

    @app.get("/read")
    async def read() -> dict[str, bool]:
        calls.append("read")
        return {"ok": True}

    @app.post("/upload")
    async def upload(request: Request) -> dict[str, int]:
        body = await request.body()
        calls.append("upload")
        return {"bytes": len(body)}

    @app.websocket("/socket")
    async def socket(websocket: WebSocket) -> None:
        await websocket.accept()
        calls.append("socket")
        await websocket.close()

    app.add_middleware(OriginCheckMiddleware, allowed=allowed)
    return app, calls


def _client(allowed: frozenset[str] = frozenset({SERVER})) -> tuple[TestClient, list]:
    app, calls = _app(allowed)
    return TestClient(app, base_url="https://switch.example.com"), calls


def _refused(response) -> bool:
    return response.status_code == 403 and response.json() == {"detail": REFUSAL}


# ── Matching origins ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "configured",
    [
        "https://switch.example.com",
        "https://switch.example.com:443",
        "https://switch.example.com/",
        "https://switch.example.com/gateway/",
        "HTTPS://Switch.Example.COM",
    ],
)
def test_a_configured_address_in_any_spelling_matches_the_browsers_origin(
    configured: str,
) -> None:
    """A port, slash, path or capitals in the setting still match
    a browser's Origin, which never has them."""
    client, calls = _client(frozenset({normalise_origin(configured) or ""}))
    for origin in ("https://switch.example.com", "https://SWITCH.example.com"):
        response = client.post("/change", headers={**COOKIE, "origin": origin})
        assert response.status_code == 200
    assert calls == ["change", "change"]


def test_each_configured_origin_passes_and_a_same_origin_referer_passes() -> None:
    allowed = frozenset({SERVER, "https://ui.example.com"})
    client, calls = _client(allowed)
    for origin in allowed:
        assert (
            client.post("/change", headers={**COOKIE, "origin": origin}).status_code
            == 200
        )
    referer = {**COOKIE, "referer": f"{SERVER}/rooms?x=1"}
    assert client.post("/change", headers=referer).status_code == 200
    assert calls == ["change", "change", "change"]


# ── Refusals ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://evil.example.org"},
        {"origin": "https://evil.example.com"},  # a sibling subdomain
        {"origin": "null"},
        {"origin": "http://switch.example.com"},  # scheme differs
        {"origin": "https://switch.example.com:8443"},  # port differs
        {"origin": "not a url"},
        {"referer": "https://evil.example.com/page"},
        {"sec-fetch-site": "same-site"},  # a browser, but no Origin or Referer
        {"sec-fetch-site": "same-origin", "sec-fetch-mode": "cors"},
    ],
)
def test_a_cookie_change_from_anywhere_else_is_refused_and_does_nothing(
    headers: dict[str, str],
) -> None:
    client, calls = _client()
    for method in ("post", "put", "delete"):
        response = getattr(client, method)("/change", headers={**COOKIE, **headers})
        assert _refused(response)
        assert response.headers["x-frame-options"] == "DENY"
    assert calls == []


@pytest.mark.parametrize("authorization", ["Bearer junk", "Bearer ", "", "Basic eA=="])
def test_an_authorization_header_never_carries_a_cookie_request_past_the_check(
    authorization: str,
) -> None:
    """A bad or empty bearer beside the cookie is still checked."""
    client, calls = _client()
    foreign = {
        **COOKIE,
        "authorization": authorization,
        "origin": "https://evil.example.com",
    }
    assert _refused(client.post("/change", headers=foreign))
    browser = {**COOKIE, "authorization": authorization, "sec-fetch-site": "cross-site"}
    assert _refused(client.post("/change", headers=browser))
    assert calls == []


def test_a_multipart_upload_is_checked_like_json() -> None:
    """A multipart upload is checked the same way as JSON."""
    client, calls = _client()
    files = {"file": ("a.txt", b"hello", "text/plain")}
    foreign = {**COOKIE, "origin": "https://evil.example.com"}
    assert _refused(client.post("/upload", headers=foreign, files=files))
    same = {**COOKIE, "origin": SERVER}
    assert client.post("/upload", headers=same, files=files).status_code == 200
    assert calls == ["upload"]


def test_a_cookie_websocket_from_another_origin_is_closed() -> None:
    """A browser's cookie WebSocket from another origin, or with
    no Origin at all, is closed."""
    client, calls = _client()
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(
            "/socket", headers={**COOKIE, "origin": "https://evil.example.com"}
        ):
            pass
    assert closed.value.code == 4403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/socket", headers={**COOKIE, "sec-fetch-site": "same-site"}
        ):
            pass
    with client.websocket_connect("/socket", headers={**COOKIE, "origin": SERVER}):
        pass
    assert calls == ["socket"]


def test_console_s_change_socket_shape_passes() -> None:
    """Switch Console's main process opens `/changes/ws` with Node's WebSocket:
    the cookie, no Origin, Referer or Sec-Fetch-Site (rule 3, as for its
    fetch calls). Refusing it would turn off Console's live list updates."""
    client, calls = _client()
    node_handshake = {**COOKIE, "sec-fetch-mode": "websocket", "user-agent": "node"}
    with client.websocket_connect("/socket", headers=node_handshake):
        pass
    assert calls == ["socket"]


# ── What passes unchecked ────────────────────────────────────────────────────


def test_console_s_exact_request_shape_passes() -> None:
    """Rule 3, pinned to what Console's main process sends (Node's fetch): the
    cookie, `sec-fetch-mode: cors`, and no Origin, Referer or
    `Sec-Fetch-Site`. Temporary, until Console sends Origin."""
    client, calls = _client()
    console = {
        **COOKIE,
        "sec-fetch-mode": "cors",
        "accept": "*/*",
        "user-agent": "node",
        "content-type": "application/json",
    }
    assert client.post("/change", headers=console, content=b"{}").status_code == 200
    assert calls == ["change"]


def test_bearer_requests_and_reads_are_not_checked() -> None:
    client, calls = _client()
    foreign = {"origin": "https://evil.example.com"}
    bearer = {**foreign, "authorization": "Bearer controller-token"}
    assert client.post("/change", headers=bearer).status_code == 200
    assert client.get("/read", headers={**COOKIE, **foreign}).status_code == 200
    assert calls == ["change", "read"]


def test_every_answer_refuses_framing() -> None:
    client, _ = _client()
    response = client.get("/read")
    assert response.headers["x-frame-options"] == "DENY"


# ── The log ──────────────────────────────────────────────────────────────────


def test_the_warn_names_the_method_and_rule_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client, _ = _client()
    with caplog.at_level(logging.WARNING, logger="switch_core.gateway.origin_check"):
        client.post(
            "/change",
            headers={**COOKIE, "origin": f"https://{MARKER}.example.com"},
            content=MARKER.encode(),
        )
    records = [r for r in caplog.records if r.name.endswith("origin_check")]
    assert len(records) == 1
    record = records[0]
    assert (record.method, record.rule) == ("POST", "origin")  # type: ignore[attr-defined]
    text = record.getMessage() + repr(record.__dict__)
    assert MARKER not in text
    assert "session-token-zz7" not in text


# ── With no origins configured ───────────────────────────────────────────────


def test_unconfigured_the_requests_own_host_passes_and_a_sibling_fails() -> None:
    client, calls = _client(frozenset())
    own = {**COOKIE, "origin": "https://switch.example.com"}
    assert client.post("/change", headers=own).status_code == 200
    sibling = {**COOKIE, "origin": "https://evil.example.com"}
    assert _refused(client.post("/change", headers=sibling))
    assert calls == ["change"]


# ── Building the allowed set ─────────────────────────────────────────────────


def _config(**overrides: object) -> SimpleNamespace:
    base = {
        "gateway_public_url": None,
        "frontend_base_url": None,
        "gateway_oidc_enabled": False,
        "gateway_oidc_redirect_url": None,
        "gateway_extra_origins": [],
    }
    return SimpleNamespace(**{**base, **overrides})


def test_the_allowed_set_comes_from_config_only() -> None:
    config = _config(
        gateway_public_url="https://switch.example.com/",
        frontend_base_url="https://ui.example.com:443",
        gateway_oidc_enabled=True,
        gateway_oidc_redirect_url="https://login.example.com/gateway/auth/oidc/callback",
        gateway_extra_origins=["http://localhost:5173"],
    )
    assert allowed_origins(config) == {  # type: ignore[arg-type]
        "https://switch.example.com",
        "https://ui.example.com",
        "https://login.example.com",
        "http://localhost:5173",
    }
    off = _config(gateway_oidc_redirect_url="https://login.example.com/cb")
    assert allowed_origins(off) == frozenset()  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "entry",
    [
        "http://localhost:5173",
        "http://127.0.0.1:8080",
        "http://[::1]:3000",
        "https://dev.example.com",
    ],
)
def test_an_extra_origin_is_scheme_host_and_port(entry: str) -> None:
    assert check_extra_origin(entry) == normalise_origin(entry)


@pytest.mark.parametrize(
    "entry",
    [
        "http://dev.example.com",  # plain http is refused off loopback
        "http://10.0.0.5:5173",
        "https://dev.example.com/app",
        "https://dev.example.com/?x=1",
        "ftp://dev.example.com",
        "dev.example.com",
        "",
    ],
)
def test_a_bad_extra_origin_is_refused_at_start(entry: str) -> None:
    with pytest.raises(ValueError, match="GATEWAY_EXTRA_ORIGINS"):
        check_extra_origin(entry)


def test_the_config_refuses_a_bad_extra_origin() -> None:
    from pydantic import ValidationError

    from switch_core.config import SwitchConfig

    with pytest.raises(ValidationError, match="loopback"):
        SwitchConfig.model_validate(
            {"gateway_extra_origins": ["http://dev.example.com"]}, strict=False
        )


def test_start_up_warns_with_no_origins_or_any_extra(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="switch_core.gateway.origin_check"):
        log_origin_setup(_config(), frozenset())  # type: ignore[arg-type]
        log_origin_setup(
            _config(gateway_extra_origins=["http://localhost:5173"]),  # type: ignore[arg-type]
            frozenset({"http://localhost:5173"}),
        )
    messages = [r.getMessage() for r in caplog.records]
    assert any("GATEWAY_PUBLIC_URL" in m for m in messages)
    assert any("GATEWAY_EXTRA_ORIGINS" in m for m in messages)


@pytest.mark.parametrize(
    "cookie",
    [
        'bad="unterminated; switch_auth=session-token-zz7',
        "a=b; c; switch_auth=session-token-zz7",
        'x=\\"y; switch_auth=session-token-zz7',
        "switch_auth=session-token-zz7; =odd",
        "SWITCH_auth=no; switch_auth=session-token-zz7",
        "switch_auth=session-token-zz7",
        'x="planted; switch_auth=session-token-zz7',
        'x={"a":1}; switch_auth=session-token-zz7',
        "x=a b; switch_auth=session-token-zz7",
    ],
)
def test_a_malformed_cookie_beside_switch_auth_cant_hide_it(cookie: str) -> None:
    """Security: another cookie on the site, which a sibling
    subdomain can set, must never make the check miss `switch_auth` while
    sign-in still finds it."""
    from starlette.requests import cookie_parser

    assert "switch_auth" in cookie_parser(cookie)
    client, calls = _client()
    foreign = {"cookie": cookie, "origin": "https://evil.example.com"}
    assert _refused(client.post("/change", headers=foreign))
    assert calls == []


# ── Sign-in is checked with no cookie ───────────────────────────────


def _sign_in_app(allowed: frozenset[str] = frozenset({SERVER})):
    """The sign-in routes behind the middleware, on a gateway app mounted at
    `/gateway` as Core mounts it, so the prefix is handled too."""
    calls: list[str] = []
    gateway = FastAPI()
    for path in ("/auth/login", "/auth/signup", "/auth/oidc/exchange", "/other"):

        async def handler(path: str = path) -> dict[str, bool]:
            calls.append(path)
            return {"ok": True}

        gateway.post(path)(handler)
    gateway.add_middleware(OriginCheckMiddleware, allowed=allowed)
    outer = FastAPI()
    outer.mount("/gateway", gateway)
    return TestClient(outer, base_url=SERVER), calls


@pytest.mark.parametrize("path", ["/auth/login", "/auth/signup", "/auth/oidc/exchange"])
@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://evil.example.com"},
        {"origin": "https://other.switch.example.com"},
        {"origin": "null"},
        {"referer": "https://evil.example.com/page"},
        {"sec-fetch-site": "cross-site"},
    ],
)
def test_a_foreign_sign_in_is_refused_with_no_cookie(path: str, headers: dict) -> None:
    client, calls = _sign_in_app()
    response = client.post(f"/gateway{path}", headers=headers, json={})
    assert _refused(response)
    assert calls == []


@pytest.mark.parametrize("path", ["/auth/login", "/auth/signup", "/auth/oidc/exchange"])
def test_sign_in_from_switch_or_console_passes(path: str) -> None:
    client, calls = _sign_in_app()
    from_page = client.post(f"/gateway{path}", headers={"origin": SERVER}, json={})
    assert from_page.status_code == 200
    # Console's main process: no Origin, no Referer, no Sec-Fetch-Site.
    from_console = client.post(f"/gateway{path}", json={})
    assert from_console.status_code == 200
    assert calls == [path, path]


def test_other_cookie_less_requests_still_arent_checked() -> None:
    client, calls = _sign_in_app()
    response = client.post(
        "/gateway/other", headers={"origin": "https://evil.example.com"}, json={}
    )
    assert response.status_code == 200
    assert calls == ["/other"]


def test_people_s_routes_never_fall_back_from_a_bearer_to_the_cookie() -> None:
    """People's routes read only the `switch_auth` cookie.
    A bearer with no cookie is a 401, so there's no fallback either way."""
    from fastapi import HTTPException
    from starlette.requests import Request as StarletteRequest

    from switch_core.gateway.auth import _session_claims

    request = StarletteRequest(
        {
            "type": "http",
            "method": "GET",
            "path": "/me",
            "headers": [(b"authorization", b"Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln")],
        }
    )
    with pytest.raises(HTTPException) as refused:
        _session_claims(request, SimpleNamespace())  # type: ignore[arg-type]
    assert refused.value.status_code == 401


# ── Switch web's hosted calls go through the check ─────────────


def _hosted_web_app(allowed: frozenset[str] = frozenset({SERVER})) -> TestClient:
    """The real routes Switch web's hosted pages change things with: agent
    management (create an agent, give or withdraw a login) and the person's
    cloud machine (ensure, lifecycle), mounted on a gateway app behind the middleware as
    Core mounts them (`mount_gateway_routes`, `create_gateway_app`). A refused
    request never reaches a route: no database is needed to show it."""
    from switch_core.gateway.agents import router as agents_router
    from switch_core.gateway.hosted_machines import router as hosted_machines_router
    from switch_core.management.wiring import mount_gateway_routes

    gateway = FastAPI()
    mount_gateway_routes(gateway)
    gateway.include_router(hosted_machines_router)
    gateway.include_router(agents_router, prefix="/agents")
    gateway.add_middleware(OriginCheckMiddleware, allowed=allowed)
    outer = FastAPI()
    outer.mount("/gateway", gateway)
    return TestClient(outer, base_url=SERVER, raise_server_exceptions=False)


HOSTED_WEB_CHANGES = [
    ("POST", "/gateway/management/agents"),
    ("POST", "/gateway/hosted-machines/ensure"),
    ("POST", "/gateway/hosted-machines/m-1/lifecycle"),
    ("PUT", "/gateway/management/controllers/c-1/provider-logins/claude"),
    ("DELETE", "/gateway/management/controllers/c-1/provider-logins/claude"),
    # Deleting a cloud agent from Switch web (slice 5): the same route as every agent.
    ("DELETE", "/gateway/agents/a-1"),
]


@pytest.mark.parametrize(("method", "path"), HOSTED_WEB_CHANGES)
@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://evil.example.com"},
        {"referer": "https://evil.example.com/page"},
        {"sec-fetch-site": "cross-site"},
    ],
)
def test_a_cross_origin_hosted_change_with_the_cookie_is_refused(
    method: str, path: str, headers: dict
) -> None:
    client = _hosted_web_app()
    response = client.request(method, path, headers={**COOKIE, **headers}, json={})
    assert _refused(response)


@pytest.mark.parametrize(("method", "path"), HOSTED_WEB_CHANGES)
def test_the_same_hosted_change_from_switch_web_passes_the_check(
    method: str, path: str
) -> None:
    """From Switch web's own page the check lets it through to the route, which
    then answers for itself (here without a database, never the check's 403)."""
    client = _hosted_web_app()
    response = client.request(
        method, path, headers={**COOKIE, "origin": SERVER}, json={}
    )
    assert not _refused(response)

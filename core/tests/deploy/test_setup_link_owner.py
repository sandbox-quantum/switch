"""The setup job links the seeded Mattermost account to the seeded admin, and
confirms the link with that account's own session (CHOO-3881).

A link counts only once the account confirms it. A person confirms by posting
a code where an agent can hear it, and a fresh deployment has no agent yet, so
setup proves the account the other way: it signs in as the account it
created and hands Switch the session, then signs out.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SETUP_PY = _REPO_ROOT / "deploy" / "shared_resources" / "setup.py"

_ENV = {
    "SWITCH_URL": "http://switch-core:8000",
    "GATEWAY_ADMIN_EMAIL": "admin@example.invalid",
    "GATEWAY_ADMIN_PASSWORD": "setup-test-password",
    "MATTERMOST_URL": "http://mattermost:8065",
    "MATTERMOST_ADMIN_USER": "admin",
    "MATTERMOST_ADMIN_PASSWORD": "setup-test-password",
    "MATTERMOST_TEAM_NAME": "switch",
    "MATTERMOST_USER": "user",
    "MATTERMOST_USER_PASSWORD": "user-test-password",
}


@pytest.fixture
def setup_script(monkeypatch: pytest.MonkeyPatch) -> Any:
    for key, value in _ENV.items():
        monkeypatch.setenv(key, value)
    spec = importlib.util.spec_from_file_location("_switch_setup_link", _SETUP_PY)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["_switch_setup_link"] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop("_switch_setup_link", None)


class _Platforms:
    """Switch's gateway and the bundled Mattermost, recording every call."""

    def __init__(
        self,
        *,
        claim: dict[str, Any],
        login_status: int = 200,
        linked: list[dict[str, Any]] | None = None,
    ) -> None:
        self.claim = claim
        self.login_status = login_status
        self.linked = linked or []
        self.calls: list[tuple[str, str, Any]] = []

    def gateway(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
        path = request.url.path
        if path == "/gateway/auth/me/identities":
            return httpx.Response(200, json=self.linked)
        if path.endswith("/directory"):
            return httpx.Response(200, json={"users": [{"external_user_id": "mm-1"}]})
        if path.endswith("/identities"):
            return httpx.Response(200, json=self.claim)
        if path.endswith("/verify-session"):
            return httpx.Response(200, json={**self.claim, "link_request": None})
        return httpx.Response(404)

    def mattermost(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append(
            (
                request.method,
                request.url.path,
                body or request.headers.get("authorization"),
            )
        )
        if request.url.path == "/api/v4/users/login":
            if self.login_status != 200:
                return httpx.Response(self.login_status, text="no")
            return httpx.Response(200, headers={"Token": "mm-session"}, json={})
        return httpx.Response(200, json={})


def _run(
    setup_script: Any, platforms: _Platforms, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_client = httpx.Client

    def client(*, base_url: str, timeout: float) -> httpx.Client:
        assert base_url == _ENV["MATTERMOST_URL"]
        return real_client(
            base_url=base_url,
            timeout=timeout,
            transport=httpx.MockTransport(platforms.mattermost),
        )

    monkeypatch.setattr(setup_script, "httpx", SimpleNamespace(Client=client))
    gateway = real_client(
        base_url=_ENV["SWITCH_URL"], transport=httpx.MockTransport(platforms.gateway)
    )
    setup_script.link_owner_identity(gateway, "bridge-1", "mm-1")


_PENDING = {
    "id": "identity-1",
    "link_request": {"user_id": "admin-id", "code": {"code": "ABCD-EFGH"}},
}


def test_a_waiting_link_is_confirmed_with_the_accounts_session(
    setup_script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    platforms = _Platforms(claim=_PENDING)

    _run(setup_script, platforms, monkeypatch)

    assert (
        "POST",
        "/api/v4/users/login",
        {"login_id": "user", "password": "user-test-password"},
    ) in platforms.calls
    assert (
        "POST",
        "/gateway/collaborations/bridge-1/identities/identity-1/verify-session",
        {"token": "mm-session"},
    ) in platforms.calls
    # Signed out again, with the session it opened.
    assert platforms.calls[-1] == ("POST", "/api/v4/users/logout", "Bearer mm-session")


def test_a_link_that_needs_no_confirming_opens_no_session(
    setup_script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    platforms = _Platforms(claim={"id": "identity-1", "link_request": None})

    _run(setup_script, platforms, monkeypatch)

    assert not any(path.startswith("/api/v4/") for _m, path, _b in platforms.calls)


def test_a_failed_sign_in_leaves_the_link_waiting(
    setup_script: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    platforms = _Platforms(claim=_PENDING, login_status=401)

    _run(setup_script, platforms, monkeypatch)

    assert not any(path.endswith("/verify-session") for _m, path, _b in platforms.calls)
    assert "waiting to be confirmed" in capsys.readouterr().out


def test_a_link_from_before_confirmation_is_confirmed_on_a_rerun(
    setup_script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    platforms = _Platforms(
        claim=_PENDING,
        linked=[
            {"bridge_id": "bridge-1", "external_user_id": "mm-1", "verified": False}
        ],
    )

    _run(setup_script, platforms, monkeypatch)

    assert any(path.endswith("/verify-session") for _m, path, _b in platforms.calls)


def test_an_unconfirmed_link_to_another_account_is_left_alone(
    setup_script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The admin linked their own account before confirmation existed: setup
    # must not add the seeded one beside it.
    platforms = _Platforms(
        claim=_PENDING,
        linked=[
            {"bridge_id": "bridge-1", "external_user_id": "mm-other", "verified": False}
        ],
    )

    _run(setup_script, platforms, monkeypatch)

    assert [(m, path) for m, path, _b in platforms.calls] == [
        ("GET", "/gateway/auth/me/identities")
    ]


def test_a_confirmed_link_is_left_alone(
    setup_script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    platforms = _Platforms(
        claim=_PENDING, linked=[{"bridge_id": "bridge-1", "verified": True}]
    )

    _run(setup_script, platforms, monkeypatch)

    assert [(m, path) for m, path, _b in platforms.calls] == [
        ("GET", "/gateway/auth/me/identities")
    ]


def test_the_claim_says_it_expects_confirmation(
    setup_script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    platforms = _Platforms(claim=_PENDING)

    _run(setup_script, platforms, monkeypatch)

    claim = next(
        body
        for m, path, body in platforms.calls
        if m == "POST" and path.endswith("/identities")
    )
    assert claim["expects_confirmation"] is True

"""Tests for the silent session-renewal endpoint (CHOO-1435).

`POST /gateway/auth/refresh` re-mints the `switch_auth` cookie for a caller
whose current cookie is still valid, so an active Switch Console client renews its
session before expiry without bouncing the user to sign-in. The route depends
on `get_current_user`, which already rejects a missing/expired/invalid cookie
with 401 — so an expired session cannot renew itself. Here we exercise the
route coroutine directly against a lightweight config stub.
"""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import Response

from switch_core.db.models import User
from switch_core.gateway.auth import decode_jwt
from switch_core.gateway.auth_routes import refresh

# Dummy HS256 signing key for these unit tests only — not a real secret.
_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow


def _config(*, cookie_secure: bool = False) -> SimpleNamespace:
    # refresh() only touches these two config attributes.
    return SimpleNamespace(jwt_secret_key=_SECRET, gateway_cookie_secure=cookie_secure)


def _extract_cookie(response: Response) -> str:
    raw = response.headers.get("set-cookie")
    assert raw is not None, "refresh did not set a cookie"
    pair = raw.split(";")[0]
    key, _, value = pair.partition("=")
    assert key == "switch_auth"
    return value


async def test_refresh_remints_cookie_for_current_user() -> None:
    user = User(id="u-1", name="Ada", email="ada@example.com", role="user")
    response = Response()

    result = await refresh(response, user, _config())

    token = _extract_cookie(response)
    payload = decode_jwt(token, _SECRET)
    assert payload["sub"] == "u-1"
    assert payload["email"] == "ada@example.com"
    assert payload["role"] == "user"
    # The renewed token carries a fresh expiry.
    assert payload["exp"] > payload["iat"]
    # And the response body echoes the renewed user.
    assert result.id == "u-1"
    assert result.email == "ada@example.com"


async def test_refresh_cookie_is_httponly_and_respects_secure_flag() -> None:
    user = User(id="u-2", name="Bo", email="bo@example.com", role="admin")

    insecure = Response()
    await refresh(insecure, user, _config(cookie_secure=False))
    header = insecure.headers.get("set-cookie") or ""
    assert "httponly" in header.lower()
    assert "secure" not in header.lower()

    secure = Response()
    await refresh(secure, user, _config(cookie_secure=True))
    assert "secure" in (secure.headers.get("set-cookie") or "").lower()

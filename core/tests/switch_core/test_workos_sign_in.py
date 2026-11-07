"""Exchanging an AuthKit sign-in for the admin's token for an organization."""

from __future__ import annotations

import json
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest

from switch_core.organization_directory import DirectoryUnavailable
from switch_core.workos_sign_in import SignInRefused, WorkOSOrganizationSignIn

API = "https://api.workos.example.test"
KEY = "workos-api-key-placeholder"
CLIENT_ID = "client_EXAMPLE"
REDIRECT = "https://switch.example.test/gateway/auth/workos/callback"


def access_token(expires_at: int) -> str:
    return jwt.encode(
        {"exp": expires_at, "sub": "user_A"},
        "test-signing-key-long-enough-for-hs256",
        algorithm="HS256",
    )


def _sign_in(handler) -> WorkOSOrganizationSignIn:
    return WorkOSOrganizationSignIn(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        KEY,
        API,
        CLIENT_ID,
        REDIRECT,
    )


def test_the_browser_is_sent_to_sign_in_for_the_organization() -> None:
    url = _sign_in(lambda request: httpx.Response(500)).authorize_url(
        "org_A", "the-state", "the-challenge"
    )

    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == (
        f"{API}/user_management/authorize"
    )
    assert {key: value[0] for key, value in parse_qs(parts.query).items()} == {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "provider": "authkit",
        "organization_id": "org_A",
        "state": "the-state",
        "code_challenge": "the-challenge",
        "code_challenge_method": "S256",
    }


async def test_a_code_is_exchanged_for_the_token_and_its_expiry() -> None:
    expires_at = int(time.time()) + 300
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "user": {"id": "user_A"},
                "organization_id": "org_A",
                "access_token": access_token(expires_at),
                "refresh_token": "dropped",
            },
        )

    token = await _sign_in(handler).authenticate("the-code", "the-verifier")

    assert (token.subject, token.workos_organization_id, token.expires_at) == (
        "user_A",
        "org_A",
        expires_at,
    )
    [request] = seen
    assert request.url.path == "/user_management/authenticate"
    assert json.loads(request.content) == {
        "client_id": CLIENT_ID,
        "client_secret": KEY,
        "grant_type": "authorization_code",
        "code": "the-code",
        "code_verifier": "the-verifier",
    }


async def test_a_refused_code_is_refused() -> None:
    with pytest.raises(SignInRefused):
        await _sign_in(lambda request: httpx.Response(400)).authenticate("c", "v")


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(500),
        httpx.Response(200, json={"user": {"id": "user_A"}}),
        httpx.Response(
            200,
            json={
                "user": {"id": "user_A"},
                "organization_id": "org_A",
                "access_token": "not-a-token",
            },
        ),
    ],
)
async def test_anything_else_is_unavailable(answer: httpx.Response) -> None:
    with pytest.raises(DirectoryUnavailable):
        await _sign_in(lambda request: answer).authenticate("c", "v")

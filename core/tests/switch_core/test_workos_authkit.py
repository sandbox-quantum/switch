"""Signing people in through WorkOS AuthKit, and their sessions there."""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest

from switch_core.workos_authkit import (
    AuthKit,
    AuthKitOrganization,
    AuthKitRefused,
    AuthKitUnavailable,
)

API = "https://api.workos.example.test"
KEY = "workos-api-key-placeholder"
CLIENT_ID = "client_EXAMPLE"
REDIRECT = "https://switch.example.test/gateway/auth/oidc/callback"


def access_token(session_id: str | None = "session_A") -> str:
    claims = {"sub": "user_A", "exp": 4_000_000_000}
    if session_id is not None:
        claims["sid"] = session_id
    return jwt.encode(
        claims, "test-signing-key-long-enough-for-hs256", algorithm="HS256"
    )


def authenticated(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "user": {
            "id": "user_A",
            "email": "ada@example.test",
            "email_verified": True,
            "first_name": "Ada",
            "last_name": "Lovelace",
        },
        "organization_id": "org_A",
        "access_token": access_token(),
        "refresh_token": "refresh-placeholder",
        "authentication_method": "Password",
    }
    body.update(overrides)
    return body


def _authkit(handler) -> AuthKit:
    return AuthKit(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)), KEY, API, CLIENT_ID
    )


async def _never(_organizations: list[AuthKitOrganization]) -> str | None:
    raise AssertionError("no organization should have been asked for")


def test_the_browser_goes_to_authkit_with_pkce_and_what_workos_sent() -> None:
    url = _authkit(lambda request: httpx.Response(500)).authorize_url(
        redirect_uri=REDIRECT,
        state="the-state",
        challenge="the-challenge",
        extra={"invitation_token": "invite-token", "login_hint": "ada@example.test"},
    )
    parts = urlsplit(url)
    assert (
        f"{parts.scheme}://{parts.netloc}{parts.path}"
        == f"{API}/user_management/authorize"
    )
    assert {key: value[0] for key, value in parse_qs(parts.query).items()} == {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "provider": "authkit",
        "state": "the-state",
        "code_challenge": "the-challenge",
        "code_challenge_method": "S256",
        "invitation_token": "invite-token",
        "login_hint": "ada@example.test",
    }


def test_what_workos_sent_cannot_override_the_sign_in() -> None:
    url = _authkit(lambda request: httpx.Response(500)).authorize_url(
        redirect_uri=REDIRECT,
        state="the-state",
        challenge="the-challenge",
        extra={"redirect_uri": "https://elsewhere.example.test/", "state": "other"},
    )
    query = parse_qs(urlsplit(url).query)
    assert query["redirect_uri"] == [REDIRECT]
    assert query["state"] == ["the-state"]


def test_sign_out_goes_to_workos_and_comes_back() -> None:
    url = _authkit(lambda request: httpx.Response(500)).logout_url(
        "session_A", "https://switch.example.test/login"
    )
    parts = urlsplit(url)
    assert parts.path == "/user_management/sessions/logout"
    assert parse_qs(parts.query) == {
        "session_id": ["session_A"],
        "return_to": ["https://switch.example.test/login"],
    }


async def test_a_code_is_exchanged_with_the_verifier_and_the_tokens_are_dropped() -> (
    None
):
    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_management/authenticate"
        assert "Authorization" not in request.headers
        sent.append(json.loads(request.content))
        return httpx.Response(200, json=authenticated())

    sign_in = await _authkit(handler).authenticate(
        code="the-code",
        verifier="the-verifier",
        ip_address="198.51.100.7",
        user_agent="Browser/1.0",
        choose_organization=_never,
    )

    assert sent == [
        {
            "client_id": CLIENT_ID,
            "client_secret": KEY,
            "grant_type": "authorization_code",
            "code": "the-code",
            "code_verifier": "the-verifier",
            "ip_address": "198.51.100.7",
            "user_agent": "Browser/1.0",
        }
    ]
    assert sign_in.user_id == "user_A"
    assert sign_in.email == "ada@example.test"
    assert sign_in.email_verified
    assert sign_in.name == "Ada Lovelace"
    assert sign_in.session_id == "session_A"
    assert sign_in.organization_id == "org_A"
    assert sign_in.impersonator is None
    assert "access_token" not in vars(sign_in)


async def test_without_a_client_address_none_is_sent() -> None:
    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json=authenticated())

    await _authkit(handler).authenticate(
        code="c",
        verifier="v",
        ip_address=None,
        user_agent=None,
        choose_organization=_never,
    )
    assert "ip_address" not in sent[0]
    assert "user_agent" not in sent[0]


async def test_an_impersonated_sign_in_names_who_is_really_signing_in() -> None:
    sign_in = await _authkit(
        lambda request: httpx.Response(
            200,
            json=authenticated(
                impersonator={"email": "support@example.test", "reason": "x"}
            ),
        )
    ).authenticate(
        code="c",
        verifier="v",
        ip_address=None,
        user_agent=None,
        choose_organization=_never,
    )
    assert sign_in.impersonator == "support@example.test"


async def test_a_person_in_several_organizations_signs_in_to_the_one_chosen() -> None:
    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        if body["grant_type"] == "authorization_code":
            return httpx.Response(
                403,
                json={
                    "code": "organization_selection_required",
                    "message": "Choose one.",
                    "pending_authentication_token": "pending-token",
                    "organizations": [
                        {"id": "org_A", "name": "Acme"},
                        {"id": "org_B", "name": "Beta"},
                    ],
                },
            )
        return httpx.Response(200, json=authenticated(organization_id="org_B"))

    offered: list[list[AuthKitOrganization]] = []

    async def choose(organizations: list[AuthKitOrganization]) -> str | None:
        offered.append(organizations)
        return "org_B"

    sign_in = await _authkit(handler).authenticate(
        code="c",
        verifier="v",
        ip_address=None,
        user_agent=None,
        choose_organization=choose,
    )
    assert offered == [
        [AuthKitOrganization("org_A", "Acme"), AuthKitOrganization("org_B", "Beta")]
    ]
    assert sent[1]["grant_type"] == "urn:workos:oauth:grant-type:organization-selection"
    assert sent[1]["pending_authentication_token"] == "pending-token"
    assert sent[1]["organization_id"] == "org_B"
    assert sign_in.organization_id == "org_B"


async def test_no_organization_chosen_is_a_refusal() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={
                "code": "organization_selection_required",
                "pending_authentication_token": "pending-token",
                "organizations": [{"id": "org_A", "name": "Acme"}],
            },
        )

    async def choose(_organizations: list[AuthKitOrganization]) -> str | None:
        return None

    with pytest.raises(AuthKitRefused) as refused:
        await _authkit(handler).authenticate(
            code="c",
            verifier="v",
            ip_address=None,
            user_agent=None,
            choose_organization=choose,
        )
    assert refused.value.code == "organization_selection_required"


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (400, {"error": "invalid_grant", "error_description": "used"}, "invalid_grant"),
        (403, {"code": "email_verification_required"}, "email_verification_required"),
        (400, {"error": "sso_required"}, "sso_required"),
        (401, {}, None),
    ],
)
async def test_a_refused_code_says_why(
    status: int, body: dict, code: str | None
) -> None:
    with pytest.raises(AuthKitRefused) as refused:
        await _authkit(lambda request: httpx.Response(status, json=body)).authenticate(
            code="c",
            verifier="v",
            ip_address=None,
            user_agent=None,
            choose_organization=_never,
        )
    assert refused.value.code == code


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_a_busy_or_failing_workos_is_unavailable(status: int) -> None:
    with pytest.raises(AuthKitUnavailable) as unavailable:
        await _authkit(
            lambda request: httpx.Response(status, headers={"Retry-After": "3"})
        ).authenticate(
            code="c",
            verifier="v",
            ip_address=None,
            user_agent=None,
            choose_organization=_never,
        )
    assert unavailable.value.retry_after == 3.0


async def test_an_unreachable_workos_is_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow")

    with pytest.raises(AuthKitUnavailable, match="could not be reached"):
        await _authkit(handler).authenticate(
            code="c",
            verifier="v",
            ip_address=None,
            user_agent=None,
            choose_organization=_never,
        )


async def test_a_sign_in_with_no_session_says_which_application_to_check() -> None:
    with pytest.raises(AuthKitUnavailable, match="WORKOS_CLIENT_ID"):
        await _authkit(
            lambda request: httpx.Response(
                200, json=authenticated(access_token=access_token(None))
            )
        ).authenticate(
            code="c",
            verifier="v",
            ip_address=None,
            user_agent=None,
            choose_organization=_never,
        )


async def test_only_active_sessions_are_alive_across_every_page() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_management/users/user_A/sessions"
        assert request.headers["Authorization"] == f"Bearer {KEY}"
        if "after" not in request.url.params:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "session_live", "status": "active", "ended_at": None},
                        {
                            "id": "session_revoked",
                            "status": "revoked",
                            "ended_at": "2026-11-01T00:00:00Z",
                        },
                    ],
                    "list_metadata": {"after": "session_revoked"},
                },
            )
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "session_other_app", "status": "active", "ended_at": None}
                ],
                "list_metadata": {"after": None},
            },
        )

    assert await _authkit(handler).active_session_ids("user_A") == {
        "session_live",
        "session_other_app",
    }


async def test_a_user_workos_no_longer_has_has_no_active_sessions() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_management/users/user_GONE/sessions"
        return httpx.Response(404, json={"code": "entity_not_found"})

    assert await _authkit(handler).active_session_ids("user_GONE") == set()


@pytest.mark.parametrize("status", [401, 403])
async def test_a_refused_session_listing_is_raised(status: int) -> None:
    with pytest.raises(AuthKitRefused):
        await _authkit(
            lambda request: httpx.Response(status, json={"code": "unauthorized"})
        ).active_session_ids("user_A")


@pytest.mark.parametrize("status", [200, 204, 404])
async def test_revoking_a_session_workos_no_longer_has_counts_as_done(
    status: int,
) -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_management/sessions/revoke"
        seen.append(json.loads(request.content))
        return httpx.Response(status)

    await _authkit(handler).revoke_session("session_A")
    assert seen == [{"session_id": "session_A"}]


async def test_a_refused_revoke_is_raised() -> None:
    with pytest.raises(AuthKitRefused):
        await _authkit(
            lambda request: httpx.Response(403, json={"code": "forbidden"})
        ).revoke_session("session_A")


def organization_token(organization_id: str | None) -> str:
    claims: dict[str, object] = {
        "sub": "user_A",
        "sid": "session_A",
        "exp": 4_000_000_000,
    }
    if organization_id is not None:
        claims["org_id"] = organization_id
    return jwt.encode(
        claims, "test-signing-key-long-enough-for-hs256", algorithm="HS256"
    )


async def test_a_sign_in_keeps_its_refresh_token_out_of_sight() -> None:
    sign_in = await _authkit(
        lambda request: httpx.Response(200, json=authenticated())
    ).authenticate(
        code="c",
        verifier="v",
        ip_address=None,
        user_agent=None,
        choose_organization=_never,
    )
    assert sign_in.refresh_token == "refresh-placeholder"
    assert "refresh-placeholder" not in repr(sign_in)


async def test_a_sign_in_with_no_refresh_token_is_unreadable() -> None:
    body = authenticated()
    del body["refresh_token"]
    with pytest.raises(AuthKitUnavailable):
        await _authkit(lambda request: httpx.Response(200, json=body)).authenticate(
            code="c",
            verifier="v",
            ip_address=None,
            user_agent=None,
            choose_organization=_never,
        )


async def test_a_refresh_renews_access_for_the_organization_asked() -> None:
    sent: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_management/authenticate"
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json=authenticated(
                access_token=organization_token("org_B"), refresh_token="rotated"
            ),
        )

    tokens = await _authkit(handler).refresh("kept-refresh", "org_B")

    assert sent == [
        {
            "client_id": CLIENT_ID,
            "client_secret": KEY,
            "grant_type": "refresh_token",
            "refresh_token": "kept-refresh",
            "organization_id": "org_B",
        }
    ]
    assert tokens.access_token == organization_token("org_B")
    assert tokens.refresh_token == "rotated"
    assert tokens.expires_at == 4_000_000_000
    assert "rotated" not in repr(tokens)
    assert tokens.access_token not in repr(tokens)


@pytest.mark.parametrize("organization_id", [None, "org_OTHER"])
async def test_a_refresh_for_another_organization_than_asked_is_not_used(
    organization_id: str | None,
) -> None:
    with pytest.raises(AuthKitUnavailable, match="another organization"):
        await _authkit(
            lambda request: httpx.Response(
                200,
                json=authenticated(access_token=organization_token(organization_id)),
            )
        ).refresh("kept-refresh", "org_B")


async def test_a_refused_refresh_says_why() -> None:
    with pytest.raises(AuthKitRefused) as refused:
        await _authkit(
            lambda request: httpx.Response(
                400,
                json={"error": "invalid_grant", "error_description": "Session ended."},
            )
        ).refresh("kept-refresh", "org_B")
    assert refused.value.code == "invalid_grant"


async def test_a_refresh_workos_is_too_busy_for_can_be_tried_again() -> None:
    with pytest.raises(AuthKitUnavailable):
        await _authkit(lambda request: httpx.Response(503)).refresh(
            "kept-refresh", "org_B"
        )

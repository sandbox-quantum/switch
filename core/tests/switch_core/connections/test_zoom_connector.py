"""Tests for the Zoom Meetings service connection catalog entry and OAuth adapter."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
)
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import CATALOG, SKILL_FORBIDDEN


@pytest.fixture
def zoom_definition():
    return CATALOG["zoom"].definition


@pytest.fixture
def test_client():
    return StaticClient(
        OAuthClientCredentials(
            "test_zoom_client_id",
            "test_zoom_client_secret",
            authentication=None,
        )
    )


def test_zoom_catalog_loads_and_has_correct_metadata(zoom_definition):
    assert zoom_definition.slug == "zoom"
    assert zoom_definition.name == "Zoom Meetings"
    assert zoom_definition.category == "Productivity"
    assert zoom_definition.enabled is True
    assert zoom_definition.adapter == "oauth"

    oauth = zoom_definition.auth.oauth
    assert oauth is not None
    assert oauth.registration == "static"
    assert oauth.client_settings == "ZOOM"
    assert oauth.redirect == ["core"]
    assert oauth.authorization_url == "https://zoom.us/oauth/authorize"
    assert oauth.token_url == "https://zoom.us/oauth/token"
    assert oauth.revocation_url == "https://zoom.us/oauth/revoke"
    assert oauth.prompt == "consent"
    assert zoom_definition.auth.refresh == "rotating"

    assert zoom_definition.token is not None
    assert zoom_definition.token.kind == "pass_through"
    assert zoom_definition.token.max_lifetime == 3600

    assert zoom_definition.mcp is not None
    assert len(zoom_definition.mcp.servers) == 1
    assert zoom_definition.mcp.servers[0].name == "zoom"
    assert (
        zoom_definition.mcp.servers[0].url
        == "https://mcp.zoom.us/mcp/meeting/streamable"
    )

    assert zoom_definition.access is not None
    assert zoom_definition.access.read.scopes == [
        "user:read",
        "meeting:read",
        "recording:read",
    ]
    # Enforce read-only: no write scope should be defined
    assert zoom_definition.access.write is None

    identity = zoom_definition.auth.identity
    assert identity is not None
    assert identity.url == "https://api.zoom.us/v2/users/me"
    assert identity.account_id == "id"
    assert identity.label == "email"


async def test_zoom_authorization_url_matches_spec(zoom_definition, test_client):
    adapter = OAuthAdapter(zoom_definition, test_client, httpx.AsyncClient())
    redirect_uri = (
        "https://switch.example.test/gateway/service-connections/zoom/flows/callback"
    )

    url = await adapter.authorization_url(
        redirect_uri=redirect_uri,
        state="test-state-1234",
        code_challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        scopes=zoom_definition.access.read.scopes,
    )

    parsed = urlsplit(url)
    assert (
        f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        == "https://zoom.us/oauth/authorize"
    )

    query = parse_qs(parsed.query)
    assert query["response_type"] == ["code"]
    assert query["client_id"] == ["test_zoom_client_id"]
    assert query["redirect_uri"] == [redirect_uri]
    assert query["state"] == ["test-state-1234"]
    assert query["code_challenge"] == ["E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["prompt"] == ["consent"]
    assert query["scope"] == ["user:read meeting:read recording:read"]


async def test_zoom_exchange_code(zoom_definition, test_client):
    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://zoom.us/oauth/token"
        assert request.method == "POST"
        body = parse_qs(request.content.decode())
        assert body["grant_type"] == ["authorization_code"]
        assert body["code"] == ["test_code_xyz"]
        assert body["code_verifier"] == ["test_verifier_abc"]
        assert body["redirect_uri"] == ["https://switch.example.test/callback"]
        assert body["client_id"] == ["test_zoom_client_id"]
        assert body["client_secret"] == ["test_zoom_client_secret"]

        return httpx.Response(
            200,
            json={
                "access_token": "zoom_access_tok_123",
                "token_type": "bearer",
                "refresh_token": "zoom_refresh_tok_456",
                "expires_in": 3600,
                "scope": "user:read meeting:read recording:read",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = OAuthAdapter(zoom_definition, test_client, client)

    sign_in = await adapter.exchange_code(
        code="test_code_xyz",
        verifier="test_verifier_abc",
        redirect_uri="https://switch.example.test/callback",
        scopes=zoom_definition.access.read.scopes,
    )

    secret = sign_in.secret.values
    assert secret["access_token"] == "zoom_access_tok_123"
    assert secret["refresh_token"] == "zoom_refresh_tok_456"
    assert secret["scope"] == "user:read meeting:read recording:read"
    assert sign_in.granted_scopes == ["user:read", "meeting:read", "recording:read"]
    assert sign_in.client_id == "test_zoom_client_id"


async def test_zoom_identify_extracts_id_and_email(zoom_definition, test_client):
    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.zoom.us/v2/users/me"
        assert request.headers["authorization"] == "Bearer zoom_access_tok_123"
        return httpx.Response(
            200,
            json={
                "id": "usr_zoom_abc789",
                "email": "engineer@example.com",
                "first_name": "Test",
                "last_name": "User",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = OAuthAdapter(zoom_definition, test_client, client)

    identity = await adapter.identify("zoom_access_tok_123")
    assert identity.account_id == "usr_zoom_abc789"
    assert identity.label == "engineer@example.com"


async def test_zoom_identify_unauthorized_raises_reauthorization_error(
    zoom_definition, test_client
):
    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.zoom.us/v2/users/me"
        return httpx.Response(
            401,
            json={"code": 124, "message": "Invalid access token."},
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = OAuthAdapter(zoom_definition, test_client, client)

    with pytest.raises(ReauthorizationRequiredError, match="refused the new sign-in"):
        await adapter.identify("invalid_zoom_tok")


async def test_zoom_token_refresh_rotates_tokens(zoom_definition, test_client):
    token_requests: list[dict] = []

    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://zoom.us/oauth/token"
        body = parse_qs(request.content.decode())
        token_requests.append(body)
        assert body["grant_type"] == ["refresh_token"]
        assert body["refresh_token"] == ["zoom_refresh_tok_old"]

        return httpx.Response(
            200,
            json={
                "access_token": "zoom_access_tok_new",
                "token_type": "bearer",
                "refresh_token": "zoom_refresh_tok_new",
                "expires_in": 3600,
                "scope": "user:read meeting:read recording:read",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = OAuthAdapter(zoom_definition, test_client, client)

    old_secret = ConnectionSecret(
        {
            "access_token": "zoom_access_tok_old",
            "refresh_token": "zoom_refresh_tok_old",
            "expires_at": 1000.0,
            "scope": "user:read meeting:read recording:read",
        }
    )

    new_secret = await adapter.refresh(old_secret)
    assert new_secret.access_token == "zoom_access_tok_new"
    assert new_secret.values["access_token"] == "zoom_access_tok_new"
    assert new_secret.values["refresh_token"] == "zoom_refresh_tok_new"
    assert len(token_requests) == 1


async def test_zoom_revocation_calls_zoom_revoke(zoom_definition, test_client):
    revocations: list[dict] = []

    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://zoom.us/oauth/revoke"
        assert request.method == "POST"
        body = parse_qs(request.content.decode())
        revocations.append(body)
        assert body["token"] == ["zoom_refresh_tok_to_revoke"]
        assert body["token_type_hint"] == ["refresh_token"]
        assert body["client_id"] == ["test_zoom_client_id"]
        assert body["client_secret"] == ["test_zoom_client_secret"]
        return httpx.Response(200, json={"status": "success"})

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = OAuthAdapter(zoom_definition, test_client, client)

    await adapter.revoke_connection(
        ConnectionSecret(
            {
                "access_token": "zoom_access_tok",
                "refresh_token": "zoom_refresh_tok_to_revoke",
            }
        )
    )
    assert len(revocations) == 1


def test_zoom_skill_file_integrity_and_clean_credentials():
    zoom_entry = CATALOG["zoom"]
    assert "SKILL.md" in zoom_entry.skill_files
    skill_content = zoom_entry.skill_files["SKILL.md"]

    # Verify frontmatter name
    assert "name: zoom" in skill_content
    assert "Zoom Meetings" in skill_content

    # Verify forbidden phrases
    for forbidden in SKILL_FORBIDDEN:
        assert forbidden not in skill_content, (
            f"Forbidden term '{forbidden}' in SKILL.md"
        )

    # Verify supported operations are documented
    assert "search_meetings" in skill_content
    assert "get_meeting_assets" in skill_content
    assert "Read-only" in skill_content or "read-only" in skill_content

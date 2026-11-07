"""Tests for the Notion service connection catalog entry, RFC 7662 introspection identity, and OAuth adapter."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.adapters.oauth import (
    AuthorizationEndpoints,
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import CATALOG, SKILL_FORBIDDEN


@pytest.fixture
def notion_definition():
    return CATALOG["notion"].definition


@pytest.fixture
def test_client():
    return StaticClient(
        OAuthClientCredentials(
            "test_notion_client_id",
            "test_notion_client_secret",
            authentication=None,
        )
    )


@pytest.fixture
def endpoints():
    return AuthorizationEndpoints(
        authorization="https://mcp.notion.com/oauth/authorize",
        token="https://mcp.notion.com/oauth/token",
        registration="https://mcp.notion.com/oauth/register",
        revocation="https://mcp.notion.com/oauth/revoke",
        resource="https://mcp.notion.com/mcp",
        client_authentication="client_secret_post",
        introspection="https://mcp.notion.com/introspect",
    )


def make_adapter(
    definition,
    client: StaticClient,
    http: httpx.AsyncClient,
    endpoints: AuthorizationEndpoints,
) -> OAuthAdapter:
    adapter = OAuthAdapter(definition, client, http)
    adapter._endpoints = endpoints
    return adapter


def test_notion_catalog_loads_and_has_correct_metadata(notion_definition):
    assert notion_definition.slug == "notion"
    assert notion_definition.name == "Notion"
    assert notion_definition.category == "Knowledge base"
    assert notion_definition.enabled is True
    assert notion_definition.adapter == "oauth"

    oauth = notion_definition.auth.oauth
    assert oauth is not None
    assert oauth.registration == "dynamic"
    assert oauth.redirect == ["loopback"]
    assert oauth.loopback_ports == [39231, 39232, 39233, 39234, 39235]
    assert oauth.revocation_discovered is True
    assert notion_definition.auth.refresh == "rotating"

    assert notion_definition.token is not None
    assert notion_definition.token.kind == "pass_through"
    assert notion_definition.token.max_lifetime == 28800

    assert notion_definition.mcp is not None
    assert len(notion_definition.mcp.servers) == 1
    assert notion_definition.mcp.servers[0].name == "notion"
    assert notion_definition.mcp.servers[0].url == "https://mcp.notion.com/mcp"

    assert (
        notion_definition.access is not None
        and notion_definition.access.write is not None
    )
    assert notion_definition.access.read.scopes == ["default"]
    assert notion_definition.access.write.scopes == ["default"]

    identity = notion_definition.auth.identity
    assert identity is not None
    assert identity.method == "introspection"
    assert identity.url is None
    assert identity.account_id == ["workspace_id", "user_id"]
    assert identity.label == "workspace_id"


async def test_notion_authorization_url_matches_spec(
    notion_definition, test_client, endpoints
):
    adapter = make_adapter(
        notion_definition, test_client, httpx.AsyncClient(), endpoints
    )
    redirect_uri = "http://127.0.0.1:39231/switch-services/callback"

    url = await adapter.authorization_url(
        redirect_uri=redirect_uri,
        state="test-notion-state",
        code_challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        scopes=notion_definition.access.read.scopes,
    )

    parsed = urlsplit(url)
    assert (
        f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        == "https://mcp.notion.com/oauth/authorize"
    )

    query = parse_qs(parsed.query)
    assert query["response_type"] == ["code"]
    assert query["client_id"] == ["test_notion_client_id"]
    assert query["redirect_uri"] == [redirect_uri]
    assert query["state"] == ["test-notion-state"]
    assert query["code_challenge"] == ["E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["scope"] == ["default"]
    assert query["resource"] == ["https://mcp.notion.com/mcp"]


async def test_notion_exchange_code(notion_definition, test_client, endpoints):
    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://mcp.notion.com/oauth/token"
        assert request.method == "POST"
        body = parse_qs(request.content.decode())
        assert body["grant_type"] == ["authorization_code"]
        assert body["code"] == ["notion_code_456"]
        assert body["code_verifier"] == ["notion_verifier_789"]
        assert body["redirect_uri"] == [
            "http://127.0.0.1:39231/switch-services/callback"
        ]

        return httpx.Response(
            200,
            json={
                "access_token": "notion_access_tok_xyz",
                "token_type": "bearer",
                "refresh_token": "notion_refresh_tok_abc",
                "expires_in": 28800,
                "scope": "default",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = make_adapter(notion_definition, test_client, client, endpoints)

    sign_in = await adapter.exchange_code(
        code="notion_code_456",
        verifier="notion_verifier_789",
        redirect_uri="http://127.0.0.1:39231/switch-services/callback",
        scopes=["default"],
    )

    # Check secret
    assert sign_in.secret.access_token == "notion_access_tok_xyz"
    assert sign_in.secret.values["refresh_token"] == "notion_refresh_tok_abc"
    assert sign_in.secret.values["scope"] == "default"
    assert sign_in.client_id == "test_notion_client_id"


async def test_notion_identify_via_introspection_success(
    notion_definition, test_client, endpoints
):
    introspect_calls: list[httpx.Request] = []

    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://mcp.notion.com/introspect"
        assert request.method == "POST"
        assert request.headers.get("accept") == "application/json"
        body = parse_qs(request.content.decode())
        assert body["token"] == ["notion_access_tok_xyz"]
        assert body["client_id"] == ["test_notion_client_id"]
        assert body["client_secret"] == ["test_notion_client_secret"]
        introspect_calls.append(request)
        return httpx.Response(
            200,
            json={
                "active": True,
                "sub": "sub_xyz",
                "user_id": "usr_notion_007",
                "workspace_id": "ws_notion_acme",
                "client_id": "test_notion_client_id",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = make_adapter(notion_definition, test_client, client, endpoints)

    identity = await adapter.identify("notion_access_tok_xyz")
    assert len(introspect_calls) == 1
    assert identity.account_id == "ws_notion_acme:usr_notion_007"
    assert identity.label == "ws_notion_acme"


async def test_notion_introspection_inactive_raises_reauth_error(
    notion_definition, test_client, endpoints
):
    def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"active": False})

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = make_adapter(notion_definition, test_client, client, endpoints)

    with pytest.raises(
        ReauthorizationRequiredError, match="says the sign-in is inactive"
    ):
        await adapter.identify("inactive_token")


@pytest.mark.parametrize("active_val", [None, "true", 1, "yes", []])
async def test_notion_introspection_active_not_boolean_true_raises_service_error(
    notion_definition, test_client, endpoints, active_val
):
    def handle_request(request: httpx.Request) -> httpx.Response:
        data = {}
        if active_val is not None:
            data["active"] = active_val
        return httpx.Response(200, json=data)

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = make_adapter(notion_definition, test_client, client, endpoints)

    with pytest.raises(ServiceAdapterError, match="did not confirm an active sign-in"):
        await adapter.identify("bad_active_token")


async def test_notion_introspection_client_id_mismatch_raises_reauth_error(
    notion_definition, test_client, endpoints
):
    def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "active": True,
                "client_id": "foreign_client_id",
                "workspace_id": "ws_123",
                "user_id": "usr_456",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = make_adapter(notion_definition, test_client, client, endpoints)

    with pytest.raises(ReauthorizationRequiredError, match="for another OAuth client"):
        await adapter.identify("foreign_token")


@pytest.mark.parametrize(
    "payload",
    [
        {"active": True, "user_id": "usr_456"},
        {"active": True, "workspace_id": "ws_123"},
        {"active": True, "workspace_id": "", "user_id": "usr_456"},
        {"active": True, "workspace_id": "ws_123", "user_id": "   "},
        {"active": True, "workspace_id": 123, "user_id": None},
    ],
)
async def test_notion_introspection_missing_or_empty_account_parts_raises_service_error(
    notion_definition, test_client, endpoints, payload
):
    def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = make_adapter(notion_definition, test_client, client, endpoints)

    with pytest.raises(ServiceAdapterError, match="did not name the account's id"):
        await adapter.identify("incomplete_token")


async def test_notion_introspection_refuses_when_metadata_has_no_introspection_endpoint(
    notion_definition, test_client
):
    no_introspection_endpoints = AuthorizationEndpoints(
        authorization="https://mcp.notion.com/oauth/authorize",
        token="https://mcp.notion.com/oauth/token",
        registration="https://mcp.notion.com/oauth/register",
        revocation="https://mcp.notion.com/oauth/revoke",
        resource="https://mcp.notion.com/mcp",
        client_authentication="client_secret_post",
        introspection=None,
    )
    client = httpx.AsyncClient()
    adapter = make_adapter(
        notion_definition, test_client, client, no_introspection_endpoints
    )

    with pytest.raises(
        ServiceAdapterError, match="advertises no introspection endpoint"
    ):
        await adapter.identify("tok")


async def test_notion_token_refresh_rotates_tokens(
    notion_definition, test_client, endpoints
):
    token_requests: list[dict] = []

    def handle_request(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://mcp.notion.com/oauth/token"
        body = parse_qs(request.content.decode())
        token_requests.append(body)
        assert body["grant_type"] == ["refresh_token"]
        assert body["refresh_token"] == ["notion_refresh_tok_old"]

        return httpx.Response(
            200,
            json={
                "access_token": "notion_access_tok_new",
                "token_type": "bearer",
                "refresh_token": "notion_refresh_tok_new",
                "expires_in": 28800,
                "scope": "default",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = httpx.AsyncClient(transport=transport)
    adapter = make_adapter(notion_definition, test_client, client, endpoints)

    old_secret = ConnectionSecret(
        {
            "access_token": "notion_access_tok_old",
            "refresh_token": "notion_refresh_tok_old",
            "expires_at": 1000.0,
            "scope": "default",
        }
    )

    new_secret = await adapter.refresh(old_secret)
    assert new_secret.access_token == "notion_access_tok_new"
    assert new_secret.values["access_token"] == "notion_access_tok_new"
    assert new_secret.values["refresh_token"] == "notion_refresh_tok_new"
    assert len(token_requests) == 1


def test_notion_skill_file_integrity_and_clean_credentials():
    notion_entry = CATALOG["notion"]
    assert "SKILL.md" in notion_entry.skill_files
    skill_content = notion_entry.skill_files["SKILL.md"]

    # Verify frontmatter
    assert "name: notion" in skill_content
    assert "Notion" in skill_content

    # Verify forbidden credential phrases
    for forbidden in SKILL_FORBIDDEN:
        assert forbidden not in skill_content, (
            f"Forbidden term '{forbidden}' in SKILL.md"
        )

    # Verify MCP tool documentation
    assert "notion-search" in skill_content
    assert "notion-list-recent-pages" in skill_content
    assert "notion-delete-pages" in skill_content
    assert "notion-restore-pages" in skill_content
    assert "Trash" in skill_content

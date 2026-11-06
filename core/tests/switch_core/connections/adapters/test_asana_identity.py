"""Exercise candidate Asana wiring against synthetic, not live, responses."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult

from switch_core.connections.adapters import ServiceAdapterError, oauth
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import CATALOG


async def test_asana_authorization_uses_advertised_audience_without_scopes():
    def respond(request):
        if request.url.host == "mcp.asana.com" and request.url.path == "/v2/mcp":
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.asana.com/.well-known/oauth-protected-resource/v2"'
                },
            )
        if request.url.host == "mcp.asana.com":
            return httpx.Response(
                200,
                json={
                    "resource": "https://mcp.asana.com/v2/mcp",
                    "authorization_servers": ["https://app.asana.com"],
                },
            )
        return httpx.Response(
            200,
            json={
                "authorization_endpoint": "https://app.asana.com/-/oauth_authorize",
                "token_endpoint": "https://app.asana.com/-/oauth_token",
                "code_challenge_methods_supported": ["S256"],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        adapter = OAuthAdapter(
            CATALOG["asana"].definition,
            StaticClient(OAuthClientCredentials("synthetic-client", None, None)),
            http,
        )
        url = await adapter.authorization_url(
            redirect_uri="https://switch.example.test/callback",
            state="synthetic-state",
            code_challenge="synthetic-challenge",
            scopes=[],
        )
    query = parse_qs(urlsplit(url).query)
    assert query["resource"] == ["https://mcp.asana.com/v2/mcp"]
    assert "scope" not in query


@pytest.mark.parametrize("account", ["synthetic-account", None, [], ["one", "two"]])
async def test_asana_identity_uses_mcp_and_rejects_missing_account(
    monkeypatch, account
):
    server = FastMCP("synthetic-asana")
    calls = []

    @server.tool(annotations={"readOnlyHint": True})
    def get_user(user: str | None = None) -> ToolResult:
        calls.append(user)
        # A membership list does not identify which workspace was selected.
        data = {"email": "synthetic@example.test", "workspaces": [{"gid": "other"}]}
        if account is not None:
            data["gid"] = account
        return ToolResult(content=[], structured_content={"data": data})

    transports = []

    def transport(url, *, headers, httpx_client_factory):
        transports.append((url, headers))
        return server

    monkeypatch.setattr(oauth, "StreamableHttpTransport", transport)
    async with httpx.AsyncClient() as http:
        adapter = OAuthAdapter(
            CATALOG["asana"].definition,
            StaticClient(OAuthClientCredentials("synthetic-client", None, None)),
            http,
        )
        if not isinstance(account, str):
            with pytest.raises(ServiceAdapterError):
                await adapter.identify("synthetic-token")
        else:
            identity = await adapter.identify("synthetic-token")
            assert (identity.account_id, identity.label) == (
                account,
                "synthetic@example.test",
            )
    assert calls == [None]
    assert transports == [
        ("https://mcp.asana.com/v2/mcp", {"Authorization": "Bearer synthetic-token"})
    ]

"""Exercise the shipped Grafana entry, not a parallel example configuration."""

import httpx
import pytest
from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult

from switch_core.connections.adapters import oauth
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import CATALOG, oauth_field_values, oauth_mcp_url


@pytest.mark.parametrize("host", ["a.grafana.net", "prod-42.grafana.net"])
def test_stack_host_fills_the_documented_endpoint(host):
    entry = CATALOG["grafana"].definition
    values = oauth_field_values(entry.auth.oauth.fields, {"stack": host})
    assert oauth_mcp_url(entry.mcp.servers[0].url, values) == (
        "https://mcp.grafana.com/mcp/" + host
    )


@pytest.mark.parametrize(
    "host",
    [
        "prod",
        "prod.grafana.net.evil.test",
        "https://prod.grafana.net",
        "prod.grafana.net/path",
        "prod.grafana.net?x=1",
        "prod.grafana.net:443",
        "prod.grafana.net\n",
        "-prod.grafana.net",
        "prod-.grafana.net",
    ],
)
def test_shipped_stack_pattern_refuses_non_hosts(host):
    entry = CATALOG["grafana"].definition
    with pytest.raises(ValueError):
        oauth_field_values(entry.auth.oauth.fields, {"stack": host})


async def test_shipped_identity_uses_selected_stack_not_vendor_claim(monkeypatch):
    server = FastMCP("grafana-entry-test")

    @server.tool(annotations={"readOnlyHint": True})
    def user_info() -> ToolResult:
        return ToolResult(
            content=[],
            structured_content={
                "login": "same-user",
                "email": "",
                "connection": {"stack": "forged.grafana.net"},
            },
        )

    destinations = []

    def transport(url, **kwargs):
        destinations.append(url)
        return server

    monkeypatch.setattr(oauth, "StreamableHttpTransport", transport)
    async with httpx.AsyncClient() as http:
        adapter = OAuthAdapter(
            CATALOG["grafana"].definition,
            StaticClient(
                OAuthClientCredentials("test-client", None, authentication=None)
            ),
            http,
        )
        first = await adapter.with_fields({"stack": "first.grafana.net"}).identify(
            "test-token"
        )
        second = await adapter.with_fields({"stack": "second.grafana.net"}).identify(
            "test-token"
        )
    assert first.account_id == "first.grafana.net:same-user"
    assert second.account_id == "second.grafana.net:same-user"
    assert first.label == second.label == "same-user"
    assert destinations == [
        "https://mcp.grafana.com/mcp/first.grafana.net",
        "https://mcp.grafana.com/mcp/second.grafana.net",
    ]

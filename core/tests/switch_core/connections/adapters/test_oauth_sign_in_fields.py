"""OAuth sign-ins keep the connection's selected server and identity."""

import pytest
import yaml
from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    oauth,
)
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import ConnectionDefinition
from tests.switch_core.connections.adapters.test_oauth import _sign_in
from tests.switch_core.connections.fake_vendor import (
    MCP_URL,
    STATIC_CLIENT_ID,
    STATIC_CLIENT_SECRET,
    FakeOAuthServer,
)
from tests.switch_core.connections.test_loader import FIELDS_ENTRY, OAUTH_ENTRY


def _adapter(http, text=FIELDS_ENTRY):
    return OAuthAdapter(
        ConnectionDefinition.model_validate(yaml.safe_load(text)),
        StaticClient(
            OAuthClientCredentials(
                STATIC_CLIENT_ID, STATIC_CLIENT_SECRET, authentication=None
            )
        ),
        http,
    )


async def test_an_unbound_adapter_never_discovers():
    vendor = FakeOAuthServer()
    async with vendor.client() as http:
        with pytest.raises(ServiceAdapterError, match="sign-in fields"):
            await _adapter(http).endpoints()
    assert vendor.paths == []


async def test_a_bound_adapter_discovers_through_its_tenants_server():
    vendor = FakeOAuthServer()
    vendor.per_path = True
    async with vendor.client() as http:
        adapter = _adapter(http)
        bound = adapter.for_fields({"tenant": "team-a"})
        assert bound._client is adapter._client
        assert bound._http is adapter._http
        assert (await bound.endpoints()).resource == MCP_URL
    assert "https://mcp.example.test/v1/mcp/team-a" in vendor.paths
    assert vendor.mcp_urls == ["https://mcp.example.test/v1/mcp/team-a"]


async def test_a_bad_value_is_refused():
    vendor = FakeOAuthServer()
    async with vendor.client() as http:
        with pytest.raises(ServiceAdapterError, match="Example team is not valid"):
            _adapter(http).for_fields({"tenant": "team-a/x"})
    assert vendor.paths == []


async def test_the_sign_in_keeps_its_fields_and_a_refresh_reuses_them():
    vendor = FakeOAuthServer()
    vendor.per_path = True
    async with vendor.client() as http:
        adapter = _adapter(http)
        secret = await _sign_in(adapter.for_fields({"tenant": "team-a"}), vendor)
        assert secret.values["sign_in_fields"] == {"tenant": "team-a"}
        refreshed = await adapter.refresh(secret)
        assert refreshed.values["sign_in_fields"] == {"tenant": "team-a"}
        assert refreshed.values["access_token"] in vendor.live_access
        assert adapter._fields == {}


@pytest.mark.parametrize("operation", ["refresh", "revoke_connection"])
async def test_refresh_without_fields_asks_to_reconnect(operation):
    vendor = FakeOAuthServer()
    async with vendor.client() as http:
        with pytest.raises(
            ReauthorizationRequiredError, match="does not record its sign-in fields"
        ):
            await getattr(_adapter(http), operation)(
                ConnectionSecret(
                    {"access_token": "a", "refresh_token": "r", "expires_at": 0}
                )
            )
    assert vendor.paths == []


async def test_the_account_takes_the_tenant_from_the_field_not_the_vendor(monkeypatch):
    server = FastMCP("field-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> ToolResult:
        return ToolResult(
            content=[],
            structured_content={"login": "ada", "connection": {"tenant": "evil"}},
        )

    calls = []

    def transport(url, *, headers, httpx_client_factory):
        calls.append(url)
        return server

    monkeypatch.setattr(oauth, "StreamableHttpTransport", transport)
    entry = yaml.safe_load(FIELDS_ENTRY)
    entry["auth"]["identity"] = {
        "mcp_tool": "get_user",
        "account_id": ["connection.tenant", "login"],
        "label": "login",
    }
    vendor = FakeOAuthServer()
    async with vendor.client() as http:
        adapter = _adapter(http, yaml.safe_dump(entry)).for_fields({"tenant": "team-a"})
        identity = await adapter.identify("example-bearer-value")
    assert identity.account_id == "team-a:ada"
    assert calls == ["https://mcp.example.test/v1/mcp/team-a"]


async def test_an_entry_without_fields_only_accepts_empty_values():
    vendor = FakeOAuthServer()
    async with vendor.client() as http:
        adapter = _adapter(http, OAUTH_ENTRY)
        assert adapter.for_fields({}) is adapter
        with pytest.raises(ServiceAdapterError):
            adapter.for_fields({"tenant": "team-a"})


async def test_revocation_binds_to_the_saved_fields():
    vendor = FakeOAuthServer()
    vendor.per_path = True
    async with vendor.client() as http:
        adapter = _adapter(
            http,
            FIELDS_ENTRY.replace(
                "    registration: dynamic",
                "    revocation_discovered: true\n    registration: dynamic",
            ),
        )
        secret = await _sign_in(adapter.for_fields({"tenant": "team-a"}), vendor)
        await adapter.revoke_connection(secret)
    assert vendor.revoked
    assert secret.values["refresh_token"] not in vendor.live_refresh

"""Asana's V2 MCP OAuth contract, against its measured metadata shapes."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import cast
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult
from mcp.types import TextContent

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    oauth,
)
from switch_core.connections.adapters.oauth import (
    Identity,
    OAuthAdapter,
    OAuthClientCredentials,
    SignIn,
)
from switch_core.connections.flows import Exchange, ServiceFlows
from switch_core.connections.loader import CATALOG
from switch_core.connections.registry import build_adapters
from switch_core.connections.sign_in_flows import SignInFlows, StoredFlow
from tests.switch_core.connections.test_registry import REG

MCP_URL = "https://mcp.asana.com/v2/mcp"
RESOURCE_METADATA = "https://mcp.asana.com/.well-known/oauth-protected-resource/v2"
AUTH_METADATA = "https://app.asana.com/.well-known/oauth-authorization-server"
AUTHORIZE_URL = "https://app.asana.com/-/oauth_authorize"
TOKEN_URL = "https://app.asana.com/-/oauth_token"
REVOKE_URL = "https://app.asana.com/-/oauth_revoke"
REDIRECT_URI = "http://127.0.0.1:39231/switch-services/callback"


class FakeAsana:
    def __init__(self, token_response: dict | None = None) -> None:
        self.token_forms: list[dict[str, list[str]]] = []
        self.revoke_forms: list[dict[str, list[str]]] = []
        self.token_response = token_response

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "POST" and url == MCP_URL:
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": f'Bearer resource_metadata="{RESOURCE_METADATA}"'
                },
            )
        if request.method == "GET" and url == RESOURCE_METADATA:
            return httpx.Response(
                200,
                json={
                    "resource": MCP_URL,
                    "authorization_servers": ["https://app.asana.com"],
                    "scopes_supported": ["default"],
                },
            )
        if request.method == "GET" and url == AUTH_METADATA:
            return httpx.Response(
                200,
                json={
                    "issuer": "https://app.asana.com",
                    "authorization_endpoint": AUTHORIZE_URL,
                    "token_endpoint": TOKEN_URL,
                    "revocation_endpoint": REVOKE_URL,
                    "code_challenge_methods_supported": ["plain", "S256"],
                    "token_endpoint_auth_methods_supported": [
                        "client_secret_post",
                        "client_secret_basic",
                    ],
                },
            )
        if request.method == "POST" and url == TOKEN_URL:
            self.token_forms.append(parse_qs(request.content.decode()))
            return httpx.Response(
                200,
                json=self.token_response
                or {
                    "access_token": "new-access",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "scope": "default identity",
                },
            )
        if request.method == "POST" and url == REVOKE_URL:
            self.revoke_forms.append(parse_qs(request.content.decode()))
            return httpx.Response(200)
        raise AssertionError(f"Unexpected Asana request: {request.method} {url}")


def _adapter(http: httpx.AsyncClient) -> OAuthAdapter:
    adapters = build_adapters(
        CATALOG,
        github_app=None,
        oauth_clients={
            "asana": OAuthClientCredentials(
                "client-1", "SYNTHETIC", authentication=None
            )
        },
        http=http,
        registration=REG,
    )
    adapter = adapters["asana"]
    assert isinstance(adapter, OAuthAdapter)
    return adapter


async def test_asana_endpoints_are_discovered_from_the_v2_server() -> None:
    vendor = FakeAsana()
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        endpoints = await _adapter(http).endpoints()
    assert endpoints.authorization == AUTHORIZE_URL
    assert endpoints.token == TOKEN_URL
    assert endpoints.revocation == REVOKE_URL
    assert endpoints.registration is None
    assert endpoints.resource == MCP_URL
    assert endpoints.client_authentication == "client_secret_post"


async def test_asana_authorization_sends_no_scope_and_names_the_v2_resource() -> None:
    vendor = FakeAsana()
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        url = await _adapter(http).authorization_url(
            redirect_uri=REDIRECT_URI,
            state="synthetic-state",
            code_challenge="synthetic-challenge",
            scopes=[],
        )
    query = parse_qs(urlsplit(url).query, keep_blank_values=True)
    assert "scope" not in query
    assert query["resource"] == [MCP_URL]
    assert query["code_challenge_method"] == ["S256"]
    assert "prompt" not in query
    assert query["redirect_uri"] == [REDIRECT_URI]


async def test_asana_identity_reads_get_me(monkeypatch: pytest.MonkeyPatch) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_me() -> ToolResult:
        return ToolResult(
            content=[],
            structured_content={
                "data": {
                    "gid": "1000000000000001",
                    "email": "person@example.test",
                    "name": "Example Person",
                }
            },
        )

    calls: list[tuple[str, dict]] = []
    original = oauth.Client.call_tool_mcp

    async def call_tool(client, name, arguments):
        calls.append((name, arguments))
        return await original(client, name, arguments)

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    monkeypatch.setattr(oauth.Client, "call_tool_mcp", call_tool)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        identity = await _adapter(http).identify("synthetic-access")
    assert identity == Identity("1000000000000001", "person@example.test")
    assert calls == [("get_me", {})]


async def test_asana_identity_refuses_a_get_me_that_is_not_read_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": None})
    def get_me() -> ToolResult:
        return ToolResult(content=[], structured_content={"data": {"gid": "1"}})

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        with pytest.raises(
            ServiceAdapterError, match="could not identify the account through MCP"
        ):
            await _adapter(http).identify("synthetic-access")


async def test_asana_identity_refuses_a_get_me_that_requires_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_me(account: str) -> dict:
        return {"data": {"gid": account, "email": "person@example.test"}}

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        with pytest.raises(
            ServiceAdapterError, match="could not identify the account through MCP"
        ):
            await _adapter(http).identify("synthetic-access")


async def test_asana_identity_calls_an_optional_schema_with_no_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_me(account: str = "synthetic-account") -> ToolResult:
        return ToolResult(
            content=[],
            structured_content={
                "data": {"gid": account, "email": "person@example.test"}
            },
        )

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        identity = await _adapter(http).identify("synthetic-access")
    assert identity == Identity("synthetic-account", "person@example.test")


async def test_asana_identity_hides_a_vendor_tool_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_me() -> dict:
        raise RuntimeError("SYNTHETIC-VENDOR-DIAGNOSTIC")

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        with pytest.raises(ServiceAdapterError) as error:
            await _adapter(http).identify("synthetic-access")
    assert "SYNTHETIC-VENDOR-DIAGNOSTIC" not in str(error.value)


async def test_asana_identity_bounds_the_result_and_disables_redirects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_me() -> ToolResult:
        return ToolResult(
            content=[],
            structured_content={"data": {"gid": "1", "email": "x" * 70000}},
        )

    captured: list[dict] = []

    def transport(*args, **kwargs):
        captured.append(kwargs)
        return server

    monkeypatch.setattr(oauth, "StreamableHttpTransport", transport)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        with pytest.raises(
            ServiceAdapterError, match="could not identify the account through MCP"
        ):
            await _adapter(http).identify("synthetic-access")
    factory = captured[0]["httpx_client_factory"]
    async with factory(headers={}, auth=None, follow_redirects=True) as client:
        assert client.follow_redirects is False


async def test_asana_identity_bounds_extra_content_even_with_a_small_structured_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_me() -> ToolResult:
        return ToolResult(
            content=[TextContent(type="text", text="x" * 70000)],
            structured_content={"data": {"gid": "1", "email": "person@example.test"}},
        )

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        with pytest.raises(
            ServiceAdapterError, match="could not identify the account through MCP"
        ):
            await _adapter(http).identify("synthetic-access")


async def test_asana_identity_hides_malformed_sdk_diagnostics(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    server = FastMCP("asana-identity-test")

    async def malformed_list_tools(client, max_pages=250):
        logging.getLogger("mcp.client.streamable_http").warning(
            "Raw result: SYNTHETIC-TOKEN-LIKE-VENDOR-PAYLOAD"
        )
        logging.getLogger("switch_core.connections").warning("SAFE-APP-LOG")
        raise ValueError("malformed vendor response")

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    monkeypatch.setattr(oauth.Client, "list_tools", malformed_list_tools)
    with caplog.at_level(logging.WARNING):
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(FakeAsana().handle)
        ) as http:
            with pytest.raises(
                ServiceAdapterError, match="could not identify the account through MCP"
            ):
                await _adapter(http).identify("synthetic-access")
        logging.getLogger("mcp.client.streamable_http").warning("OUTSIDE-CALL")
    assert "SYNTHETIC-TOKEN-LIKE-VENDOR-PAYLOAD" not in caplog.text
    assert "SAFE-APP-LOG" in caplog.text
    assert "OUTSIDE-CALL" in caplog.text


async def test_asana_identity_can_find_get_me_on_a_later_tool_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = FastMCP("asana-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_me() -> ToolResult:
        return ToolResult(
            content=[],
            structured_content={"data": {"gid": "1", "email": "person@example.test"}},
        )

    original = oauth.Client.list_tools

    async def list_tools(client, max_pages=250):
        if max_pages < 2:
            return []
        return await original(client, max_pages=max_pages)

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    monkeypatch.setattr(oauth.Client, "list_tools", list_tools)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(FakeAsana().handle)
    ) as http:
        identity = await _adapter(http).identify("synthetic-access")
    assert identity.account_id == "1"


def test_asana_unscoped_consent_is_write_even_without_granted_scope_names() -> None:
    flow = cast(
        StoredFlow,
        SimpleNamespace(
            details={
                "name": "Asana",
                "unscoped": True,
                "read_scopes": [],
                "write_scopes": [],
            }
        ),
    )
    exchange = Exchange(
        flow=flow,
        signed_in=SignIn(ConnectionSecret({}), [], "synthetic-client"),
        account=Identity("synthetic-id", "person@example.test"),
    )
    assert ServiceFlows(None, cast(SignInFlows, None)).consent(exchange) == "write"


async def test_asana_flow_records_explicit_unscoped_consent() -> None:
    recorded: dict = {}

    class FlowStore:
        async def start(self, **kwargs):
            recorded.update(kwargs["details"])
            return SimpleNamespace(details=kwargs["details"])

    await ServiceFlows(None, cast(SignInFlows, FlowStore())).start(
        definition=CATALOG["asana"].definition,
        tenant_id="synthetic-tenant",
        user_id="synthetic-user",
        state="synthetic-state",
        port=39231,
        completion_secret="synthetic-secret",
        owner_label="Synthetic Owner",
    )
    assert recorded["unscoped"] is True
    assert recorded["scopes"] == []
    assert recorded["write_scopes"] == []


async def test_asana_refresh_keeps_the_refresh_token_asana_does_not_replace() -> None:
    vendor = FakeAsana()
    secret = ConnectionSecret(
        {
            "access_token": "old-access",
            "refresh_token": "r",
            "grant_context": "1000000000000001",
        }
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        renewed = await _adapter(http).refresh(secret)
    assert renewed.access_token == "new-access"
    assert renewed.values["refresh_token"] == "r"
    assert renewed.values["grant_context"] == "1000000000000001"
    assert vendor.token_forms == [
        {
            "grant_type": ["refresh_token"],
            "refresh_token": ["r"],
            "client_id": ["client-1"],
            "client_secret": ["SYNTHETIC"],
            "resource": [MCP_URL],
        }
    ]


def _token_response(workspace: object = "1000000000000001") -> dict:
    return {
        "access_token": "new-access",
        "refresh_token": "synthetic-refresh",
        "token_type": "Bearer",
        "expires_in": 3600,
        "data": {"authorized_workspace": workspace},
    }


@pytest.mark.parametrize(
    "workspace", ["1000000000000001", 1000000000000001, {"gid": "1000000000000001"}]
)
async def test_asana_exchange_keeps_only_the_normalized_workspace_id(
    workspace: object,
) -> None:
    vendor = FakeAsana(_token_response(workspace))
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        signed_in = await _adapter(http).exchange_code(
            code="synthetic-code",
            verifier="synthetic-verifier",
            redirect_uri=REDIRECT_URI,
            scopes=[],
        )
    assert signed_in.secret.values["grant_context"] == "1000000000000001"
    assert "data" not in signed_in.secret.values
    assert vendor.token_forms[0]["grant_type"] == ["authorization_code"]


@pytest.mark.parametrize(
    "workspace",
    [None, "", "  ", True, [], ["1000000000000001"], {}, {"gid": ""}, {"gid": True}],
)
async def test_asana_exchange_refuses_invalid_workspace_context(
    workspace: object,
) -> None:
    vendor = FakeAsana(_token_response(workspace))
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        with pytest.raises(ServiceAdapterError, match="workspace") as error:
            await _adapter(http).exchange_code(
                code="synthetic-code",
                verifier="synthetic-verifier",
                redirect_uri=REDIRECT_URI,
                scopes=[],
            )
    assert "synthetic-refresh" not in str(error.value)


async def test_asana_exchange_refuses_missing_workspace_context() -> None:
    response = _token_response()
    del response["data"]["authorized_workspace"]
    vendor = FakeAsana(response)
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        with pytest.raises(ServiceAdapterError, match="workspace"):
            await _adapter(http).exchange_code(
                code="synthetic-code",
                verifier="synthetic-verifier",
                redirect_uri=REDIRECT_URI,
                scopes=[],
            )


@pytest.mark.parametrize("workspace", ["1000000000000001", {"gid": "1000000000000001"}])
async def test_asana_refresh_accepts_the_same_explicit_workspace(
    workspace: object,
) -> None:
    vendor = FakeAsana(_token_response(workspace))
    secret = ConnectionSecret(
        {"refresh_token": "synthetic-refresh", "grant_context": "1000000000000001"}
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        renewed = await _adapter(http).refresh(secret)
    assert renewed.values["grant_context"] == "1000000000000001"


@pytest.mark.parametrize(
    "workspace", ["1000000000000002", None, "", True, [], {"gid": "1000000000000002"}]
)
async def test_asana_refresh_requires_reauthorization_for_changed_or_invalid_context(
    workspace: object,
) -> None:
    vendor = FakeAsana(_token_response(workspace))
    secret = ConnectionSecret(
        {"refresh_token": "synthetic-refresh", "grant_context": "1000000000000001"}
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        with pytest.raises(ReauthorizationRequiredError, match="workspace"):
            await _adapter(http).refresh(secret)


async def test_asana_refresh_refuses_old_secret_without_workspace_context() -> None:
    vendor = FakeAsana()
    secret = ConnectionSecret({"refresh_token": "synthetic-refresh"})
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        with pytest.raises(ReauthorizationRequiredError, match="workspace"):
            await _adapter(http).refresh(secret)


async def test_asana_refresh_refuses_a_non_normalized_prior_workspace_context() -> None:
    vendor = FakeAsana()
    secret = ConnectionSecret(
        {
            "refresh_token": "synthetic-refresh",
            "grant_context": {"gid": "1000000000000001"},
        }
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        with pytest.raises(ReauthorizationRequiredError, match="workspace"):
            await _adapter(http).refresh(secret)


async def test_asana_disconnect_revokes_the_refresh_token_at_the_advertised_endpoint() -> (
    None
):
    vendor = FakeAsana()
    secret = ConnectionSecret({"access_token": "old-access", "refresh_token": "r"})
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor.handle)) as http:
        await _adapter(http).revoke_connection(secret)
    assert vendor.revoke_forms == [
        {
            "token": ["r"],
            "token_type_hint": ["refresh_token"],
            "client_id": ["client-1"],
            "client_secret": ["SYNTHETIC"],
        }
    ]

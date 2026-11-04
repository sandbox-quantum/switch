"""MCP identity uses the vendor protocol without exposing response diagnostics."""

from __future__ import annotations

import json
import logging

import httpx
import pytest
import yaml
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.tools.tool import ToolResult
from mcp.types import TextContent
from pydantic import ValidationError

from switch_core.connections.adapters import ServiceAdapterError, oauth
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import ConnectionDefinition, ConnectionIdentity
from tests.switch_core.connections.test_loader import OAUTH_ENTRY


@pytest.mark.parametrize(
    "source", [{}, {"url": "https://example.com/me", "mcp_tool": "get_user"}]
)
def test_identity_requires_exactly_one_source(source):
    with pytest.raises(ValidationError, match="exactly one"):
        ConnectionIdentity(account_id="data.gid", label="data.name", **source)


def test_mcp_identity_requires_mcp_server():
    entry = yaml.safe_load(OAUTH_ENTRY)
    entry["auth"]["identity"] = {
        "mcp_tool": "get_user",
        "account_id": "data.gid",
        "label": "data.name",
    }
    del entry["mcp"]
    with pytest.raises(ValidationError, match="MCP identity needs"):
        ConnectionDefinition.model_validate(entry)


@pytest.mark.parametrize("shape", ["structured", "text", "integer", "missing-label"])
async def test_mcp_identity_protocol(monkeypatch, shape):
    server = FastMCP("identity-test")
    payload = {"data": {"gid": 42 if shape == "integer" else "account-example"}}
    if shape != "missing-label":
        payload["data"]["name"] = "Example account"

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> ToolResult:
        if shape == "text":
            return ToolResult(
                content=[TextContent(type="text", text=json.dumps(payload))]
            )
        return ToolResult(content=[], structured_content=payload)

    calls = []

    def transport(url, *, headers, httpx_client_factory):
        calls.append((url, headers))
        return server

    monkeypatch.setattr(oauth, "StreamableHttpTransport", transport)
    async with httpx.AsyncClient() as http:
        adapter = _adapter(http)
        identity = await adapter.identify("example-bearer-value")
    assert identity.account_id == ("42" if shape == "integer" else "account-example")
    assert identity.label == (
        identity.account_id if shape == "missing-label" else "Example account"
    )
    assert calls == [
        (adapter._mcp_url, {"Authorization": "Bearer example-bearer-value"})
    ]


@pytest.mark.parametrize(
    "shape", ["tool-error", "invalid-json", "oversized", "array", "empty", "missing-id"]
)
async def test_mcp_identity_rejects_unusable_results(monkeypatch, shape, caplog):
    server = FastMCP("identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> ToolResult:
        if shape == "tool-error":
            raise ToolError("Vendor refused identity")
        if shape == "empty":
            return ToolResult(content=[])
        if shape == "missing-id":
            return ToolResult(
                content=[], structured_content={"data": {"name": "Example"}}
            )
        text = {
            "invalid-json": "private-diagnostic",
            "array": "[]",
            "oversized": "x" * 65537,
        }[shape]
        return ToolResult(content=[TextContent(type="text", text=text)])

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError) as exc:
            await _adapter(http).identify("example-bearer-value")
    assert "private-diagnostic" not in str(exc.value)
    assert "example-bearer-value" not in str(exc.value)
    assert "private-diagnostic" not in caplog.text
    assert "example-bearer-value" not in caplog.text


async def test_mcp_identity_sanitizes_transport_failure(monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("private-diagnostic example-bearer-value")

    monkeypatch.setattr(oauth, "StreamableHttpTransport", fail)
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError, match="could not identify") as exc:
            await _adapter(http).identify("example-bearer-value")
    assert exc.value.__suppress_context__
    assert "private-diagnostic" not in str(exc.value)


def _adapter(http):
    entry = yaml.safe_load(OAUTH_ENTRY)
    entry["auth"]["identity"] = {
        "mcp_tool": "get_user",
        "account_id": "data.gid",
        "label": "data.name",
    }
    return OAuthAdapter(
        ConnectionDefinition.model_validate(entry),
        StaticClient(
            OAuthClientCredentials("example-client", None, authentication=None)
        ),
        http,
    )


@pytest.mark.parametrize(
    "location", ["https://example.com/redirected", "https://other.example.com/identity"]
)
async def test_mcp_identity_refuses_http_redirects(monkeypatch, location):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(307, headers={"Location": location})

    factory = oauth._mcp_http_client

    def mock_factory(**kwargs):
        return factory(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(oauth, "_mcp_http_client", mock_factory)
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError, match="could not identify"):
            await _adapter(http).identify("example-bearer-value")
    assert requests
    assert {str(request.url) for request in requests} == {_adapter_url()}


def _adapter_url():
    return yaml.safe_load(OAUTH_ENTRY)["mcp"]["servers"][0]["url"]


@pytest.mark.parametrize(
    "payload",
    [
        b'{"echo": "example-bearer-value", broken',
        b'{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"example-bearer-value"}}',
    ],
)
async def test_mcp_identity_malformed_http_does_not_log_token(
    monkeypatch, payload, caplog
):
    def handler(request):
        return httpx.Response(
            200, content=payload, headers={"content-type": "application/json"}
        )

    factory = oauth._mcp_http_client

    def mock_factory(**kwargs):
        return factory(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(oauth, "_mcp_http_client", mock_factory)
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError):
            await _adapter(http).identify("example-bearer-value")
    assert "example-bearer-value" not in caplog.text
    logging.getLogger("mcp.client.streamable_http").warning(
        "outside identity diagnostic"
    )
    assert "outside identity diagnostic" in caplog.text


def test_malformed_https_url_is_sanitized():
    with pytest.raises(ServiceAdapterError, match="not an https URL"):
        oauth._https("https://[", "endpoint")


def test_identity_diagnostic_filter_does_not_affect_other_contexts(caplog):
    logger = logging.getLogger("mcp.client.streamable_http")
    active = oauth._IDENTITY_DIAGNOSTICS.set(True)
    try:
        try:
            raise ValueError("private-diagnostic")
        except ValueError:
            logger.exception(
                "private-diagnostic %s", "example-bearer-value", stack_info=True
            )
        logging.getLogger("switch_core.connections.test").warning(
            "application diagnostic"
        )
    finally:
        oauth._IDENTITY_DIAGNOSTICS.reset(active)
    logger.warning("outside identity diagnostic")
    assert "private-diagnostic" not in caplog.text
    assert "example-bearer-value" not in caplog.text
    assert "application diagnostic" in caplog.text
    assert "outside identity diagnostic" in caplog.text


@pytest.mark.parametrize("readonly,has_argument", [(False, False), (True, True)])
async def test_identity_refuses_mutating_or_parameterized_tools(
    monkeypatch, readonly, has_argument
):
    server = FastMCP("unsafe-identity")
    called = []

    if has_argument:

        @server.tool(annotations={"readOnlyHint": readonly})
        def get_user(account: str) -> dict:
            called.append(account)
            return {"data": {"gid": "example-account"}}
    else:

        @server.tool(annotations={"readOnlyHint": readonly})
        def get_user() -> dict:
            called.append(True)
            return {"data": {"gid": "example-account"}}

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError, match="could not identify"):
            await _adapter(http).identify("example-bearer-value")
    assert called == []


@pytest.mark.parametrize("count", [0, 1, 2])
async def test_identity_never_selects_the_first_account_from_an_array(
    monkeypatch, count
):
    server = FastMCP("ambiguous-identity")

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> ToolResult:
        accounts = [{"data": {"gid": "example-account"}} for _ in range(count)]
        return ToolResult(content=[TextContent(type="text", text=json.dumps(accounts))])

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError):
            await _adapter(http).identify("example-bearer-value")


@pytest.mark.parametrize("account_id", [None, "", [], ["a", "b"], {}, True])
async def test_identity_requires_one_scalar_account_id(monkeypatch, account_id):
    server = FastMCP("missing-identity")

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> ToolResult:
        return ToolResult(content=[], structured_content={"data": {"gid": account_id}})

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError):
            await _adapter(http).identify("example-bearer-value")


async def test_existing_rest_identity_keeps_its_get_and_account_mapping():
    requests = []

    def response(request):
        requests.append(request)
        return httpx.Response(200, json={"id": "example-account", "label": "Example"})

    entry = yaml.safe_load(OAUTH_ENTRY)
    entry["auth"]["identity"] = {
        "url": "https://identity.example.test/me",
        "account_id": "id",
        "label": "label",
    }
    async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as http:
        adapter = OAuthAdapter(
            ConnectionDefinition.model_validate(entry),
            StaticClient(
                OAuthClientCredentials("example-client", None, authentication=None)
            ),
            http,
        )
        result = await adapter.identify("example-bearer-value")
    assert (result.account_id, result.label) == ("example-account", "Example")
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert str(requests[0].url) == "https://identity.example.test/me"


async def test_optional_identity_selector_is_never_supplied(monkeypatch):
    server = FastMCP("current-account-identity")
    calls = []

    @server.tool(annotations={"readOnlyHint": True})
    def get_user(user: str = "me") -> ToolResult:
        calls.append(user)
        return ToolResult(
            content=[], structured_content={"data": {"gid": "current-account"}}
        )

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with httpx.AsyncClient() as http:
        result = await _adapter(http).identify("example-bearer-value")
    assert result.account_id == "current-account"
    assert calls == ["me"]


@pytest.mark.parametrize("paths", [[], ["data.id[0]"], [""], [False], "data.id[0]"])
def test_composite_identity_rejects_invalid_paths(paths):
    with pytest.raises(ValidationError):
        ConnectionIdentity(mcp_tool="get_user", account_id=paths, label="name")


@pytest.mark.parametrize("source", ["mcp", "rest"])
@pytest.mark.parametrize(
    "parts, expected",
    [
        ({"user": "example-user", "org": 42}, "example-user:42"),
        ({"user": "a:b", "org": "c"}, "a%3Ab:c"),
        ({"user": "a", "org": "b:c"}, "a:b%3Ac"),
        ({"user": "a%3Ab", "org": "c"}, "a%253Ab:c"),
    ],
)
async def test_composite_identity_protocol(monkeypatch, source, parts, expected):
    server = FastMCP("composite-identity-test")

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> ToolResult:
        return ToolResult(content=[], structured_content=parts)

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=parts))
    async with httpx.AsyncClient(transport=transport) as http:
        adapter = _adapter(http)
        source_fields = (
            {"mcp_tool": "get_user"}
            if source == "mcp"
            else {"url": "https://example.com/me"}
        )
        adapter._identity = ConnectionIdentity(
            **source_fields, account_id=["user", "org"], label="user"
        )
        identity = await adapter.identify("example-bearer-value")
    assert identity.account_id == expected
    assert identity.label == parts["user"]


@pytest.mark.parametrize("bad", [None, "", "  ", [], ["one", "two"], {}, False, 1.5])
async def test_composite_identity_refuses_any_invalid_component(bad):
    payload = {"user": "example-user", "org": bad}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    async with httpx.AsyncClient(transport=transport) as http:
        adapter = _adapter(http)
        adapter._identity = ConnectionIdentity(
            url="https://example.com/me", account_id=["user", "org"], label="user"
        )
        with pytest.raises(ServiceAdapterError, match="account's id"):
            await adapter.identify("example-bearer-value")


async def test_composite_identity_changes_with_account():
    payload = {"user": "same-user", "org": "first-account"}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    async with httpx.AsyncClient(transport=transport) as http:
        adapter = _adapter(http)
        adapter._identity = ConnectionIdentity(
            url="https://example.com/me", account_id=["user", "org"], label="user"
        )
        first = await adapter.identify("example-bearer-value")
        payload["org"] = "second-account"
        second = await adapter.identify("example-bearer-value")
    assert first.account_id != second.account_id

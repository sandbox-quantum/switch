"""MCP identity uses the vendor protocol without exposing response diagnostics."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx
import pytest
import yaml
from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.tools.tool import ToolResult
from mcp.types import TextContent
from pydantic import ValidationError

from switch_core.connections.adapters import (
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
    oauth,
)
from switch_core.connections.adapters.oauth import (
    McpIdentityError,
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import ConnectionDefinition, ConnectionIdentity
from switch_core.logging_context import MCP_IDENTITY_DIAGNOSTICS
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
    assert exc.value.__context__ is None
    _assert_reason(exc.value, "protocol_error")
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


class _Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


async def test_vendor_log_notifications_never_reach_the_logs(monkeypatch):
    server = FastMCP("chatty-identity")

    @server.tool(annotations={"readOnlyHint": True})
    async def get_user(ctx: Context) -> ToolResult:
        await ctx.warning("vendor-marker example-bearer-value")
        return ToolResult(content=[], structured_content={"data": {"gid": "a"}})

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    handler = _Records()
    fastmcp_logger = logging.getLogger("fastmcp")
    level = fastmcp_logger.level
    fastmcp_logger.setLevel(logging.DEBUG)
    fastmcp_logger.addHandler(handler)
    logging.getLogger().addHandler(handler)
    try:
        async with httpx.AsyncClient() as http:
            identity = await _adapter(http).identify("example-bearer-value")
    finally:
        fastmcp_logger.removeHandler(handler)
        fastmcp_logger.setLevel(level)
        logging.getLogger().removeHandler(handler)
    assert identity.account_id == "a"
    # The in-memory server's own records stand for the vendor's machine.
    client_side = [
        record.getMessage()
        for record in handler.records
        if not record.name.startswith("fastmcp.server")
    ]
    assert not any("vendor-marker" in message for message in client_side)
    assert not any("example-bearer-value" in message for message in client_side)


def test_identity_diagnostic_filter_does_not_affect_other_contexts(caplog):
    logger = logging.getLogger("mcp.client.streamable_http")
    active = MCP_IDENTITY_DIAGNOSTICS.set(True)
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
        MCP_IDENTITY_DIAGNOSTICS.reset(active)
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


@pytest.mark.parametrize(
    "paths", [[], ["data.id"], ["data.id[0]"], [""], [False], "data.id[0]"]
)
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


# ── Fixed failure reasons, and HTTP errors ───────────────────────────────────

MARKER = "vendor-marker example-bearer-value"
GET_USER = {
    "name": "get_user",
    "inputSchema": {"type": "object"},
    "annotations": {"readOnlyHint": True},
}


class _ScriptedMcp:
    """An MCP server over `httpx.MockTransport` that answers `tools/list`
    from `pages`: a cursor to its tools and the next cursor. `status` answers
    every request with that status instead."""

    def __init__(
        self,
        pages: dict[str | None, tuple[list[dict[str, Any]], str | None]] | None = None,
        *,
        status: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.pages = pages or {None: ([GET_USER], None)}
        self.status = status
        self.headers = headers or {}
        self.requests: list[httpx.Request] = []
        self.calls: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status is not None:
            return httpx.Response(self.status, text=MARKER)
        if request.method != "POST":
            return httpx.Response(405)
        message = json.loads(request.content)
        if "id" not in message:
            return httpx.Response(202)
        method = message["method"]
        if method == "initialize":
            result: dict[str, Any] = {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "example", "version": "1.0.0"},
            }
        elif method == "tools/list":
            tools, cursor = self.pages[(message.get("params") or {}).get("cursor")]
            result = {"tools": tools, **({"nextCursor": cursor} if cursor else {})}
        elif method == "tools/call":
            self.calls.append(message)
            result = {
                "content": [],
                "structuredContent": {"data": {"gid": "account-example"}},
            }
        else:
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {"code": -32601, "message": MARKER},
                },
            )
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": message["id"], "result": result},
            headers=self.headers,
        )


def _over_mock(monkeypatch, handler) -> None:
    factory = oauth._mcp_http_client
    monkeypatch.setattr(
        oauth,
        "_mcp_http_client",
        lambda **kw: factory(transport=httpx.MockTransport(handler), **kw),
    )


async def _identify_error() -> ServiceAdapterError:
    async with httpx.AsyncClient() as http:
        with pytest.raises(ServiceAdapterError) as raised:
            await _adapter(http).identify("example-bearer-value")
    error = raised.value
    assert error.__context__ is None
    assert error.__cause__ is None
    assert "vendor-marker" not in str(error)
    assert "example-bearer-value" not in str(error)
    return error


def _assert_reason(error: ServiceAdapterError, reason: str) -> None:
    assert isinstance(error, McpIdentityError)
    assert error.reason == reason
    assert str(error) == str(McpIdentityError("Example", reason))  # type: ignore[arg-type]


def _failing_server(case: str, called: list[bool]) -> FastMCP:
    server = FastMCP("failing-identity")
    read_only = {"readOnlyHint": True}

    if case == "no-tool":

        @server.tool(annotations=read_only)
        def other_tool() -> dict:
            called.append(True)
            return {}
    elif case in ("not-read-only", "no-annotations"):
        annotations = {"readOnlyHint": False} if case == "not-read-only" else None

        @server.tool(annotations=annotations)
        def get_user() -> dict:
            called.append(True)
            return {"data": {"gid": "a"}}
    elif case == "required-argument":

        @server.tool(annotations=read_only)
        def get_user(account: str) -> dict:
            called.append(True)
            return {"data": {"gid": account}}
    else:
        texts = {
            "not-json": [MARKER],
            "oversized": ["x" * 65537],
            "array": ["[]"],
            "empty": [],
            "two-blocks": ['{"data": {"gid": "a"}}', '{"data": {"gid": "b"}}'],
        }

        @server.tool(annotations=read_only)
        def get_user() -> ToolResult:
            called.append(True)
            if case == "tool-error":
                raise ToolError(MARKER)
            return ToolResult(
                content=[TextContent(type="text", text=text) for text in texts[case]]
            )

    return server


@pytest.mark.parametrize(
    "case, reason",
    [
        ("no-tool", "tool_not_found"),
        ("not-read-only", "not_read_only"),
        ("no-annotations", "not_read_only"),
        ("required-argument", "needs_arguments"),
        ("tool-error", "tool_error"),
        ("not-json", "bad_result"),
        ("oversized", "bad_result"),
        ("array", "bad_result"),
        ("empty", "bad_result"),
        ("two-blocks", "bad_result"),
    ],
)
async def test_mcp_identity_failure_reasons(monkeypatch, caplog, case, reason):
    called: list[bool] = []
    server = _failing_server(case, called)
    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    error = await _identify_error()
    _assert_reason(error, reason)
    assert "vendor-marker" not in caplog.text
    assert "example-bearer-value" not in caplog.text
    if reason in ("tool_not_found", "not_read_only", "needs_arguments"):
        assert called == []


async def test_mcp_identity_refuses_a_duplicate_tool_name(monkeypatch):
    vendor = _ScriptedMcp({None: ([GET_USER, GET_USER], None)})
    _over_mock(monkeypatch, vendor)
    _assert_reason(await _identify_error(), "tool_not_found")
    assert vendor.calls == []


@pytest.mark.parametrize(
    "status, expected",
    [
        (401, ReauthorizationRequiredError),
        (429, ServiceUnavailableError),
        (500, ServiceUnavailableError),
        (503, ServiceUnavailableError),
        (403, McpIdentityError),
    ],
)
async def test_mcp_identity_maps_http_status(monkeypatch, status, expected):
    _over_mock(monkeypatch, _ScriptedMcp(status=status))
    error = await _identify_error()
    assert type(error) is expected
    if expected is ServiceUnavailableError:
        assert f"HTTP {status}" in str(error)
    if expected is McpIdentityError:
        _assert_reason(error, "protocol_error")


async def test_mcp_identity_transport_error_is_unavailable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError(MARKER)

    _over_mock(monkeypatch, handler)
    assert type(await _identify_error()) is ServiceUnavailableError


async def test_mcp_identity_timeout_is_unavailable(monkeypatch):
    monkeypatch.setattr(oauth, "MCP_IDENTITY_SECONDS", 0.2)

    async def handler(request):
        await asyncio.sleep(10)
        return httpx.Response(200)

    _over_mock(monkeypatch, handler)
    started = time.monotonic()
    assert type(await _identify_error()) is ServiceUnavailableError
    assert time.monotonic() - started < 2


@pytest.mark.parametrize("nested", [False, True])
async def test_mcp_failure_unwraps_exception_groups(nested):
    request = httpx.Request("POST", _adapter_url())
    status = httpx.HTTPStatusError(
        "401", request=request, response=httpx.Response(401, request=request)
    )
    group = ExceptionGroup("sdk", [ValueError("other"), status])
    if nested:
        group = ExceptionGroup("outer", [group])
    adapter = _adapter(None)
    failure = adapter._mcp_failure(group, asyncio.timeout(None))
    assert type(failure) is ReauthorizationRequiredError

"""MCP identity uses the vendor protocol without exposing response diagnostics."""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import inspect
import json
import logging
import socket
import threading
import time
from collections.abc import AsyncIterator, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpcore
import httpx
import pytest
import yaml
from aiohttp import web
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
    _McpBudget,
)
from switch_core.connections.loader import ConnectionDefinition, ConnectionIdentity
from switch_core.logging_context import MCP_IDENTITY_DIAGNOSTICS
from switch_core.outbound import (
    GuardedAsyncClient,
    OutboundPolicy,
    guarded_async_client,
)
from tests.switch_core.connections.test_loader import OAUTH_ENTRY
from tests.switch_core.test_outbound import _resolving_to

_NOTHING_ALLOWED = OutboundPolicy.parse("")


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
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        adapter = _adapter(http)
        identity = await adapter.identify("example-bearer-value", {})
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
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        with pytest.raises(ServiceAdapterError) as exc:
            await _adapter(http).identify("example-bearer-value", {})
    assert "private-diagnostic" not in str(exc.value)
    assert "example-bearer-value" not in str(exc.value)
    assert "private-diagnostic" not in caplog.text
    assert "example-bearer-value" not in caplog.text


async def test_mcp_identity_sanitizes_transport_failure(monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("private-diagnostic example-bearer-value")

    monkeypatch.setattr(oauth, "StreamableHttpTransport", fail)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        with pytest.raises(ServiceAdapterError, match="could not identify") as exc:
            await _adapter(http).identify("example-bearer-value", {})
    assert exc.value.__context__ is None
    _assert_reason(exc.value, "protocol_error")
    assert "private-diagnostic" not in str(exc.value)


def _adapter(http, arguments: dict[str, str] | None = None):
    entry = yaml.safe_load(OAUTH_ENTRY)
    entry["auth"]["identity"] = {
        "mcp_tool": "get_user",
        "account_id": "data.gid",
        "label": "data.name",
    }
    if arguments is not None:
        entry["auth"]["identity"]["arguments"] = arguments
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

    _over_mock(monkeypatch, handler)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        with pytest.raises(ServiceAdapterError, match="could not identify"):
            await _adapter(http).identify("example-bearer-value", {})
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
    # The SDK drops a body it cannot parse and waits for the deadline.
    monkeypatch.setattr(oauth, "MCP_IDENTITY_SECONDS", 0.5)

    def handler(request):
        return httpx.Response(
            200, content=payload, headers={"content-type": "application/json"}
        )

    _over_mock(monkeypatch, handler)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        with pytest.raises(ServiceAdapterError):
            await _adapter(http).identify("example-bearer-value", {})
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
        async with guarded_async_client(_NOTHING_ALLOWED) as http:
            identity = await _adapter(http).identify("example-bearer-value", {})
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


@pytest.mark.parametrize(
    "name", ["fastmcp.client.client", "mcp.client.streamable_http"]
)
def test_identity_diagnostics_are_suppressed_on_the_sdk_loggers(name):
    # Handlers Core did not install: on fastmcp's own logger, which does not
    # propagate, and on root.
    records = _Records()
    holders = [logging.getLogger("fastmcp"), logging.getLogger()]
    for holder in holders:
        holder.addHandler(records)
    active = MCP_IDENTITY_DIAGNOSTICS.set(True)
    try:
        try:
            raise ValueError(MARKER)
        except ValueError:
            logging.getLogger(name).exception("diagnostic %s", MARKER)
    finally:
        MCP_IDENTITY_DIAGNOSTICS.reset(active)
        for holder in holders:
            holder.removeHandler(records)
    mine = [record for record in records.records if record.name == name]
    assert mine
    assert all("vendor-marker" not in record.getMessage() for record in mine)
    assert all(record.exc_info is None for record in mine)


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
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        with pytest.raises(ServiceAdapterError, match="could not identify"):
            await _adapter(http).identify("example-bearer-value", {})
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
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        with pytest.raises(ServiceAdapterError):
            await _adapter(http).identify("example-bearer-value", {})


@pytest.mark.parametrize("account_id", [None, "", [], ["a", "b"], {}, True])
async def test_identity_requires_one_scalar_account_id(monkeypatch, account_id):
    server = FastMCP("missing-identity")

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> ToolResult:
        return ToolResult(content=[], structured_content={"data": {"gid": account_id}})

    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        with pytest.raises(ServiceAdapterError):
            await _adapter(http).identify("example-bearer-value", {})


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
        result = await adapter.identify("example-bearer-value", {})
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
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        result = await _adapter(http).identify("example-bearer-value", {})
    assert result.account_id == "current-account"
    assert calls == ["me"]


EVIL_PATTERN = {"type": "string", "pattern": "^(a+)+$"}


def _unevaluated_chain(levels: int, keyword: str) -> dict[str, Any]:
    schema: dict[str, Any] = {}
    for _ in range(levels):
        schema = {"type": "object", keyword: [schema], "unevaluatedProperties": False}
    return schema


@pytest.mark.parametrize(
    "schema",
    [
        {"type": "object"},
        {"type": "object", "properties": {"a": {"type": "string"}}},
        {"type": "object", "properties": {"a": {"$ref": "#"}}},
        {"type": "object", "properties": {"a": EVIL_PATTERN}},
        {"type": "object", "properties": {}, "required": []},
        {"type": "object", "additionalProperties": False},
        {"type": "object", "additionalProperties": {"type": "string"}},
        {"type": "object", "minProperties": 0, "maxProperties": 3},
        {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "$comment": "c",
            "type": "object",
            "title": "t",
            "description": "d",
            "default": {},
            "examples": [{}],
            "deprecated": False,
        },
        # Not read: a tool that still refuses {} fails when called.
        {"type": "object", "minProperties": 1},
        {"type": "object", "anyOf": [{}, {"required": ["a"]}]},
        {"type": "object", "x-vendor": 1},
        {"type": "object", "$ref": "https://schemas.example.test/s.json"},
        # Hostile shapes that make a JSON Schema validator take minutes.
        _unevaluated_chain(16, "allOf"),
        _unevaluated_chain(16, "anyOf"),
        {"type": "object", "allOf": [{}] * 21000},
    ],
    ids=lambda schema: str(schema)[:40],
)
def test_accepts_no_arguments_takes_a_safe_shape(schema):
    started = time.monotonic()
    assert oauth._accepts_arguments(schema, []) is True
    assert time.monotonic() - started < 0.1


@pytest.mark.parametrize(
    "schema",
    [
        ["type", "object"],
        {},
        {"type": "array"},
        {"type": ["object"]},
        {"type": "object", "required": ["a"]},
        {"type": "object", "required": "a"},
    ],
    ids=lambda schema: str(schema)[:40],
)
def test_accepts_no_arguments_refuses_other_shapes(schema):
    assert oauth._accepts_arguments(schema, []) is False


async def test_mcp_identity_refuses_a_schema_that_rejects_empty_arguments(
    monkeypatch,
):
    tool = {**GET_USER, "inputSchema": {"type": "object", "required": ["id"]}}
    vendor = _ScriptedMcp({None: ([tool], None)})
    _over_mock(monkeypatch, vendor)
    _assert_reason(await _identify_error(), "needs_arguments")
    assert vendor.calls == []


async def test_mcp_identity_spends_no_time_on_a_hostile_schema(monkeypatch):
    tool = {**GET_USER, "inputSchema": _unevaluated_chain(16, "allOf")}
    vendor = _ScriptedMcp({None: ([tool], None)})
    _over_mock(monkeypatch, vendor)
    started = time.monotonic()
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        identity = await _adapter(http).identify("example-bearer-value", {})
    assert time.monotonic() - started < 1
    assert identity.account_id == "account-example"


ME = {"query": "me"}
# Linear's get_user input schema, as measured.
QUERY_SCHEMA = {
    "type": "object",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "properties": {
        "query": {"type": "string", "description": 'User ID, name, email, or "me"'}
    },
    "required": ["query"],
    "additionalProperties": False,
}


async def _identify_with(arguments: dict[str, str], tool: dict[str, Any], monkeypatch):
    vendor = _ScriptedMcp({None: ([tool], None)})
    _over_mock(monkeypatch, vendor)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        try:
            result = await _adapter(http, arguments).identify(
                "example-bearer-value", {}
            )
        except ServiceAdapterError as error:
            assert error.__context__ is None and error.__cause__ is None
            return error, vendor
    return result, vendor


async def test_mcp_identity_sends_the_catalogs_arguments_exactly(monkeypatch):
    tool = {**GET_USER, "inputSchema": QUERY_SCHEMA}
    identity, vendor = await _identify_with(ME, tool, monkeypatch)
    assert not isinstance(identity, ServiceAdapterError)
    assert identity.account_id == "account-example"
    assert [call["params"]["name"] for call in vendor.calls] == ["get_user"]
    assert [call["params"]["arguments"] for call in vendor.calls] == [ME]


@pytest.mark.parametrize(
    "schema",
    [
        {"type": "object", "properties": {"other": {"type": "string"}}},
        {"type": "object"},
        {"type": "object", "properties": ["query"]},
        {**QUERY_SCHEMA, "required": ["query", "team"]},
        {**QUERY_SCHEMA, "required": "query"},
        {**QUERY_SCHEMA, "required": {"query": 1}},
        {"type": "object", "properties": {"query": {"type": "integer"}}},
        {"type": "object", "properties": {"query": {"type": ["string"]}}},
        {"type": "object", "properties": {"query": True}},
        {**QUERY_SCHEMA, "type": "array"},
        {key: value for key, value in QUERY_SCHEMA.items() if key != "type"},
    ],
    ids=lambda schema: str(schema)[:60],
)
async def test_mcp_identity_refuses_a_schema_its_arguments_do_not_fit(
    monkeypatch, schema
):
    error, vendor = await _identify_with(
        ME, {**GET_USER, "inputSchema": schema}, monkeypatch
    )
    assert isinstance(error, ServiceAdapterError)
    _assert_reason(error, "needs_arguments")
    assert vendor.calls == []


async def test_mcp_identity_with_arguments_still_needs_a_read_only_tool(monkeypatch):
    tool = {
        "name": "get_user",
        "inputSchema": QUERY_SCHEMA,
        "annotations": {"readOnlyHint": False},
    }
    error, vendor = await _identify_with(ME, tool, monkeypatch)
    assert isinstance(error, ServiceAdapterError)
    _assert_reason(error, "not_read_only")
    assert vendor.calls == []


@pytest.mark.parametrize(
    "schema",
    [
        QUERY_SCHEMA,
        {"type": "object", "properties": {"query": {}}},
        {"type": "object", "properties": {"query": {"type": "string"}, "team": {}}},
        {**QUERY_SCHEMA, "required": []},
        {**QUERY_SCHEMA, "allOf": [{}] * 21000},
    ],
    ids=lambda schema: str(schema)[:60],
)
def test_accepts_arguments_takes_a_schema_they_fit(schema):
    started = time.monotonic()
    assert oauth._accepts_arguments(schema, ["query"]) is True
    assert time.monotonic() - started < 0.1


def test_accepts_arguments_refuses_an_unhashable_required_entry():
    schema = {**QUERY_SCHEMA, "required": [{"query": 1}]}
    assert oauth._accepts_arguments(schema, ["query"]) is False


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
    async with (
        guarded_async_client(_NOTHING_ALLOWED)
        if source == "mcp"
        else httpx.AsyncClient(transport=transport)
    ) as http:
        adapter = _adapter(http)
        source_fields = (
            {"mcp_tool": "get_user"}
            if source == "mcp"
            else {"url": "https://example.com/me"}
        )
        adapter._identity = ConnectionIdentity(
            **source_fields, account_id=["user", "org"], label="user"
        )
        identity = await adapter.identify("example-bearer-value", {})
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
            await adapter.identify("example-bearer-value", {})


async def test_composite_identity_changes_with_account():
    payload = {"user": "same-user", "org": "first-account"}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    async with httpx.AsyncClient(transport=transport) as http:
        adapter = _adapter(http)
        adapter._identity = ConnectionIdentity(
            url="https://example.com/me", account_id=["user", "org"], label="user"
        )
        first = await adapter.identify("example-bearer-value", {})
        payload["org"] = "second-account"
        second = await adapter.identify("example-bearer-value", {})
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
    every request with that status instead, and `compressed` gzips answers."""

    def __init__(
        self,
        pages: dict[str | None, tuple[list[dict[str, Any]], str | None]] | None = None,
        *,
        status: int | None = None,
        compressed: bool = False,
        call_error: int | None = None,
    ) -> None:
        self.pages = pages or {None: ([GET_USER], None)}
        self.status = status
        self.compressed = compressed
        self.call_error = call_error
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
            if self.call_error is not None:
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": {"code": self.call_error, "message": MARKER},
                    },
                )
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
        body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result})
        if not self.compressed:
            return httpx.Response(
                200, content=body, headers={"content-type": "application/json"}
            )
        return httpx.Response(
            200,
            content=gzip.compress(body.encode()),
            headers={"content-type": "application/json", "content-encoding": "gzip"},
        )


def _over_mock(monkeypatch, handler) -> None:
    """The identity call's own transport answers with `handler`."""
    monkeypatch.setattr(
        oauth, "guarded_transport", lambda policy, **kw: httpx.MockTransport(handler)
    )


async def _identify_error(
    policy: OutboundPolicy = _NOTHING_ALLOWED,
) -> ServiceAdapterError:
    async with guarded_async_client(policy) as http:
        with pytest.raises(ServiceAdapterError) as raised:
            await _adapter(http).identify("example-bearer-value", {})
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
    ],
)
async def test_mcp_identity_maps_http_status(monkeypatch, status, expected):
    _over_mock(monkeypatch, _ScriptedMcp(status=status))
    error = await _identify_error()
    assert type(error) is expected
    if expected is ServiceUnavailableError:
        assert f"HTTP {status}" in str(error)


@pytest.mark.parametrize("status", [400, 403, 404, 405, 410, 422])
async def test_mcp_identity_reports_a_refusal_with_its_status(monkeypatch, status):
    _over_mock(monkeypatch, _ScriptedMcp(status=status))
    started = time.monotonic()
    error = await _identify_error()
    assert type(error) is ServiceAdapterError
    assert str(error) == f"Example would not say whose sign-in this is (HTTP {status})."
    assert time.monotonic() - started < 1


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
    failure = adapter._mcp_failure(group, _McpBudget(1, 1, asyncio.timeout(None)))
    assert type(failure) is ReauthorizationRequiredError


# ── The byte and page budget ─────────────────────────────────────────────────


@contextlib.asynccontextmanager
async def _over_http(monkeypatch, server: FastMCP, *, json_response: bool):
    """The identity call to `server`'s real HTTP app, through Core's client."""
    app = server.http_app(path="/v1/mcp", json_response=json_response)
    monkeypatch.setattr(
        oauth, "guarded_transport", lambda policy, **kw: httpx.ASGITransport(app=app)
    )
    async with app.router.lifespan_context(app):
        yield


def _paged_server(tools: int, *, page_size: int, description: str = "") -> FastMCP:
    """`tools` other tools, then `get_user`, listed `page_size` at a time."""
    server = FastMCP("paged-identity", list_page_size=page_size)
    for index in range(tools):
        server.tool(
            lambda: {},
            name=f"tool_{index}",
            description=description,
            annotations={"readOnlyHint": True},
        )

    @server.tool(annotations={"readOnlyHint": True})
    def get_user() -> dict:
        return {"data": {"gid": "account-example"}}

    return server


@pytest.mark.parametrize("json_response", [True, False], ids=["json", "sse"])
async def test_mcp_identity_refuses_an_oversized_response_quickly(
    monkeypatch, json_response
):
    monkeypatch.setattr(oauth, "MCP_RESPONSE_BYTES", 4096)
    server = _paged_server(1, page_size=100, description="x" * 8192)
    started = time.monotonic()
    async with _over_http(monkeypatch, server, json_response=json_response):
        _assert_reason(await _identify_error(), "bad_result")
    assert time.monotonic() - started < 1


async def test_mcp_identity_refuses_pages_over_the_total_budget(monkeypatch):
    monkeypatch.setattr(oauth, "MCP_IDENTITY_BYTES", 16 * 1024)
    server = _paged_server(40, page_size=5, description="x" * 1024)
    started = time.monotonic()
    async with _over_http(monkeypatch, server, json_response=True):
        _assert_reason(await _identify_error(), "bad_result")
    assert time.monotonic() - started < 1


async def test_mcp_identity_reads_a_small_server_over_http(monkeypatch):
    async with _over_http(
        monkeypatch, _paged_server(3, page_size=2), json_response=False
    ):
        async with guarded_async_client(_NOTHING_ALLOWED) as http:
            identity = await _adapter(http).identify("example-bearer-value", {})
    assert identity.account_id == "account-example"


@pytest.mark.parametrize("pages, succeeds", [(5, False), (6, True)])
async def test_mcp_identity_page_limit(monkeypatch, pages, succeeds):
    monkeypatch.setattr(oauth, "MCP_TOOL_PAGES", pages)
    server = _paged_server(10, page_size=2)
    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    if succeeds:
        async with guarded_async_client(_NOTHING_ALLOWED) as http:
            identity = await _adapter(http).identify("example-bearer-value", {})
        assert identity.account_id == "account-example"
    else:
        _assert_reason(await _identify_error(), "bad_result")


async def test_mcp_identity_finds_the_tool_on_a_later_page(monkeypatch):
    server = _paged_server(7, page_size=2)
    monkeypatch.setattr(oauth, "StreamableHttpTransport", lambda *a, **kw: server)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        identity = await _adapter(http).identify("example-bearer-value", {})
    assert identity.account_id == "account-example"


async def test_mcp_identity_refuses_a_repeated_cursor(monkeypatch):
    vendor = _ScriptedMcp({None: ([], "page-1"), "page-1": ([], "page-1")})
    _over_mock(monkeypatch, vendor)
    _assert_reason(await _identify_error(), "bad_result")
    assert vendor.calls == []
    # Stopped at the repeat, not by the page limit.
    listed = [
        request
        for request in vendor.requests
        if request.method == "POST"
        and json.loads(request.content).get("method") == "tools/list"
    ]
    assert len(listed) == 2


async def test_mcp_identity_refuses_a_name_listed_on_two_pages(monkeypatch):
    vendor = _ScriptedMcp({None: ([GET_USER], "page-1"), "page-1": ([GET_USER], None)})
    _over_mock(monkeypatch, vendor)
    _assert_reason(await _identify_error(), "tool_not_found")
    assert vendor.calls == []


async def test_mcp_identity_refuses_a_compressed_response(monkeypatch):
    vendor = _ScriptedMcp(compressed=True)
    _over_mock(monkeypatch, vendor)
    started = time.monotonic()
    _assert_reason(await _identify_error(), "bad_result")
    assert time.monotonic() - started < 1


async def test_a_second_budget_trip_is_a_no_op():
    deadline = asyncio.timeout(None)
    budget = _McpBudget(1, 1, deadline)
    with pytest.raises(TimeoutError):
        async with deadline:
            budget.trip()
            await asyncio.sleep(1)
    budget.trip()
    assert budget.tripped


async def test_mcp_identity_over_budget_on_two_streams(monkeypatch):
    """The listing and the server's event stream both go over the budget."""
    monkeypatch.setattr(oauth, "MCP_RESPONSE_BYTES", 1024)
    vendor = _ScriptedMcp()
    big = "x" * 4096
    streaming = asyncio.Event()

    async def events() -> AsyncIterator[bytes]:
        yield b": open\n\n"
        streaming.set()
        # A chunk that arrives after the first trip ended the call.
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.sleep(1)
        yield f"data: {big}\n\n".encode()

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200, content=events(), headers={"content-type": "text/event-stream"}
            )
        if b'"tools/list"' in request.content:
            await streaming.wait()
            message = json.loads(request.content)
            result = {"tools": [], "x": big}
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": message["id"], "result": result}
            )
        response = vendor(request)
        # The SDK opens the event stream only for a session.
        response.headers["mcp-session-id"] = "example-session"
        return response

    trips: list[BaseException | None] = []
    trip = _McpBudget.trip

    def recorded_trip(self: _McpBudget) -> None:
        try:
            trip(self)
        except BaseException as error:
            trips.append(error)
            raise
        trips.append(None)

    monkeypatch.setattr(_McpBudget, "trip", recorded_trip)
    _over_mock(monkeypatch, handler)
    records = _Records()
    loggers = [logging.getLogger(), logging.getLogger("fastmcp")]
    for logger in loggers:
        logger.addHandler(records)
    try:
        _assert_reason(await _identify_error(), "bad_result")
        # The event stream's reader outlives the call.
        await asyncio.sleep(0.1)
    finally:
        for logger in loggers:
            logger.removeHandler(records)
    assert len(trips) >= 2
    assert all(error is None for error in trips)
    assert not any(
        "Cannot change state" in record.getMessage()
        or (record.exc_info and isinstance(record.exc_info[1], RuntimeError))
        for record in records.records
    )


async def test_mcp_identity_asks_for_identity_encoding(monkeypatch):
    vendor = _ScriptedMcp()
    _over_mock(monkeypatch, vendor)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        await _adapter(http).identify("example-bearer-value", {})
    assert vendor.requests
    assert {r.headers.get("accept-encoding") for r in vendor.requests} == {"identity"}


@contextlib.contextmanager
def _fetch_recorder() -> Iterator[tuple[str, list[str]]]:
    """A loopback URL that records every GET of it, served from a thread
    because a fetch from the event loop's thread would block it."""
    hits: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            hits.append(self.path)
            body = b'{"type": "object"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/internal", hits
    finally:
        server.shutdown()
        server.server_close()


async def test_mcp_identity_never_fetches_an_output_schema_reference(monkeypatch):
    with _fetch_recorder() as (url, hits):
        output = {"type": "object", "properties": {"data": {"$ref": url}}}
        vendor = _ScriptedMcp({None: ([{**GET_USER, "outputSchema": output}], None)})
        _over_mock(monkeypatch, vendor)
        async with guarded_async_client(_NOTHING_ALLOWED) as http:
            identity = await _adapter(http).identify("example-bearer-value", {})
    assert hits == []
    assert identity.account_id == "account-example"


async def test_mcp_identity_reads_a_tool_with_an_output_schema(monkeypatch):
    output = {
        "type": "object",
        "properties": {"data": {"type": "object"}},
        "required": ["data"],
    }
    vendor = _ScriptedMcp({None: ([{**GET_USER, "outputSchema": output}], None)})
    _over_mock(monkeypatch, vendor)
    async with guarded_async_client(_NOTHING_ALLOWED) as http:
        identity = await _adapter(http).identify("example-bearer-value", {})
    assert identity.account_id == "account-example"
    assert len(vendor.calls) == 1


@pytest.mark.parametrize(
    "status, expected",
    [(401, ReauthorizationRequiredError), (500, ServiceUnavailableError)],
)
async def test_mcp_identity_maps_http_status_on_the_tool_call(
    monkeypatch, status, expected
):
    # The plain request is not watched for the SDK's transport failure, so
    # the error arrives when the deadline ends.
    monkeypatch.setattr(oauth, "MCP_IDENTITY_SECONDS", 0.5)
    vendor = _ScriptedMcp()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and b'"tools/call"' in request.content:
            return httpx.Response(status, text=MARKER)
        return vendor(request)

    _over_mock(monkeypatch, handler)
    assert type(await _identify_error()) is expected


# ── The outbound policy ──────────────────────────────────────────────────────

NOT_HELD = (
    "Example was not asked whose sign-in this is: Core's HTTP client is not "
    "held to its outbound policy."
)
REFUSED = (
    "Example's MCP server address is not allowed by this server's outbound policy."
)


class _Connects:
    """Records each TCP connection the guarded backend makes, and fails it."""

    def __init__(self, monkeypatch) -> None:
        self.addresses: list[tuple[str, int]] = []

        async def connect_tcp(backend, host, port, **kwargs):
            self.addresses.append((host, port))
            raise httpcore.ConnectError(MARKER)

        monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", connect_tcp)


async def test_mcp_identity_refuses_a_client_not_held_to_the_policy(monkeypatch):
    vendor = _ScriptedMcp()
    _over_mock(monkeypatch, vendor)
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor)) as http:
        assert not isinstance(http, GuardedAsyncClient)
        with pytest.raises(ServiceAdapterError) as raised:
            await _adapter(http).identify("example-bearer-value", {})
    assert type(raised.value) is ServiceAdapterError
    assert str(raised.value) == NOT_HELD
    assert raised.value.__context__ is None
    assert vendor.requests == []


async def test_mcp_identity_never_connects_where_the_policy_refuses(monkeypatch):
    _resolving_to(monkeypatch, "10.9.9.9")
    connects = _Connects(monkeypatch)
    error = await _identify_error()
    assert type(error) is ServiceAdapterError
    assert str(error) == REFUSED
    assert connects.addresses == []


@pytest.mark.parametrize(
    "allowed, address",
    [
        ("10.9.9.9", "10.9.9.9"),
        ("mcp.example.test", "10.9.9.9"),
        ("", "93.184.215.14"),
    ],
)
async def test_mcp_identity_connects_where_the_policy_allows(
    monkeypatch, allowed, address
):
    _resolving_to(monkeypatch, address)
    connects = _Connects(monkeypatch)
    error = await _identify_error(OutboundPolicy.parse(allowed))
    assert type(error) is ServiceUnavailableError
    assert "could not be reached" in str(error)
    assert connects.addresses == [(address, 443)]


async def test_mcp_identity_name_that_does_not_resolve_is_unreachable(monkeypatch):
    async def getaddrinfo(self, host, port, **kwargs):
        raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")

    monkeypatch.setattr("asyncio.base_events.BaseEventLoop.getaddrinfo", getaddrinfo)
    connects = _Connects(monkeypatch)
    error = await _identify_error()
    assert type(error) is ServiceUnavailableError
    assert "could not be reached" in str(error)
    assert connects.addresses == []


@pytest.mark.parametrize("verify", [True, False])
async def test_mcp_identity_transport_has_the_clients_policy(monkeypatch, verify):
    built = []
    vendor = _ScriptedMcp()

    def transport(policy, **kwargs):
        built.append((policy, kwargs))
        return httpx.MockTransport(vendor)

    monkeypatch.setattr(oauth, "guarded_transport", transport)
    policy = OutboundPolicy.parse("10.0.0.0/8")
    async with guarded_async_client(policy, verify=verify) as http:
        await _adapter(http).identify("example-bearer-value", {})
    assert built == [(policy, {"verify": verify})]


def test_mcp_http_client_takes_no_transport():
    """Nothing a caller passes can replace the guarded transport."""
    parameters = inspect.signature(oauth._mcp_http_client).parameters
    assert set(parameters) == {
        "budget",
        "policy",
        "verify",
        "headers",
        "timeout",
        "auth",
        "follow_redirects",
    }
    assert all(p.kind is p.KEYWORD_ONLY for p in parameters.values())


class _ClosingTransport(httpx.MockTransport):
    closed = False

    async def aclose(self) -> None:
        self.closed = True


@contextlib.asynccontextmanager
async def _local_server() -> AsyncIterator[str]:
    async def ok(_: web.Request) -> web.Response:
        return web.Response(text="ok")

    app = web.Application()
    app.router.add_get("/ok", ok)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    try:
        yield f"http://127.0.0.1:{port}/ok"
    finally:
        await runner.cleanup()


@pytest.mark.parametrize("status", [None, 500], ids=["succeeds", "fails"])
async def test_mcp_identity_leaves_the_shared_client_open(monkeypatch, status):
    built: list[_ClosingTransport] = []

    def transport(policy, **kwargs):
        built.append(_ClosingTransport(_ScriptedMcp(status=status)))
        return built[-1]

    monkeypatch.setattr(oauth, "guarded_transport", transport)
    async with _local_server() as url:
        async with guarded_async_client(OutboundPolicy.parse("127.0.0.1/32")) as http:
            if status is None:
                await _adapter(http).identify("example-bearer-value", {})
            else:
                with pytest.raises(ServiceUnavailableError):
                    await _adapter(http).identify("example-bearer-value", {})
            assert http.is_closed is False
            assert (await http.get(url)).text == "ok"
    assert [t.closed for t in built] == [True]


@pytest.mark.parametrize(
    "code, reason", [(-32602, "tool_error"), (-32603, "protocol_error")]
)
async def test_mcp_identity_tool_that_refuses_empty_arguments(
    monkeypatch, code, reason
):
    """A tool can refuse {} with a JSON-RPC invalid-params error instead of
    an isError result: that is the tool's refusal, not a broken answer."""
    vendor = _ScriptedMcp(call_error=code)
    _over_mock(monkeypatch, vendor)
    _assert_reason(await _identify_error(), reason)
    assert len(vendor.calls) == 1

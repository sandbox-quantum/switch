"""Identity discovery must never execute a write tool or expose vendor errors."""

import json

import httpx
import pytest
import yaml

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import ConnectionDefinition
from tests.switch_core.connections.test_loader import OAUTH_ENTRY


def definition():
    body = yaml.safe_load(OAUTH_ENTRY)
    body["auth"]["identity"] = {
        "mcp_tool": "user_info",
        "account_id": "login",
        "label": "login",
    }
    return ConnectionDefinition.model_validate(body)


def adapter(handler):
    return OAuthAdapter(
        definition(),
        StaticClient(OAuthClientCredentials("client", None, None)),
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def server(*, tools=None, answer=None, sse=False):
    calls = []

    def handle(request):
        body = json.loads(request.content)
        calls.append(body)
        assert str(request.url) == "https://mcp.example.test/v1/mcp"
        assert request.headers["authorization"] == "Bearer secret"
        method = body["method"]
        if method == "notifications/initialized":
            return httpx.Response(202)
        result = {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "serverInfo": {"name": "fake", "version": "1"},
        }
        if method == "tools/list":
            result = {
                "tools": tools
                if tools is not None
                else [
                    {
                        "name": "user_info",
                        "annotations": {"readOnlyHint": True},
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ]
            }
        if method == "tools/call":
            result = (
                answer
                if answer is not None
                else {"content": [{"type": "text", "text": '{"login":"ada"}'}]}
            )
        envelope = {"jsonrpc": "2.0", "id": body["id"], "result": result}
        if sse:
            return httpx.Response(
                200,
                text="event: message\ndata: " + json.dumps(envelope) + "\n\n",
                headers={
                    "content-type": "text/event-stream",
                    "mcp-session-id": "session",
                },
            )
        return httpx.Response(200, json=envelope, headers={"mcp-session-id": "session"})

    return handle, calls


@pytest.mark.parametrize("sse", [False, True])
async def test_reads_one_account_from_safe_tool(sse):
    handler, calls = server(sse=sse)
    result = await adapter(handler).identify("secret")
    assert (result.account_id, result.label) == ("ada", "ada")
    assert [c["method"] for c in calls] == [
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
    ]
    assert calls[-1]["params"] == {"name": "user_info", "arguments": {}}


@pytest.mark.parametrize(
    "tool",
    [
        {"name": "user_info", "inputSchema": {"type": "object"}},
        {
            "name": "user_info",
            "annotations": {"readOnlyHint": False},
            "inputSchema": {"type": "object"},
        },
        {
            "name": "user_info",
            "annotations": {"readOnlyHint": True},
            "inputSchema": {"type": "object", "required": ["org"]},
        },
    ],
)
async def test_unsafe_identity_tool_is_never_called(tool):
    handler, calls = server(tools=[tool])
    with pytest.raises(ServiceAdapterError, match="identity_tool_unsafe"):
        await adapter(handler).identify("secret")
    assert not any(c["method"] == "tools/call" for c in calls)


@pytest.mark.parametrize(
    "answer",
    [
        {"isError": True, "content": [{"type": "text", "text": "SECRET VENDOR ERROR"}]},
        {"structuredContent": []},
        {"structuredContent": [{"login": "a"}, {"login": "b"}]},
        {"structuredContent": {"login": True}},
        {"structuredContent": {"login": {"id": "a"}}},
        {
            "content": [
                {"type": "text", "text": '{"login":"a"}'},
                {"type": "text", "text": '{"login":"b"}'},
            ]
        },
    ],
)
async def test_ambiguous_or_invalid_identity_is_fixed_failure(answer):
    handler, _ = server(answer=answer)
    with pytest.raises(ServiceAdapterError) as raised:
        await adapter(handler).identify("secret")
    assert "identity_" in str(raised.value)
    assert "SECRET" not in str(raised.value)


async def test_redirect_is_not_followed():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(307, headers={"location": "https://evil.test/"})

    with pytest.raises(ServiceAdapterError, match="identity_transport"):
        await adapter(handler).identify("secret")
    assert len(calls) == 1


@pytest.mark.parametrize(
    "response, code",
    [
        (httpx.Response(200, text="not JSON"), "identity_protocol"),
        (httpx.Response(200, content=b"x" * 65537), "identity_response_too_large"),
        (httpx.Response(500, text="PRIVATE VENDOR DIAGNOSTIC"), "identity_transport"),
        (
            httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": {"message": "PRIVATE VENDOR DIAGNOSTIC"},
                },
            ),
            "identity_protocol",
        ),
    ],
)
async def test_bad_protocol_answers_are_bounded_and_sanitized(response, code):
    with pytest.raises(ServiceAdapterError, match=code) as raised:
        await adapter(lambda request: response).identify("secret")
    assert "PRIVATE" not in str(raised.value)


async def test_advertised_resource_never_changes_identity_destination():
    from tests.switch_core.connections.fake_vendor import FakeOAuthServer

    vendor = FakeOAuthServer()
    original = vendor.client()
    safe_handler, calls = server()

    async def handle(request):
        if request.headers.get("authorization") == "Bearer secret":
            return safe_handler(request)
        response = await original.send(request)
        if (
            "oauth-protected-resource" in str(request.url)
            and response.status_code == 200
        ):
            document = response.json()
            document["resource"] = "https://other.example.test/mcp"
            return httpx.Response(200, json=document)
        return response

    identity_adapter = adapter(handle)
    endpoints = await identity_adapter.endpoints()
    assert endpoints.resource == "https://other.example.test/mcp"
    assert (await identity_adapter.identify("secret")).account_id == "ada"
    assert len(calls) == 4


async def test_schema_composition_cannot_hide_required_arguments():
    handler, calls = server(
        tools=[
            {
                "name": "user_info",
                "annotations": {"readOnlyHint": True},
                "inputSchema": {"type": "object", "allOf": [{"required": ["tenant"]}]},
            }
        ]
    )
    with pytest.raises(ServiceAdapterError, match="identity_tool_unsafe"):
        await adapter(handler).identify("secret")
    assert not any(call["method"] == "tools/call" for call in calls)


class OpenEventStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        raise httpx.ReadTimeout("vendor kept stream open")

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize("split", [False, True])
async def test_sse_returns_before_stream_end_after_notifications(split):
    handler, _ = server(sse=True)
    streams = []

    def handle(request):
        response = handler(request)
        if response.status_code == 202:
            return response
        event = (
            b'data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'
            + response.content.replace(b"\n", b"\r\n")
        )
        chunks = [event[i : i + 1] for i in range(len(event))] if split else [event]
        stream = OpenEventStream(chunks)
        streams.append(stream)
        return httpx.Response(
            200, stream=stream, headers={"content-type": "text/event-stream"}
        )

    assert (await adapter(handle).identify("secret")).account_id == "ada"
    assert len(streams) == 3
    assert all(stream.closed for stream in streams)


SAFE_TOOL = {
    "name": "user_info",
    "annotations": {"readOnlyHint": True},
    "inputSchema": {"type": "object"},
}


def paginated_server(pages):
    fallback, calls = server()
    seen = []

    def handle(request):
        message = json.loads(request.content)
        if message["method"] != "tools/list":
            return fallback(request)
        seen.append(message["params"])
        index = len(seen) - 1
        page = pages[index] if index < len(pages) else pages[-1]
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": message["id"], "result": page}
        )

    return handle, calls, seen


async def test_identity_tool_can_be_on_later_page():
    handler, calls, seen = paginated_server(
        [{"tools": [], "nextCursor": "page-2"}, {"tools": [SAFE_TOOL]}]
    )
    assert (await adapter(handler).identify("secret")).account_id == "ada"
    assert seen == [{}, {"cursor": "page-2"}]
    assert calls[-1]["method"] == "tools/call"


@pytest.mark.parametrize(
    "pages",
    [
        [{"tools": [SAFE_TOOL], "nextCursor": "next"}, {"tools": [SAFE_TOOL]}],
        [{"tools": [], "nextCursor": "loop"}],
    ],
)
async def test_duplicate_tools_or_cursor_cycles_never_call_identity(pages):
    handler, calls, seen = paginated_server(pages)
    with pytest.raises(ServiceAdapterError, match="identity_tool_unsafe"):
        await adapter(handler).identify("secret")
    assert not any(call["method"] == "tools/call" for call in calls)
    assert len(seen) == 2


@pytest.mark.parametrize(
    "limit, pages",
    [
        (
            "MAX_IDENTITY_PAGES",
            [
                {"tools": [], "nextCursor": "a"},
                {"tools": [], "nextCursor": "b"},
                {"tools": [SAFE_TOOL]},
            ],
        ),
        (
            "MAX_IDENTITY_TOOLS",
            [
                {"tools": [{"name": "other"}, SAFE_TOOL], "nextCursor": "a"},
                {"tools": [{"name": "third"}]},
            ],
        ),
        (
            "MAX_IDENTITY_BYTES",
            [
                {"tools": [], "padding": "x" * 400, "nextCursor": "next"},
                {"tools": [SAFE_TOOL], "padding": "x" * 400},
            ],
        ),
    ],
)
async def test_paginated_discovery_has_global_limits(monkeypatch, limit, pages):
    import switch_core.connections.adapters.oauth as oauth

    monkeypatch.setattr(
        oauth, limit, 1000 if limit == "MAX_IDENTITY_BYTES" else 2, raising=False
    )
    handler, calls, seen = paginated_server(pages)
    with pytest.raises(
        ServiceAdapterError, match="identity_(tool_unsafe|response_too_large)"
    ):
        await adapter(handler).identify("secret")
    assert not any(call["method"] == "tools/call" for call in calls)
    assert len(seen) == 2


async def test_total_deadline_stops_an_open_identity_stream(monkeypatch):
    import asyncio

    import switch_core.connections.adapters.oauth as oauth

    original_timeout = asyncio.timeout

    def short_timeout(seconds):
        assert seconds == 20
        return original_timeout(0.01)

    monkeypatch.setattr(oauth.asyncio, "timeout", short_timeout)

    class WaitingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
            await asyncio.Event().wait()

    with pytest.raises(ServiceAdapterError, match="identity_transport"):
        await adapter(
            lambda request: httpx.Response(
                200,
                stream=WaitingStream(),
                headers={"content-type": "text/event-stream"},
            )
        ).identify("secret")

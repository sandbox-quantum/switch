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
    from tests.switch_core.connections.fake_vendor import MCP_URL, FakeOAuthServer

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
    assert endpoints.resource == MCP_URL
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

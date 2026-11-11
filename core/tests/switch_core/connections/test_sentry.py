"""The shipped Sentry entry against Sentry's MCP server as it answers."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from switch_core.connections.adapters import ServiceAdapterError, oauth
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import CATALOG
from switch_core.outbound import OutboundPolicy, guarded_async_client

SENTRY = CATALOG["sentry"].definition

# Sentry's whoami as its tools/list shows it: zod's empty object, as the MCP
# TypeScript SDK writes it in JSON Schema, and its output schema.
WHOAMI_TOOL = {
    "name": "whoami",
    "title": "Who Am I",
    "description": "Identify the authenticated user in Sentry.",
    "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
        "$schema": "http://json-schema.org/draft-07/schema#",
    },
    "outputSchema": {
        "type": "object",
        "properties": {
            "user": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": ["string", "null"]},
                    "email": {"type": "string"},
                },
                "required": ["id", "name", "email"],
            },
            "sessionConstraints": {"type": ["object", "null"]},
        },
        "required": ["user", "sessionConstraints"],
        "$schema": "http://json-schema.org/draft-07/schema#",
    },
    "annotations": {
        "readOnlyHint": True,
        "destructiveHint": False,
        "openWorldHint": True,
    },
}
OTHER_TOOL = {
    "name": "find_organizations",
    "inputSchema": {"type": "object", "properties": {}},
    "annotations": {"readOnlyHint": True},
}


class _SentryMcp:
    """Sentry's MCP server as the identity call sees it, over MockTransport."""

    def __init__(self, tool: dict[str, Any], answer: dict[str, Any]) -> None:
        self.tool = tool
        self.answer = answer
        self.calls: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
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
                "serverInfo": {"name": "sentry-mcp", "version": "0.0.0"},
            }
        elif method == "tools/list":
            result = {"tools": [OTHER_TOOL, self.tool]}
        elif method == "tools/call":
            self.calls.append(message)
            result = self.answer
        else:
            return httpx.Response(404)
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": message["id"], "result": result}
        )


def _adapter(http: httpx.AsyncClient) -> OAuthAdapter:
    return OAuthAdapter(
        SENTRY,
        StaticClient(OAuthClientCredentials("synthetic-client", None, None)),
        http,
    )


def _whoami(user: dict[str, Any], **extra: Any) -> dict[str, Any]:
    body = {"user": user, "sessionConstraints": None, **extra}
    # Sentry's server sends the same answer as JSON text as well.
    return {
        "content": [{"type": "text", "text": json.dumps(body)}],
        "structuredContent": body,
    }


async def _identify(monkeypatch, vendor: _SentryMcp) -> oauth.Identity:
    monkeypatch.setattr(
        oauth, "guarded_transport", lambda policy, **kw: httpx.MockTransport(vendor)
    )
    async with guarded_async_client(OutboundPolicy.parse("")) as http:
        return await _adapter(http).identify("example-bearer-value")


async def test_sentry_whoami_names_the_account(monkeypatch):
    vendor = _SentryMcp(
        WHOAMI_TOOL, _whoami({"id": "123", "name": None, "email": "ada@example.test"})
    )
    identity = await _identify(monkeypatch, vendor)
    assert (identity.account_id, identity.label) == ("123", "ada@example.test")
    [call] = vendor.calls
    assert call["params"] == {"name": "whoami", "arguments": {}}


async def test_sentry_whoami_reads_the_user_not_the_accounts(monkeypatch):
    # Sentry's stdio server also lists every account it has signed in.
    answer = _whoami(
        {"id": "123", "name": "Ada", "email": "ada@example.test"},
        accounts=[
            {"id": "456", "name": "Bob", "email": "bob@example.test"},
            {"id": "123", "name": "Ada", "email": "ada@example.test"},
        ],
    )
    identity = await _identify(monkeypatch, _SentryMcp(WHOAMI_TOOL, answer))
    assert identity.account_id == "123"


async def test_sentry_whoami_as_text_alone_names_the_account(monkeypatch):
    answer = _whoami({"id": "123", "name": None, "email": "ada@example.test"})
    del answer["structuredContent"]
    identity = await _identify(monkeypatch, _SentryMcp(WHOAMI_TOOL, answer))
    assert (identity.account_id, identity.label) == ("123", "ada@example.test")


async def test_sentry_whoami_with_no_email_is_labelled_by_its_id(monkeypatch):
    answer = _whoami({"id": "123", "name": None, "email": ""})
    identity = await _identify(monkeypatch, _SentryMcp(WHOAMI_TOOL, answer))
    assert (identity.account_id, identity.label) == ("123", "123")


@pytest.mark.parametrize("read_only", [False, None])
async def test_sentry_whoami_that_is_not_read_only_is_never_called(
    monkeypatch, read_only
):
    tool = {**WHOAMI_TOOL, "annotations": {"readOnlyHint": read_only}}
    vendor = _SentryMcp(tool, _whoami({"id": "1", "name": None, "email": "x"}))
    with pytest.raises(ServiceAdapterError):
        await _identify(monkeypatch, vendor)
    assert vendor.calls == []

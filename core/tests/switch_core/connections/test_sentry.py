"""Sentry's shipped policy and MCP-only OAuth identity, without live accounts."""

from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

import anyio
import httpx
import pytest
from mcp.types import LATEST_PROTOCOL_VERSION
from pydantic import ValidationError

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.adapters.oauth import (
    Identity,
    OAuthAdapter,
    OAuthClientCredentials,
    SignIn,
    StaticClient,
    s256,
)
from switch_core.connections.flows import Exchange, FlowError, ServiceFlows
from switch_core.connections.loader import CATALOG, ConnectionDefinition
from switch_core.connections.registry import every_scope
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import TENANT_ZERO_ID
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.test_broker import _user

SENTRY = CATALOG["sentry"].definition
MCP_URL = "https://mcp.sentry.dev/mcp"
SCOPES = ["org:read", "project:write", "team:write", "event:write"]


def _adapter(http: httpx.AsyncClient) -> OAuthAdapter:
    return OAuthAdapter(
        SENTRY,
        StaticClient(OAuthClientCredentials("synthetic-client", None, None)),
        http,
    )


class IdentityServer:
    def __init__(self, *, sse: bool = False) -> None:
        self.sse = sse
        self.calls: list[dict[str, Any]] = []
        self.requests: list[httpx.Request] = []
        self.result: dict[str, Any] = {
            "content": [],
            "structuredContent": {
                "user": {"id": "synthetic-user", "email": "owner@example.test"}
            },
        }
        self.status = 200
        self.headers: dict[str, str] = {}
        self.raw: bytes | None = None
        self.response_id = 2
        self.protocol_version = LATEST_PROTOCOL_VERSION
        self.session_id = "synthetic-session"
        self.capabilities = {"tools": {}}

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert str(request.url) == MCP_URL
        assert request.method == "POST"
        assert request.headers["Authorization"] == "Bearer SYNTHETIC"
        message = json.loads(request.content)
        self.calls.append(message)
        if self.status != 200:
            return httpx.Response(self.status, headers=self.headers, text="SYNTHETIC")
        if self.raw is not None:
            return httpx.Response(200, headers=self.headers, content=self.raw)
        if message["method"] == "notifications/initialized":
            return httpx.Response(202)
        if message["method"] == "initialize":
            result = {
                "protocolVersion": self.protocol_version,
                "capabilities": self.capabilities,
                "serverInfo": {"name": "Sentry stand-in", "version": "1"},
            }
            response_id = message["id"]
        else:
            assert request.headers["Mcp-Session-Id"] == "synthetic-session"
            assert request.headers["MCP-Protocol-Version"] == LATEST_PROTOCOL_VERSION
            assert message["params"] == {"name": "whoami", "arguments": {}}
            result = self.result
            response_id = self.response_id
        body = {"jsonrpc": "2.0", "id": response_id, "result": result}
        headers = {"Mcp-Session-Id": self.session_id}
        if self.sse:
            headers["Content-Type"] = "text/event-stream"
            # A notification is data, never a request for Core to execute.
            notification = json.dumps(
                {"jsonrpc": "2.0", "method": "notifications/message"}
            )
            return httpx.Response(
                200,
                headers=headers,
                text=f": keepalive\r\n\r\ndata: {notification}\r\n\r\nevent: message\r\ndata: {json.dumps(body)}\r\n\r\n",
            )
        return httpx.Response(200, headers=headers, json=body)


def test_sentry_is_oauth_with_mcp_identity_and_only_write_access():
    assert SENTRY.enabled and SENTRY.adapter == "oauth"
    assert SENTRY.auth.refresh == "rotating"
    assert SENTRY.auth.oauth is not None
    assert SENTRY.auth.oauth.registration == "dynamic"
    assert SENTRY.auth.oauth.redirect == ["loopback"]
    assert SENTRY.auth.oauth.revocation_discovered
    assert SENTRY.auth.identity is not None
    assert SENTRY.auth.identity.model_dump() == {
        "url": MCP_URL,
        "mcp_tool": "whoami",
        "account_id": "user.id",
        "label": "user.email",
    }
    assert SENTRY.access is not None and SENTRY.access.read is None
    assert SENTRY.access.write is not None and SENTRY.access.write.scopes == SCOPES
    assert every_scope(SENTRY) == SCOPES
    assert SENTRY.tools is not None and SENTRY.tools.mode == "pass_through"
    assert SENTRY.token is not None and SENTRY.token.max_lifetime == 3600
    assert SENTRY.mcp is not None
    assert [(s.name, s.url, s.headers) for s in SENTRY.mcp.servers] == [
        ("sentry", MCP_URL, None)
    ]


@pytest.mark.parametrize(
    ("section", "value", "message"),
    [
        ("identity_url", "http://mcp.sentry.dev/mcp", "String should match pattern"),
        ("identity_url", "https://other.example.test/identity", "catalog MCP server"),
        ("identity_tool", "../whoami", "String should match pattern"),
        ("tools", {"mode": "listed", "read": [], "write": []}, "tools pass through"),
        ("access", {}, "at least one level"),
    ],
)
def test_sentry_cannot_bypass_loader_checks(section, value, message):
    body = SENTRY.model_dump()
    if section == "identity_url":
        body["auth"]["identity"]["url"] = value
    elif section == "identity_tool":
        body["auth"]["identity"]["mcp_tool"] = value
    else:
        body[section] = value
    with pytest.raises(ValidationError, match=message):
        ConnectionDefinition.model_validate(body)


@pytest.mark.parametrize("sse", [False, True])
async def test_identity_uses_structured_whoami_without_sending_mcp_tokens_to_rest(sse):
    server = IdentityServer(sse=sse)
    async with httpx.AsyncClient(transport=httpx.MockTransport(server.handle)) as http:
        identity = await _adapter(http).identify("SYNTHETIC")
    assert (identity.account_id, identity.label) == (
        "synthetic-user",
        "owner@example.test",
    )
    assert [message["method"] for message in server.calls] == [
        "initialize",
        "notifications/initialized",
        "tools/call",
    ]


@pytest.mark.parametrize(
    "result",
    [
        {"content": [{"type": "text", "text": '{"user":{"id":"SYNTHETIC"}}'}]},
        {
            "content": [],
            "isError": True,
            "structuredContent": {"user": {"id": "SYNTHETIC"}},
        },
        {"content": [], "structuredContent": {"user": {"email": "owner@example.test"}}},
        {"content": [], "structuredContent": {"user": {"id": ""}}},
        {"content": [], "structuredContent": {"user": {"id": False}}},
    ],
)
async def test_unverified_or_failed_identity_is_rejected_without_echoing_payloads(
    result, caplog
):
    server = IdentityServer()
    server.result = result
    async with httpx.AsyncClient(transport=httpx.MockTransport(server.handle)) as http:
        with pytest.raises(ServiceAdapterError) as failure:
            await _adapter(http).identify("SYNTHETIC")
    assert "SYNTHETIC" not in str(failure.value) + caplog.text


@pytest.mark.parametrize("status", [301, 302, 307, 308, 401, 403, 429, 503])
async def test_identity_does_not_follow_redirects_or_disclose_vendor_errors(
    status, caplog
):
    server = IdentityServer()
    server.status = status
    server.headers = {"Location": "https://other.example.test/collect"}
    error = (
        ReauthorizationRequiredError
        if status == 401
        else ServiceUnavailableError
        if status in (429, 503)
        else ServiceAdapterError
    )
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(server.handle), follow_redirects=True
    ) as http:
        with pytest.raises(error) as failure:
            await _adapter(http).identify("SYNTHETIC")
    assert len(server.requests) == 1
    assert "SYNTHETIC" not in str(failure.value) + caplog.text


@pytest.mark.parametrize(
    ("raw", "headers"),
    [
        (b"SYNTHETIC", {"Content-Type": "application/json"}),
        (b"x" * (64 * 1024 + 1), {"Content-Type": "application/json"}),
        (b"data: SYNTHETIC\n\n", {"Content-Type": "text/event-stream"}),
        (b"<html>SYNTHETIC</html>", {"Content-Type": "text/html"}),
    ],
)
async def test_malformed_and_oversized_identity_responses_fail_closed(
    raw, headers, caplog
):
    server = IdentityServer()
    server.raw, server.headers = raw, headers
    async with httpx.AsyncClient(transport=httpx.MockTransport(server.handle)) as http:
        with pytest.raises(ServiceAdapterError) as failure:
            await _adapter(http).identify("SYNTHETIC")
    assert "SYNTHETIC" not in str(failure.value) + caplog.text


async def test_an_unrelated_rpc_result_cannot_supply_identity():
    server = IdentityServer()
    server.response_id = 999
    async with httpx.AsyncClient(transport=httpx.MockTransport(server.handle)) as http:
        with pytest.raises(ServiceAdapterError, match="invalid identity"):
            await _adapter(http).identify("SYNTHETIC")


@pytest.mark.parametrize("case", ["protocol", "session", "tools"])
async def test_invalid_initialization_cannot_reach_the_identity_tool(case):
    server = IdentityServer()
    if case == "protocol":
        server.protocol_version = "unsupported"
    elif case == "session":
        server.session_id = "SYNTHETIC\ninjected-header"
    else:
        server.capabilities = {}
    async with httpx.AsyncClient(transport=httpx.MockTransport(server.handle)) as http:
        with pytest.raises(ServiceAdapterError, match="invalid identity"):
            await _adapter(http).identify("SYNTHETIC")
    assert [message["method"] for message in server.calls] == ["initialize"]


async def test_identity_accepts_an_sse_result_without_waiting_for_stream_close():
    server = IdentityServer(sse=True)

    class OpenStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield self.data[:17]
            yield self.data[17:]
            await anyio.sleep_forever()

        def __init__(self, data):
            self.data = data
            self.closed = False

        async def aclose(self):
            self.closed = True

    streams = []

    def handle(request):
        response = server.handle(request)
        if response.status_code == 202:
            return response
        stream = OpenStream(response.content)
        streams.append(stream)
        return httpx.Response(200, headers=response.headers, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        with anyio.fail_after(2):
            identity = await _adapter(http).identify("SYNTHETIC")
    assert identity.account_id == "synthetic-user"
    assert all(stream.closed for stream in streams)


async def test_identity_timeout_is_bounded_and_does_not_echo_exceptions(monkeypatch):
    from switch_core.connections.adapters import mcp_identity

    monkeypatch.setattr(mcp_identity, "IDENTITY_TIMEOUT", 0.01)

    async def handle(request):
        await anyio.sleep_forever()

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        with pytest.raises(ServiceUnavailableError, match="could not be reached"):
            await _adapter(http).identify("SYNTHETIC")


async def test_a_sentry_flow_cannot_fall_back_to_read_consent(session_factory):
    async with session_factory() as session:
        owner = await _user(session, "Sentry owner")
        await session.commit()
    flows = ServiceFlows(None, SignInFlows(session_factory, TEST_KEYRING))
    flow = await flows.start(
        definition=SENTRY,
        tenant_id=TENANT_ZERO_ID,
        user_id=owner.id,
        state="synthetic-sentry-state",
        port=39251,
        completion_secret="synthetic-completion",
        owner_label="Sentry owner",
    )
    assert flow.stored.details["scopes"] == SCOPES
    assert flow.stored.details["read_scopes"] is None
    assert flow.stored.details["consent"] == "write"
    for scopes in ([], ["org:read"], SCOPES[:-1]):
        exchange = Exchange(
            flow.stored,
            SignIn(ConnectionSecret({}), scopes, "synthetic-client"),
            Identity("synthetic-user", "owner@example.test"),
        )
        with pytest.raises(FlowError, match="granted less than Switch needs"):
            flows.consent(exchange)
    assert (
        flows.consent(
            Exchange(
                flow.stored,
                SignIn(ConnectionSecret({}), SCOPES, "synthetic-client"),
                Identity("synthetic-user", "owner@example.test"),
            )
        )
        == "write"
    )


async def test_sentry_oauth_discovery_identity_refresh_and_revocation():
    """The actual entry uses downstream MCP auth for the complete lifecycle."""
    server = IdentityServer()
    origin = "https://mcp.sentry.dev"
    token_requests = []
    challenge = s256("synthetic-verifier")
    metadata = {
        "issuer": origin,
        "authorization_endpoint": f"{origin}/oauth/authorize",
        "token_endpoint": f"{origin}/oauth/token",
        "registration_endpoint": f"{origin}/oauth/register",
        "revocation_endpoint": f"{origin}/oauth/token",
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }

    def handle(request):
        url = str(request.url)
        if url == MCP_URL and "authorization" not in request.headers:
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": f'Bearer resource_metadata="{origin}/.well-known/oauth-protected-resource/mcp"'
                },
            )
        if url == f"{origin}/.well-known/oauth-protected-resource/mcp":
            return httpx.Response(
                200, json={"resource": MCP_URL, "authorization_servers": [origin]}
            )
        if url == f"{origin}/.well-known/oauth-authorization-server":
            return httpx.Response(200, json=metadata)
        if url == f"{origin}/oauth/token":
            form = {
                key: values[0]
                for key, values in parse_qs(request.content.decode()).items()
            }
            token_requests.append(form)
            if "token" in form:
                assert form["token"] == "SYNTHETIC-REFRESH-2"
                assert form["token_type_hint"] == "refresh_token"
                return httpx.Response(200)
            if form["grant_type"] == "authorization_code":
                assert s256(form["code_verifier"]) == challenge
                assert form["resource"] == MCP_URL
                access, refresh = "SYNTHETIC", "SYNTHETIC-REFRESH-1"
            else:
                assert form["grant_type"] == "refresh_token"
                assert form["refresh_token"] == "SYNTHETIC-REFRESH-1"
                access, refresh = "SYNTHETIC-RENEWED", "SYNTHETIC-REFRESH-2"
            return httpx.Response(
                200,
                json={
                    "access_token": access,
                    "refresh_token": refresh,
                    "expires_in": 3600,
                    "token_type": "Bearer",
                    "scope": " ".join(SCOPES),
                },
            )
        return server.handle(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        adapter = _adapter(http)
        authorization = await adapter.authorization_url(
            redirect_uri="http://127.0.0.1:39251/switch-services/callback",
            state="synthetic-state",
            code_challenge=challenge,
            scopes=SCOPES,
        )
        query = parse_qs(urlsplit(authorization).query)
        assert query["scope"] == [" ".join(SCOPES)]
        assert query["code_challenge_method"] == ["S256"]
        assert query["resource"] == [MCP_URL]
        signed_in = await adapter.exchange_code(
            code="synthetic-code",
            verifier="synthetic-verifier",
            redirect_uri="http://127.0.0.1:39251/switch-services/callback",
            scopes=SCOPES,
        )
        identity = await adapter.identify(signed_in.secret.access_token or "")
        assert identity.account_id == "synthetic-user"
        renewed = await adapter.refresh(signed_in.secret)
        assert renewed.access_token == "SYNTHETIC-RENEWED"
        assert renewed.expires_at == pytest.approx(time.time() + 3600, abs=5)
        await adapter.revoke_connection(renewed)
    assert len(token_requests) == 3

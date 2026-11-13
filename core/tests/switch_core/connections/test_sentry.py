"""The shipped Sentry entry against Sentry's MCP server as it answers."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from switch_core import outbound
from switch_core.connections.adapters import (
    ConnectionSecret,
    ServiceAdapterError,
    oauth,
)
from switch_core.connections.adapters.oauth import (
    Identity,
    OAuthAdapter,
    OAuthClientCredentials,
    SignIn,
    StaticClient,
    s256,
)
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.flows import Exchange, FlowError, ServiceFlows
from switch_core.connections.loader import CATALOG
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.outbound import OutboundPolicy, guarded_async_client
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.test_broker import (
    STORE,
    _issuances,
    _issue,
    _refused,
    _user,
)
from tests.switch_core.gateway.agent_route_harness import add_agent

SENTRY = CATALOG["sentry"].definition
MCP_URL = "https://mcp.sentry.dev/mcp"
SCOPES = ["org:read", "project:write", "team:write", "event:write"]

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
        return await _adapter(http).identify("example-bearer-value", {})


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


# ── The hour after each sign-in ──────────────────────────────────────────────


async def _signed_in(session_factory, *, expires_in: float):
    """A broker over the shipped catalog, and an agent granted a Sentry
    connection whose first token has `expires_in` seconds left."""
    vendor = FakeVendor()
    vendor.pass_through = True
    vendor.revocable = False
    # Sentry's tokenExchangeCallback: a refreshed token lives as long as the
    # person's 30-day Sentry token has left.
    vendor.refreshed_lifetime = timedelta(days=29, hours=23)
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={"sentry": vendor},
        organization_apps=None,
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
        allow_non_expiring_keys=False,
    )
    async with session_factory() as session:
        owner = await _user(session, "ada")
        agent = await add_agent(session, name="triager", owner_id=owner.id)
        await STORE.save_connection(
            session,
            user_id=owner.id,
            service="sentry",
            consent="write",
            granted_scopes=SCOPES,
            account_id="123",
            external_identity="ada@example.test",
            encrypted_secret=TEST_KEYRING.encrypt(
                json.dumps(
                    {
                        "access_token": "sentry_access_0",
                        "expires_at": time.time() + expires_in,
                        "refresh_token": "sentry_refresh_0",
                    }
                )
            ),
            oauth_client_id=None,
            method="oauth",
            choices={},
        )
        await STORE.save_grant(
            session,
            agent_id=agent.id,
            owner_id=owner.id,
            service="sentry",
            access="write",
            tool_mode="deny",
            tools=[],
            resources={},
            account_id="123",
            created_by=owner.id,
        )
        await session.commit()
    return broker, vendor, agent


async def test_the_first_sentry_token_is_handed_to_the_agent(session_factory):
    broker, vendor, agent = await _signed_in(session_factory, expires_in=3600)
    token = await _issue(broker, session_factory, agent.id, service="sentry")
    assert token.token == "sentry_access_0"
    assert vendor.refreshes == 0
    left = (token.expires_at - datetime.now(UTC)).total_seconds()
    assert 3500 < left <= 3600


async def test_a_renewed_sentry_token_is_withheld_and_not_renewed_again(
    session_factory,
):
    """In its last 15 minutes the broker renews the first token. Sentry's
    renewed token outlives the hour, so it is withheld, and a second request
    does not renew (and rotate the refresh token) again."""
    broker, vendor, agent = await _signed_in(session_factory, expires_in=10 * 60)
    refused = await _refused(broker, session_factory, agent.id, service="sentry")
    assert (refused.status_code, refused.code, refused.retryable) == (
        503,
        "internal",
        True,
    )
    assert refused.message == (
        "Sentry's current token lasts longer than an hour, so it is not handed "
        "out until it has less than that left."
    )
    assert vendor.refreshes == 1
    again = await _refused(broker, session_factory, agent.id, service="sentry")
    assert again.status_code == 503
    assert vendor.refreshes == 1
    assert await _issuances(session_factory) == []


# ── Signing in ───────────────────────────────────────────────────────────────


async def test_a_sentry_flow_cannot_fall_back_to_read_consent(session_factory):
    async with session_factory() as session:
        owner = await _user(session, "sentry-owner")
        await session.commit()
    flows = ServiceFlows(None, {}, SignInFlows(session_factory, TEST_KEYRING))
    flow = await flows.start(
        definition=SENTRY,
        tenant_id=TENANT_ZERO_ID,
        user_id=owner.id,
        state="synthetic-sentry-state",
        port=39231,
        completion_secret="synthetic-completion",
        owner_label="sentry-owner",
        choices={},
    )
    details = flow.stored.details
    assert (details["consent"], details["scopes"]) == ("write", SCOPES)

    def consent(scopes: list[str]) -> str:
        return flows.consent(
            Exchange(
                flow.stored,
                SignIn(ConnectionSecret({}), scopes, "synthetic-client"),
                Identity("123", "ada@example.test"),
                {},
            )
        )

    assert consent(SCOPES) == "write"
    # The read level lists the same scopes, so a partial grant is refused
    # rather than kept as a read connection whose token can still write.
    for partial in ([], ["org:read"], SCOPES[:-1]):
        with pytest.raises(FlowError, match="granted less"):
            consent(partial)


async def test_sentry_discovery_sign_in_identity_refresh_and_revocation(
    monkeypatch,
):
    """The shipped entry through a whole sign-in, against Sentry's MCP server
    and its OAuth endpoints."""
    origin = "https://mcp.sentry.dev"
    metadata = {
        "issuer": origin,
        "authorization_endpoint": f"{origin}/oauth/authorize",
        "token_endpoint": f"{origin}/oauth/token",
        "registration_endpoint": f"{origin}/oauth/register",
        "revocation_endpoint": f"{origin}/oauth/token",
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }
    challenge = s256("synthetic-verifier")
    mcp = _SentryMcp(
        WHOAMI_TOOL, _whoami({"id": "123", "name": None, "email": "ada@example.test"})
    )
    token_requests: list[dict[str, str]] = []
    bearers: set[str] = set()

    def handle(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == MCP_URL and "authorization" not in request.headers:
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": f'Bearer resource_metadata="{origin}/.well-known/oauth-protected-resource/mcp"'
                },
            )
        if url == MCP_URL:
            bearers.add(request.headers["authorization"])
            return mcp(request)
        if url == f"{origin}/.well-known/oauth-protected-resource/mcp":
            return httpx.Response(
                200, json={"resource": MCP_URL, "authorization_servers": [origin]}
            )
        if url == f"{origin}/.well-known/oauth-authorization-server":
            return httpx.Response(200, json=metadata)
        assert url == f"{origin}/oauth/token"
        form = {
            key: values[0] for key, values in parse_qs(request.content.decode()).items()
        }
        token_requests.append(form)
        if "token" in form:
            return httpx.Response(200)
        assert form["resource"] == MCP_URL
        if form["grant_type"] == "authorization_code":
            assert s256(form["code_verifier"]) == challenge
            access, refresh, expires_in = "SYNTHETIC", "SYNTHETIC-REFRESH-1", 3600
        else:
            assert form["refresh_token"] == "SYNTHETIC-REFRESH-1"
            # tokenExchangeCallback: what is left of the 30-day Sentry token.
            access, refresh = "SYNTHETIC-RENEWED", "SYNTHETIC-REFRESH-2"
            expires_in = int(timedelta(days=29, hours=23).total_seconds())
        return httpx.Response(
            200,
            json={
                "access_token": access,
                "refresh_token": refresh,
                "expires_in": expires_in,
                "token_type": "Bearer",
                "scope": " ".join(SCOPES),
            },
        )

    def transport(policy, **kw):
        return httpx.MockTransport(handle)

    # The adapter's own client, and the client its MCP identity call opens.
    monkeypatch.setattr(outbound, "guarded_transport", transport)
    monkeypatch.setattr(oauth, "guarded_transport", transport)
    redirect = "http://127.0.0.1:39231/switch-services/callback"
    async with guarded_async_client(OutboundPolicy.parse("")) as http:
        adapter = _adapter(http)
        authorization = await adapter.authorization_url(
            redirect_uri=redirect,
            state="synthetic-state",
            code_challenge=challenge,
            scopes=SCOPES,
            choices={},
        )
        query = parse_qs(urlsplit(authorization).query)
        assert query["scope"] == [" ".join(SCOPES)]
        assert query["code_challenge_method"] == ["S256"]
        assert query["resource"] == [MCP_URL]
        signed_in = await adapter.exchange_code(
            code="synthetic-code",
            verifier="synthetic-verifier",
            redirect_uri=redirect,
            scopes=SCOPES,
            choices={},
        )
        assert signed_in.granted_scopes == SCOPES
        identity = await adapter.identify(signed_in.secret.access_token or "", {})
        assert (identity.account_id, identity.label) == ("123", "ada@example.test")
        renewed = await adapter.refresh(signed_in.secret)
        assert renewed.access_token == "SYNTHETIC-RENEWED"
        assert renewed.values["refresh_token"] == "SYNTHETIC-REFRESH-2"
        # The renewed token lasts about 30 days: why the broker withholds it.
        assert (
            renewed.values["expires_at"] - time.time()
            > timedelta(days=29).total_seconds()
        )
        await adapter.revoke_connection(renewed)
    assert bearers == {"Bearer SYNTHETIC"}
    assert [form.get("grant_type") for form in token_requests] == [
        "authorization_code",
        "refresh_token",
        None,
    ]
    assert (token_requests[-1]["token"], token_requests[-1]["token_type_hint"]) == (
        "SYNTHETIC-REFRESH-2",
        "refresh_token",
    )

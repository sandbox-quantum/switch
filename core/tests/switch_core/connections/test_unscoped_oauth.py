"""Unscoped OAuth consent and protected resource discovery regressions."""

from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import yaml
from pydantic import ValidationError

from switch_core.connections.adapters import ConnectionSecret, ServiceAdapterError
from switch_core.connections.adapters.oauth import Identity, OAuthAdapter, SignIn
from switch_core.connections.flows import Exchange, FlowError, ServiceFlows
from switch_core.connections.loader import ConnectionAccess, ConnectionDefinition
from switch_core.connections.sign_in_flows import SignInFlows, StoredFlow
from tests.switch_core.connections.adapters.test_oauth import REDIRECT, STATIC, _adapter
from tests.switch_core.connections.fake_vendor import FakeOAuthServer


def _definition(unscoped=True):
    body = yaml.safe_load(STATIC)
    if unscoped:
        body["access"] = {
            "unscoped": True,
            "read": {"scopes": []},
            "write": {"scopes": []},
        }
    return ConnectionDefinition.model_validate(body)


@pytest.mark.parametrize(
    "access",
    [
        {"read": {"scopes": []}},
        {"read": {"scopes": ["read"]}, "write": {"scopes": []}},
        {"unscoped": True, "read": {"scopes": []}},
        {"unscoped": True, "read": {"scopes": []}, "write": {"scopes": ["write"]}},
        {
            "unscoped": True,
            "read": {"permissions": {"contents": "read"}},
            "write": {"scopes": []},
        },
    ],
)
def test_empty_scopes_require_explicit_unscoped_read_and_write(access):
    with pytest.raises(ValidationError):
        ConnectionAccess.model_validate(access)


@pytest.mark.parametrize("unscoped", [False, True])
async def test_authorization_scope_is_omitted_only_for_explicit_unscoped_access(
    unscoped,
):
    vendor = FakeOAuthServer()
    existing, http = _adapter(vendor)
    async with http:
        adapter = OAuthAdapter(_definition(unscoped), existing._client, http)
        scopes = [] if unscoped else ["read:items", "write:items"]
        url = await adapter.authorization_url(
            redirect_uri=REDIRECT,
            state="example-state",
            code_challenge="example-challenge",
            scopes=scopes,
        )
        query = parse_qs(urlsplit(url).query, keep_blank_values=True)
        assert query["code_challenge_method"] == ["S256"]
        if unscoped:
            assert "scope" not in query
        else:
            assert query["scope"] == ["read:items write:items"]


@pytest.mark.parametrize(
    "resource",
    [
        "https://mcp.example.test",
        "http://mcp.example.test",
        "file:///tmp/resource",
        "https://",
        "https://user:pass@mcp.example.test",
        None,
    ],
)
async def test_discovery_uses_and_validates_advertised_resource(resource):
    vendor = FakeOAuthServer()
    existing, original_http = _adapter(vendor)
    async with original_http:

        async def respond(request):
            response = await original_http.send(request)
            if request.url.path == vendor.resource_metadata_path:
                return httpx.Response(
                    200, json={**response.json(), "resource": resource}
                )
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            adapter = OAuthAdapter(_definition(), existing._client, http)
            if resource == "https://mcp.example.test":
                endpoints = await adapter.endpoints()
                assert endpoints.resource == resource
                url = await adapter.authorization_url(
                    redirect_uri=REDIRECT,
                    state="example-state",
                    code_challenge="example-challenge",
                    scopes=[],
                )
                assert parse_qs(urlsplit(url).query)["resource"] == [resource]
            else:
                with pytest.raises(ServiceAdapterError, match="resource identifier"):
                    await adapter.endpoints()


async def test_unscoped_sign_in_records_explicit_consent_without_invented_scopes():
    stored = Mock(spec=StoredFlow)
    repository = Mock(spec=SignInFlows)
    repository.start = AsyncMock(return_value=stored)
    flows = ServiceFlows(None, repository)
    await flows.start(
        definition=_definition(),
        tenant_id="example-tenant",
        user_id="example-user",
        state="example-state",
        port=43123,
        completion_secret="example-completion",
        owner_label="Example owner",
    )
    details = repository.start.call_args.kwargs["details"]
    assert details["unscoped"] is True
    assert details["consent"] == "write"
    assert details["scopes"] == details["read_scopes"] == details["write_scopes"] == []


@pytest.mark.parametrize(
    "unscoped,granted,expected",
    [
        (True, [], "write"),
        (False, ["read:items"], "read"),
        (False, ["read:items", "write:items"], "write"),
        (False, [], None),
    ],
)
def test_consent_does_not_mistake_empty_scopes_for_read_only(
    unscoped, granted, expected
):
    stored = Mock(spec=StoredFlow)
    stored.details = {
        "name": "Example",
        "unscoped": unscoped,
        "read_scopes": [] if unscoped else ["read:items"],
        "write_scopes": [] if unscoped else ["read:items", "write:items"],
    }
    exchange = Exchange(
        stored,
        SignIn(ConnectionSecret({}), granted, "example-client"),
        Identity("example-account", "Example"),
    )
    flows = ServiceFlows(None, Mock(spec=SignInFlows))
    if expected is None:
        with pytest.raises(FlowError):
            flows.consent(exchange)
    else:
        assert flows.consent(exchange) == expected

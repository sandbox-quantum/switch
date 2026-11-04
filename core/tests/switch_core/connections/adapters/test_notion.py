"""Notion's documented introspection contract; no live credentials or calls."""

import base64
from urllib.parse import parse_qs, quote

import httpx
import pytest
from pydantic import ValidationError

from switch_core.connections.adapters import (
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.adapters.oauth import (
    AuthorizationEndpoints,
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import CATALOG, ConnectionIdentity


@pytest.mark.parametrize(
    "method", ["none", "client_secret_basic", "client_secret_post"]
)
async def test_introspection_reuses_client_auth_and_never_puts_the_token_in_the_url(
    method,
):
    seen = []

    def receive(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "active": True,
                "client_id": "client-placeholder",
                "workspace_id": "workspace-placeholder",
                "user_id": "user-placeholder",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
        credentials = OAuthClientCredentials(
            "client-placeholder",
            None if method == "none" else "client-secret-placeholder",
            authentication=None if method == "none" else method,
        )
        adapter = OAuthAdapter(
            CATALOG["notion"].definition, StaticClient(credentials), http
        )
        adapter._endpoints = AuthorizationEndpoints(
            authorization="https://mcp.notion.com/authorize",
            token="https://mcp.notion.com/token",
            registration=None,
            revocation=None,
            resource="https://mcp.notion.com/mcp",
            client_authentication="client_secret_post" if method == "none" else method,
            introspection="https://mcp.notion.com/introspect",
        )
        identity = await adapter.identify("access-token-placeholder")
    assert identity.account_id == "workspace-placeholder:user-placeholder"
    assert identity.label == "workspace-placeholder"
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "https://mcp.notion.com/introspect"
    fields = parse_qs(request.content.decode())
    assert fields["token"] == ["access-token-placeholder"]
    assert fields["client_id"] == ["client-placeholder"]
    assert "application/x-www-form-urlencoded" in request.headers["content-type"]
    if method == "client_secret_basic":
        assert (
            base64.b64decode(request.headers["authorization"].split()[1]).decode()
            == "client-placeholder:client-secret-placeholder"
        )
        assert "client_secret" not in fields
    else:
        assert "authorization" not in request.headers
        assert ("client_secret" in fields) == (method == "client_secret_post")


async def identify(body, status=200):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(status, json=body))
    ) as http:
        adapter = OAuthAdapter(
            CATALOG["notion"].definition,
            StaticClient(
                OAuthClientCredentials("client-placeholder", None, authentication=None)
            ),
            http,
        )
        adapter._endpoints = AuthorizationEndpoints(
            authorization="https://mcp.notion.com/authorize",
            token="https://mcp.notion.com/token",
            registration=None,
            revocation=None,
            resource=None,
            client_authentication="client_secret_post",
            introspection="https://mcp.notion.com/introspect",
        )
        return await adapter.identify("access-token-placeholder")


@pytest.mark.parametrize(
    "body,error",
    [
        ({"active": False}, ReauthorizationRequiredError),
        ({"active": "true"}, ServiceAdapterError),
        ({"active": 1}, ServiceAdapterError),
        ({}, ServiceAdapterError),
        (
            {
                "active": True,
                "client_id": "another-client",
                "workspace_id": "workspace",
                "user_id": "user",
            },
            ReauthorizationRequiredError,
        ),
        ({"active": True, "user_id": "user"}, ServiceAdapterError),
        ({"active": True, "workspace_id": "workspace"}, ServiceAdapterError),
        ({"active": True, "workspace_id": "", "user_id": "user"}, ServiceAdapterError),
        ({"active": True, "workspace_id": " ", "user_id": "user"}, ServiceAdapterError),
        (
            {"active": True, "workspace_id": True, "user_id": "user"},
            ServiceAdapterError,
        ),
        ({"active": True, "workspace_id": [], "user_id": "user"}, ServiceAdapterError),
        (
            {"active": True, "workspace_id": "workspace", "user_id": None},
            ServiceAdapterError,
        ),
    ],
)
async def test_unverified_or_incomplete_identities_cannot_connect(body, error):
    with pytest.raises(error):
        await identify(body)


async def test_composite_identity_distinguishes_people_workspaces_and_delimiters():
    pairs = [
        ("workspace", "user-one"),
        ("workspace", "user-two"),
        ("other-workspace", "user-one"),
        ("a:b", "c"),
        ("a", "b:c"),
        ("a%3Ab", "c"),
        ("workspace/one", "person with spaces"),
        (123, 456),
    ]
    identities = [
        await identify({"active": True, "workspace_id": workspace, "user_id": user})
        for workspace, user in pairs
    ]
    assert len({identity.account_id for identity in identities}) == len(pairs)
    assert [identity.account_id for identity in identities] == [
        f"{quote(str(workspace), safe='')}:{quote(str(user), safe='')}"
        for workspace, user in pairs
    ]


async def test_identity_errors_never_echo_provider_response_secrets():
    with pytest.raises(ServiceAdapterError) as error:
        await identify({"error": "private-response-placeholder"}, status=403)
    assert "private-response-placeholder" not in str(error.value)


@pytest.mark.parametrize("paths", [[], ["id"] * 9, ["id", "bad/path"]])
def test_bad_composite_identity_configuration_is_refused(paths):
    with pytest.raises(ValidationError):
        ConnectionIdentity(
            url="https://example.invalid/me", account_id=paths, label="id"
        )


def test_existing_get_identity_configuration_remains_the_default():
    definition = ConnectionIdentity(
        url="https://example.invalid/me", account_id="id", label="name"
    )
    assert definition.method == "GET"
    assert definition.account_id == "id"


@pytest.mark.parametrize(
    "values",
    [
        {"method": "GET"},
        {"method": "introspection", "url": "https://example.invalid/me"},
    ],
)
def test_identity_cannot_bypass_discovery_with_a_catalog_url(values):
    with pytest.raises(ValidationError):
        ConnectionIdentity(
            **values, account_id=["workspace_id", "user_id"], label="name"
        )


@pytest.mark.parametrize(
    "endpoint",
    [None, "", "http://example.invalid/introspect", 42],
)
async def test_missing_or_invalid_advertisement_prevents_identification(endpoint):
    calls = []

    def receive(request):
        calls.append(request)
        if request.method == "POST":
            assert str(request.url) == "https://mcp.notion.com/mcp"
            return httpx.Response(401)
        if "oauth-protected-resource" in request.url.path:
            return httpx.Response(
                200, json={"authorization_servers": ["https://auth.example.test"]}
            )
        metadata = {
            "authorization_endpoint": "https://auth.example.test/authorize",
            "token_endpoint": "https://auth.example.test/token",
            "code_challenge_methods_supported": ["S256"],
        }
        if endpoint is not None:
            metadata["introspection_endpoint"] = endpoint
        return httpx.Response(200, json=metadata)

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
        adapter = OAuthAdapter(
            CATALOG["notion"].definition,
            StaticClient(OAuthClientCredentials("client-placeholder", None, None)),
            http,
        )
        with pytest.raises(ServiceAdapterError, match="introspection"):
            await adapter.identify("access-token-placeholder")
        assert adapter._endpoints is None
    assert all(b"access-token-placeholder" not in request.content for request in calls)


async def test_introspection_uses_the_advertised_endpoint_and_authentication():
    calls = []
    endpoint = "https://auth.example.test/advertised-token-check"

    def receive(request):
        calls.append(request)
        if str(request.url) == endpoint:
            return httpx.Response(
                200,
                json={"active": True, "workspace_id": "workspace", "user_id": "user"},
            )
        if request.method == "POST":
            assert str(request.url) == "https://mcp.notion.com/mcp"
            return httpx.Response(401)
        if "oauth-protected-resource" in request.url.path:
            return httpx.Response(
                200, json={"authorization_servers": ["https://auth.example.test"]}
            )
        return httpx.Response(
            200,
            json={
                "authorization_endpoint": "https://auth.example.test/authorize",
                "token_endpoint": "https://auth.example.test/token",
                "code_challenge_methods_supported": ["S256"],
                "introspection_endpoint": endpoint,
                "token_endpoint_auth_methods_supported": ["client_secret_basic"],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
        adapter = OAuthAdapter(
            CATALOG["notion"].definition,
            StaticClient(
                OAuthClientCredentials(
                    "client-placeholder", "client-secret-placeholder", None
                )
            ),
            http,
        )
        identity = await adapter.identify("access-token-placeholder")
    assert identity.account_id == "workspace:user"
    request = calls[-1]
    assert str(request.url) == endpoint
    assert request.headers["authorization"].startswith("Basic ")
    assert parse_qs(request.content.decode()) == {
        "token": ["access-token-placeholder"],
        "client_id": ["client-placeholder"],
    }

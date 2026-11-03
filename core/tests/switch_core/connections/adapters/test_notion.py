"""Notion's documented introspection contract; no live credentials or calls."""

import base64
import json
from urllib.parse import parse_qs

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
        )
        identity = await adapter.identify("access-token-placeholder")
    assert json.loads(identity.account_id) == [
        "workspace-placeholder",
        "user-placeholder",
    ]
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
    ]
    identities = [
        await identify({"active": True, "workspace_id": workspace, "user_id": user})
        for workspace, user in pairs
    ]
    assert len({identity.account_id for identity in identities}) == len(pairs)


async def test_identity_errors_never_echo_provider_response_secrets():
    with pytest.raises(ServiceAdapterError) as error:
        await identify({"error": "private-response-placeholder"}, status=403)
    assert "private-response-placeholder" not in str(error.value)


@pytest.mark.parametrize("paths", [["id"], ["id", "id"], ["id", "bad/path"]])
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

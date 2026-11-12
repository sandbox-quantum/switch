"""The shipped GitLab definition against synthetic HTTP responses.

These tests exercise Switch's requests and error handling, not GitLab's
authorization policy or a live OAuth/MCP integration.
"""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from pydantic import ValidationError

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
    s256,
)
from switch_core.connections.loader import CATALOG, ConnectionDefinition

ORIGIN = "https://gitlab.com"
MCP = f"{ORIGIN}/api/v4/mcp"
CALLBACK = (
    "https://switch.example.test/gateway/service-connections/gitlab/flows/callback"
)
DEFINITION = CATALOG["gitlab"].definition


def test_gitlab_static_configuration_cannot_drop_the_client_settings():
    document = DEFINITION.model_dump()
    del document["auth"]["oauth"]["client_settings"]
    with pytest.raises(ValidationError, match="client_settings"):
        ConnectionDefinition.model_validate(document)


@pytest.mark.parametrize("level", ["read", "write"])
async def test_gitlab_sign_in_identity_rotation_and_disconnect(level):
    assert DEFINITION.access is not None
    access = getattr(DEFINITION.access, level)
    scopes = access.scopes
    requests = []
    renewals = 0

    def vendor(request: httpx.Request) -> httpx.Response:
        nonlocal renewals
        requests.append(request)
        if request.url.path == "/api/v4/mcp":
            return httpx.Response(401)
        if request.url.path == "/.well-known/oauth-protected-resource/api/v4/mcp":
            return httpx.Response(
                200, json={"resource": MCP, "authorization_servers": [ORIGIN]}
            )
        if request.url.path == "/.well-known/oauth-authorization-server":
            return httpx.Response(
                200,
                json={
                    "authorization_endpoint": f"{ORIGIN}/oauth/authorize",
                    "token_endpoint": f"{ORIGIN}/oauth/token",
                    "revocation_endpoint": f"{ORIGIN}/oauth/revoke",
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["client_secret_post"],
                },
            )
        if request.url.path == "/oauth/token":
            form = parse_qs(request.content.decode())
            assert form["client_id"] == ["synthetic-client"]
            assert form["client_secret"] == ["synthetic-secret"]
            if form["grant_type"] == ["authorization_code"]:
                assert form["code_verifier"] == ["v" * 64]
                assert form["redirect_uri"] == [CALLBACK]
                assert form["code"] == ["synthetic-code"]
            else:
                assert form["grant_type"] == ["refresh_token"]
                assert form["refresh_token"] == [f"synthetic-refresh-{renewals}"]
                renewals += 1
            return httpx.Response(
                200,
                json={
                    "access_token": f"synthetic-access-{renewals}",
                    "refresh_token": f"synthetic-refresh-{renewals}",
                    "token_type": "Bearer",
                    "expires_in": 7200,
                    "scope": " ".join(scopes),
                },
            )
        if request.url.path == "/api/v4/user":
            assert request.headers["Authorization"] == "Bearer synthetic-access-0"
            return httpx.Response(200, json={"id": 42, "username": "example-user"})
        if request.url.path == "/oauth/revoke":
            form = parse_qs(request.content.decode())
            assert form["token"] == ["synthetic-refresh-2"]
            assert form["token_type_hint"] == ["refresh_token"]
            assert form["client_secret"] == ["synthetic-secret"]
            return httpx.Response(200)
        pytest.fail(f"Unexpected vendor request: {request.method} {request.url.path}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor)) as http:
        adapter = OAuthAdapter(
            DEFINITION,
            StaticClient(
                OAuthClientCredentials(
                    "synthetic-client", "synthetic-secret", authentication=None
                )
            ),
            http,
        )
        url = await adapter.authorization_url(
            redirect_uri=CALLBACK,
            state="synthetic-state",
            code_challenge=s256("v" * 64),
            scopes=scopes,
        )
        parsed = urlsplit(url)
        assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == (
            f"{ORIGIN}/oauth/authorize"
        )
        query = parse_qs(parsed.query)
        assert query["code_challenge_method"] == ["S256"]
        assert query["code_challenge"] == [s256("v" * 64)]
        assert query["state"] == ["synthetic-state"]
        assert query["redirect_uri"] == [CALLBACK]
        assert set(query["scope"][0].split()) == set(scopes)
        assert "client_secret" not in query
        signed_in = await adapter.exchange_code(
            code="synthetic-code",
            verifier="v" * 64,
            redirect_uri=CALLBACK,
            scopes=scopes,
        )
        assert signed_in.client_id == "synthetic-client"
        assert signed_in.granted_scopes == scopes
        identity = await adapter.identify(signed_in.secret.access_token)
        assert (identity.account_id, identity.label) == ("42", "example-user")
        secret = signed_in.secret
        for generation in (1, 2):
            secret = await adapter.refresh(secret)
            assert secret.access_token == f"synthetic-access-{generation}"
            assert secret.values["refresh_token"] == f"synthetic-refresh-{generation}"
        await adapter.revoke_connection(secret)
    assert not any(request.url.path == "/oauth/register" for request in requests)


@pytest.mark.parametrize("failure", ["no_s256", "no_refresh", "no_identity"])
async def test_gitlab_refuses_incomplete_authentication(failure):
    def vendor(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v4/mcp":
            return httpx.Response(401)
        if "oauth-protected-resource" in request.url.path:
            return httpx.Response(200, json={"authorization_servers": [ORIGIN]})
        if request.url.path == "/.well-known/oauth-authorization-server":
            return httpx.Response(
                200,
                json={
                    "authorization_endpoint": f"{ORIGIN}/oauth/authorize",
                    "token_endpoint": f"{ORIGIN}/oauth/token",
                    "code_challenge_methods_supported": (
                        ["plain"] if failure == "no_s256" else ["S256"]
                    ),
                },
            )
        if request.url.path == "/oauth/token":
            return httpx.Response(
                200,
                json={
                    "access_token": "synthetic-access",
                    "expires_in": 7200,
                    **(
                        {}
                        if failure == "no_refresh"
                        else {"refresh_token": "synthetic-refresh"}
                    ),
                },
            )
        if request.url.path == "/api/v4/user":
            return httpx.Response(200, json={"username": "example-user"})
        pytest.fail(f"Unexpected vendor path: {request.url.path}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor)) as http:
        adapter = OAuthAdapter(
            DEFINITION,
            StaticClient(
                OAuthClientCredentials(
                    "synthetic-client", "synthetic-secret", authentication=None
                )
            ),
            http,
        )
        message = {
            "no_s256": "S256",
            "no_refresh": "no refresh token",
            "no_identity": "account's id",
        }[failure]
        with pytest.raises(ServiceAdapterError, match=message):
            if failure == "no_identity":
                await adapter.identify("synthetic-access")
            else:
                await adapter.exchange_code(
                    code="synthetic-code",
                    verifier="v" * 64,
                    redirect_uri=CALLBACK,
                    scopes=["mcp", "read_api", "read_user"],
                )

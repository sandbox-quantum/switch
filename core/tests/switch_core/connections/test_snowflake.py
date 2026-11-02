from __future__ import annotations

from urllib.parse import urlsplit

import httpx
import pytest

from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    ServiceAdapterError,
    StaticClient,
)
from switch_core.connections.loader import CATALOG
from switch_core.connections.snowflake import validate_mcp_endpoint

ENDPOINT = (
    "https://account.snowflakecomputing.com/api/v2/databases/DATABASE/"
    "schemas/SCHEMA/mcp-servers/SERVER"
)
ORIGIN = "https://account.snowflakecomputing.com"
PRIVATE_ENDPOINT = ENDPOINT.replace(
    "account.snowflakecomputing.com", "account.privatelink.snowflakecomputing.com"
)
PRIVATE_ORIGIN = ORIGIN.replace(
    "account.snowflakecomputing.com", "account.privatelink.snowflakecomputing.com"
)


@pytest.mark.parametrize(
    "endpoint",
    [
        ENDPOINT,
        ENDPOINT.replace(
            "account.snowflakecomputing.com",
            "account.privatelink.snowflakecomputing.com",
        ),
        ENDPOINT.replace(
            "account.snowflakecomputing.com",
            "account.snowflakecomputing.cn",
        ),
    ],
)
def test_accepts_snowflake_mcp_endpoints(endpoint: str) -> None:
    assert validate_mcp_endpoint(endpoint) == endpoint


@pytest.mark.parametrize(
    "endpoint",
    [
        ENDPOINT.replace("https://", "http://"),
        ENDPOINT.replace("account.snowflakecomputing.com", "attacker.example"),
        ENDPOINT.replace("https://", "https://user:password@"),
        ENDPOINT.replace("snowflakecomputing.com/", "snowflakecomputing.com:8443/"),
        ENDPOINT.replace("snowflakecomputing.com/", "snowflakecomputing.com:/"),
        ENDPOINT + "?redirect=https://attacker.example",
        ENDPOINT + "#fragment",
        ENDPOINT.replace("/api/v2/", "/api/v1/"),
        ENDPOINT.replace("/DATABASE/", "/%2fother/"),
        ENDPOINT.replace("/SERVER", "/../SERVER"),
        ENDPOINT.replace("/api/v2/", "///api/v2/"),
        " " + ENDPOINT,
    ],
)
def test_rejects_non_snowflake_or_malformed_endpoints(endpoint: str) -> None:
    with pytest.raises(ValueError):
        validate_mcp_endpoint(endpoint)


def _adapter(http: httpx.AsyncClient) -> OAuthAdapter:
    return OAuthAdapter(
        CATALOG["snowflake"].definition,
        StaticClient(OAuthClientCredentials("client-id", None, None)),
        http,
    )


def _metadata_response(request: httpx.Request) -> httpx.Response:
    if request.method == "POST":
        return httpx.Response(
            401,
            headers={
                "WWW-Authenticate": (
                    f'Bearer resource_metadata="{ORIGIN}/.well-known/'
                    'oauth-protected-resource"'
                )
            },
        )
    if request.url.path == "/.well-known/oauth-protected-resource":
        return httpx.Response(
            200, json={"authorization_servers": [ORIGIN], "resource": ENDPOINT}
        )
    if request.url.path == "/.well-known/oauth-authorization-server":
        return httpx.Response(
            200,
            json={
                "authorization_endpoint": f"{ORIGIN}/oauth/authorize",
                "token_endpoint": f"{ORIGIN}/oauth/token-request",
                "revocation_endpoint": f"{ORIGIN}/oauth/revoke-token",
                "userinfo_endpoint": f"{ORIGIN}/oauth/userinfo",
                "code_challenge_methods_supported": ["S256"],
            },
        )
    return httpx.Response(404)


async def test_discovers_account_scoped_oauth_endpoints() -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_metadata_response)
    ) as http:
        endpoints = await _adapter(http).for_mcp_endpoint(ENDPOINT).endpoints()

    assert endpoints.resource == ENDPOINT
    assert endpoints.authorization == f"{ORIGIN}/oauth/authorize"
    assert endpoints.token == f"{ORIGIN}/oauth/token-request"
    assert endpoints.userinfo == f"{ORIGIN}/oauth/userinfo"


async def test_accepts_the_public_oauth_host_paired_with_a_private_link_endpoint() -> (
    None
):
    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": (
                        f'Bearer resource_metadata="{PRIVATE_ORIGIN}/.well-known/'
                        'oauth-protected-resource"'
                    )
                },
            )
        if request.url.host == "account.privatelink.snowflakecomputing.com":
            return httpx.Response(
                200,
                json={
                    "authorization_servers": [ORIGIN],
                    "resource": PRIVATE_ENDPOINT,
                },
            )
        if request.url.host == "account.snowflakecomputing.com":
            return httpx.Response(
                200,
                json={
                    "authorization_endpoint": f"{ORIGIN}/oauth/authorize",
                    "token_endpoint": f"{ORIGIN}/oauth/token-request",
                    "code_challenge_methods_supported": ["S256"],
                },
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        endpoints = await _adapter(http).for_mcp_endpoint(PRIVATE_ENDPOINT).endpoints()

    assert endpoints.resource == PRIVATE_ENDPOINT
    assert endpoints.authorization == f"{ORIGIN}/oauth/authorize"
    assert endpoints.token == f"{ORIGIN}/oauth/token-request"


async def test_does_not_send_the_static_client_secret_to_a_different_host() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return _metadata_response(request)
        if request.url.path == "/.well-known/oauth-protected-resource":
            return httpx.Response(
                200,
                json={"authorization_servers": ["https://attacker.example"]},
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        with pytest.raises(
            ServiceAdapterError, match="not on its Snowflake account host"
        ):
            await _adapter(http).for_mcp_endpoint(ENDPOINT).endpoints()

    assert all(
        urlsplit(str(request.url)).hostname != "attacker.example"
        for request in requests
    )


async def test_rejects_malformed_port_in_discovered_authorization_server() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return _metadata_response(request)
        if request.url.path == "/.well-known/oauth-protected-resource":
            return httpx.Response(
                200,
                json={
                    "authorization_servers": [f"{ORIGIN}:not-a-port"],
                    "resource": ENDPOINT,
                },
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        with pytest.raises(
            ServiceAdapterError, match="authorization server is not on its Snowflake"
        ):
            await _adapter(http).for_mcp_endpoint(ENDPOINT).endpoints()

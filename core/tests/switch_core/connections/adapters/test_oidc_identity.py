"""OIDC identity uses signed claims bound to this authorization flow."""

import json
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
    s256,
)
from switch_core.connections.loader import CATALOG

ISSUER = "https://mcp.linear.app"
RESOURCE = ISSUER + "/mcp"
CLIENT = "example-client"
VERIFIER = "example-verifier"


@pytest.fixture
def oidc_server():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
    jwk.update({"kid": "test-key", "alg": "RS256", "use": "sig"})
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": CLIENT,
        "sub": "example-user",
        "email": "user@example.test",
        "exp": now + 300,
        "iat": now,
        "nonce": s256("oidc:" + VERIFIER),
    }
    state = {
        "claims": claims,
        "key": private,
        "jwk": jwk,
        "header": {"kid": "test-key"},
        "metadata_issuer": ISSUER,
        "resource_issuer": ISSUER,
        "requests": [],
    }

    def handler(request):
        state["requests"].append(request)
        if request.url.path == "/mcp":
            return httpx.Response(
                401,
                headers={
                    "www-authenticate": f'Bearer resource_metadata="{ISSUER}/.well-known/resource"'
                },
            )
        if request.url.path == "/.well-known/resource":
            return httpx.Response(
                200, json={"authorization_servers": [state["resource_issuer"]]}
            )
        if request.url.path == "/.well-known/openid-configuration":
            return httpx.Response(
                200,
                json={
                    "issuer": state["metadata_issuer"],
                    "authorization_endpoint": ISSUER + "/authorize",
                    "token_endpoint": ISSUER + "/token",
                    "registration_endpoint": ISSUER + "/register",
                    "revocation_endpoint": ISSUER + "/revoke",
                    "code_challenge_methods_supported": ["S256"],
                    "jwks_uri": ISSUER + "/jwks",
                },
            )
        if request.url.path == "/jwks":
            return httpx.Response(200, json={"keys": [state["jwk"]]})
        if request.url.path == "/token":
            token = jwt.encode(
                state["claims"],
                state["key"],
                algorithm="RS256",
                headers=state["header"],
            )
            return httpx.Response(
                200,
                json={
                    "access_token": "SYNTHETIC-ACCESS",
                    "refresh_token": "SYNTHETIC-REFRESH",
                    "expires_in": 3600,
                    "scope": state.get("scope", "read openid email"),
                    "id_token": None if state.get("missing_token") else token,
                },
            )
        raise AssertionError(request.url)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = OAuthAdapter(
        CATALOG["linear"].definition,
        StaticClient(OAuthClientCredentials(CLIENT, None, None)),
        http,
    )
    state["adapter"] = adapter
    state["other"] = other
    state["http"] = http
    return state


async def exchange(state):
    return await state["adapter"].exchange_code(
        code="code",
        verifier=VERIFIER,
        redirect_uri="http://127.0.0.1/callback",
        scopes=["read", "openid", "email"],
    )


async def test_signed_identity_and_resource_are_bound_to_signin(oidc_server):
    state = oidc_server
    url = await state["adapter"].authorization_url(
        redirect_uri="http://127.0.0.1/callback",
        state="state",
        code_challenge=s256(VERIFIER),
        scopes=["read", "openid", "email"],
        oidc_nonce=s256("oidc:" + VERIFIER),
    )
    query = parse_qs(urlsplit(url).query)
    assert query["nonce"] == [s256("oidc:" + VERIFIER)]
    assert query["resource"] == [RESOURCE]
    result = await exchange(state)
    assert (result.identity.account_id, result.identity.label) == (
        "example-user",
        "user@example.test",
    )
    assert result.granted_scopes == ["read", "openid", "email"]
    assert "id_token" not in result.secret.values
    request = next(r for r in state["requests"] if r.url.path == "/token")
    assert parse_qs(request.content.decode())["resource"] == [RESOURCE]
    assert all(r.url.host != "api.linear.app" for r in state["requests"])
    assert (
        sum(
            r.url.path == "/.well-known/openid-configuration" for r in state["requests"]
        )
        == 1
    )


async def test_jwks_is_refetched_while_issuer_metadata_is_cached(oidc_server):
    await exchange(oidc_server)
    rotated = oidc_server["other"]
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(rotated.public_key()))
    jwk.update({"kid": "rotated-key", "alg": "RS256", "use": "sig"})
    oidc_server["jwk"] = jwk
    oidc_server["key"] = rotated
    oidc_server["header"] = {"kid": "rotated-key"}
    await exchange(oidc_server)
    paths = [r.url.path for r in oidc_server["requests"]]
    assert paths.count("/.well-known/openid-configuration") == 1
    assert paths.count("/jwks") == 2


async def test_rejected_issuer_metadata_is_not_cached(oidc_server):
    oidc_server["metadata_issuer"] = "https://wrong.example.test"
    with pytest.raises(ServiceAdapterError):
        await exchange(oidc_server)
    oidc_server["metadata_issuer"] = ISSUER
    assert (await exchange(oidc_server)).identity.account_id == "example-user"
    assert (
        sum(
            r.url.path == "/.well-known/openid-configuration"
            for r in oidc_server["requests"]
        )
        == 2
    )


@pytest.mark.parametrize("issuer_matches", [True, False])
async def test_oidc_metadata_is_verified_with_explicit_endpoints(
    oidc_server, issuer_matches
):
    definition = CATALOG["linear"].definition
    explicit_oauth = definition.auth.oauth.model_copy(
        update={
            "authorization_url": ISSUER + "/authorize",
            "token_url": ISSUER + "/token",
        }
    )
    explicit_auth = definition.auth.model_copy(update={"oauth": explicit_oauth})
    explicit_definition = definition.model_copy(update={"auth": explicit_auth})
    oidc_server["adapter"] = OAuthAdapter(
        explicit_definition,
        StaticClient(OAuthClientCredentials(CLIENT, None, None)),
        oidc_server["http"],
    )
    if issuer_matches:
        assert (await exchange(oidc_server)).identity.account_id == "example-user"
    else:
        oidc_server["metadata_issuer"] = "https://wrong.example.test"
        with pytest.raises(ServiceAdapterError):
            await exchange(oidc_server)
    assert any(
        r.url.path == "/.well-known/openid-configuration"
        for r in oidc_server["requests"]
    )


@pytest.mark.parametrize(
    "case",
    [
        "signature",
        "issuer",
        "audience",
        "expired",
        "future_iat",
        "nonce",
        "subject",
        "kid",
        "azp",
        "metadata_issuer",
        "resource_issuer",
        "missing_token",
    ],
)
async def test_rejects_untrusted_identity(oidc_server, case):
    state = oidc_server
    claims = state["claims"]
    if case == "signature":
        state["key"] = state["other"]
    elif case == "issuer":
        claims["iss"] = "https://wrong.example.test"
    elif case == "audience":
        claims["aud"] = "wrong-client"
    elif case == "expired":
        claims["exp"] = int(time.time()) - 90
    elif case == "future_iat":
        claims["iat"] = int(time.time()) + 3600
    elif case == "nonce":
        claims["nonce"] = "wrong"
    elif case == "subject":
        claims.pop("sub")
    elif case == "kid":
        state["header"]["kid"] = "unknown"
    elif case == "azp":
        claims["aud"] = [CLIENT, "other-client"]
        claims["azp"] = "other-client"
    elif case == "metadata_issuer":
        state["metadata_issuer"] = "https://wrong.example.test"
    elif case == "resource_issuer":
        state["resource_issuer"] = "https://wrong.example.test"
    elif case == "missing_token":
        state["missing_token"] = True
    with pytest.raises(ServiceAdapterError):
        await exchange(state)


@pytest.mark.parametrize("claim", ["exp", "iat", "nbf"])
@pytest.mark.parametrize("within_leeway", [True, False])
async def test_clock_skew_is_bounded(oidc_server, claim, within_leeway):
    now = int(time.time())
    offset = 30 if within_leeway else 90
    oidc_server["claims"][claim] = now + (-offset if claim == "exp" else offset)
    if within_leeway:
        result = await exchange(oidc_server)
        assert result.identity.account_id == "example-user"
    else:
        with pytest.raises(ServiceAdapterError):
            await exchange(oidc_server)


async def test_a_verified_id_token_proves_the_identity_scopes(oidc_server):
    # A token response may list only the vendor's own scopes; the signed ID
    # token is the proof that openid (and email, where it carries one) was
    # granted, so the consent check still sees them.
    state = oidc_server
    state["scope"] = "read"
    result = await exchange(state)
    assert result.granted_scopes == ["read", "openid", "email"]


async def test_an_id_token_without_email_proves_only_openid(oidc_server):
    state = oidc_server
    state["scope"] = "read"
    state["claims"].pop("email")
    result = await exchange(state)
    assert result.granted_scopes == ["read", "openid"]
    assert result.identity.label == "example-user"

"""The generic OAuth/MCP adapter against a fake vendor's HTTP side.

These are the conformance tests a pass-through OAuth vendor's catalog entry
is held to: discovery, sign-in with PKCE, the account's id, refresh as the
vendor rotates or keeps its refresh tokens, a token handed out that the
vendor's MCP server accepts and Switch never revokes, and disconnect. Only
the vendor's HTTP side is faked.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import yaml
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import (
    AccessToken,
    ConnectionSecret,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.adapters.oauth_mcp import (
    OAuthClientCredentials,
    OAuthMcpAdapter,
    StaticClient,
)
from switch_core.connections.broker import Principal, ServiceBroker
from switch_core.connections.loader import ConnectionDefinition
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import (
    IDENTITY_URL,
    ISSUER,
    MCP_URL,
    STATIC_CLIENT_ID,
    STATIC_CLIENT_SECRET,
    FakeOAuthServer,
    s256,
)
from tests.switch_core.connections.test_broker import _user, pass_through_catalog
from tests.switch_core.connections.test_loader import OAUTH_MCP_ENTRY
from tests.switch_core.gateway.agent_route_harness import add_agent

STATIC = OAUTH_MCP_ENTRY.replace(
    "    registration: dynamic\n",
    "    registration: static\n    client_settings: EXAMPLE\n",
)
STORE = ServiceConnectionStore()
REDIRECT = "http://127.0.0.1:43123/callback"


def _definition(text: str = STATIC) -> ConnectionDefinition:
    return ConnectionDefinition.model_validate(yaml.safe_load(text))


def _adapter(
    vendor: FakeOAuthServer, text: str = STATIC
) -> tuple[OAuthMcpAdapter, httpx.AsyncClient]:
    http = vendor.client()
    client = StaticClient(
        OAuthClientCredentials(STATIC_CLIENT_ID, STATIC_CLIENT_SECRET)
    )
    return OAuthMcpAdapter(_definition(text), client, http), http


def _request(resources: dict | None = None) -> IssueRequest:
    return IssueRequest(
        service="example",
        access="write",
        reach={"scopes": ["read:items", "write:items"]},
        resources=resources or {},
    )


async def _sign_in(
    adapter: OAuthMcpAdapter, vendor: FakeOAuthServer
) -> ConnectionSecret:
    verifier = secrets.token_urlsafe(48)
    url = await adapter.authorization_url(
        redirect_uri=REDIRECT,
        state="state-1",
        code_challenge=s256(verifier),
        scopes=["read:items", "write:items"],
    )
    back = parse_qs(urlsplit(vendor.authorize(url)).query)
    signed_in = await adapter.exchange_code(
        code=back["code"][0],
        verifier=verifier,
        redirect_uri=REDIRECT,
        scopes=["read:items", "write:items"],
    )
    return signed_in.secret


@pytest.fixture
def vendor() -> FakeOAuthServer:
    return FakeOAuthServer()


class TestDiscovery:
    async def test_finds_the_endpoints_from_the_mcp_servers_metadata(
        self, vendor
    ) -> None:
        adapter, _ = _adapter(vendor)
        endpoints = await adapter.endpoints()
        assert endpoints.authorization == f"{ISSUER}/authorize"
        assert endpoints.token == f"{ISSUER}/token"
        assert endpoints.registration == f"{ISSUER}/register"
        assert endpoints.resource == MCP_URL
        await adapter.endpoints()
        assert (
            vendor.paths.count(f"{ISSUER}/.well-known/oauth-authorization-server") == 1
        )

    async def test_the_catalogs_endpoints_need_no_discovery(self, vendor) -> None:
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    client_settings: EXAMPLE\n",
                "    client_settings: EXAMPLE\n"
                f"    authorization_url: {ISSUER}/authorize\n"
                f"    token_url: {ISSUER}/token\n",
            ),
        )
        endpoints = await adapter.endpoints()
        assert (endpoints.token, endpoints.resource) == (f"{ISSUER}/token", None)
        assert vendor.paths == []

    async def test_refuses_a_server_without_pkce(self, vendor) -> None:
        vendor.metadata["code_challenge_methods_supported"] = ["plain"]
        adapter, _ = _adapter(vendor)
        with pytest.raises(ServiceAdapterError, match="S256"):
            await adapter.endpoints()

    async def test_refuses_an_endpoint_that_is_not_https(self, vendor) -> None:
        vendor.metadata["token_endpoint"] = "http://auth.example.test/token"
        adapter, _ = _adapter(vendor)
        with pytest.raises(ServiceAdapterError, match="token endpoint is not an https"):
            await adapter.endpoints()

    async def test_a_vendor_that_is_down_is_unavailable(self, vendor) -> None:
        vendor.fail[f"{ISSUER}/.well-known/oauth-authorization-server"] = (503, {})
        adapter, _ = _adapter(vendor)
        with pytest.raises(ServiceUnavailableError):
            await adapter.endpoints()


class TestSignIn:
    async def test_signs_in_with_pkce_for_the_mcp_server(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        verifier = secrets.token_urlsafe(48)
        url = await adapter.authorization_url(
            redirect_uri=REDIRECT,
            state="state-1",
            code_challenge=s256(verifier),
            scopes=["read:items", "write:items"],
        )
        query = parse_qs(urlsplit(url).query)
        assert query["client_id"] == [STATIC_CLIENT_ID]
        assert query["redirect_uri"] == [REDIRECT]
        assert query["scope"] == ["read:items write:items"]
        assert query["state"] == ["state-1"]
        assert query["code_challenge_method"] == ["S256"]
        assert query["resource"] == [MCP_URL]
        assert "client_secret" not in url

        back = parse_qs(urlsplit(vendor.authorize(url)).query)
        signed_in = await adapter.exchange_code(
            code=back["code"][0],
            verifier=verifier,
            redirect_uri=REDIRECT,
            scopes=["read:items", "write:items"],
        )
        secret = signed_in.secret
        assert secret.access_token in vendor.live_access
        assert secret.values["refresh_token"] in vendor.live_refresh
        assert secret.expires_at == pytest.approx(time.time() + 3600, abs=5)
        assert signed_in.granted_scopes == ["read:items", "write:items"]

    async def test_a_code_with_the_wrong_verifier_is_refused(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        url = await adapter.authorization_url(
            redirect_uri=REDIRECT,
            state="s",
            code_challenge=s256("the-real-verifier"),
            scopes=["read:items"],
        )
        back = parse_qs(urlsplit(vendor.authorize(url)).query)
        with pytest.raises(ReauthorizationRequiredError):
            await adapter.exchange_code(
                code=back["code"][0],
                verifier="another-verifier",
                redirect_uri=REDIRECT,
                scopes=["read:items"],
            )

    async def test_reads_the_accounts_id_and_label(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        identity = await adapter.identify(secret.access_token or "")
        assert (identity.account_id, identity.label) == ("acct-1", "ada@example.test")

    async def test_a_numeric_account_id_is_read_as_text(self, vendor) -> None:
        vendor.account = {"id": 1001}
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        identity = await adapter.identify(secret.access_token or "")
        assert (identity.account_id, identity.label) == ("1001", "1001")

    async def test_an_account_without_an_id_is_refused(self, vendor) -> None:
        vendor.account = {"email": "ada@example.test"}
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        with pytest.raises(ServiceAdapterError, match="did not name the account"):
            await adapter.identify(secret.access_token or "")


class TestRefresh:
    async def test_a_rotating_refresh_spends_the_old_token(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        renewed = await adapter.refresh(secret)
        assert renewed.access_token != secret.access_token
        assert renewed.values["refresh_token"] != secret.values["refresh_token"]
        with pytest.raises(ReauthorizationRequiredError):
            await adapter.refresh(secret)
        assert vendor.token_requests[-1]["resource"] == MCP_URL

    async def test_a_reusable_refresh_token_is_kept(self) -> None:
        vendor = FakeOAuthServer(rotating=False)
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        renewed = await adapter.refresh(secret)
        assert renewed.access_token != secret.access_token
        assert renewed.values["refresh_token"] == secret.values["refresh_token"]
        assert (await adapter.refresh(renewed)).access_token is not None

    async def test_a_vendor_that_is_down_is_retried_later(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        vendor.fail[f"{ISSUER}/token"] = (502, {})
        with pytest.raises(ServiceUnavailableError):
            await adapter.refresh(secret)

    async def test_a_response_without_an_expiry_is_refused(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        vendor.fail[f"{ISSUER}/token"] = (
            200,
            {"access_token": "x", "token_type": "Bearer", "refresh_token": "y"},
        )
        with pytest.raises(ServiceAdapterError, match="when its access token expires"):
            await adapter.refresh(secret)


class TestIssue:
    async def test_hands_out_the_owners_token_which_the_mcp_server_takes(
        self, vendor
    ) -> None:
        adapter, http = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        expires_at = datetime.now(UTC) + timedelta(minutes=50)
        issued = await adapter.issue(
            AccessToken(secret.access_token or "", expires_at), _request()
        )
        assert issued.token == secret.access_token
        assert (issued.expires_at, issued.resources, issued.revocable) == (
            expires_at,
            {},
            False,
        )
        response = await http.post(
            MCP_URL,
            headers={"Authorization": f"Bearer {issued.token}"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        )
        assert response.json()["result"]["tools"][0]["name"] == "search_items"
        refused = await http.post(
            MCP_URL, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        )
        assert refused.status_code == 401
        assert "resource_metadata" in refused.headers["www-authenticate"]

    async def test_a_grant_names_no_resources(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        assert await adapter.check_grant("token", _request()) == {}
        with pytest.raises(ServiceAdapterError, match="names no resources"):
            await adapter.check_grant("token", _request({"project": "ABC"}))

    async def test_never_revokes_one_issued_token(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        with pytest.raises(ServiceAdapterError, match="cannot be revoked alone"):
            await adapter.revoke_issued("token")
        assert vendor.revoked == []

    def test_says_the_grant_acts_as_the_owner(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        assert adapter.summary("Planner", "write", {}) == (
            "Planner reads and writes Example as you."
        )
        assert adapter.summary("Planner", "read", {}) == "Planner reads Example as you."


class TestDisconnect:
    async def test_revokes_the_sign_in_where_the_catalog_names_how(
        self, vendor
    ) -> None:
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    client_settings: EXAMPLE\n",
                f"    client_settings: EXAMPLE\n    revocation_url: {ISSUER}/revoke\n",
            ),
        )
        secret = await _sign_in(adapter, vendor)
        await adapter.revoke_connection(secret)
        [revoked] = vendor.revoked
        assert revoked["token"] == secret.values["refresh_token"]
        assert revoked["token_type_hint"] == "refresh_token"

    async def test_says_so_where_the_vendor_offers_no_revocation(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        with pytest.raises(ServiceAdapterError, match="no way to revoke"):
            await adapter.revoke_connection(secret)
        assert vendor.revoked == []

    async def test_revokes_at_the_advertised_endpoint_where_the_catalog_says_to(
        self, vendor
    ) -> None:
        vendor.metadata["revocation_endpoint"] = f"{ISSUER}/revoke"
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    client_settings: EXAMPLE\n",
                "    client_settings: EXAMPLE\n    revocation_discovered: true\n",
            ),
        )
        secret = await _sign_in(adapter, vendor)
        await adapter.revoke_connection(secret)
        [revoked] = vendor.revoked
        assert revoked["token"] == secret.values["refresh_token"]
        assert secret.values["refresh_token"] not in vendor.live_refresh

    async def test_says_so_where_the_advertised_endpoint_is_missing(
        self, vendor
    ) -> None:
        del vendor.metadata["revocation_endpoint"]
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    client_settings: EXAMPLE\n",
                "    client_settings: EXAMPLE\n    revocation_discovered: true\n",
            ),
        )
        secret = await _sign_in(adapter, vendor)
        with pytest.raises(ServiceAdapterError, match="no way to revoke"):
            await adapter.revoke_connection(secret)


class TestWhereTheMetadataIs:
    async def test_follows_the_metadata_the_servers_401_names(self, vendor) -> None:
        vendor.resource_metadata_path = "/resource-metadata/v1"
        adapter, _ = _adapter(vendor)
        endpoints = await adapter.endpoints()
        assert endpoints.token == f"{ISSUER}/token"
        assert "https://mcp.example.test/resource-metadata/v1" in vendor.paths
        # Never the host's root metadata, which describes another server.
        assert (
            "https://mcp.example.test/.well-known/oauth-protected-resource"
            not in vendor.paths
        )

    async def test_falls_back_to_the_well_known_address(self, vendor) -> None:
        vendor.advertise = False
        adapter, _ = _adapter(vendor)
        endpoints = await adapter.endpoints()
        assert endpoints.token == f"{ISSUER}/token"
        assert (
            "https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp"
            in vendor.paths
        )

    async def test_asks_for_consent_where_the_catalog_says_to(self, vendor) -> None:
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    client_settings: EXAMPLE\n",
                "    client_settings: EXAMPLE\n    prompt: consent\n",
            ),
        )
        await _sign_in(adapter, vendor)
        assert vendor.authorizations[-1]["prompt"] == "consent"
        plain, _ = _adapter(vendor)
        await _sign_in(plain, vendor)
        assert "prompt" not in vendor.authorizations[-1]


class TestThroughTheBroker:
    async def test_agents_renewing_at_once_refresh_a_rotating_sign_in_once(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        vendor,
        tmp_path: Path,
    ) -> None:
        adapter, _ = _adapter(vendor)
        broker = ServiceBroker(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            catalog=pass_through_catalog(tmp_path / "catalog"),
            adapters={"example": adapter},
            disabled={},
            store=STORE,
            token_retention=timedelta(days=30),
        )
        secret = await _sign_in(adapter, vendor)
        # Due for renewal: inside the fifteen minutes a pass-through keeps.
        values = {**secret.values, "expires_at": time.time() + 600}
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agents = [
                await add_agent(session, name=f"planner{i}", owner_id=owner.id)
                for i in range(3)
            ]
            await STORE.save_connection(
                session,
                user_id=owner.id,
                service="example",
                consent="write",
                granted_scopes=["read:items", "write:items"],
                account_id="acct-1",
                external_identity="ada@example.test",
                encrypted_secret=TEST_KEYRING.encrypt(json.dumps(values)),
            )
            for agent in agents:
                await STORE.save_grant(
                    session,
                    agent_id=agent.id,
                    owner_id=owner.id,
                    service="example",
                    access="write",
                    tool_mode="deny",
                    tools=[],
                    resources={},
                    account_id="acct-1",
                    created_by=owner.id,
                )
            await session.commit()

        async def issue(agent_id: str):
            async with session_factory() as session:
                return await broker.issue(
                    session, agent_id, Principal.agent_key(), "example"
                )

        tokens = await asyncio.gather(*(issue(agent.id) for agent in agents))
        refreshes = [
            request
            for request in vendor.token_requests
            if request["grant_type"] == "refresh_token"
        ]
        assert len(refreshes) == 1
        assert len({token.token for token in tokens}) == 1
        assert tokens[0].token in vendor.live_access
        assert tokens[0].token != secret.access_token
        assert tokens[0].use_until <= datetime.now(UTC) + timedelta(hours=1)

        async with session_factory() as session:
            connection = await STORE.get_connection(session, owner.id, "example")
            assert connection is not None
            stored = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert stored["refresh_token"] in vendor.live_refresh
        assert stored["access_token"] == tokens[0].token
        assert IDENTITY_URL not in vendor.paths

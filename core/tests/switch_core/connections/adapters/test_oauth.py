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
    ConnectionNotRevocable,
    ConnectionSecret,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.broker import Principal, ServiceBroker
from switch_core.connections.loader import CATALOG_ROOT, ConnectionDefinition
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
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
from tests.switch_core.connections.test_loader import CLI_ENTRY, OAUTH_ENTRY
from tests.switch_core.gateway.agent_route_harness import add_agent

STATIC = OAUTH_ENTRY.replace(
    "    registration: dynamic\n",
    "    registration: static\n    client_settings: EXAMPLE\n",
)
STORE = ServiceConnectionStore()
REDIRECT = "http://127.0.0.1:43123/callback"


def _definition(text: str = STATIC) -> ConnectionDefinition:
    return ConnectionDefinition.model_validate(yaml.safe_load(text))


def _adapter(
    vendor: FakeOAuthServer, text: str = STATIC
) -> tuple[OAuthAdapter, httpx.AsyncClient]:
    http = vendor.client()
    client = StaticClient(
        OAuthClientCredentials(
            STATIC_CLIENT_ID, STATIC_CLIENT_SECRET, authentication=None
        )
    )
    return OAuthAdapter(_definition(text), client, http), http


def _request(resources: dict | None = None) -> IssueRequest:
    return IssueRequest(
        service="example",
        access="write",
        reach={"scopes": ["read:items", "write:items"]},
        resources=resources or {},
    )


async def _sign_in(adapter: OAuthAdapter, vendor: FakeOAuthServer) -> ConnectionSecret:
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

    async def test_a_get_identity_sends_no_body(self, vendor) -> None:
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        await adapter.identify(secret.access_token or "")
        assert vendor.identity_requests == [("GET", b"")]

    async def test_a_post_identity_without_a_body_sends_none(self, vendor) -> None:
        adapter, _ = _adapter(
            vendor, STATIC.replace("    method: GET\n", "    method: POST\n")
        )
        secret = await _sign_in(adapter, vendor)
        identity = await adapter.identify(secret.access_token or "")
        assert identity.account_id == "acct-1"
        assert vendor.identity_requests == [("POST", b"")]

    async def test_a_post_identity_sends_its_static_body(self, vendor) -> None:
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    method: GET\n", '    method: POST\n    body: { fields: ["id"] }\n'
            ),
        )
        secret = await _sign_in(adapter, vendor)
        await adapter.identify(secret.access_token or "")
        [(method, body)] = vendor.identity_requests
        assert (method, json.loads(body)) == ("POST", {"fields": ["id"]})

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

    async def test_sends_the_secret_as_basic_where_the_vendor_takes_only_that(
        self, vendor
    ) -> None:
        vendor.metadata["token_endpoint_auth_methods_supported"] = [
            "client_secret_basic",
            "none",
        ]
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        await adapter.refresh(secret)
        assert len(vendor.token_requests) == 2
        assert not any("client_secret" in form for form in vendor.token_requests)

    async def test_sends_the_secret_in_the_body_where_the_vendor_lists_that(
        self, vendor
    ) -> None:
        vendor.metadata["token_endpoint_auth_methods_supported"] = [
            "client_secret_basic",
            "client_secret_post",
        ]
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        await adapter.refresh(secret)
        assert [form.get("client_secret") for form in vendor.token_requests] == [
            STATIC_CLIENT_SECRET,
            STATIC_CLIENT_SECRET,
        ]

    async def test_metadata_listing_no_methods_means_basic(self, vendor) -> None:
        del vendor.metadata["token_endpoint_auth_methods_supported"]
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        await adapter.refresh(secret)
        assert len(vendor.token_requests) == 2
        assert not any("client_secret" in form for form in vendor.token_requests)

    async def test_a_basic_secret_is_form_urlencoded(self, vendor) -> None:
        unusual = "a+b/c:d%e f="
        vendor.clients[STATIC_CLIENT_ID] = unusual
        vendor.metadata["token_endpoint_auth_methods_supported"] = [
            "client_secret_basic"
        ]
        client = StaticClient(
            OAuthClientCredentials(STATIC_CLIENT_ID, unusual, authentication=None)
        )
        adapter = OAuthAdapter(_definition(), client, vendor.client())
        secret = await _sign_in(adapter, vendor)
        assert (await adapter.refresh(secret)).access_token in vendor.live_access

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


DROPBOX_READ = ["account_info.read", "files.metadata.read", "files.content.read"]
DROPBOX_ACCOUNT = {"account_id": "dbid:SYNTHETIC-ACCOUNT", "email": "ada@example.test"}


def _dropbox_vendor(**kwargs) -> FakeOAuthServer:
    vendor = FakeOAuthServer(rotating=False, lifetime=14400, **kwargs)
    vendor.flat_account = True
    vendor.account = dict(DROPBOX_ACCOUNT)
    return vendor


def _dropbox_adapter(vendor: FakeOAuthServer) -> OAuthAdapter:
    """The entry as shipped, with only Dropbox's addresses swapped for the fake's."""
    text = (CATALOG_ROOT / "dropbox" / "connection.yaml").read_text()
    text = text.replace(
        "https://api.dropboxapi.com/2/users/get_current_account", IDENTITY_URL
    )
    text = text.replace("https://mcp.dropbox.com/mcp", MCP_URL)
    return _adapter(vendor, text)[0]


async def _dropbox_sign_in(adapter: OAuthAdapter, vendor: FakeOAuthServer, scopes):
    verifier = secrets.token_urlsafe(48)
    url = await adapter.authorization_url(
        redirect_uri=REDIRECT,
        state="state-1",
        code_challenge=s256(verifier),
        scopes=scopes,
    )
    back = parse_qs(urlsplit(vendor.authorize(url)).query)
    return await adapter.exchange_code(
        code=back["code"][0], verifier=verifier, redirect_uri=REDIRECT, scopes=scopes
    )


class TestTheShippedDropboxEntry:
    """Dropbox's entry run against a fake of its HTTP side. Verified live, not
    here: that Dropbox answers these requests as the fake does."""

    async def test_signs_in_offline_with_pkce_and_the_scopes_asked(self) -> None:
        vendor = _dropbox_vendor()
        signed_in = await _dropbox_sign_in(
            _dropbox_adapter(vendor), vendor, DROPBOX_READ
        )
        asked = vendor.authorizations[-1]
        assert asked["token_access_type"] == "offline"
        assert asked["code_challenge_method"] == "S256"
        assert asked["scope"] == " ".join(DROPBOX_READ)
        assert signed_in.granted_scopes == DROPBOX_READ
        assert signed_in.secret.values["refresh_token"]

    async def test_a_narrower_grant_is_what_the_token_answer_names(self) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        write = [*DROPBOX_READ, "files.content.write"]
        signed_in = await _dropbox_sign_in(adapter, vendor, write)
        assert signed_in.granted_scopes == write

    async def test_names_the_account_with_a_post_that_has_no_body(self) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
        identity = await adapter.identify(signed_in.secret.access_token or "")
        assert (identity.account_id, identity.label) == (
            "dbid:SYNTHETIC-ACCOUNT",
            "ada@example.test",
        )
        assert vendor.identity_requests == [("POST", b"")]

    async def test_a_refresh_answers_a_new_access_token_and_keeps_the_refresh_token(
        self,
    ) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
        renewed = await adapter.refresh(signed_in.secret)
        assert renewed.access_token != signed_in.secret.access_token
        assert (
            renewed.values["refresh_token"] == signed_in.secret.values["refresh_token"]
        )
        again = await adapter.refresh(renewed)
        assert again.access_token not in (None, renewed.access_token)
        assert [r["grant_type"] for r in vendor.token_requests[-2:]] == [
            "refresh_token"
        ] * 2

    async def test_a_sign_in_without_the_account_scope_must_be_made_again(self) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
        vendor.fail[IDENTITY_URL] = (
            401,
            {"error": {".tag": "missing_scope", "required_scope": "account_info.read"}},
        )
        with pytest.raises(ReauthorizationRequiredError):
            await adapter.identify(signed_in.secret.access_token or "")

    async def test_dropbox_being_down_when_asked_whose_sign_in_it_is_is_unavailable(
        self,
    ) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
        vendor.fail[IDENTITY_URL] = (503, {})
        with pytest.raises(ServiceUnavailableError):
            await adapter.identify(signed_in.secret.access_token or "")

    async def test_an_account_answer_without_an_id_is_refused(self) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
        vendor.account = {"email": "ada@example.test"}
        with pytest.raises(ServiceAdapterError, match="did not name the account"):
            await adapter.identify(signed_in.secret.access_token or "")

    async def test_a_revoked_refresh_token_must_be_signed_in_again(self) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
        vendor.live_refresh.clear()
        with pytest.raises(ReauthorizationRequiredError):
            await adapter.refresh(signed_in.secret)

    async def test_disconnect_says_where_to_remove_switch_and_asks_nothing_of_dropbox(
        self,
    ) -> None:
        vendor = _dropbox_vendor()
        adapter = _dropbox_adapter(vendor)
        signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
        calls = len(vendor.paths)
        with pytest.raises(ConnectionNotRevocable, match="Connected apps"):
            await adapter.revoke_connection(signed_in.secret)
        assert vendor.revoked == [] and len(vendor.paths) == calls


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


class TestCommandLineTool:
    """An entry whose tool is the vendor's CLI has no MCP server to discover
    from: it signs in and revokes where the catalog says."""

    async def test_signs_in_and_revokes_at_the_catalogs_endpoints(self, vendor) -> None:
        adapter, _ = _adapter(vendor, CLI_ENTRY)
        secret = await _sign_in(adapter, vendor)
        [authorization] = vendor.authorizations
        assert "resource" not in authorization
        assert "resource" not in vendor.token_requests[0]
        await adapter.revoke_connection(secret)
        assert [r["token"] for r in vendor.revoked] == [secret.values["refresh_token"]]
        assert not any("mcp.example.test" in path for path in vendor.paths)

    async def test_hands_out_the_owners_token(self, vendor) -> None:
        adapter, _ = _adapter(vendor, CLI_ENTRY)
        secret = await _sign_in(adapter, vendor)
        issued = await adapter.issue(
            AccessToken(
                secret.access_token or "", datetime.now(UTC) + timedelta(minutes=50)
            ),
            _request(),
        )
        assert issued.token == secret.access_token
        assert issued.revocable is False


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

    async def test_says_it_cannot_revoke_where_the_vendor_offers_no_revocation(
        self, vendor
    ) -> None:
        adapter, _ = _adapter(vendor)
        secret = await _sign_in(adapter, vendor)
        with pytest.raises(
            ConnectionNotRevocable,
            match="so it still works. Remove Switch under Connected apps in Example.",
        ):
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
        with pytest.raises(ServiceAdapterError, match="no way to revoke") as raised:
            await adapter.revoke_connection(secret)
        assert not isinstance(raised.value, ConnectionNotRevocable)


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

    async def test_sends_a_dropbox_style_offline_token_request(self, vendor) -> None:
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    client_settings: EXAMPLE\n",
                "    client_settings: EXAMPLE\n"
                "    authorization_params: { token_access_type: offline }\n",
            ),
        )
        await _sign_in(adapter, vendor)
        assert vendor.authorizations[-1]["token_access_type"] == "offline"

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

    async def test_sends_the_catalogs_extra_parameters_with_every_authorization(
        self, vendor
    ) -> None:
        adapter, _ = _adapter(
            vendor,
            CLI_ENTRY.replace(
                "    client_settings: EXAMPLE\n",
                "    client_settings: EXAMPLE\n"
                "    authorization_params:\n"
                "      access_type: offline\n"
                "      include_granted_scopes: 'false'\n",
            ),
        )
        await _sign_in(adapter, vendor)
        await _sign_in(adapter, vendor)
        for authorization in vendor.authorizations:
            assert authorization["access_type"] == "offline"
            assert authorization["include_granted_scopes"] == "false"
            assert authorization["redirect_uri"] == REDIRECT
        plain, _ = _adapter(vendor, CLI_ENTRY)
        await _sign_in(plain, vendor)
        assert "access_type" not in vendor.authorizations[-1]


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
            organization_apps=None,
            disabled={},
            store=STORE,
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
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
                oauth_client_id=None,
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

    async def test_disconnecting_a_vendor_without_revocation_says_so_plainly(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        vendor,
        tmp_path: Path,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        adapter, _ = _adapter(vendor)
        broker = ServiceBroker(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            catalog=pass_through_catalog(tmp_path / "catalog"),
            adapters={"example": adapter},
            organization_apps=None,
            disabled={},
            store=STORE,
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
        )
        secret = await _sign_in(adapter, vendor)
        async with session_factory() as session:
            owner = await _user(session, "ada")
            await STORE.save_connection(
                session,
                user_id=owner.id,
                service="example",
                consent="write",
                granted_scopes=["read:items", "write:items"],
                account_id="acct-1",
                external_identity="ada@example.test",
                encrypted_secret=TEST_KEYRING.encrypt(json.dumps(secret.values)),
                oauth_client_id=None,
            )
            await session.commit()

        async with session_factory() as session:
            warning = await broker.disconnect(session, owner.id, "example")

        assert warning is not None
        assert "cannot revoke it, so it still works" in warning
        assert "could not revoke" not in warning
        assert not [r for r in caplog.records if r.levelname == "ERROR"]
        assert vendor.revoked == []
        async with session_factory() as session:
            assert await STORE.get_connection(session, owner.id, "example") is None

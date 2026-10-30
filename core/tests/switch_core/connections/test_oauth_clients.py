"""The OAuth client Core registers for itself, against Postgres and a fake vendor."""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import OAuthAdapter
from switch_core.connections.broker import (
    CLIENT_REPLACED,
    CONNECTOR_REVOKED,
    Principal,
    ServiceBroker,
    ServiceError,
)
from switch_core.connections.loader import ConnectionDefinition
from switch_core.connections.oauth_clients import (
    LOOPBACK_REDIRECT_URI,
    RegisteredClient,
    client_name,
    core_callback,
    loopback_redirect,
    redirect_uris,
)
from switch_core.db.models import ServiceOAuthClient
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import TEST_KEYRING, RLSHarness
from tests.switch_core.connections.fake_vendor import (
    ISSUER,
    FakeOAuthServer,
    UnregisteredRedirect,
    s256,
)
from tests.switch_core.connections.test_broker import _user, pass_through_catalog
from tests.switch_core.connections.test_loader import OAUTH_ENTRY
from tests.switch_core.gateway.agent_route_harness import add_agent

STORE = ServiceConnectionStore()
PORTS = [43123, 43124]
REDIRECT = loopback_redirect(43123)
SCOPES = ["read:items", "write:items"]


def _client(
    session_factory: async_sessionmaker[AsyncSession],
    vendor: FakeOAuthServer,
    ports: list[int] = PORTS,
) -> RegisteredClient:
    return RegisteredClient(
        service="example",
        name="Example",
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        http=vendor.client(),
        client_name="Switch (switch.example.com)",
        redirect_uris=[loopback_redirect(port) for port in ports],
        scopes=SCOPES,
    )


def _adapter(client: RegisteredClient, vendor: FakeOAuthServer) -> OAuthAdapter:
    definition = ConnectionDefinition.model_validate(yaml.safe_load(OAUTH_ENTRY))
    return OAuthAdapter(definition, client, vendor.client())


async def _rows(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[ServiceOAuthClient]:
    async with session_factory() as session:
        return list(await session.scalars(select(ServiceOAuthClient)))


async def _sign_in(adapter: OAuthAdapter, vendor: FakeOAuthServer, redirect: str):
    verifier = secrets.token_urlsafe(48)
    url = await adapter.authorization_url(
        redirect_uri=redirect,
        state="s",
        code_challenge=s256(verifier),
        scopes=SCOPES,
        choices={},
    )
    back = parse_qs(urlsplit(vendor.authorize(url)).query)
    return await adapter.exchange_code(
        code=back["code"][0],
        verifier=verifier,
        redirect_uri=redirect,
        scopes=SCOPES,
        choices={},
    )


@pytest.fixture
def vendor() -> FakeOAuthServer:
    return FakeOAuthServer()


async def test_registers_once_and_keeps_the_client_encrypted(
    session_factory, vendor
) -> None:
    adapter = _adapter(_client(session_factory, vendor), vendor)
    endpoints = await adapter.endpoints({})
    first = await adapter._client.credentials(endpoints)
    again = await adapter._client.credentials(endpoints)
    assert first == again
    [registration] = vendor.registrations
    assert registration == {
        "client_name": "Switch (switch.example.com)",
        "redirect_uris": [loopback_redirect(43123), loopback_redirect(43124)],
        "scope": "read:items write:items",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }
    [row] = await _rows(session_factory)
    assert (row.service, row.oauth_client_id) == ("example", first.client_id)
    assert row.registration_endpoint == f"{ISSUER}/register"
    assert first.client_id not in row.encrypted_secret
    stored = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))
    assert stored["answer"]["client_id"] == first.client_id

    # Another process, the same deployment: the stored client, no registration.
    restarted = _adapter(_client(session_factory, vendor), vendor)
    assert await restarted._client.credentials(endpoints) == first
    assert len(vendor.registrations) == 1


async def test_two_replicas_connecting_at_once_register_one_client(
    session_factory, vendor
) -> None:
    adapters = [_adapter(_client(session_factory, vendor), vendor) for _ in range(3)]
    endpoints = await adapters[0].endpoints({})
    clients = await asyncio.gather(
        *(adapter._client.credentials(endpoints) for adapter in adapters)
    )
    assert len(vendor.registrations) == 1
    assert len({client.client_id for client in clients}) == 1
    assert len(await _rows(session_factory)) == 1


async def test_a_moved_registration_endpoint_registers_again(
    session_factory, vendor
) -> None:
    adapter = _adapter(_client(session_factory, vendor), vendor)
    endpoints = await adapter.endpoints({})
    first = await adapter._client.credentials(endpoints)
    async with session_factory() as session:
        row = await session.get(ServiceOAuthClient, ("example", ""))
        assert row is not None
        row.registration_endpoint = "https://old.example.test/register"
        await session.commit()
    second = await _client(session_factory, vendor).credentials(
        replace(endpoints, registration=f"{ISSUER}/register")
    )
    assert second.client_id != first.client_id
    [row] = await _rows(session_factory)
    assert (row.oauth_client_id, row.registration_endpoint) == (
        second.client_id,
        f"{ISSUER}/register",
    )


async def test_changed_ports_register_again_and_sign_in_on_the_new_ones(
    session_factory, vendor
) -> None:
    endpoints = await _adapter(_client(session_factory, vendor), vendor).endpoints({})
    first = await _client(session_factory, vendor).credentials(endpoints)
    adapter = _adapter(_client(session_factory, vendor, ports=[43125]), vendor)
    second = await adapter._client.credentials(endpoints)
    assert second.client_id != first.client_id
    assert vendor.registrations[-1]["redirect_uris"] == [loopback_redirect(43125)]
    signed_in = await _sign_in(adapter, vendor, loopback_redirect(43125))
    assert signed_in.secret.access_token in vendor.live_access


async def test_a_connection_through_a_client_registered_anew_must_reconnect(
    session_factory, vendor, tmp_path: Path
) -> None:
    """A process knows the client it registered only once it uses it, so a
    connection through one since replaced is found out by the refresh that
    registers anew: as a replaced client, not as a refused sign-in."""
    signed_in = await _sign_in(
        _adapter(_client(session_factory, vendor), vendor), vendor, REDIRECT
    )
    # Restarted with other redirects: the stored registration no longer fits.
    adapter = _adapter(_client(session_factory, vendor, ports=[43125]), vendor)
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=pass_through_catalog(tmp_path / "catalog"),
        adapters={"example": adapter},
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )
    async with session_factory() as session:
        owner = await _user(session, "ada")
        agent = await add_agent(session, name="planner", owner_id=owner.id)
        await STORE.save_connection(
            session,
            user_id=owner.id,
            service="example",
            consent="write",
            granted_scopes=SCOPES,
            account_id="acct-1",
            external_identity="ada@example.test",
            # Due for renewal, so the token asked for below is refreshed.
            encrypted_secret=TEST_KEYRING.encrypt(
                json.dumps({**signed_in.secret.values, "expires_at": time.time() + 60})
            ),
            oauth_client_id=signed_in.client_id,
            method="oauth",
            choices={},
        )
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
        connection = await STORE.get_connection(session, owner.id, "example")
    assert connection is not None
    assert broker.connection_status(connection) == "active"

    with pytest.raises(ServiceError) as caught:
        async with session_factory() as session:
            await broker.issue(session, agent.id, Principal.agent_key(), "example")

    assert caught.value.code == CONNECTOR_REVOKED
    assert caught.value.message == (
        "Example was connected through an app this server no longer uses. The "
        "agent's owner must reconnect Example from Connectors in Switch Console."
    )
    assert len(vendor.registrations) == 2
    async with session_factory() as session:
        connection = await STORE.get_connection(session, owner.id, "example")
    assert connection is not None
    assert (connection.status, connection.error_code) == (
        "needs_reauthorization",
        CLIENT_REPLACED,
    )


async def test_the_vendor_refuses_a_port_the_client_did_not_register(
    session_factory, vendor
) -> None:
    adapter = _adapter(_client(session_factory, vendor), vendor)
    with pytest.raises(UnregisteredRedirect):
        await _sign_in(adapter, vendor, loopback_redirect(43999))


async def test_a_vendor_without_registration_is_refused(
    session_factory, vendor
) -> None:
    del vendor.metadata["registration_endpoint"]
    adapter = _adapter(_client(session_factory, vendor), vendor)
    with pytest.raises(ServiceAdapterError, match="offers no client registration"):
        await adapter.authorization_url(
            redirect_uri=REDIRECT,
            state="s",
            code_challenge="c",
            scopes=["read:items"],
            choices={},
        )
    assert await _rows(session_factory) == []


async def test_a_public_client_ignores_the_secret_it_was_given_anyway(
    session_factory, vendor
) -> None:
    adapter = _adapter(_client(session_factory, vendor), vendor)
    signed_in = await _sign_in(adapter, vendor, REDIRECT)
    assert signed_in.secret.access_token in vendor.live_access
    [row] = await _rows(session_factory)
    issued = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))["answer"]
    assert issued["client_secret"].startswith("SYNTHETIC-REGISTERED-")
    [exchange] = vendor.token_requests
    assert "client_secret" not in exchange
    assert vendor.clients[exchange["client_id"]] is None
    renewed = await adapter.refresh(signed_in.secret)
    assert "client_secret" not in vendor.token_requests[-1]
    assert renewed.access_token in vendor.live_access


@pytest.mark.parametrize(
    ("registered", "listed", "in_body"),
    [
        ("client_secret_basic", ["client_secret_post", "client_secret_basic"], False),
        ("client_secret_post", ["client_secret_basic"], True),
    ],
)
async def test_a_client_registered_with_a_secret_sends_it_as_registered(
    session_factory,
    vendor,
    registered: str,
    listed: list[str],
    in_body: bool,
) -> None:
    vendor.register_as = registered
    vendor.metadata["token_endpoint_auth_methods_supported"] = listed
    adapter = _adapter(_client(session_factory, vendor), vendor)
    signed_in = await _sign_in(adapter, vendor, REDIRECT)
    renewed = await adapter.refresh(signed_in.secret)
    assert renewed.access_token in vendor.live_access
    assert [("client_secret" in form) for form in vendor.token_requests] == [
        in_body,
        in_body,
    ]


async def test_a_registration_naming_no_method_means_basic(
    session_factory, vendor
) -> None:
    vendor.register_as = "client_secret_basic"
    vendor.answer_names_method = False
    adapter = _adapter(_client(session_factory, vendor), vendor)
    signed_in = await _sign_in(adapter, vendor, REDIRECT)
    assert signed_in.secret.access_token in vendor.live_access
    [exchange] = vendor.token_requests
    assert "client_secret" not in exchange


async def test_a_client_registered_for_another_method_is_refused(
    session_factory, vendor
) -> None:
    vendor.register_as = "private_key_jwt"
    adapter = _adapter(_client(session_factory, vendor), vendor)
    with pytest.raises(ServiceAdapterError, match="private_key_jwt"):
        await adapter.client_id({})
    assert await _rows(session_factory) == []


async def test_the_runtime_role_registers_outside_any_tenant(
    rls_harness: RLSHarness, vendor
) -> None:
    adapter = _adapter(_client(rls_harness.restricted, vendor), vendor)
    client = await adapter._client.credentials(await adapter.endpoints({}))
    [row] = await _rows(rls_harness.owner)
    assert row.oauth_client_id == client.client_id


def test_registers_the_redirects_this_server_can_use() -> None:
    public = "https://switch.example.com"
    core = f"{public}/gateway/service-connections/example/flows/callback"
    assert redirect_uris("example", ["loopback", "core"], public, None) == [
        LOOPBACK_REDIRECT_URI,
        core,
    ]
    assert redirect_uris("example", ["loopback", "core"], None, [43123, 43124]) == [
        "http://127.0.0.1:43123/switch-services/callback",
        "http://127.0.0.1:43124/switch-services/callback",
    ]
    assert redirect_uris("example", ["core"], None, None) == []
    assert core_callback(public + "/", "example") == core


def test_names_switch_and_its_host_on_the_consent_screen() -> None:
    assert client_name("https://switch.example.com", "switch.local") == (
        "Switch (switch.example.com)"
    )
    assert client_name(None, "switch.local") == "Switch (switch.local)"

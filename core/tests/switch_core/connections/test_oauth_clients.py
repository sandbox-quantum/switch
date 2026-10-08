"""The OAuth client Core registers for itself, against Postgres and a fake vendor."""

from __future__ import annotations

import asyncio
import json
import secrets
from dataclasses import replace
from urllib.parse import parse_qs, urlsplit

import pytest
import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth_mcp import OAuthMcpAdapter
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
from tests.conftest import TEST_KEYRING, RLSHarness
from tests.switch_core.connections.fake_vendor import (
    ISSUER,
    FakeOAuthServer,
    UnregisteredRedirect,
    s256,
)
from tests.switch_core.connections.test_loader import OAUTH_MCP_ENTRY

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


def _adapter(client: RegisteredClient, vendor: FakeOAuthServer) -> OAuthMcpAdapter:
    definition = ConnectionDefinition.model_validate(yaml.safe_load(OAUTH_MCP_ENTRY))
    return OAuthMcpAdapter(definition, client, vendor.client())


async def _rows(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[ServiceOAuthClient]:
    async with session_factory() as session:
        return list(await session.scalars(select(ServiceOAuthClient)))


async def _sign_in(adapter: OAuthMcpAdapter, vendor: FakeOAuthServer, redirect: str):
    verifier = secrets.token_urlsafe(48)
    url = await adapter.authorization_url(
        redirect_uri=redirect,
        state="s",
        code_challenge=s256(verifier),
        scopes=SCOPES,
    )
    back = parse_qs(urlsplit(vendor.authorize(url)).query)
    return await adapter.exchange_code(
        code=back["code"][0], verifier=verifier, redirect_uri=redirect, scopes=SCOPES
    )


@pytest.fixture
def vendor() -> FakeOAuthServer:
    return FakeOAuthServer()


async def test_registers_once_and_keeps_the_client_encrypted(
    session_factory, vendor
) -> None:
    adapter = _adapter(_client(session_factory, vendor), vendor)
    endpoints = await adapter.endpoints()
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
    assert (row.service, row.client_id) == ("example", first.client_id)
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
    endpoints = await adapters[0].endpoints()
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
    endpoints = await adapter.endpoints()
    first = await adapter._client.credentials(endpoints)
    async with session_factory() as session:
        row = await session.get(ServiceOAuthClient, "example")
        assert row is not None
        row.registration_endpoint = "https://old.example.test/register"
        await session.commit()
    second = await _client(session_factory, vendor).credentials(
        replace(endpoints, registration=f"{ISSUER}/register")
    )
    assert second.client_id != first.client_id
    [row] = await _rows(session_factory)
    assert (row.client_id, row.registration_endpoint) == (
        second.client_id,
        f"{ISSUER}/register",
    )


async def test_changed_ports_register_again_and_sign_in_on_the_new_ones(
    session_factory, vendor
) -> None:
    endpoints = await _adapter(_client(session_factory, vendor), vendor).endpoints()
    first = await _client(session_factory, vendor).credentials(endpoints)
    adapter = _adapter(_client(session_factory, vendor, ports=[43125]), vendor)
    second = await adapter._client.credentials(endpoints)
    assert second.client_id != first.client_id
    assert vendor.registrations[-1]["redirect_uris"] == [loopback_redirect(43125)]
    signed_in = await _sign_in(adapter, vendor, loopback_redirect(43125))
    assert signed_in.secret.access_token in vendor.live_access


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
            redirect_uri=REDIRECT, state="s", code_challenge="c", scopes=["read:items"]
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


async def test_the_runtime_role_registers_outside_any_tenant(
    rls_harness: RLSHarness, vendor
) -> None:
    adapter = _adapter(_client(rls_harness.restricted, vendor), vendor)
    client = await adapter._client.credentials(await adapter.endpoints())
    [row] = await _rows(rls_harness.owner)
    assert row.client_id == client.client_id


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

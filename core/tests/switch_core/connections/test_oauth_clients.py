"""The OAuth client Core registers for itself, against Postgres and a fake vendor."""

from __future__ import annotations

import asyncio
import json
import secrets
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
    redirect_uris,
)
from switch_core.db.models import ServiceOAuthClient
from tests.conftest import TEST_KEYRING, RLSHarness
from tests.switch_core.connections.fake_vendor import ISSUER, FakeOAuthServer, s256
from tests.switch_core.connections.test_loader import OAUTH_MCP_ENTRY

REDIRECT = "http://127.0.0.1:43123/switch-services/callback"


def _client(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeOAuthServer
) -> RegisteredClient:
    return RegisteredClient(
        service="example",
        name="Example",
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        http=vendor.client(),
        client_name="Switch (switch.example.com)",
        redirect_uris=[LOOPBACK_REDIRECT_URI],
    )


def _adapter(client: RegisteredClient, vendor: FakeOAuthServer) -> OAuthMcpAdapter:
    definition = ConnectionDefinition.model_validate(yaml.safe_load(OAUTH_MCP_ENTRY))
    return OAuthMcpAdapter(definition, client, vendor.client())


async def _rows(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[ServiceOAuthClient]:
    async with session_factory() as session:
        return list(await session.scalars(select(ServiceOAuthClient)))


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
        "redirect_uris": [LOOPBACK_REDIRECT_URI],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }
    [row] = await _rows(session_factory)
    assert (row.service, row.client_id) == ("example", first.client_id)
    assert row.registration_endpoint == f"{ISSUER}/register"
    assert first.client_id not in row.encrypted_secret
    assert json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))["client_id"] == (
        first.client_id
    )

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
    moved = type(endpoints)(
        authorization=endpoints.authorization,
        token=endpoints.token,
        registration=f"{ISSUER}/register",
        resource=endpoints.resource,
    )
    vendor.metadata["registration_endpoint"] = f"{ISSUER}/register"
    async with session_factory() as session:
        row = await session.get(ServiceOAuthClient, "example")
        assert row is not None
        row.registration_endpoint = "https://old.example.test/register"
        await session.commit()
    restarted = _client(session_factory, vendor)
    second = await restarted.credentials(moved)
    assert second.client_id != first.client_id
    [row] = await _rows(session_factory)
    assert (row.client_id, row.registration_endpoint) == (
        second.client_id,
        f"{ISSUER}/register",
    )


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


async def test_a_public_registered_client_signs_in_with_pkce_alone(
    session_factory, vendor
) -> None:
    adapter = _adapter(_client(session_factory, vendor), vendor)
    verifier = secrets.token_urlsafe(48)
    url = await adapter.authorization_url(
        redirect_uri=REDIRECT,
        state="s",
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
    assert signed_in.secret.access_token in vendor.live_access
    [exchange] = vendor.token_requests
    assert "client_secret" not in exchange
    assert vendor.clients[exchange["client_id"]] is None


async def test_the_runtime_role_registers_outside_any_tenant(
    rls_harness: RLSHarness, vendor
) -> None:
    adapter = _adapter(_client(rls_harness.restricted, vendor), vendor)
    client = await adapter._client.credentials(await adapter.endpoints())
    [row] = await _rows(rls_harness.owner)
    assert row.client_id == client.client_id


def test_registers_the_redirects_this_server_can_use() -> None:
    public = "https://switch.example.com"
    assert redirect_uris("example", ["loopback", "core"], public) == [
        LOOPBACK_REDIRECT_URI,
        f"{public}/gateway/service-connections/example/flows/callback",
    ]
    assert redirect_uris("example", ["loopback", "core"], None) == [
        LOOPBACK_REDIRECT_URI
    ]
    assert redirect_uris("example", ["core"], None) == []
    assert core_callback(public + "/", "example") == (
        f"{public}/gateway/service-connections/example/flows/callback"
    )


def test_names_switch_and_its_host_on_the_consent_screen() -> None:
    assert client_name("https://switch.example.com", "switch.local") == (
        "Switch (switch.example.com)"
    )
    assert client_name(None, "switch.local") == "Switch (switch.local)"

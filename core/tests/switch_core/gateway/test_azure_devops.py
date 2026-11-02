"""Azure DevOps OAuth and room-grant flow with the shipped catalog entry.

The gateway, broker, persistence, agent routes, and grant lifecycle are real;
only Entra ID and Azure DevOps HTTP endpoints are synthetic.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.service_routes import router as service_router
from switch_core.connections.adapters.oauth import OAuthClientCredentials
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG
from switch_core.connections.oauth_clients import LOOPBACK_CALLBACK_PATH
from switch_core.connections.registry import ClientRegistration, build_adapters
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import ServiceConnection, room_agents
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from switch_core.gateway.service_flows import router as service_flows_router
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import (
    IDENTITY_URL,
    MCP_URL,
    STATIC_CLIENT_ID,
    STATIC_CLIENT_SECRET,
    FakeOAuthServer,
)
from tests.switch_core.connections.service_harness import agent_with_key
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    add_room,
    bearer,
    build_harness,
    cookies_for,
)

PUBLIC = "https://switch.example.com"
SERVICE = "azure-devops"
FLOW = f"/gateway/service-connections/{SERVICE}/flows"
PROFILE = "https://app.vssps.visualstudio.com/_apis/profile/profiles/me"
STORE = ServiceConnectionStore()


class AzureDevOpsWorld:
    def __init__(
        self,
        harness: Harness,
        vendor: FakeOAuthServer,
        http: httpx.AsyncClient,
        broker: ServiceBroker,
    ) -> None:
        self.harness = harness
        self.vendor = vendor
        self.http = http
        self.broker = broker


def _world(session_factory: async_sessionmaker[AsyncSession]) -> AzureDevOpsWorld:
    vendor = FakeOAuthServer()
    vendor.account = {
        "id": "synthetic-profile-id",
        "emailAddress": "ada@example.test",
    }
    vendor.clients[STATIC_CLIENT_ID] = STATIC_CLIENT_SECRET

    def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url) == PROFILE:
            identity_request = httpx.Request(
                request.method, IDENTITY_URL, headers=request.headers
            )
            response = vendor.handle(identity_request)
            if response.status_code != 200:
                return response
            return httpx.Response(200, json=vendor.account)
        if request.url.host == "mcp.dev.azure.com":
            mcp_request = httpx.Request(
                request.method,
                MCP_URL,
                headers=request.headers,
                content=request.content,
            )
            return vendor.handle(mcp_request)
        return vendor.handle(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    adapters = build_adapters(
        CATALOG,
        github_app=None,
        oauth_clients={
            SERVICE: OAuthClientCredentials(
                STATIC_CLIENT_ID, STATIC_CLIENT_SECRET, authentication=None
            )
        },
        http=http,
        registration=ClientRegistration(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            public_url=PUBLIC,
            server_name="switch.example.com",
        ),
    )
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters=adapters,
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=PUBLIC,
    )
    harness = build_harness(session_factory)
    harness.app.state.service_broker = broker
    harness.app.include_router(service_router, prefix="/agents")
    harness.gateway_app.state.service_broker = broker
    harness.gateway_app.state.service_flows = ServiceFlows(
        PUBLIC, SignInFlows(session_factory, TEST_KEYRING)
    )
    harness.gateway_app.include_router(service_connections_router)
    harness.gateway_app.include_router(service_flows_router)
    return AzureDevOpsWorld(harness, vendor, http, broker)


async def _connect(world: AzureDevOpsWorld, client: httpx.AsyncClient, user) -> None:
    state = secrets.token_urlsafe(32)
    completion_secret = secrets.token_urlsafe(32)
    started = await client.post(
        FLOW,
        json={
            "port": 43123,
            "state": state,
            "completion_secret": completion_secret,
        },
        cookies=cookies_for(user),
    )
    assert started.status_code == 200, started.text
    assert started.json()["mode"] == "core"

    left = await client.get(started.json()["url"].removeprefix(PUBLIC))
    assert left.status_code == 307, left.text
    cookie = {f"switch_service_{state}": left.cookies[f"switch_service_{state}"]}
    authorize_url = left.headers["location"]
    query = parse_qs(urlsplit(authorize_url).query)
    assert query["client_id"] == [STATIC_CLIENT_ID]
    assert query["code_challenge_method"] == ["S256"]
    assert set(query["scope"][0].split()) == {
        "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation",
        "offline_access",
    }

    returned_url = urlsplit(world.vendor.authorize(authorize_url))
    assert (
        f"{returned_url.scheme}://{returned_url.netloc}{returned_url.path}"
        == f"{PUBLIC}{FLOW}/callback"
    )
    code = parse_qs(returned_url.query)["code"][0]
    callback = await client.get(
        f"{returned_url.path}?{returned_url.query}", cookies=cookie
    )
    assert callback.status_code == 303
    listener = urlsplit(callback.headers["location"])
    assert (listener.netloc, listener.path) == (
        "127.0.0.1:43123",
        LOOPBACK_CALLBACK_PATH,
    )

    completed = await client.post(
        f"{FLOW}/{state}/complete",
        json={"completion_secret": completion_secret, "code": code},
        cookies=cookies_for(user),
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["account"] == "ada@example.test"
    assert "access_token" not in completed.text


@pytest.mark.asyncio
async def test_azure_devops_oauth_room_grant_refresh_and_revoke(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    world = _world(session_factory)
    owner = await add_member(session_factory, "ada")
    try:
        async with world.harness.client() as client:
            await _connect(world, client, owner)

            catalog = await client.get(
                "/gateway/service-connections", cookies=cookies_for(owner)
            )
            assert catalog.status_code == 200, catalog.text
            azure = next(
                item
                for item in catalog.json()["connections"]
                if item["slug"] == SERVICE
            )
            assert azure["grant_access_levels"] == ["read", "write"]

            async with session_factory() as session:
                connection = await session.scalar(
                    select(ServiceConnection).where(
                        ServiceConnection.user_id == owner.id,
                        ServiceConnection.service == SERVICE,
                    )
                )
                assert connection is not None
                assert connection.oauth_client_id == STATIC_CLIENT_ID
                assert connection.account_id == "synthetic-profile-id"
                assert connection.external_identity == "ada@example.test"
                assert set(connection.granted_scopes) == {
                    "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation",
                    "offline_access",
                }
                secret = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
                assert secret["access_token"] in world.vendor.live_access
                secret["expires_at"] = time.time() - 1
                connection.encrypted_secret = TEST_KEYRING.encrypt(json.dumps(secret))
                await session.commit()

            agent_id, agent_key = await agent_with_key(
                session_factory, owner, "azure-devops-agent"
            )
            room_id = await add_room(session_factory, agent_id, name="azure-devops")
            async with session_factory() as session:
                assert await session.scalar(
                    select(room_agents.c.agent_id).where(
                        room_agents.c.room_id == room_id,
                        room_agents.c.agent_id == agent_id,
                    )
                ) == agent_id

            granted = await client.put(
                f"/gateway/agents/{agent_id}/service-grants/{SERVICE}",
                json={"access": "read", "resources": {}},
                cookies=cookies_for(owner),
            )
            assert granted.status_code == 200, granted.text
            assert granted.json()["grant"]["access"] == "read"

            listed = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(agent_key)
            )
            assert listed.status_code == 200, listed.text
            [grant] = listed.json()["grants"]
            assert grant["service"] == SERVICE
            assert grant["access"] == "read"
            assert grant["mcp_servers"][0]["url"] == "https://mcp.dev.azure.com/"
            assert grant["mcp_servers"][0]["read_only_header"] == "X-MCP-Readonly"
            assert grant["mcp_servers"][0]["headers"]["X-MCP-Readonly"] == "true"
            assert "vendor_access_" not in listed.text

            issued = await client.post(
                f"/agents/{agent_id}/service-tokens/{SERVICE}",
                headers=bearer(agent_key),
            )
            assert issued.status_code == 200, issued.text
            token = issued.json()["token"]
            assert issued.json()["access"] == "read"
            assert token in world.vendor.live_access
            assert any(
                request["grant_type"] == "refresh_token"
                for request in world.vendor.token_requests
            )
            assert all(value not in caplog.text for value in world.vendor.live_access)

            writable = await client.put(
                f"/gateway/agents/{agent_id}/service-grants/{SERVICE}",
                json={"access": "write", "resources": {}},
                cookies=cookies_for(owner),
            )
            assert writable.status_code == 200, writable.text
            listed = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(agent_key)
            )
            assert listed.status_code == 200, listed.text
            [grant] = listed.json()["grants"]
            assert grant["access"] == "write"
            assert "X-MCP-Readonly" not in grant["mcp_servers"][0]["headers"]
            issued_write = await client.post(
                f"/agents/{agent_id}/service-tokens/{SERVICE}",
                headers=bearer(agent_key),
            )
            assert issued_write.status_code == 200, issued_write.text
            assert issued_write.json()["access"] == "write"

            removed = await client.delete(
                f"/gateway/agents/{agent_id}/service-grants/{SERVICE}",
                cookies=cookies_for(owner),
            )
            assert removed.status_code == 200, removed.text
            refused = await client.post(
                f"/agents/{agent_id}/service-tokens/{SERVICE}",
                headers=bearer(agent_key),
            )
            assert refused.status_code == 403
            assert refused.json()["error"]["code"] == "grant_missing"
    finally:
        await world.http.aclose()

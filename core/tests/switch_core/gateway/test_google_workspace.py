"""Google Workspace as the shipped catalog has it, against a fake Google.

The connection is made through Core's callback with the operator's own client,
as a self-hosted server does; the routes run on the real gateway with cookie
sign-in and Postgres, and only Google's HTTP side is faked.
"""

from __future__ import annotations

import json
import secrets
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.broker import Principal, ServiceBroker
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG
from switch_core.connections.oauth_clients import LOOPBACK_CALLBACK_PATH
from switch_core.connections.registry import ClientRegistration, build_adapters
from switch_core.db.models import ServiceConnection, User
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from switch_core.gateway.service_flows import router as service_flows_router
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import (
    GOOGLE_AUTHORIZE,
    GOOGLE_SCOPE,
    STATIC_CLIENT_ID,
    STATIC_CLIENT_SECRET,
    FakeGoogle,
)
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
)

PUBLIC = "https://switch.example.com"
PORT = 43123
SERVICE = "google-workspace"
FLOWS = f"/gateway/service-connections/{SERVICE}/flows"
STORE = ServiceConnectionStore()
WRITE_ONLY = {
    GOOGLE_SCOPE + scope
    for scope in (
        "drive",
        "documents",
        "spreadsheets",
        "presentations",
        "calendar.events",
    )
}


class World:
    def __init__(
        self, harness: Harness, google: FakeGoogle, broker: ServiceBroker
    ) -> None:
        self.harness = harness
        self.google = google
        self.broker = broker


def _world(
    session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
    *,
    client_settings: bool = True,
    disabled: dict[str, str] | None = None,
) -> World:
    google = FakeGoogle()
    environ = {}
    if client_settings:
        path = tmp_path / "google-client.json"
        path.write_text(
            json.dumps(
                {"client_id": STATIC_CLIENT_ID, "client_secret": STATIC_CLIENT_SECRET}
            )
        )
        environ["GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH"] = str(path)
    adapters = build_adapters(
        CATALOG,
        github_app=None,
        environ=environ,
        http=google.client(),
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
        disabled=disabled or {},
        store=STORE,
        token_retention=timedelta(days=30),
    )
    harness = build_harness(session_factory)
    harness.gateway_app.state.service_broker = broker
    harness.gateway_app.state.service_flows = ServiceFlows(PUBLIC)
    harness.gateway_app.include_router(service_connections_router)
    harness.gateway_app.include_router(service_flows_router)
    return World(harness, google, broker)


async def _connect(world: World, client: httpx.AsyncClient, user: User) -> None:
    """Switch Console's side and the person's browser, through Core's callback."""
    state = secrets.token_urlsafe(32)
    secret = secrets.token_urlsafe(32)
    started = await client.post(
        FLOWS,
        json={"port": PORT, "state": state, "completion_secret": secret},
        cookies=cookies_for(user),
    )
    assert started.status_code == 200, started.text
    assert started.json()["mode"] == "core"
    left = await client.get(started.json()["url"].removeprefix(PUBLIC))
    assert left.status_code == 307
    cookie = {f"switch_service_{state}": left.cookies[f"switch_service_{state}"]}
    assert left.headers["location"].startswith(GOOGLE_AUTHORIZE)
    back = urlsplit(world.google.authorize(left.headers["location"]))
    assert f"{back.scheme}://{back.netloc}{back.path}" == f"{PUBLIC}{FLOWS}/callback"
    code = parse_qs(back.query)["code"][0]
    page = await client.get(f"{back.path}?{back.query}", cookies=cookie)
    assert page.status_code == 200
    relayed = await client.post(
        f"{FLOWS}/callback", data={"state": state, "code": code}, cookies=cookie
    )
    assert relayed.status_code == 303
    listener = urlsplit(relayed.headers["location"])
    assert (listener.netloc, listener.path) == (
        f"127.0.0.1:{PORT}",
        LOOPBACK_CALLBACK_PATH,
    )
    assert parse_qs(listener.query)["code"] == [code]
    completed = await client.post(
        f"{FLOWS}/{state}/complete",
        json={"completion_secret": secret, "code": code},
        cookies=cookies_for(user),
    )
    assert completed.status_code == 204, completed.text
    confirmed = await client.post(
        f"{FLOWS}/{state}/confirm",
        json={"completion_secret": secret},
        cookies=cookies_for(user),
    )
    assert confirmed.status_code == 200, confirmed.text


async def _connection(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> ServiceConnection:
    async with session_factory() as session:
        connection = await session.scalar(
            select(ServiceConnection).where(
                ServiceConnection.user_id == user_id,
                ServiceConnection.service == SERVICE,
            )
        )
    assert connection is not None
    return connection


class TestSignIn:
    async def test_signs_in_offline_through_core_and_keeps_the_refresh_token(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        [authorization] = world.google.authorizations
        assert authorization["access_type"] == "offline"
        assert authorization["prompt"] == "consent select_account"
        assert authorization["redirect_uri"] == f"{PUBLIC}{FLOWS}/callback"
        assert "resource" not in authorization
        scopes = authorization["scope"].split()
        assert {"openid", GOOGLE_SCOPE + "userinfo.email"} | WRITE_ONLY <= set(scopes)
        assert not any("gmail" in scope for scope in scopes)
        [exchange] = world.google.token_requests
        assert exchange["grant_type"] == "authorization_code"
        assert exchange["client_secret"] == STATIC_CLIENT_SECRET
        assert exchange["code_verifier"]

        connection = await _connection(session_factory, ada.id)
        assert connection.account_id == "100000000000000000001"
        assert connection.external_identity == "ada@example.test"
        assert connection.consent == "write"
        secret = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert secret["refresh_token"] in world.google.live_refresh
        assert secret["access_token"] in world.google.live_access

    async def test_a_sign_in_without_the_write_scopes_is_read_only(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path)
        world.google.unticked = set(WRITE_ONLY)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)
        assert connection.consent == "read"
        assert not WRITE_ONLY & set(connection.granted_scopes)


class TestAgents:
    async def test_a_granted_agent_gets_gws_and_the_owners_token(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)
        async with session_factory() as session:
            agent = await add_agent(session, name="planner", owner_id=ada.id)
            await STORE.save_grant(
                session,
                agent_id=agent.id,
                owner_id=ada.id,
                service=SERVICE,
                access="write",
                tool_mode="deny",
                tools=[],
                resources={},
                account_id=connection.account_id,
                created_by=ada.id,
            )
            await session.commit()
            [grant] = await world.broker.grants_for(
                session, agent, Principal.agent_key()
            )
        assert grant["mcp_servers"] == []
        [cli] = grant["cli_tools"]
        assert (cli["name"], cli["binary"]) == ("google-workspace", "gws")
        assert cli["release"]["version"] == "0.22.5"
        assert grant["skill"]["name"] == SERVICE

        async with session_factory() as session:
            issued = await world.broker.issue(
                session, agent.id, Principal.agent_key(), SERVICE
            )
        secret = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert issued.token == secret["access_token"]
        assert issued.token in world.google.live_access

    async def test_a_refresh_keeps_googles_reusable_refresh_token(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)
        before = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        adapter = world.broker._adapters[SERVICE]
        refreshed = await adapter.refresh(ConnectionSecret(before))
        assert refreshed.values["refresh_token"] == before["refresh_token"]
        assert refreshed.access_token != before["access_token"]


class TestDisconnect:
    async def test_disconnecting_revokes_the_sign_in_at_google(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
            connection = await _connection(session_factory, ada.id)
            secret = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
            gone = await client.delete(
                f"/gateway/service-connections/{SERVICE}", cookies=cookies_for(ada)
            )
        assert gone.status_code in (200, 204), gone.text
        [revoked] = world.google.revoked
        assert revoked["token"] == secret["refresh_token"]
        assert revoked["client_secret"] == STATIC_CLIENT_SECRET
        assert world.google.live_refresh == {} and world.google.live_access == {}


class TestAvailability:
    @pytest.mark.parametrize(
        ("client_settings", "disabled", "reason"),
        [
            (
                False,
                {},
                "Not set up on this server. Its operator registers an internal "
                "Google app; see the docs.",
            ),
            (
                True,
                {SERVICE: "Coming to this service soon."},
                "Coming to this service soon.",
            ),
        ],
        ids=["no-client-settings", "switched-off"],
    )
    async def test_says_why_google_workspace_cannot_be_used_here(
        self, session_factory, tmp_path, client_settings, disabled, reason
    ) -> None:
        world = _world(
            session_factory,
            tmp_path,
            client_settings=client_settings,
            disabled=disabled,
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(ada)
            )
        [entry] = [
            entry for entry in listed.json()["connections"] if entry["slug"] == SERVICE
        ]
        assert entry["connectable"] is False
        assert entry["unavailable_reason"] == reason

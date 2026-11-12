"""Google Workspace as the shipped catalog has it, against a fake Google.

The connection is made through Core's callback with the operator's own client,
as a self-hosted server does; the routes run on the real gateway with cookie
sign-in and Postgres, and only Google's HTTP side is faked.
"""

from __future__ import annotations

import json
import secrets
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations.my_context import (
    _services as my_context_services,
)
from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.adapters.oauth import OAuthAdapter, OAuthClientCredentials
from switch_core.connections.broker import (
    Principal,
    ServiceBroker,
    ServiceError,
    _scopes_changed,
)
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import (
    CATALOG,
    Connection,
    with_access_profiles,
)
from switch_core.connections.oauth_clients import LOOPBACK_CALLBACK_PATH
from switch_core.connections.registry import ClientRegistration, build_adapters
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import TENANT_ZERO_ID, ServiceConnection, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
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
    *,
    client_settings: bool = True,
    disabled: dict[str, str] | None = None,
    catalog: dict[str, Connection] = CATALOG,
    workspace_gate: bool = False,
) -> World:
    google = FakeGoogle()
    adapters = build_adapters(
        catalog,
        github_app=None,
        oauth_clients=(
            {
                SERVICE: OAuthClientCredentials(
                    STATIC_CLIENT_ID, STATIC_CLIENT_SECRET, authentication=None
                )
            }
            if client_settings
            else {}
        ),
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
        catalog=catalog,
        adapters=adapters,
        organization_apps=None,
        disabled=disabled or {},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=workspace_gate,
        public_url=PUBLIC,
    )
    harness = build_harness(session_factory)
    harness.gateway_app.state.service_broker = broker
    harness.gateway_app.state.service_flows = ServiceFlows(
        PUBLIC, SignInFlows(harness.session_factory, TEST_KEYRING)
    )
    harness.gateway_app.include_router(service_connections_router)
    harness.gateway_app.include_router(service_flows_router)
    return World(harness, google, broker)


async def _connect(world: World, client: httpx.AsyncClient, user: User) -> None:
    state, secret, code = await _signed_in(world, client, user)
    completed = await client.post(
        f"{FLOWS}/{state}/complete",
        json={"completion_secret": secret, "code": code},
        cookies=cookies_for(user),
    )
    assert completed.status_code == 200, completed.text


async def _signed_in(
    world: World, client: httpx.AsyncClient, user: User
) -> tuple[str, str, str]:
    """Switch Console's side and the person's browser, through Core's callback,
    up to Console holding the code: its state, completion secret and code."""
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
    returned = await client.get(f"{back.path}?{back.query}", cookies=cookie)
    assert returned.status_code == 303
    listener = urlsplit(returned.headers["location"])
    assert (listener.netloc, listener.path) == (
        f"127.0.0.1:{PORT}",
        LOOPBACK_CALLBACK_PATH,
    )
    assert parse_qs(listener.query)["code"] == [code]
    return state, secret, code


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


def _another_client(world: World, session_factory) -> OAuthAdapter:
    adapter = build_adapters(
        CATALOG,
        github_app=None,
        oauth_clients={
            SERVICE: OAuthClientCredentials(
                "other-client-id", "example-secret-1111", authentication=None
            )
        },
        http=world.google.client(),
        registration=ClientRegistration(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            public_url=PUBLIC,
            server_name="switch.example.com",
        ),
    )[SERVICE]
    assert isinstance(adapter, OAuthAdapter)
    return adapter


class TestTheClientSignedInThrough:
    async def test_the_connection_records_it(self, session_factory) -> None:
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)
        assert connection.oauth_client_id == STATIC_CLIENT_ID

    async def test_a_client_replaced_during_the_sign_in_is_refused(
        self, session_factory
    ) -> None:
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            state, secret, code = await _signed_in(world, client, ada)
            world.broker.replace_adapter(
                SERVICE, _another_client(world, session_factory)
            )
            completed = await client.post(
                f"{FLOWS}/{state}/complete",
                json={"completion_secret": secret, "code": code},
                cookies=cookies_for(ada),
            )
        assert completed.status_code == 400
        assert completed.json()["detail"] == (
            "Switch's Google Workspace app changed during your sign-in. Start it again."
        )
        assert [
            request
            for request in world.google.token_requests
            if request.get("grant_type") == "authorization_code"
        ] == []

    async def test_a_replaced_client_shows_the_connection_as_needing_reconnecting(
        self, session_factory
    ) -> None:
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
            world.broker.replace_adapter(
                SERVICE, _another_client(world, session_factory)
            )
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(ada)
            )
        [google] = [c for c in listed.json()["connections"] if c["slug"] == SERVICE]
        assert google["status"] == "needs_reauthorization"


class TestFromTheWeb:
    """Google returns sign-ins to Core's callback, so a person connects it
    from the dashboard, with no Switch Console involved."""

    async def test_the_list_offers_it_on_the_web(self, session_factory) -> None:
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            listed = await client.get(
                "/gateway/service-connections", cookies=cookies_for(ada)
            )
        [google] = [c for c in listed.json()["connections"] if c["slug"] == SERVICE]
        assert (google["connectable"], google["web_sign_in"]) == (True, True)

    async def test_connects_from_the_browser_with_offline_access(
        self, session_factory
    ) -> None:
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        session_cookie = cookies_for(ada)
        async with world.harness.client() as client:
            started = await client.post(
                f"{FLOWS}/web", cookies=session_cookie, headers={"Origin": PUBLIC}
            )
            assert started.status_code == 200, started.text
            state = started.json()["id"]
            left = await client.get(
                started.json()["url"].removeprefix(PUBLIC), cookies=session_cookie
            )
            assert left.status_code == 307, left.text
            assert left.headers["location"].startswith(GOOGLE_AUTHORIZE)
            back = urlsplit(world.google.authorize(left.headers["location"]))
            returned = await client.get(
                f"{back.path}?{back.query}",
                cookies={**session_cookie, **dict(left.cookies)},
            )
            assert returned.status_code == 303, returned.text
            assert returned.headers["location"] == (
                f"/connectors/{SERVICE}?sign_in={state}"
            )
            outcome = await client.get(f"{FLOWS}/{state}", cookies=session_cookie)
        assert outcome.json()["status"] == "connected"
        connection = await _connection(session_factory, ada.id)
        assert connection.oauth_client_id == STATIC_CLIENT_ID
        assert connection.status == "active"


class TestSignIn:
    async def test_signs_in_offline_through_core_and_keeps_the_refresh_token(
        self, session_factory
    ) -> None:
        world = _world(session_factory)
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
        self, session_factory
    ) -> None:
        world = _world(session_factory)
        world.google.unticked = set(WRITE_ONLY)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)
        assert connection.consent == "read"
        assert not WRITE_ONLY & set(connection.granted_scopes)


DRIVE_FILE = with_access_profiles(CATALOG, {SERVICE: "drive-file"})
WRITE_ONLY_DRIVE_FILE = (WRITE_ONLY - {GOOGLE_SCOPE + "drive"}) | {
    GOOGLE_SCOPE + "drive.file"
}


class TestTheDriveFileProfile:
    async def test_signs_in_without_googles_restricted_drive_scopes(
        self, session_factory
    ) -> None:
        world = _world(session_factory, catalog=DRIVE_FILE)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        [authorization] = world.google.authorizations
        scopes = set(authorization["scope"].split())
        assert {
            "openid",
            GOOGLE_SCOPE + "userinfo.email",
        } | WRITE_ONLY_DRIVE_FILE <= scopes
        assert not {GOOGLE_SCOPE + "drive", GOOGLE_SCOPE + "drive.readonly"} & scopes
        connection = await _connection(session_factory, ada.id)
        assert connection.consent == "write"

    async def test_a_sign_in_without_the_write_scopes_is_read_only(
        self, session_factory
    ) -> None:
        world = _world(session_factory, catalog=DRIVE_FILE)
        world.google.unticked = set(WRITE_ONLY_DRIVE_FILE)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)
        assert connection.consent == "read"

    async def test_a_granted_agent_is_told_drive_reaches_only_what_it_creates(
        self, session_factory
    ) -> None:
        world = _world(session_factory, catalog=DRIVE_FILE)
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
        assert (
            grant["skill"]["content"]
            == CATALOG[SERVICE].skill_files["drive-file/SKILL.md"]
        )


async def _status(world: World, client: httpx.AsyncClient, user: User) -> str:
    listed = await client.get("/gateway/service-connections", cookies=cookies_for(user))
    assert listed.status_code == 200, listed.text
    [google] = [c for c in listed.json()["connections"] if c["slug"] == SERVICE]
    return google["status"]


class TestTheProfileChanging:
    """A connection made before the server changed SERVICE_ACCESS_PROFILES
    holds scopes its sign-in no longer asks for, or lacks ones it does."""

    @pytest.mark.parametrize(
        ("before", "after", "unticked"),
        [
            (CATALOG, DRIVE_FILE, set()),
            # Still holds drive.readonly, which drive-file avoids.
            (CATALOG, DRIVE_FILE, WRITE_ONLY),
            (DRIVE_FILE, CATALOG, set()),
            (DRIVE_FILE, CATALOG, WRITE_ONLY_DRIVE_FILE),
        ],
        ids=[
            "full-write-to-drive-file",
            "full-read-to-drive-file",
            "drive-file-write-to-full",
            "drive-file-read-to-full",
        ],
    )
    async def test_a_connection_out_of_step_needs_reconnecting(
        self, session_factory, before, after, unticked
    ) -> None:
        world = _world(session_factory, catalog=before)
        world.google.unticked = set(unticked)
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
                access=connection.consent,
                tool_mode="deny",
                tools=[],
                resources={},
                account_id=connection.account_id,
                created_by=ada.id,
            )
            await session.commit()

        later = _world(session_factory, catalog=after)
        async with later.harness.client() as client:
            assert await _status(later, client, ada) == "needs_reauthorization"
        async with session_factory() as session:
            with pytest.raises(ServiceError) as issuing:
                await later.broker.issue(
                    session, agent.id, Principal.agent_key(), SERVICE
                )
            with pytest.raises(ServiceError) as granting:
                await later.broker.set_grant(
                    session,
                    agent=agent,
                    actor_id=ada.id,
                    service=SERVICE,
                    access=None,
                    tool_mode=None,
                    tools=None,
                    resources={},
                )
        for refused in (issuing.value, granting.value):
            assert (refused.status_code, refused.code) == (409, "connector_revoked")
        assert issuing.value.message == (
            "The agent's owner must reconnect Google Workspace: Switch now "
            "asks for other Google Workspace access than the sign-in granted. "
            "Reconnect it in Switch Console, under Connectors."
        )
        assert granting.value.message == (
            "Reconnect Google Workspace in Switch Console, under Connectors, first."
        )
        assert later.google.token_requests == []

    async def test_an_agent_reads_a_connection_out_of_step_as_needing_reconnecting(
        self, session_factory
    ) -> None:
        """`get_my_context` tells an agent what its owner's Connections page
        says, so it does not offer a service that will refuse it."""
        world = _world(session_factory, catalog=CATALOG)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)

        later = _world(session_factory, catalog=DRIVE_FILE)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            services = await my_context_services(
                session,
                SimpleNamespace(service_broker=later.broker),
                {SERVICE: connection},
                [],
                {},
            )
        [google] = [entry for entry in services if entry["slug"] == SERVICE]
        assert google["connection"] == "needs_reauthorization"

    @pytest.mark.parametrize(
        ("catalog", "unticked"),
        [
            (CATALOG, set()),
            (CATALOG, WRITE_ONLY),
            (DRIVE_FILE, set()),
            (DRIVE_FILE, WRITE_ONLY_DRIVE_FILE),
        ],
        ids=["full-write", "full-read", "drive-file-write", "drive-file-read"],
    )
    async def test_a_connection_in_step_stays_active(
        self, session_factory, catalog, unticked
    ) -> None:
        world = _world(session_factory, catalog=catalog)
        world.google.unticked = set(unticked)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
            assert await _status(world, client, ada) == "active"

    @pytest.mark.parametrize("service", ["atlassian", "airtable"])
    def test_an_entry_without_access_profiles_is_not_checked(self, service) -> None:
        connection = ServiceConnection(
            service=service, consent="write", granted_scopes=["not-asked-for"]
        )
        assert not _scopes_changed(connection, DRIVE_FILE[service])


class TestAgents:
    async def test_a_granted_agent_gets_gws_and_the_owners_token(
        self, session_factory
    ) -> None:
        world = _world(session_factory)
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
        self, session_factory
    ) -> None:
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
        connection = await _connection(session_factory, ada.id)
        before = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        adapter = world.broker._adapters[SERVICE]
        refreshed = await adapter.refresh(ConnectionSecret(before))
        assert refreshed.values["refresh_token"] == before["refresh_token"]
        assert refreshed.access_token != before["access_token"]


class TestReconnect:
    """Google ends every sign-in of the account through the client when any
    of them is revoked, so a reconnect must not revoke the sign-in it
    replaces: that would end the new one too."""

    async def test_reconnecting_keeps_the_new_sign_in_working(
        self, session_factory
    ) -> None:
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
            first = json.loads(
                TEST_KEYRING.decrypt(
                    (await _connection(session_factory, ada.id)).encrypted_secret
                )
            )
            await _connect(world, client, ada)
        second = json.loads(
            TEST_KEYRING.decrypt(
                (await _connection(session_factory, ada.id)).encrypted_secret
            )
        )
        assert second["refresh_token"] != first["refresh_token"]
        assert world.google.revoked == []
        assert second["access_token"] in world.google.live_access
        adapter = world.broker._adapters[SERVICE]
        refreshed = await adapter.refresh(ConnectionSecret(second))
        assert refreshed.access_token in world.google.live_access

    async def test_reconnecting_another_account_revokes_the_old_one(
        self, session_factory
    ) -> None:
        """A revocation ends one account's sign-ins only, so the old
        account's is revoked as before."""
        world = _world(session_factory)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect(world, client, ada)
            first = json.loads(
                TEST_KEYRING.decrypt(
                    (await _connection(session_factory, ada.id)).encrypted_secret
                )
            )
            world.google.account = {
                "sub": "100000000000000000002",
                "email": "ada.other@example.test",
            }
            await _connect(world, client, ada)
        second = json.loads(
            TEST_KEYRING.decrypt(
                (await _connection(session_factory, ada.id)).encrypted_secret
            )
        )
        assert [revoked["token"] for revoked in world.google.revoked] == [
            first["refresh_token"]
        ]
        assert first["refresh_token"] not in world.google.live_refresh
        adapter = world.broker._adapters[SERVICE]
        refreshed = await adapter.refresh(ConnectionSecret(second))
        assert refreshed.access_token in world.google.live_access

    async def test_a_sign_in_switch_does_not_keep_leaves_the_connection_working(
        self, session_factory
    ) -> None:
        world = _world(session_factory, workspace_gate=True)
        ada = await add_member(session_factory, "ada")

        async def switch(enabled: bool) -> None:
            async with session_factory() as session:
                await WorkspaceServiceStore().set_enabled(
                    session, SERVICE, enabled, ada.id
                )
                await session.commit()

        await switch(True)
        async with world.harness.client() as client:
            await _connect(world, client, ada)
            state, secret, code = await _signed_in(world, client, ada)
            # Switched off while the person was at Google.
            await switch(False)
            refused = await client.post(
                f"{FLOWS}/{state}/complete",
                json={"completion_secret": secret, "code": code},
                cookies=cookies_for(ada),
            )
        assert refused.status_code == 403, refused.text
        kept = json.loads(
            TEST_KEYRING.decrypt(
                (await _connection(session_factory, ada.id)).encrypted_secret
            )
        )
        assert world.google.revoked == []
        adapter = world.broker._adapters[SERVICE]
        refreshed = await adapter.refresh(ConnectionSecret(kept))
        assert refreshed.access_token in world.google.live_access


class TestDisconnect:
    async def test_disconnecting_revokes_the_sign_in_at_google(
        self, session_factory
    ) -> None:
        world = _world(session_factory)
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
        ("client_settings", "disabled", "reason", "code"),
        [
            (
                False,
                {},
                "Google Workspace is not set up here. Whoever runs Switch can set "
                "it up in Switch Console, under Admin → Connector apps.",
                "app_not_set_up",
            ),
            (
                True,
                {SERVICE: "Coming to this service soon."},
                "Coming to this service soon.",
                "switched_off",
            ),
        ],
        ids=["no-client-settings", "switched-off"],
    )
    async def test_says_why_google_workspace_cannot_be_used_here(
        self, session_factory, client_settings, disabled, reason, code
    ) -> None:
        world = _world(
            session_factory,
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
        assert entry["unavailable_code"] == code

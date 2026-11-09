"""Connecting Datadog through the generic OAuth sign-in, at each of its sites.

The shipped catalog entry and the adapter the server builds for it run on the
real gateway with cookie sign-in and Postgres; Datadog's HTTP side is a
stand-in for each site (`fake_datadog.py`), and Switch Console's listener is
played by following the redirect it would receive.
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters.oauth import OAuthAdapter
from switch_core.connections.broker import Principal, ServiceBroker, ServiceError
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG, RedirectMode
from switch_core.connections.oauth_clients import LOOPBACK_CALLBACK_PATH
from switch_core.connections.registry import ClientRegistration, build_adapter
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import Agent, ServiceConnection, ServiceOAuthClient, User
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from switch_core.gateway.service_flows import router as service_flows_router
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_datadog import (
    LIFETIME,
    READ_PERMISSIONS,
    SITES,
    WRITE_PERMISSIONS,
    FakeDatadog,
)
from tests.switch_core.connections.standing import reconnect_reason
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
)

PUBLIC = "https://switch.example.com"
FLOWS = "/gateway/service-connections/datadog/flows"
CALLBACK = f"{PUBLIC}{FLOWS}/callback"
PORT = 39241
LOOPBACK = [
    f"http://127.0.0.1:{port}{LOOPBACK_CALLBACK_PATH}"
    for port in (39241, 39242, 39243, 39244, 39245)
]
STORE = ServiceConnectionStore()


class World:
    def __init__(
        self, harness: Harness, datadog: FakeDatadog, broker: ServiceBroker
    ) -> None:
        self.harness = harness
        self.datadog = datadog
        self.broker = broker


def _world(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    public_url: str | None,
    named: RedirectMode | None,
    allow_non_expiring_keys: bool = False,
) -> World:
    """The server as `main` builds it for Datadog: its adapter from the
    registry, the way back the server names, whether it allows keys that
    never expire, and the shipped catalog."""
    datadog = FakeDatadog()
    redirects = {} if named is None else {"datadog": named}
    adapter = build_adapter(
        "datadog",
        CATALOG["datadog"].definition,
        github_app=None,
        oauth_client=None,
        http=datadog.client(),
        registration=ClientRegistration(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            public_url=public_url,
            server_name="switch.local",
            redirects=redirects,
        ),
    )
    assert isinstance(adapter, OAuthAdapter)
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={"datadog": adapter},
        organization_apps=None,
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=public_url,
        allow_non_expiring_keys=allow_non_expiring_keys,
    )
    harness = build_harness(session_factory)
    harness.gateway_app.state.service_broker = broker
    harness.gateway_app.state.service_flows = ServiceFlows(
        public_url, redirects, SignInFlows(session_factory, TEST_KEYRING)
    )
    harness.gateway_app.include_router(service_connections_router)
    harness.gateway_app.include_router(service_flows_router)
    return World(harness, datadog, broker)


class Console:
    """Switch Console's side: its state, completion secret and listener port."""

    def __init__(self, client: httpx.AsyncClient, user: User) -> None:
        self.client = client
        self.user = user
        self.state = secrets.token_urlsafe(32)
        self.secret = secrets.token_urlsafe(32)

    async def start(self, site: str) -> httpx.Response:
        return await self.client.post(
            FLOWS,
            json={
                "port": PORT,
                "state": self.state,
                "completion_secret": self.secret,
                "choices": {"site": site},
            },
            cookies=cookies_for(self.user),
        )

    async def complete(self, code: str) -> httpx.Response:
        return await self.client.post(
            f"{FLOWS}/{self.state}/complete",
            json={"completion_secret": self.secret, "code": code},
            cookies=cookies_for(self.user),
        )

    async def status(self) -> httpx.Response:
        return await self.client.get(
            f"{FLOWS}/{self.state}", cookies=cookies_for(self.user)
        )


def _listener_code(url: str, state: str) -> str:
    """What Console's listener takes from the redirect it receives: the code
    for its state, whatever else Datadog adds."""
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == LOOPBACK[0]
    query = parse_qs(parts.query)
    assert query["state"] == [state]
    return query["code"][0]


async def _connect(
    world: World, console: Console, site: str, *, full: bool
) -> httpx.Response:
    started = await console.start(site)
    assert started.status_code == 200, started.text
    code = _listener_code(
        world.datadog.authorize(started.json()["url"], full=full), console.state
    )
    return await console.complete(code)


async def _connection(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> ServiceConnection | None:
    async with session_factory() as session:
        return await STORE.get_connection(session, user_id, "datadog")


async def _due_for_renewal(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    async with session_factory() as session:
        connection = await STORE.get_connection(session, user_id, "datadog")
        assert connection is not None
        values = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        connection.encrypted_secret = TEST_KEYRING.encrypt(
            json.dumps({**values, "expires_at": time.time() + 60})
        )
        await session.commit()


async def _grant(session: AsyncSession, owner: User, account_id: str) -> Agent:
    agent = await add_agent(session, name="sre", owner_id=owner.id)
    await STORE.save_grant(
        session,
        agent_id=agent.id,
        owner_id=owner.id,
        service="datadog",
        access="write",
        tool_mode="deny",
        tools=[],
        resources={},
        account_id=account_id,
        created_by=owner.id,
    )
    await session.commit()
    return agent


class TestSignIn:
    @pytest.mark.parametrize("site", SITES)
    async def test_signs_in_at_the_site_picked_and_keeps_it(
        self, session_factory, site
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        at = world.datadog[site]
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start(site)
            assert started.status_code == 200, started.text
            assert (started.json()["mode"], started.json()["callback_url"]) == (
                "loopback",
                None,
            )
            url = started.json()["url"]
            assert url.startswith(f"{at.authorize_url}?")
            query = parse_qs(urlsplit(url).query)
            assert query["redirect_uri"] == [LOOPBACK[0]]
            assert query["resource"] == [f"https://mcp.{site}/v1/mcp"]
            assert query["scope"] == ["mcp_all"]
            code = _listener_code(
                world.datadog.authorize(url, full=True), console.state
            )
            completed = await console.complete(code)
            assert completed.status_code == 200, completed.text
            assert completed.json() == {
                "warning": None,
                "consent": "write",
                "account": "ada@example.test",
            }
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (
            connection.choices,
            connection.method,
            connection.consent,
            connection.account_id,
            connection.external_identity,
            connection.granted_scopes,
        ) == (
            {"site": site},
            "oauth",
            "write",
            f"user-at-{site}",
            "ada@example.test",
            READ_PERMISSIONS + WRITE_PERMISSIONS,
        )
        secret = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert secret["choices"] == {"site": site}
        # A public client, registered at the picked site for Console's ports.
        [registration] = at.registrations
        assert registration["redirect_uris"] == LOOPBACK
        assert registration["scope"] == "mcp_all"
        assert registration["token_endpoint_auth_method"] == "none"
        async with session_factory() as session:
            [row] = await session.scalars(select(ServiceOAuthClient))
        assert (row.service, row.choice) == ("datadog", site)
        assert connection.oauth_client_id == row.oauth_client_id
        assert all(
            not other.paths
            for name, other in world.datadog.sites.items()
            if name != site
        )

    async def test_limited_access_connects_read_only(self, session_factory) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            completed = await _connect(
                world, Console(client, ada), "datadoghq.eu", full=False
            )
        assert completed.status_code == 200, completed.text
        assert completed.json()["consent"] == "read"
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (connection.consent, connection.granted_scopes) == (
            "read",
            READ_PERMISSIONS,
        )

    async def test_a_token_with_neither_marker_is_refused(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        site = world.datadog["datadoghq.com"]
        mint = site._mint
        site._mint = lambda permissions, refresh: mint(  # type: ignore[method-assign]
            [p for p in permissions if not p.startswith("mcp_")], refresh
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            refused = await _connect(world, console, "datadoghq.com", full=True)
            assert refused.status_code == 400
            assert refused.json()["detail"] == (
                "Datadog granted less than Switch needs to read. Connect again and "
                "allow what it asks for."
            )
            assert (await console.status()).json()["status"] == "failed"
        assert await _connection(session_factory, ada.id) is None

    async def test_a_site_datadog_does_not_have_is_refused_before_datadog(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            refused = await Console(client, ada).start("ddog-gov.com")
        assert refused.status_code == 422
        assert refused.json()["detail"].startswith("Datadog site must be one of ")
        assert all(not site.paths for site in world.datadog.sites.values())

    async def test_returns_through_core_once_the_callback_is_allow_listed(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=PUBLIC, named="core")
        eu = world.datadog["datadoghq.eu"]
        eu.allow_listed.add(CALLBACK)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start("datadoghq.eu")
            assert started.status_code == 200, started.text
            assert (started.json()["mode"], started.json()["callback_url"]) == (
                "core",
                CALLBACK,
            )
            left = await client.get(started.json()["url"].removeprefix(PUBLIC))
            assert left.status_code == 307
            cookie = f"switch_service_{console.state}"
            back = urlsplit(
                world.datadog.authorize(left.headers["location"], full=True)
            )
            assert {"site", "domain", "dd_oid", "dd_org_name"} <= set(
                parse_qs(back.query)
            )
            returned = await client.get(
                f"{back.path}?{back.query}", cookies={cookie: left.cookies[cookie]}
            )
            assert returned.status_code == 303
            # Only the code and state go on to Console; what Datadog adds stays.
            onward = urlsplit(returned.headers["location"])
            assert set(parse_qs(onward.query)) == {"code", "state"}
            code = _listener_code(returned.headers["location"], console.state)
            completed = await console.complete(code)
            assert completed.status_code == 200, completed.text
        [registration] = eu.registrations
        assert registration["redirect_uris"] == [*LOOPBACK, CALLBACK]


class TestUse:
    async def test_refreshes_with_the_reused_refresh_token_at_its_own_site(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        us5 = world.datadog["us5.datadoghq.com"]
        async with world.harness.client() as client:
            completed = await _connect(
                world, Console(client, ada), "us5.datadoghq.com", full=True
            )
            assert completed.status_code == 200, completed.text
        [refresh_token] = us5.live_refresh
        for _ in range(2):
            await _due_for_renewal(session_factory, ada.id)
            async with session_factory() as session:
                token = await world.broker.connection_access_token(
                    session, ada.id, "datadog"
                )
            assert token in us5.live_access
        refreshes = [
            form for form in us5.token_requests if form["grant_type"] == "refresh_token"
        ]
        assert [form["refresh_token"] for form in refreshes] == [refresh_token] * 2
        assert all(
            form["resource"] == "https://mcp.us5.datadoghq.com/v1/mcp"
            for form in refreshes
        )
        assert world.datadog["datadoghq.com"].paths == []

    async def test_an_agent_gets_the_owners_token_and_the_mcp_server_at_its_site(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        eu = world.datadog["datadoghq.eu"]
        async with world.harness.client() as client:
            completed = await _connect(
                world, Console(client, ada), "datadoghq.eu", full=True
            )
            assert completed.status_code == 200, completed.text
        async with session_factory() as session:
            agent = await _grant(session, ada, "user-at-datadoghq.eu")
            [grant] = await world.broker.grants_for(
                session, agent, Principal.agent_key()
            )
            agent_id = agent.id
        assert grant["access"] == "write"
        assert grant["mcp_servers"] == [
            {
                "name": "datadog",
                "url": "https://mcp.datadoghq.eu/v1/mcp",
                "headers": {"Authorization": "Bearer {token}"},
            }
        ]
        assert grant["skill"]["name"] == "datadog"
        async with session_factory() as session:
            issued = await world.broker.issue(
                session, agent_id, Principal.agent_key(), "datadog"
            )
        assert issued.token in eu.live_access
        assert issued.expires_at <= datetime.now(UTC) + timedelta(seconds=LIFETIME)

    async def test_disconnecting_says_where_to_remove_the_sign_in(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            completed = await _connect(
                world, Console(client, ada), "ap1.datadoghq.com", full=False
            )
            assert completed.status_code == 200, completed.text
            removed = await client.delete(
                "/gateway/service-connections/datadog", cookies=cookies_for(ada)
            )
        assert removed.status_code == 200, removed.text
        assert removed.json()["warning"] == (
            "Switch has stopped using the Datadog sign-in but cannot revoke it, so "
            "it still works. Remove it in Datadog under Personal Settings, "
            "Authorized Apps."
        )
        assert await _connection(session_factory, ada.id) is None

    async def test_the_list_says_the_site_each_person_connected_at(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        grace = await add_member(session_factory, "grace")
        async with world.harness.client() as client:
            completed = await _connect(
                world, Console(client, ada), "uk1.datadoghq.com", full=True
            )
            assert completed.status_code == 200, completed.text
            listed = {
                person.name: next(
                    entry
                    for entry in (
                        await client.get(
                            "/gateway/service-connections", cookies=cookies_for(person)
                        )
                    ).json()["connections"]
                    if entry["slug"] == "datadog"
                )
                for person in (ada, grace)
            }
        assert {
            name: (
                entry["status"],
                entry["method"],
                entry["choices"],
                entry["external_identity"],
            )
            for name, entry in listed.items()
        } == {
            "ada": (
                "active",
                "oauth",
                {"site": "uk1.datadoghq.com"},
                "ada@example.test",
            ),
            "grace": ("not_connected", None, None, None),
        }
        assert listed["ada"]["connectable"] is True
        assert listed["ada"]["loopback_ports"] == [39241, 39242, 39243, 39244, 39245]

    async def test_the_list_says_what_to_pick_before_signing_in(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            entries = {
                entry["slug"]: entry
                for entry in (
                    await client.get(
                        "/gateway/service-connections", cookies=cookies_for(ada)
                    )
                ).json()["connections"]
            }
        assert entries["datadog"]["sign_in_choices"] == [
            {
                "name": "site",
                "label": "Datadog site",
                "secret": False,
                "help": "The address you open Datadog at, without app. On Datadog's consent page, Full access lets agents do all your user can, admin actions too; Limited is read-only.",
                "choices": list(SITES),
                "pattern": None,
            }
        ]
        assert entries["datadog"]["key"] is None
        # An entry that asks for nothing before its sign-in, and one with no
        # sign-in of Switch's own.
        assert entries["atlassian"]["sign_in_choices"] is None
        assert entries["github"]["sign_in_choices"] is None


NEVER_EXPIRES = (
    "Datadog keys are long-lived and only Datadog can revoke them, so Switch "
    "does not hand them to agents."
)


CONNECTED_BEFORE = "Datadog was connected before it asked for a site."
FORGOTTEN_KEYS = (
    "Switch has forgotten the pasted Datadog keys but cannot revoke them. "
    "Revoke them in Datadog to stop them working."
)


async def _connected_with_keys_before(
    session_factory: async_sessionmaker[AsyncSession], owner: User
) -> None:
    """A connection made with Datadog's API and application keys when Datadog
    was connected with keys: its row names no site, and its secret records
    neither the method nor the choices, only the site inside its token."""
    token = json.dumps(
        {
            "secret": {"api_key": "SYNTHETIC-KEY", "application_key": "SYNTHETIC"},
            "public": {"site": "datadoghq.eu"},
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    async with session_factory() as session:
        await STORE.save_connection(
            session,
            user_id=owner.id,
            service="datadog",
            consent="write",
            granted_scopes=[],
            account_id="dd-key",
            external_identity="Datadog key · datadoghq.eu",
            encrypted_secret=TEST_KEYRING.encrypt(json.dumps({"access_token": token})),
            oauth_client_id=None,
            method="keys",
            choices={},
        )
        await session.commit()


class TestKeysConnectedBefore:
    """A connection made with Datadog's API and application keys before
    Datadog asked for a site is not filled in from its secret: it must be
    made again, whether or not the server allows keys that never expire."""

    @pytest.mark.parametrize("allow_non_expiring_keys", [False, True])
    async def test_reads_as_needing_reconnecting_and_is_never_used(
        self, session_factory, allow_non_expiring_keys
    ) -> None:
        world = _world(
            session_factory,
            public_url=None,
            named=None,
            allow_non_expiring_keys=allow_non_expiring_keys,
        )
        ada = await add_member(session_factory, "ada")
        await _connected_with_keys_before(session_factory, ada)
        async with session_factory() as session:
            agent = await _grant(session, ada, "dd-key")
            agent_id = agent.id
            # Its grant is kept, and left out of every session's grants.
            assert (
                await world.broker.grants_for(session, agent, Principal.agent_key())
                == []
            )
            with pytest.raises(ServiceError) as regranted:
                await world.broker.set_grant(
                    session,
                    agent=agent,
                    actor_id=ada.id,
                    service="datadog",
                    access=None,
                    tool_mode=None,
                    tools=None,
                    resources={},
                )
        assert (regranted.value.status_code, regranted.value.message) == (
            409,
            f"{CONNECTED_BEFORE} Reconnect Datadog in Switch Console, under "
            "Connectors, first.",
        )
        async with world.harness.client() as client:
            listed = next(
                entry
                for entry in (
                    await client.get(
                        "/gateway/service-connections", cookies=cookies_for(ada)
                    )
                ).json()["connections"]
                if entry["slug"] == "datadog"
            )
        assert (
            listed["status"],
            listed["method"],
            listed["choices"],
            listed["reconnect_code"],
            listed["reconnect_reason"],
        ) == (
            "needs_reauthorization",
            "keys",
            {},
            "choices_missing",
            f"{CONNECTED_BEFORE} Connect it again.",
        )
        async with session_factory() as session:
            with pytest.raises(ServiceError) as refused:
                await world.broker.issue(
                    session, agent_id, Principal.agent_key(), "datadog"
                )
        assert (refused.value.status_code, refused.value.code) == (
            409,
            "connector_revoked",
        )
        assert refused.value.message == (
            f"{CONNECTED_BEFORE} The agent's owner must reconnect Datadog in "
            "Switch Console, under Connectors."
        )
        async with session_factory() as session:
            with pytest.raises(ServiceError) as owners:
                await world.broker.connection_access_token(session, ada.id, "datadog")
        assert owners.value.message == (
            f"{CONNECTED_BEFORE} Reconnect Datadog in Switch Console, under Connectors."
        )
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        # Nothing was filled in, and Datadog was never called.
        assert (connection.status, connection.choices) == ("active", {})
        assert all(not site.paths for site in world.datadog.sites.values())

    async def test_disconnecting_it_says_switch_cannot_revoke_the_keys(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        await _connected_with_keys_before(session_factory, ada)
        async with world.harness.client() as client:
            removed = await client.delete(
                "/gateway/service-connections/datadog", cookies=cookies_for(ada)
            )

        assert removed.status_code == 200, removed.text
        assert removed.json()["warning"] == FORGOTTEN_KEYS
        assert await _connection(session_factory, ada.id) is None

    async def test_signing_in_replaces_it_and_says_switch_cannot_revoke_the_keys(
        self, session_factory
    ) -> None:
        world = _world(session_factory, public_url=None, named=None)
        ada = await add_member(session_factory, "ada")
        await _connected_with_keys_before(session_factory, ada)
        async with world.harness.client() as client:
            completed = await _connect(
                world, Console(client, ada), "datadoghq.eu", full=True
            )

        assert completed.status_code == 200, completed.text
        assert completed.json()["warning"] == FORGOTTEN_KEYS
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (connection.method, connection.choices) == (
            "oauth",
            {"site": "datadoghq.eu"},
        )
        assert await reconnect_reason(world.broker, connection) is None

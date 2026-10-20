"""Connecting a service through the generic OAuth sign-in, both ways back.

The routes run on the real gateway with cookie sign-in and Postgres; the
vendor's HTTP side is the fake OAuth server, and Switch Console's listener is
played by following the redirect it would receive.
"""

from __future__ import annotations

import json
import secrets
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters.oauth import OAuthAdapter
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG_ROOT, load_catalog
from switch_core.connections.oauth_clients import (
    LOOPBACK_CALLBACK_PATH,
    RegisteredClient,
    redirect_uris,
)
from switch_core.connections.sign_in_flows import MAX_FLOWS, SignInFlows
from switch_core.db.models import ServiceConnection, SignInFlow, User
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from switch_core.gateway.service_flows import router as service_flows_router
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeOAuthServer
from tests.switch_core.connections.test_loader import OAUTH_ENTRY, _write_example
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
)

PUBLIC = "https://switch.example.com"
PORT = 43123
FLOWS = "/gateway/service-connections/example/flows"
STORE = ServiceConnectionStore()


class World:
    def __init__(
        self,
        harness: Harness,
        vendor: FakeOAuthServer,
        flows: ServiceFlows,
        broker: ServiceBroker,
    ) -> None:
        self.harness = harness
        self.vendor = vendor
        self.flows = flows
        self.broker = broker


def _world(
    session_factory: async_sessionmaker[AsyncSession],
    root: Path,
    *,
    redirect: str = "[loopback, core]",
    public_url: str | None = None,
    disabled: dict[str, str] | None = None,
    workspace_gate: bool = False,
) -> World:
    shutil.copytree(CATALOG_ROOT, root)
    # The vendor matches a loopback redirect's port, as Atlassian does.
    ports = "\n    loopback_ports: [43123, 43124]" if "loopback" in redirect else ""
    _write_example(
        root,
        OAUTH_ENTRY.replace(
            "redirect: [loopback, core]", f"redirect: {redirect}{ports}"
        ),
    )
    catalog = load_catalog(root)
    oauth = catalog["example"].definition.auth.oauth
    assert oauth is not None
    vendor = FakeOAuthServer()
    client = RegisteredClient(
        service="example",
        name="Example",
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        http=vendor.client(),
        client_name="Switch (switch.example.com)",
        redirect_uris=redirect_uris(
            "example", oauth.redirect, PUBLIC, oauth.loopback_ports
        ),
        scopes=["read:items", "write:items"],
    )
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=catalog,
        adapters={
            "example": OAuthAdapter(
                catalog["example"].definition, client, vendor.client()
            )
        },
        disabled=disabled or {},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=workspace_gate,
        public_url=None,
    )
    harness = build_harness(session_factory)
    harness.gateway_app.state.service_broker = broker
    flows = ServiceFlows(public_url, SignInFlows(session_factory, TEST_KEYRING))
    harness.gateway_app.state.service_flows = flows
    harness.gateway_app.include_router(service_connections_router)
    harness.gateway_app.include_router(service_flows_router)
    return World(harness, vendor, flows, broker)


class Console:
    """Switch Console's side: its state, completion secret and listener port."""

    def __init__(self, client: httpx.AsyncClient, user: User) -> None:
        self.client = client
        self.user = user
        self.state = secrets.token_urlsafe(32)
        self.secret = secrets.token_urlsafe(32)

    async def start(self, service: str = "example", port: int = PORT) -> httpx.Response:
        return await self.client.post(
            f"/gateway/service-connections/{service}/flows",
            json={"port": port, "state": self.state, "completion_secret": self.secret},
            cookies=cookies_for(self.user),
        )

    async def complete(self, code: str, secret: str | None = None) -> httpx.Response:
        return await self.client.post(
            f"{FLOWS}/{self.state}/complete",
            json={"completion_secret": secret or self.secret, "code": code},
            cookies=cookies_for(self.user),
        )

    async def status(self) -> httpx.Response:
        return await self.client.get(
            f"{FLOWS}/{self.state}", cookies=cookies_for(self.user)
        )

    async def drop(self) -> httpx.Response:
        return await self.client.delete(
            f"{FLOWS}/{self.state}", cookies=cookies_for(self.user)
        )


def _listener_code(url: str, state: str) -> str:
    """What Console's listener takes from the redirect it receives."""
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}" == f"http://127.0.0.1:{PORT}"
    assert parts.path == LOOPBACK_CALLBACK_PATH
    query = parse_qs(parts.query)
    assert query["state"] == [state]
    return query["code"][0]


async def _flow_ids(session_factory: async_sessionmaker[AsyncSession]) -> set[str]:
    async with session_factory() as session:
        return set((await session.execute(select(SignInFlow.id))).scalars())


async def _flow_row(
    session_factory: async_sessionmaker[AsyncSession], state: str
) -> SignInFlow:
    async with session_factory() as session:
        row = await session.scalar(select(SignInFlow).where(SignInFlow.id == state))
    assert row is not None
    return row


async def _connection(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> ServiceConnection | None:
    async with session_factory() as session:
        return await session.scalar(
            select(ServiceConnection).where(
                ServiceConnection.user_id == user_id,
                ServiceConnection.service == "example",
            )
        )


async def _loopback_code(world: World, console: Console) -> str:
    """Start, sign in at the vendor, and take the code as Console's listener does."""
    started = await console.start()
    assert started.status_code == 200, started.text
    return _listener_code(world.vendor.authorize(started.json()["url"]), console.state)


async def _loopback_connect(world: World, console: Console) -> httpx.Response:
    completed = await console.complete(await _loopback_code(world, console))
    assert completed.status_code == 200, completed.text
    return completed


class TestLoopback:
    async def test_signs_in_through_console_and_writes_the_connection(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            assert started.status_code == 200, started.text
            assert started.json()["mode"] == "loopback"
            assert started.json()["id"] == console.state
            url = started.json()["url"]
            query = parse_qs(urlsplit(url).query)
            assert query["redirect_uri"] == [
                f"http://127.0.0.1:{PORT}{LOOPBACK_CALLBACK_PATH}"
            ]
            assert query["scope"] == ["read:items write:items"]
            assert query["state"] == [console.state]
            assert "code_verifier" not in url

            code = _listener_code(world.vendor.authorize(url), console.state)
            pending = await console.status()
            assert pending.json() == {
                "status": "pending",
                "account": None,
                "error": None,
                "warning": None,
            }
            assert await _connection(session_factory, ada.id) is None
            completed = await console.complete(code)
            assert completed.status_code == 200, completed.text
            assert completed.json() == {
                "warning": None,
                "consent": "write",
                "account": "ada@example.test",
            }
            # The outcome stays readable, without the token, until Console drops it.
            assert (await console.status()).json() == {
                "status": "connected",
                "account": "ada@example.test",
                "error": None,
                "warning": None,
            }
            flow = await _flow_row(session_factory, console.state)
            assert flow.encrypted_result is None
            assert (await console.drop()).status_code == 204
            assert (await console.status()).status_code == 410

        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (connection.account_id, connection.external_identity) == (
            "acct-1",
            "ada@example.test",
        )
        assert (connection.consent, connection.status) == ("write", "active")
        assert connection.granted_scopes == ["read:items", "write:items"]
        secret = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert secret["refresh_token"] in world.vendor.live_refresh
        assert await _flow_ids(session_factory) == set()

    async def test_a_code_is_completed_once(self, session_factory, tmp_path) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            code = _listener_code(
                world.vendor.authorize(started.json()["url"]), console.state
            )
            assert (await console.complete(code)).status_code == 200
            replayed = await console.complete(code)
            assert replayed.status_code == 400
            assert len(world.vendor.token_requests) == 1

    async def test_the_completion_secret_ties_the_code_to_the_console_that_started(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            code = _listener_code(
                world.vendor.authorize(started.json()["url"]), console.state
            )
            refused = await console.complete(code, secret=secrets.token_urlsafe(32))
            assert refused.status_code == 400
            assert world.vendor.token_requests == []

    async def test_a_state_is_used_once(self, session_factory, tmp_path) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            assert (await console.start()).status_code == 200
            again = await console.start()
            assert again.status_code == 409
            assert "already been used" in again.json()["detail"]

    async def test_an_expired_flow_is_gone(self, session_factory, tmp_path) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            code = _listener_code(
                world.vendor.authorize(started.json()["url"]), console.state
            )
            async with session_factory() as session:
                await session.execute(
                    update(SignInFlow)
                    .where(SignInFlow.id == console.state)
                    .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
                await session.commit()
            assert (await console.complete(code)).status_code == 410
            assert (await console.status()).status_code == 410

    async def test_one_flow_per_person_and_another_persons_is_not_found(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        grace = await add_member(session_factory, "grace")
        async with world.harness.client() as client:
            first = Console(client, ada)
            assert (await first.start()).status_code == 200
            second = Console(client, ada)
            assert (await second.start()).status_code == 200
            assert (await first.status()).status_code == 410
            assert (await second.status()).status_code == 200
            intruder = Console(client, grace)
            intruder.state = second.state
            assert (await intruder.status()).status_code == 410

    async def test_too_many_flows_at_once_are_refused(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        users = [await add_member(session_factory, f"u{i}") for i in range(2)]
        async with world.harness.client() as client:
            assert (await Console(client, users[0]).start()).status_code == 200
            async with session_factory() as session:
                template = await session.scalar(select(SignInFlow))
                assert template is not None
                columns = {
                    column.key: getattr(template, column.key)
                    for column in SignInFlow.__table__.columns
                }
                for i in range(MAX_FLOWS - 1):
                    session.add(SignInFlow(**{**columns, "id": f"filler-{i}"}))
                await session.commit()
            busy = await Console(client, users[1]).start()
            assert busy.status_code == 409
            assert "Too many sign-ins" in busy.json()["detail"]

    async def test_registers_one_client_for_every_person(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        grace = await add_member(session_factory, "grace")
        async with world.harness.client() as client:
            # Registration happens as the first sign-in starts.
            await _loopback_code(world, Console(client, ada))
            await _loopback_code(world, Console(client, grace))
        assert len(world.vendor.registrations) == 1

    async def test_an_account_linked_to_someone_else_is_refused(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        grace = await add_member(session_factory, "grace")
        async with world.harness.client() as client:
            await _loopback_connect(world, Console(client, ada))
            second = Console(client, grace)
            refused = await second.complete(await _loopback_code(world, second))
            assert refused.status_code == 409
            assert refused.json()["code"] == "account_linked_elsewhere"
            # The flow reads failed with the reason, for Console to show.
            assert (await second.status()).json()["status"] == "failed"
            assert "already linked" in (await second.status()).json()["error"]
        assert await _connection(session_factory, grace.id) is None

    async def test_a_sign_in_granted_only_reading_connects_read_only(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        mint = world.vendor.mint
        world.vendor.mint = lambda scopes: mint(["read:items"])  # type: ignore[method-assign]
        async with world.harness.client() as client:
            console = Console(client, ada)
            connected = await _loopback_connect(world, console)
            assert connected.json()["consent"] == "read"
        connection = await _connection(session_factory, ada.id)
        assert connection is not None and connection.consent == "read"


class TestLongCodes:
    """Atlassian's codes run past 2,000 characters (2,177 in a live sign-in)."""

    async def test_a_long_code_comes_back_to_console(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        world.vendor.code_length = 2177
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            code = _listener_code(
                world.vendor.authorize(started.json()["url"]), console.state
            )
            assert len(code) == 2177
            assert (await console.complete(code)).status_code == 200

    async def test_a_long_code_comes_back_through_core(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        world.vendor.code_length = 2177
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            left = await client.get(started.json()["url"].removeprefix(PUBLIC))
            cookie = {
                f"switch_service_{console.state}": left.cookies[
                    f"switch_service_{console.state}"
                ]
            }
            back = urlsplit(world.vendor.authorize(left.headers["location"]))
            code = parse_qs(back.query)["code"][0]
            returned = await client.get(f"{back.path}?{back.query}", cookies=cookie)
            assert returned.status_code == 303
            assert _listener_code(returned.headers["location"], console.state) == code
            assert (await console.complete(code)).status_code == 200


class TestLoopbackPorts:
    async def test_signs_in_on_any_registered_port(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start(port=43124)
            assert started.status_code == 200, started.text
            back = urlsplit(world.vendor.authorize(started.json()["url"]))
            assert f"{back.scheme}://{back.netloc}{back.path}" == (
                f"http://127.0.0.1:43124{LOOPBACK_CALLBACK_PATH}"
            )
            code = parse_qs(back.query)["code"][0]
            assert (await console.complete(code)).status_code == 200

    async def test_refuses_a_port_the_vendor_would_not_take(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            refused = await Console(client, ada).start(port=43999)
        assert refused.status_code == 409
        assert "port 43123, 43124" in refused.json()["detail"]
        assert await _flow_ids(session_factory) == set()


class TestCoreCallback:
    async def test_returns_through_core_straight_to_console(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            assert started.status_code == 200, started.text
            assert started.json()["mode"] == "core"
            authorize = started.json()["url"]
            assert authorize.startswith(f"{PUBLIC}{FLOWS}/authorize?state=")

            left = await client.get(authorize.removeprefix(PUBLIC))
            assert left.status_code == 307
            cookie = left.cookies.get(f"switch_service_{console.state}")
            assert cookie
            vendor_url = left.headers["location"]
            assert parse_qs(urlsplit(vendor_url).query)["redirect_uri"] == [
                f"{PUBLIC}{FLOWS}/callback"
            ]
            # The authorize step is the flow's once.
            assert (await client.get(authorize.removeprefix(PUBLIC))).status_code == 400

            back = urlsplit(world.vendor.authorize(vendor_url))
            assert (
                f"{back.scheme}://{back.netloc}{back.path}"
                == f"{PUBLIC}{FLOWS}/callback"
            )
            query = parse_qs(back.query)
            code = query["code"][0]
            path = f"{back.path}?{back.query}"

            # Only the browser that left through Core may bring the code back,
            # and it is sent straight on to Console's listener, once.
            stranger = await client.get(path)
            assert stranger.status_code == 400
            returned = await client.get(
                path, cookies={f"switch_service_{console.state}": cookie}
            )
            assert returned.status_code == 303
            assert _listener_code(returned.headers["location"], console.state) == code
            assert "max-age=0" in returned.headers["set-cookie"].lower()
            again = await client.get(
                path, cookies={f"switch_service_{console.state}": cookie}
            )
            assert again.status_code == 400

            assert (await console.complete(code)).status_code == 200
        connection = await _connection(session_factory, ada.id)
        assert connection is not None and connection.account_id == "acct-1"
        [exchange] = [
            request
            for request in world.vendor.token_requests
            if request["grant_type"] == "authorization_code"
        ]
        assert exchange["redirect_uri"] == f"{PUBLIC}{FLOWS}/callback"

    async def test_the_cookie_is_secure_except_on_this_computer(
        self, session_factory, tmp_path
    ) -> None:
        # A server Switch Console runs is reached over plain http on the
        # loopback address, where a Secure cookie may be dropped by the browser.
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            remote = Console(client, ada)
            started = await remote.start()
            authorize = started.json()["url"].removeprefix(PUBLIC)
            left = await client.get(f"https://switch.example.test{authorize}")
            assert "secure" in left.headers["set-cookie"].lower()

            local = Console(client, ada)
            started = await local.start()
            authorize = started.json()["url"].removeprefix(PUBLIC)
            left = await client.get(f"http://127.0.0.1:51001{authorize}")
            assert left.status_code == 307
            assert "secure" not in left.headers["set-cookie"].lower()

    async def test_a_code_cannot_skip_core(self, session_factory, tmp_path) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            left = await client.get(started.json()["url"].removeprefix(PUBLIC))
            back = urlsplit(world.vendor.authorize(left.headers["location"]))
            code = parse_qs(back.query)["code"][0]
            assert (await console.complete(code)).status_code == 400

    async def test_core_mode_needs_a_public_address(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog", redirect="[core]")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            refused = await Console(client, ada).start()
        assert refused.status_code == 409
        assert "GATEWAY_PUBLIC_URL" in refused.json()["detail"]


class TestRefusals:
    async def test_a_switched_off_service_cannot_be_connected(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", disabled={"example": "Not here yet."}
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            refused = await Console(client, ada).start()
        assert refused.status_code == 403
        assert refused.json() == {
            "detail": "Not here yet.",
            "code": "forbidden",
            "retryable": False,
        }

    async def test_github_keeps_its_own_sign_in(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            refused = await Console(client, ada).start("github")
        assert refused.status_code == 404
        assert "its own sign-in" in refused.json()["detail"]


WORKSPACE_REFUSAL = {
    "detail": (
        "Example is not enabled in this workspace. Ask a workspace admin; they "
        "switch it on under Connectors in Switch Console."
    ),
    "code": "forbidden",
    "retryable": False,
}


async def _switch(
    session_factory: async_sessionmaker[AsyncSession], enabled: bool, admin: User
) -> None:
    async with session_factory() as session:
        await WorkspaceServiceStore().set_enabled(session, "example", enabled, admin.id)
        await session.commit()


class TestWorkspaceSwitch:
    async def test_a_service_the_workspace_switched_off_is_refused_before_the_vendor(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog", workspace_gate=True)
        ada = await add_member(session_factory, "ada")
        await _switch(session_factory, False, ada)
        async with world.harness.client() as client:
            refused = await Console(client, ada).start()
        assert refused.status_code == 403
        assert refused.json() == WORKSPACE_REFUSAL
        assert world.vendor.paths == []
        assert world.vendor.registrations == []
        assert await _flow_ids(session_factory) == set()

    async def test_switched_back_on_it_proceeds(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog", workspace_gate=True)
        ada = await add_member(session_factory, "ada")
        await _switch(session_factory, False, ada)
        await _switch(session_factory, True, ada)
        async with world.harness.client() as client:
            started = await Console(client, ada).start()
        assert started.status_code == 200, started.text

    async def test_with_the_gate_off_the_switch_is_ignored(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog", workspace_gate=False)
        ada = await add_member(session_factory, "ada")
        await _switch(session_factory, False, ada)
        async with world.harness.client() as client:
            started = await Console(client, ada).start()
        assert started.status_code == 200, started.text

    async def test_switched_off_mid_sign_in_the_issued_sign_in_is_revoked(
        self, session_factory, tmp_path
    ) -> None:
        # Revoking at the endpoint the vendor advertises, as Atlassian does.
        world = _world(
            session_factory,
            tmp_path / "catalog",
            redirect="[loopback, core]\n    revocation_discovered: true",
            workspace_gate=True,
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            code = await _loopback_code(world, console)
            await _switch(session_factory, False, ada)
            refused = await console.complete(code)
        assert refused.status_code == 403
        assert refused.json() == WORKSPACE_REFUSAL
        assert await _connection(session_factory, ada.id) is None
        # The one refresh token the vendor issued for this sign-in is revoked.
        assert [form["token_type_hint"] for form in world.vendor.revoked] == [
            "refresh_token"
        ]
        assert world.vendor.live_refresh == {}
        flow = await _flow_row(session_factory, console.state)
        assert (flow.status, flow.encrypted_result) == ("failed", None)
        assert flow.error == WORKSPACE_REFUSAL["detail"]

    async def test_a_sign_in_that_cannot_be_revoked_says_what_to_do(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog", workspace_gate=True)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            code = await _loopback_code(world, console)
            await _switch(session_factory, False, ada)
            refused = await console.complete(code)
        assert refused.status_code == 403
        assert refused.json() == {
            **WORKSPACE_REFUSAL,
            "detail": WORKSPACE_REFUSAL["detail"]
            + " Switch could not revoke the sign-in Example just issued. Remove "
            "Switch from your Example account's connected apps.",
        }
        assert await _connection(session_factory, ada.id) is None

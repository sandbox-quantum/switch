"""Connecting a service through the generic OAuth sign-in, both ways back.

The routes run on the real gateway with cookie sign-in and Postgres; the
vendor's HTTP side is the fake OAuth server, and Switch Console's listener is
played by following the redirect it would receive.
"""

from __future__ import annotations

import json
import secrets
import shutil
import time
from datetime import UTC, datetime, timedelta
from html import escape
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters.oauth import OAuthAdapter
from switch_core.connections.broker import Principal, ServiceBroker
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG_ROOT, load_catalog
from switch_core.connections.oauth_clients import (
    LOOPBACK_CALLBACK_PATH,
    RegisteredClient,
    redirect_uris,
)
from switch_core.connections.sign_in_flows import MAX_FLOWS, SignInFlows
from switch_core.db.models import (
    ServiceConnection,
    ServiceOAuthClient,
    SignInFlow,
    User,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from switch_core.gateway.service_flows import router as service_flows_router
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import (
    ISSUER,
    FakeOAuthServer,
    FakeSites,
)
from tests.switch_core.connections.test_loader import (
    CHOICES_ENTRY,
    OAUTH_ENTRY,
    _write_example,
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
    markers: str = "",
) -> World:
    shutil.copytree(CATALOG_ROOT, root)
    # The vendor matches a loopback redirect's port, as Atlassian does.
    ports = "\n    loopback_ports: [43123, 43124]" if "loopback" in redirect else ""
    _write_example(
        root,
        OAUTH_ENTRY.replace(
            "redirect: [loopback, core]", f"redirect: {redirect}{ports}"
        ).replace("tools: {", f"{markers}tools: {{"),
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

    async def start(
        self,
        service: str = "example",
        port: int = PORT,
        choices: dict[str, str] | None = None,
    ) -> httpx.Response:
        body: dict[str, object] = {
            "port": port,
            "state": self.state,
            "completion_secret": self.secret,
        }
        if choices is not None:
            body["choices"] = choices
        return await self.client.post(
            f"/gateway/service-connections/{service}/flows",
            json=body,
            cookies=cookies_for(self.user),
        )

    async def complete(self, code: str, secret: str | None = None) -> httpx.Response:
        return await self.client.post(
            f"{FLOWS}/{self.state}/complete",
            json={"completion_secret": secret or self.secret, "code": code},
            cookies=cookies_for(self.user),
        )

    async def fail(
        self, error: str, description: str | None, secret: str | None = None
    ) -> httpx.Response:
        """What the listener does when the vendor sends it a refusal."""
        return await self.client.post(
            f"{FLOWS}/{self.state}/fail",
            json={
                "completion_secret": secret or self.secret,
                "error": error,
                "error_description": description,
            },
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

    async def test_a_refusal_the_listener_was_sent_fails_the_flow_with_the_vendors_words(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            assert (await console.start()).status_code == 200
            forged = await console.fail(
                "server_error", "Denied.", secret=secrets.token_urlsafe(32)
            )
            assert forged.status_code == 400
            assert (await console.status()).json()["status"] == "pending"
            failed = await console.fail(
                "server_error", "Your identity provider refused <i>Example</i>"
            )
            assert failed.status_code == 204, failed.text
            assert (await console.status()).json() == {
                "status": "failed",
                "account": None,
                "error": (
                    "Example refused the sign-in: Your identity provider refused "
                    "Example."
                ),
                "warning": None,
            }
            # Once per flow: the refusal recorded stays.
            assert (await console.fail("access_denied", None)).status_code == 400
            assert "identity provider" in (await console.status()).json()["error"]
        assert world.vendor.token_requests == []

    async def test_declining_at_the_vendor_reads_as_cancelled(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            assert (await console.start()).status_code == 200
            assert (await console.fail("access_denied", None)).status_code == 204
            assert (await console.status()).json()["error"] == (
                "Example sign-in was cancelled."
            )

    async def test_a_sign_in_granted_only_reading_connects_read_only(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        mint = world.vendor.mint
        world.vendor.mint = lambda scopes, client_id: mint(["read:items"], client_id)  # type: ignore[method-assign]
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

    async def test_a_refusal_at_the_vendor_fails_the_flow_with_what_it_said(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
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
            refusal = {
                "state": console.state,
                "error": "server_error",
                "error_description": "Your <b>identity provider</b> refused Example",
            }
            # Only the browser that left through Core can end its flow.
            stranger = await client.get(f"{FLOWS}/callback", params=refusal)
            assert stranger.status_code == 400
            assert (await console.status()).json()["status"] == "pending"

            returned = await client.get(
                f"{FLOWS}/callback", params=refusal, cookies=cookie
            )
            said = (
                "Example refused the sign-in: Your identity provider refused Example."
            )
            assert returned.status_code == 400
            assert f"<p>{said} Return to Switch Console.</p>" in returned.text
            assert (await console.status()).json() == {
                "status": "failed",
                "account": None,
                "error": said,
                "warning": None,
            }
        assert world.vendor.token_requests == []

    async def test_declining_at_the_vendor_reads_as_cancelled(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            left = await client.get(started.json()["url"].removeprefix(PUBLIC))
            returned = await client.get(
                f"{FLOWS}/callback",
                params={"state": console.state, "error": "access_denied"},
                cookies={
                    f"switch_service_{console.state}": left.cookies[
                        f"switch_service_{console.state}"
                    ]
                },
            )
            assert returned.status_code == 400
            assert "Example sign-in was cancelled." in returned.text
            assert (await console.status()).json()["error"] == (
                "Example sign-in was cancelled."
            )

    async def test_console_cannot_fail_a_flow_that_returns_through_core(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            await client.get(started.json()["url"].removeprefix(PUBLIC))
            assert (await console.fail("server_error", "Denied.")).status_code == 400
            assert (await console.status()).json()["status"] == "pending"

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


class TestRefusedOnTheWay:
    """A sign-in refused before Core takes a code fails at once with the
    reason, rather than read pending until it expires."""

    async def test_an_app_removed_before_the_browser_leaves(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            world.broker.replace_adapter("example", None)
            left = await client.get(started.json()["url"].removeprefix(PUBLIC))
            flow = (await console.status()).json()
        said = world.broker.availability("example")
        assert said is not None
        assert left.status_code == 400
        assert (flow["status"], flow["error"]) == ("failed", said)
        assert f"<p>{escape(said)}</p>" in left.text
        assert world.vendor.authorizations == []

    async def test_a_vendor_that_will_not_register_switch(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(
            session_factory, tmp_path / "catalog", redirect="[core]", public_url=PUBLIC
        )
        world.vendor.fail[f"{ISSUER}/register"] = (400, {})
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start()
            left = await client.get(started.json()["url"].removeprefix(PUBLIC))
            flow = (await console.status()).json()
        said = "Example refused to register Switch as a client (HTTP 400)."
        assert left.status_code == 400
        assert (flow["status"], flow["error"]) == ("failed", said)
        assert f"<p>{said}</p>" in left.text

    async def test_an_app_removed_before_the_code_is_handed_back(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            code = await _loopback_code(world, console)
            world.broker.replace_adapter("example", None)
            refused = await console.complete(code)
            flow = (await console.status()).json()
        assert refused.status_code == 503
        assert (flow["status"], flow["error"]) == (
            "failed",
            world.broker.availability("example"),
        )
        assert world.vendor.token_requests == []


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
        await _switch(session_factory, True, ada)
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
        await _switch(session_factory, True, ada)
        async with world.harness.client() as client:
            console = Console(client, ada)
            code = await _loopback_code(world, console)
            await _switch(session_factory, False, ada)
            refused = await console.complete(code)
        assert refused.status_code == 403
        assert refused.json() == {
            **WORKSPACE_REFUSAL,
            "detail": WORKSPACE_REFUSAL["detail"]
            + " Switch has stopped using the Example sign-in but cannot revoke it, "
            "so it still works. Remove Switch under Connected apps in Example.",
        }
        assert await _connection(session_factory, ada.id) is None


SITES = ("example.test", "eu.example.test")


class SitesWorld:
    def __init__(
        self, harness: Harness, sites: FakeSites, broker: ServiceBroker
    ) -> None:
        self.harness = harness
        self.sites = sites
        self.broker = broker


def _sites_world(
    session_factory: async_sessionmaker[AsyncSession], root: Path
) -> SitesWorld:
    """Example at two sites, chosen before signing in, each its own
    authorization server, accounts and MCP server."""
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(
        root,
        CHOICES_ENTRY.replace(
            "redirect: [loopback, core]",
            "redirect: [loopback, core]\n    loopback_ports: [43123, 43124]\n"
            "    revocation_discovered: true",
        ),
    )
    catalog = load_catalog(root)
    oauth = catalog["example"].definition.auth.oauth
    assert oauth is not None
    sites = FakeSites(*SITES)
    sites["eu.example.test"].account = {"id": "acct-eu", "email": "ada@eu.example.test"}
    client = RegisteredClient(
        service="example",
        name="Example",
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        http=sites.client(),
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
                catalog["example"].definition, client, sites.client()
            )
        },
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )
    harness = build_harness(session_factory)
    harness.gateway_app.state.service_broker = broker
    harness.gateway_app.state.service_flows = ServiceFlows(
        None, SignInFlows(session_factory, TEST_KEYRING)
    )
    harness.gateway_app.include_router(service_connections_router)
    harness.gateway_app.include_router(service_flows_router)
    return SitesWorld(harness, sites, broker)


async def _connect_at(world: SitesWorld, console: Console, site: str) -> httpx.Response:
    started = await console.start(choices={"site": site})
    assert started.status_code == 200, started.text
    code = _listener_code(world.sites.authorize(started.json()["url"]), console.state)
    completed = await console.complete(code)
    assert completed.status_code == 200, completed.text
    return completed


async def _due_for_renewal(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    async with session_factory() as session:
        connection = await STORE.get_connection(session, user_id, "example")
        assert connection is not None
        values = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        connection.encrypted_secret = TEST_KEYRING.encrypt(
            json.dumps({**values, "expires_at": time.time() + 60})
        )
        await session.commit()


class TestChoices:
    async def test_signs_in_at_the_site_chosen_and_keeps_it(
        self, session_factory, tmp_path
    ) -> None:
        world = _sites_world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            started = await console.start(choices={"site": "eu.example.test"})
            assert started.status_code == 200, started.text
            url = started.json()["url"]
            assert url.startswith("https://auth.eu.example.test/authorize?")
            assert parse_qs(urlsplit(url).query)["resource"] == [
                "https://mcp.eu.example.test/v1/mcp"
            ]
            flow = await _flow_row(session_factory, console.state)
            assert flow.details["choices"] == {"site": "eu.example.test"}
            code = _listener_code(world.sites.authorize(url), console.state)
            completed = await console.complete(code)
            assert completed.status_code == 200, completed.text
            assert completed.json()["account"] == "ada@eu.example.test"
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (connection.choices, connection.method, connection.account_id) == (
            {"site": "eu.example.test"},
            "oauth",
            "acct-eu",
        )
        secret = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert secret["choices"] == {"site": "eu.example.test"}
        assert world.sites["example.test"].paths == []

    @pytest.mark.parametrize(
        ("choices", "detail"),
        [
            (None, "Example site is required."),
            ({}, "Example site is required."),
            (
                {"site": "elsewhere.test"},
                "Example site must be one of example.test, eu.example.test.",
            ),
            (
                {"site": "example.test", "region": "eu"},
                "There is no choice named region.",
            ),
        ],
    )
    async def test_a_start_without_a_choice_the_entry_offers_is_refused(
        self, session_factory, tmp_path, choices, detail
    ) -> None:
        world = _sites_world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            refused = await Console(client, ada).start(choices=choices)
        assert refused.status_code == 422
        assert refused.json()["detail"] == detail
        assert await _flow_ids(session_factory) == set()
        assert all(world.sites[site].paths == [] for site in SITES)

    async def test_an_entry_without_choices_takes_none(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            refused = await Console(client, ada).start(choices={"site": "example.test"})
            assert refused.status_code == 422
            assert refused.json()["detail"] == "There is no choice named site."
            console = Console(client, ada)
            started = await console.start(choices={})
            assert started.status_code == 200, started.text
            code = _listener_code(
                world.vendor.authorize(started.json()["url"]), console.state
            )
            assert (await console.complete(code)).status_code == 200
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (connection.choices, connection.method) == ({}, "oauth")

    async def test_refreshes_and_revokes_at_the_connections_own_site(
        self, session_factory, tmp_path
    ) -> None:
        world = _sites_world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        eu = world.sites["eu.example.test"]
        async with world.harness.client() as client:
            await _connect_at(world, Console(client, ada), "eu.example.test")
            await _due_for_renewal(session_factory, ada.id)
            async with session_factory() as session:
                token = await world.broker.connection_access_token(
                    session, ada.id, "example"
                )
            assert token in eu.live_access
            assert eu.token_requests[-1]["grant_type"] == "refresh_token"
            assert eu.token_requests[-1]["resource"] == (
                "https://mcp.eu.example.test/v1/mcp"
            )
            removed = await client.delete(
                "/gateway/service-connections/example", cookies=cookies_for(ada)
            )
            assert removed.status_code == 200, removed.text
        assert [form["token_type_hint"] for form in eu.revoked] == ["refresh_token"]
        assert eu.live_refresh == {}
        assert world.sites["example.test"].paths == []

    async def test_people_at_two_sites_keep_both_connections(
        self, session_factory, tmp_path
    ) -> None:
        world = _sites_world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        grace = await add_member(session_factory, "grace")
        async with world.harness.client() as client:
            await _connect_at(world, Console(client, ada), "example.test")
            await _connect_at(world, Console(client, grace), "eu.example.test")
        async with session_factory() as session:
            clients = {
                row.choice: row.oauth_client_id
                for row in await session.scalars(select(ServiceOAuthClient))
            }
        assert clients == {
            "example.test": "registered-1-at-example.test",
            "eu.example.test": "registered-1-at-eu.example.test",
        }
        for person, site in ((ada, "example.test"), (grace, "eu.example.test")):
            connection = await _connection(session_factory, person.id)
            assert connection is not None
            assert connection.oauth_client_id == clients[site]
            assert world.broker.connection_status(connection) == "active"
            # Its refresh token is still good at its own site's client.
            await _due_for_renewal(session_factory, person.id)
            async with session_factory() as session:
                token = await world.broker.connection_access_token(
                    session, person.id, "example"
                )
            assert token in world.sites[site].live_access

    async def test_the_list_says_how_and_with_what_each_was_connected(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        world = _sites_world(session_factory, tmp_path / "catalog")
        # The list answers the catalog the server loaded at import.
        monkeypatch.setattr(
            "switch_core.gateway.service_connections.CATALOG",
            load_catalog(tmp_path / "catalog"),
        )
        ada = await add_member(session_factory, "ada")
        grace = await add_member(session_factory, "grace")
        async with world.harness.client() as client:
            await _connect_at(world, Console(client, ada), "eu.example.test")
            listed = {
                person.name: {
                    entry["slug"]: entry
                    for entry in (
                        await client.get(
                            "/gateway/service-connections", cookies=cookies_for(person)
                        )
                    ).json()["connections"]
                }["example"]
                for person in (ada, grace)
            }
        assert {
            name: (entry["status"], entry["method"], entry["choices"])
            for name, entry in listed.items()
        } == {
            "ada": ("active", "oauth", {"site": "eu.example.test"}),
            "grace": ("not_connected", None, None),
        }

    async def test_a_session_calls_the_mcp_server_at_the_connections_site(
        self, session_factory, tmp_path
    ) -> None:
        world = _sites_world(session_factory, tmp_path / "catalog")
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            await _connect_at(world, Console(client, ada), "eu.example.test")
        async with session_factory() as session:
            agent = await add_agent(session, name="planner", owner_id=ada.id)
            await STORE.save_grant(
                session,
                agent_id=agent.id,
                owner_id=ada.id,
                service="example",
                access="write",
                tool_mode="deny",
                tools=[],
                resources={},
                account_id="acct-eu",
                created_by=ada.id,
            )
            await session.commit()
            [grant] = await world.broker.grants_for(
                session, agent, Principal.agent_key()
            )
        assert grant["mcp_servers"] == [
            {
                "name": "example",
                "url": "https://mcp.eu.example.test/v1/mcp",
                "headers": {"Authorization": "Bearer {token}"},
            }
        ]


MARKERS = "  consent: { read: items_read, write: items_write }\n"


def _granting(vendor: FakeOAuthServer, granted: list[str]) -> None:
    """The vendor answers every sign-in with `granted` as the token's scope,
    whatever was asked for."""
    mint = vendor.mint
    vendor.mint = lambda scopes, client_id: mint(granted, client_id)  # type: ignore[method-assign]


class TestConsentMarkers:
    """A vendor whose token lists its own permissions, rather than the
    scopes asked for, is read by the entry's consent markers."""

    @pytest.mark.parametrize(
        ("granted", "consent"),
        [
            (["items_read", "items_write", "items_list"], "write"),
            (["items_read", "items_list"], "read"),
        ],
    )
    async def test_reads_the_level_from_the_marker_the_token_holds(
        self, session_factory, tmp_path, granted, consent
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog", markers=MARKERS)
        _granting(world.vendor, granted)
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            connected = await _loopback_connect(world, Console(client, ada))
        assert connected.json()["consent"] == consent
        connection = await _connection(session_factory, ada.id)
        assert connection is not None
        assert (connection.consent, connection.granted_scopes) == (consent, granted)

    async def test_a_token_with_neither_marker_is_refused(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog", markers=MARKERS)
        # Every scope asked for, but neither marker.
        _granting(world.vendor, ["read:items", "write:items", "items_list"])
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            console = Console(client, ada)
            refused = await console.complete(await _loopback_code(world, console))
            assert refused.status_code == 400
            assert refused.json()["detail"] == (
                "Example granted less than Switch needs to read. Connect again "
                "and allow what it asks for."
            )
            assert (await console.status()).json()["status"] == "failed"
        assert await _connection(session_factory, ada.id) is None

    async def test_without_markers_the_scopes_asked_for_decide(
        self, session_factory, tmp_path
    ) -> None:
        world = _world(session_factory, tmp_path / "catalog")
        _granting(world.vendor, ["read:items", "items_write"])
        ada = await add_member(session_factory, "ada")
        async with world.harness.client() as client:
            connected = await _loopback_connect(world, Console(client, ada))
        assert connected.json()["consent"] == "read"

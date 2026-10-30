"""A workspace goes through its organization's connector app, where it saved one.

Against Postgres, with the broker and `OrganizationApps` on the restricted
role row-level security applies to; `owner` only arranges fixtures. Google
Workspace stands for every static OAuth client: its adapter names the client
it signs in through, which is what tells one app from another here.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from starlette.datastructures import State

from switch_core.connections import organization_apps as organization_apps_module
from switch_core.connections.adapters import ServiceUnavailableError
from switch_core.connections.app_credentials import (
    SECRET_NAMES,
    ConnectorApps,
    cannot_work_here,
)
from switch_core.connections.app_signals import (
    CONNECTOR_APP_CHANGED_SIGNAL,
    ConnectorAppSignals,
)
from switch_core.connections.broker import ServiceBroker, ServiceError
from switch_core.connections.loader import CATALOG
from switch_core.connections.organization_apps import OrganizationApp, OrganizationApps
from switch_core.connections.registry import ClientRegistration, build_adapters
from switch_core.db.models import Organization, OrganizationAppCredential, Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.service_app_credential_store import (
    ServiceAppCredentialStore,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.keys import Keyring
from switch_core.signals import SignalBus
from tests.conftest import TEST_KEYRING, RLSHarness
from tests.switch_core.connections.adapters.test_github import _config

pytestmark = pytest.mark.no_ambient_tenant

PUBLIC_URL = "https://switch.example.test"
GOOGLE = "google-workspace"
SERVER_CLIENT = "server-client-id"
DELIVERY_TIMEOUT = 10.0


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _workspace(
    owner: async_sessionmaker[AsyncSession], *, in_organization: bool
) -> tuple[str | None, str]:
    """A workspace, in an organization of its own or, as one a process from
    before organizations created, in none."""
    organization_id = _id("org") if in_organization else None
    tenant_id = _id("tenant")
    async with owner() as session:
        if organization_id is not None:
            session.add(
                Organization(id=organization_id, slug=organization_id, name="O")
            )
            await session.flush()
        session.add(
            Tenant(
                id=tenant_id, slug=tenant_id, name="W", organization_id=organization_id
            )
        )
        await session.commit()
    return organization_id, tenant_id


async def _save(
    owner: async_sessionmaker[AsyncSession],
    organization_id: str,
    client_id: str,
    *,
    keyring: Keyring = TEST_KEYRING,
) -> None:
    async with owner() as session:
        user = User(name="admin", email=f"{_id('admin')}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        await OrganizationAppCredentialStore(keyring).save(
            session,
            organization_id=organization_id,
            service=GOOGLE,
            client_id=client_id,
            settings={},
            secrets={"client_secret": "example-secret-2222"},
            secret_names=SECRET_NAMES["oauth_client"],
            updated_by=user.id,
        )
        await session.commit()


class _Unread:
    """A session nothing may read through: what a lookup answered from
    memory, or for a service it does not cover, is handed."""

    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"read through the session: {name}")


class _Server:
    """One process: the server's apps, organizations' apps and the broker."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        tmp_path: Path,
        public_url: str = PUBLIC_URL,
    ) -> None:
        client_file = tmp_path / f"google-{uuid.uuid4().hex[:6]}.json"
        client_file.write_text(
            json.dumps(
                {"client_id": SERVER_CLIENT, "client_secret": "example-secret-0000"}
            )
        )
        settings = _config(gateway_public_url=public_url)
        self.http = httpx.AsyncClient()
        self.registration = ClientRegistration(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            public_url=public_url,
            server_name="switch.local",
        )
        self.apps = ConnectorApps(
            catalog=CATALOG,
            config=settings,
            environ={"GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH": str(client_file)},
            session_factory=session_factory,
            store=ServiceAppCredentialStore(TEST_KEYRING),
            http=self.http,
            registration=self.registration,
        )
        self.organization_apps = OrganizationApps(
            apps=self.apps,
            store=OrganizationAppCredentialStore(TEST_KEYRING),
        )
        self._session_factory = session_factory

    async def lookup(self, tenant_id: str, service: str) -> OrganizationApp | None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            return await self.organization_apps.for_workspace(
                session, tenant_id, service
            )

    async def start(self) -> ServiceBroker:
        await self.apps.load()
        return ServiceBroker(
            session_factory=self._session_factory,
            keyring=TEST_KEYRING,
            catalog=CATALOG,
            adapters=build_adapters(
                CATALOG,
                github_app=self.apps.github_app(),
                oauth_clients=self.apps.oauth_clients(),
                http=self.http,
                registration=self.registration,
            ),
            organization_apps=self.organization_apps,
            disabled={},
            store=ServiceConnectionStore(),
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=PUBLIC_URL,
        )


async def _client_in(broker: ServiceBroker, tenant_id: str) -> str | None:
    """The OAuth client `tenant_id` signs in to Google Workspace through."""
    async with tenant_session(broker._session_factory, tenant_id) as session:
        _, adapter = await broker.sign_in(session, GOOGLE)
    return adapter.current_client_id()


async def _eventually(check: Callable[[], Awaitable[bool]]) -> None:
    async with asyncio.timeout(DELIVERY_TIMEOUT):
        while not await check():
            await asyncio.sleep(0.02)


class TestWhichApp:
    async def test_a_workspace_goes_through_its_organizations_app(
        self, rls_harness: RLSHarness, tmp_path: Path
    ) -> None:
        own, with_app = await _workspace(rls_harness.owner, in_organization=True)
        _, without_app = await _workspace(rls_harness.owner, in_organization=True)
        _, no_organization = await _workspace(rls_harness.owner, in_organization=False)
        assert own is not None
        await _save(rls_harness.owner, own, "organization-client-id")
        broker = await _Server(rls_harness.restricted, tmp_path).start()

        assert await _client_in(broker, with_app) == "organization-client-id"
        assert await _client_in(broker, without_app) == SERVER_CLIENT
        assert await _client_in(broker, no_organization) == SERVER_CLIENT

    async def test_an_unusable_organization_app_does_not_fall_back_to_the_servers(
        self, rls_harness: RLSHarness, tmp_path: Path
    ) -> None:
        organization_id, tenant_id = await _workspace(
            rls_harness.owner, in_organization=True
        )
        assert organization_id is not None
        retired = Keyring.parse("retired:" + "r" * 40, legacy_secret=None)
        await _save(rls_harness.owner, organization_id, "lost-client", keyring=retired)
        broker = await _Server(rls_harness.restricted, tmp_path).start()

        async with tenant_session(rls_harness.restricted, tenant_id) as session:
            standing = await broker.standing(session, GOOGLE)
            unavailable = standing.unavailable
            assert unavailable is not None
            assert unavailable.code == "organization_app_unusable"
            assert "Your organization's Google Workspace app" in unavailable.reason
            assert "An organization admin can fix it" in unavailable.reason
            assert standing.connectable is False
            with pytest.raises(ServiceError) as refused:
                await broker.sign_in(session, GOOGLE)
        assert refused.value.message == unavailable.reason

    async def test_services_it_does_not_cover_never_read_the_organization(
        self, rls_harness: RLSHarness, tmp_path: Path
    ) -> None:
        server = _Server(rls_harness.restricted, tmp_path)
        await server.start()

        for service in ("atlassian", "github"):
            assert (
                await server.organization_apps.for_workspace(
                    _Unread(), "no-such", service
                )
                is None
            )

    async def test_what_only_the_operator_can_fix_does_not_send_members_to_their_admin(
        self, rls_harness: RLSHarness, tmp_path: Path
    ) -> None:
        organization_id, _ = await _workspace(rls_harness.owner, in_organization=True)
        assert organization_id is not None
        async with rls_harness.owner() as session:
            user = User(name="admin", email=f"{_id('a')}@example.invalid", role="user")
            session.add(user)
            await session.flush()
            row = await OrganizationAppCredentialStore(TEST_KEYRING).save(
                session,
                organization_id=organization_id,
                service="github",
                client_id="example-client-id",
                settings={"slug": "example-app"},
                secrets={"client_secret": "s", "private_key": "k"},
                secret_names=SECRET_NAMES["github_app"],
                updated_by=user.id,
            )
            await session.commit()
        server = _Server(
            rls_harness.restricted, tmp_path, public_url="http://switch.example.test"
        )

        app = server.organization_apps._build(row)

        assert app.adapter is None
        assert app.problem == cannot_work_here("GitHub")


class TestRevoking:
    async def test_a_sign_in_is_revoked_through_the_client_it_was_made_through(
        self, rls_harness: RLSHarness, tmp_path: Path
    ) -> None:
        organization_id, tenant_id = await _workspace(
            rls_harness.owner, in_organization=True
        )
        assert organization_id is not None
        await _save(rls_harness.owner, organization_id, "organization-client-id")
        broker = await _Server(rls_harness.restricted, tmp_path).start()

        async with tenant_session(rls_harness.restricted, tenant_id) as session:
            # Made through the server's app, before the organization saved its own.
            before = await broker._revoker(session, GOOGLE, SERVER_CLIENT)
            since = await broker._revoker(session, GOOGLE, "organization-client-id")
            with pytest.raises(ServiceUnavailableError) as gone:
                await broker._revoker(session, GOOGLE, "replaced-client-id")
        assert before.current_client_id() == SERVER_CLIENT
        assert since.current_client_id() == "organization-client-id"
        assert "no longer uses the Google Workspace app" in str(gone.value)


class TestKept:
    async def test_what_a_workspace_belongs_to_is_read_once(
        self, rls_harness: RLSHarness, tmp_path: Path
    ) -> None:
        organization_id, in_one = await _workspace(
            rls_harness.owner, in_organization=True
        )
        _, in_none = await _workspace(rls_harness.owner, in_organization=False)
        assert organization_id is not None
        await _save(rls_harness.owner, organization_id, "organization-client-id")
        server = _Server(rls_harness.restricted, tmp_path)
        await server.start()
        first = await server.lookup(in_one, GOOGLE)
        assert await server.lookup(in_none, GOOGLE) is None

        apps = server.organization_apps
        assert await apps.for_workspace(_Unread(), in_one, GOOGLE) is first
        assert await apps.for_workspace(_Unread(), in_none, GOOGLE) is None

    async def test_the_adapter_is_kept_until_the_app_changes(
        self, rls_harness: RLSHarness, tmp_path: Path
    ) -> None:
        organization_id, tenant_id = await _workspace(
            rls_harness.owner, in_organization=True
        )
        assert organization_id is not None
        await _save(rls_harness.owner, organization_id, "first-client")
        server = _Server(rls_harness.restricted, tmp_path)
        broker = await server.start()
        assert await _client_in(broker, tenant_id) == "first-client"

        await _save(rls_harness.owner, organization_id, "second-client")
        assert await _client_in(broker, tenant_id) == "first-client"

        server.organization_apps.changed(organization_id, GOOGLE)
        assert await _client_in(broker, tenant_id) == "second-client"

    async def test_a_kept_adapter_is_read_again_once_no_longer_trusted(
        self,
        rls_harness: RLSHarness,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        organization_id, tenant_id = await _workspace(
            rls_harness.owner, in_organization=True
        )
        assert organization_id is not None
        await _save(rls_harness.owner, organization_id, "first-client")
        server = _Server(rls_harness.restricted, tmp_path)
        await server.start()
        monkeypatch.setattr(organization_apps_module, "TRUSTED_SECONDS", 0.0)

        first = await server.lookup(tenant_id, GOOGLE)
        unchanged = await server.lookup(tenant_id, GOOGLE)
        assert first is not None and unchanged is first

        # Saved by a process whose announcement never arrived.
        await _save(rls_harness.owner, organization_id, "second-client")
        changed = await server.lookup(tenant_id, GOOGLE)
        assert changed is not None and changed.adapter is not None
        assert changed.adapter.current_client_id() == "second-client"

    async def test_a_change_during_a_read_is_not_overwritten_by_it(
        self,
        rls_harness: RLSHarness,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        organization_id, tenant_id = await _workspace(
            rls_harness.owner, in_organization=True
        )
        assert organization_id is not None
        await _save(rls_harness.owner, organization_id, "first-client")
        server = _Server(rls_harness.restricted, tmp_path)
        await server.start()
        store = OrganizationAppCredentialStore(TEST_KEYRING)
        reads = 0

        async def read_then_change(
            session: AsyncSession, organization: str, service: str
        ) -> OrganizationAppCredential | None:
            nonlocal reads
            reads += 1
            row = await store.get(session, organization, service)
            if reads == 1:
                server.organization_apps.forget(organization, service)
            return row

        monkeypatch.setattr(server.organization_apps._store, "get", read_then_change)
        await server.lookup(tenant_id, GOOGLE)
        await server.lookup(tenant_id, GOOGLE)
        assert reads == 2

    async def test_forgetting_everything_during_a_first_read_is_not_overwritten(
        self,
        rls_harness: RLSHarness,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        organization_id, tenant_id = await _workspace(
            rls_harness.owner, in_organization=True
        )
        assert organization_id is not None
        await _save(rls_harness.owner, organization_id, "first-client")
        server = _Server(rls_harness.restricted, tmp_path)
        await server.start()
        store = OrganizationAppCredentialStore(TEST_KEYRING)
        reads = 0

        async def read_then_reconnect(
            session: AsyncSession, organization: str, service: str
        ) -> OrganizationAppCredential | None:
            nonlocal reads
            reads += 1
            row = await store.get(session, organization, service)
            if reads == 1:
                server.organization_apps.forget_all()
            return row

        monkeypatch.setattr(server.organization_apps._store, "get", read_then_reconnect)
        await server.lookup(tenant_id, GOOGLE)
        await server.lookup(tenant_id, GOOGLE)
        assert reads == 2


class TestSignals:
    def _bus(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> SignalBus:
        return SignalBus(
            session_factory,
            lambda: create_async_engine(postgres_url, poolclass=NullPool),
            process_id=str(uuid.uuid4()),
        )

    async def test_a_change_in_one_process_is_forgotten_in_the_other(
        self,
        postgres_url: str,
        rls_harness: RLSHarness,
        session_factory: async_sessionmaker[AsyncSession],
        tmp_path: Path,
    ) -> None:
        organization_id, tenant_id = await _workspace(
            rls_harness.owner, in_organization=True
        )
        assert organization_id is not None
        await _save(rls_harness.owner, organization_id, "first-client")
        servers = [_Server(rls_harness.restricted, tmp_path) for _ in range(2)]
        brokers = []
        buses = []
        for server in servers:
            broker = await server.start()
            bus = self._bus(postgres_url, session_factory)
            ConnectorAppSignals(
                apps=server.apps,
                organization_apps=server.organization_apps,
                broker=broker,
                state=State(),
                bus=bus,
            )
            await bus.start()
            brokers.append(broker)
            buses.append(bus)
        try:
            here, there = servers
            assert await _client_in(brokers[1], tenant_id) == "first-client"

            # As the save route will: commit, then forget here and announce.
            await _save(rls_harness.owner, organization_id, "second-client")
            here.organization_apps.changed(organization_id, GOOGLE)

            async def moved() -> bool:
                return await _client_in(brokers[1], tenant_id) == "second-client"

            await _eventually(moved)
        finally:
            for bus in buses:
                await bus.stop()

    async def test_an_organizations_signal_leaves_the_servers_app_alone(
        self,
        postgres_url: str,
        rls_harness: RLSHarness,
        session_factory: async_sessionmaker[AsyncSession],
        tmp_path: Path,
    ) -> None:
        server = _Server(rls_harness.restricted, tmp_path)
        broker = await server.start()
        forgotten: list[tuple[str, str]] = []
        server.organization_apps.forget = (  # type: ignore[method-assign]
            lambda organization, service: forgotten.append((organization, service))
        )
        signals = ConnectorAppSignals(
            apps=server.apps,
            organization_apps=server.organization_apps,
            broker=broker,
            state=State(),
            bus=self._bus(postgres_url, session_factory),
        )

        signals._on_changed(
            {
                "kind": CONNECTOR_APP_CHANGED_SIGNAL,
                "service": GOOGLE,
                "organization_id": "org-1",
            }
        )

        assert forgotten == [("org-1", GOOGLE)]
        assert signals._owed.pending == 0

"""The credential broker against Postgres, with a fake vendor.

Only the vendor's side is faked: the checks, the per-connection lock, the
refresh, the record and the revocation all run for real. The fake stands in
for GitHub, the one enabled catalog entry, so the catalog's own levels apply.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import shutil
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import delete, event, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import (
    AccessToken,
    ConnectionSecret,
    IssuedToken,
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.broker import (
    CLIENT_REPLACED,
    CONNECTOR_REVOKED,
    Principal,
    ServiceBroker,
    ServiceError,
)
from switch_core.connections.loader import CATALOG, CATALOG_ROOT, load_catalog
from switch_core.connections.maintenance import maintain_once
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentController,
    AgentDefinition,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.test_loader import (
    CLI_ENTRY,
    OAUTH_ENTRY,
    _write_example,
)
from tests.switch_core.gateway.agent_route_harness import add_agent

STORE = ServiceConnectionStore()
RESOURCES = {"installation_id": 7, "repository_ids": [70, 71]}


@pytest.fixture
def vendor() -> FakeVendor:
    return FakeVendor()


@pytest.fixture
def broker(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> ServiceBroker:
    return ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={"github": vendor},
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _secret(*, expires_in: float) -> dict:
    return {
        "access_token": "gho_access_0",
        "expires_at": time.time() + expires_in,
        "refresh_token": "ghr_refresh_0",
        "refresh_expires_at": time.time() + 180 * 86400,
        "login": "ada-gh",
        "user_id": 1001,
    }


class World:
    def __init__(self, owner: User, agent: Agent, grant: ServiceGrant) -> None:
        self.owner = owner
        self.agent = agent
        self.grant = grant


async def _user(session: AsyncSession, name: str) -> User:
    user = User(
        name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
    )
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"))
    await session.flush()
    return user


async def _connect(
    session: AsyncSession,
    user_id: str,
    *,
    account_id: str = "1001",
    consent: str = "write",
    expires_in: float = 3600,
) -> None:
    await STORE.save_connection(
        session,
        user_id=user_id,
        service="github",
        consent=consent,
        granted_scopes=[],
        account_id=account_id,
        external_identity="ada-gh",
        encrypted_secret=TEST_KEYRING.encrypt(
            json.dumps(_secret(expires_in=expires_in))
        ),
        oauth_client_id=None,
    )


async def _world(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    access: str = "write",
    consent: str = "write",
    expires_in: float = 3600,
) -> World:
    async with session_factory() as session:
        owner = await _user(session, "ada")
        agent = await add_agent(session, name="builder", owner_id=owner.id)
        await _connect(session, owner.id, consent=consent, expires_in=expires_in)
        grant = await STORE.save_grant(
            session,
            agent_id=agent.id,
            owner_id=owner.id,
            service="github",
            access=access,
            tool_mode="deny",
            tools=[],
            resources=RESOURCES,
            account_id="1001",
            created_by=owner.id,
        )
        await session.commit()
        return World(owner, agent, grant)


async def _hosted_by(
    session_factory: async_sessionmaker[AsyncSession], world: World, controller_id: str
) -> None:
    """A live controller of the owner's, which the agent's definition places it on."""
    async with session_factory() as session:
        session.add(
            AgentController(
                id=controller_id, owner_id=world.owner.id, name="laptop", kind="console"
            )
        )
        await session.flush()
        session.add(
            AgentDefinition(
                agent_id=world.agent.id,
                owner_id=world.owner.id,
                controller_id=controller_id,
                revision=1,
                desired_state="running",
                definition={},
            )
        )
        await session.commit()


async def _issue(
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    principal: Principal | None = None,
    service: str = "github",
):
    async with session_factory() as session:
        return await broker.issue(
            session, agent_id, principal or Principal.agent_key(), service
        )


async def _refused(
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    principal: Principal | None = None,
    service: str = "github",
) -> ServiceError:
    with pytest.raises(ServiceError) as caught:
        await _issue(broker, session_factory, agent_id, principal, service)
    return caught.value


async def _issuances(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[ServiceTokenIssuance]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(ServiceTokenIssuance).order_by(ServiceTokenIssuance.created_at)
            )
        )


async def _connection(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> ServiceConnection | None:
    async with session_factory() as session:
        return await STORE.get_connection(session, user_id, "github")


class TestIssue:
    async def test_an_issue_is_recorded_and_counted(
        self, broker, session_factory, vendor, registry
    ) -> None:
        world = await _world(session_factory)
        await _hosted_by(session_factory, world, "controller-1")
        principal = Principal.controller("controller-1", world.owner.id)
        token = await _issue(broker, session_factory, world.agent.id, principal)

        assert token.resources == RESOURCES
        assert vendor.issued == [("gho_access_0", token.token)]
        assert vendor.refreshes == 0
        [record] = await _issuances(session_factory)
        assert (record.agent_id, record.owner_id, record.grant_id) == (
            world.agent.id,
            world.owner.id,
            world.grant.id,
        )
        assert (record.principal, record.controller_id) == (
            "controller",
            "controller-1",
        )
        assert record.permissions == {
            "permissions": {"contents": "write", "pull_requests": "write"}
        }
        assert record.resources == RESOURCES
        assert record.expires_at == token.expires_at
        assert record.token_sha256 == hashlib.sha256(token.token.encode()).hexdigest()
        assert record.encrypted_token is not None
        assert TEST_KEYRING.decrypt(record.encrypted_token) == token.token
        assert token.token not in repr(token)

        payload = next(
            p for p in registry.collect() if p.name == "switch.service_tokens.requests"
        )
        assert {
            tuple(sorted(point.attributes.items())): point.value
            for point in payload.numbers
        } == {(("connector", "github"), ("outcome", "issued")): 1}

    async def test_a_token_the_vendor_cannot_revoke_is_recorded_without_it(
        self, broker, session_factory, vendor
    ) -> None:
        vendor.revocable = False
        world = await _world(session_factory)
        await _issue(broker, session_factory, world.agent.id)
        [record] = await _issuances(session_factory)
        assert record.encrypted_token is None
        assert record.principal == "agent_key"

    async def test_two_issues_on_an_expiring_secret_refresh_it_once(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory, expires_in=60)
        first, second = await asyncio.gather(
            _issue(broker, session_factory, world.agent.id),
            _issue(broker, session_factory, world.agent.id),
        )

        assert vendor.refreshes == 1
        assert first.token != second.token
        assert [access for access, _ in vendor.issued] == ["gho_access_1"] * 2
        connection = await _connection(session_factory, world.owner.id)
        assert connection is not None and connection.secret_revision == 2
        stored = json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
        assert (stored["access_token"], stored["refresh_token"]) == (
            "gho_access_1",
            "ghr_refresh_1",
        )
        assert stored["login"] == "ada-gh"

    async def test_issues_at_once_share_one_fetch_rather_than_queue_on_the_lock(
        self, broker, session_factory, vendor, monkeypatch
    ) -> None:
        world = await _world(session_factory, expires_in=60)
        locked = 0
        lock = ServiceConnectionStore.lock_connection

        async def counting(self, session, user_id, service):
            nonlocal locked
            locked += 1
            await lock(self, session, user_id, service)

        monkeypatch.setattr(ServiceConnectionStore, "lock_connection", counting)
        issued = await asyncio.gather(
            *(_issue(broker, session_factory, world.agent.id) for _ in range(6))
        )

        assert vendor.refreshes == 1
        assert len({token.token for token in issued}) == 6
        # One for the shared fetch, one per record.
        assert locked == 1 + 6

    async def test_a_refused_refresh_needs_reauthorization_with_the_fix(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory, expires_in=60)
        vendor.refresh_error = ReauthorizationRequiredError(
            "GitHub refused the sign-in."
        )
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (409, "connector_revoked")
        assert "reconnect GitHub" in refused.message

        connection = await _connection(session_factory, world.owner.id)
        assert connection is not None
        assert (connection.status, connection.error_code) == (
            "needs_reauthorization",
            "refresh_refused",
        )
        again = await _refused(broker, session_factory, world.agent.id)
        assert again.code == "connector_revoked"
        assert "under Connectors" in again.message
        assert vendor.refreshes == 1
        assert vendor.issued == []

    async def test_a_token_valid_for_two_hours_is_refused_and_revoked(
        self, broker, session_factory, vendor
    ) -> None:
        vendor.lifetime = timedelta(hours=2)
        world = await _world(session_factory)
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code, refused.retryable) == (
            500,
            "internal",
            False,
        )
        assert vendor.revoked == [vendor.issued[0][1]]
        assert await _issuances(session_factory) == []

    async def test_a_vendor_refusal_is_forbidden_with_its_reason(
        self, broker, session_factory, vendor
    ) -> None:
        vendor.issue_error = ServiceAdapterError(
            "Your GitHub account no longer has access to a granted repository."
        )
        world = await _world(session_factory)
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (403, "forbidden")
        assert "no longer has access" in refused.message

    async def test_a_grant_removed_while_issuing_takes_the_token_back(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)

        async def remove_the_grant() -> None:
            async with session_factory() as session:
                await session.execute(
                    delete(ServiceGrant).where(ServiceGrant.id == world.grant.id)
                )
                await session.commit()

        vendor.during_issue = remove_the_grant
        refused = await _refused(broker, session_factory, world.agent.id)
        assert refused.code == "grant_missing"
        assert vendor.revoked == [vendor.issued[0][1]]
        assert await _issuances(session_factory) == []

    async def test_no_secret_or_token_reaches_the_logs(
        self, broker, session_factory, vendor, caplog
    ) -> None:
        caplog.set_level(logging.DEBUG)
        world = await _world(session_factory, expires_in=60)
        token = await _issue(broker, session_factory, world.agent.id)
        # A discarded token that cannot be revoked is logged and recorded.
        vendor.revocable = False
        vendor.lifetime = timedelta(hours=2)
        await _refused(broker, session_factory, world.agent.id)

        async def unreachable(token: str) -> None:
            raise ServiceAdapterError(f"GitHub refused {token}")

        # And a revocation that fails is logged and left queued.
        vendor.revoke_issued = unreachable  # type: ignore[method-assign]
        async with session_factory() as session:
            grant = await STORE.get_grant(session, world.agent.id, "github")
            assert grant is not None
            await broker.revoke_grant(session, grant, world.owner.id)

        secrets = [
            token.token,
            *(issued for _, issued in vendor.issued),
            "gho_access_0",
            "gho_access_1",
            "ghr_refresh_0",
            "ghr_refresh_1",
        ]
        assert caplog.records
        for value in secrets:
            assert value not in caplog.text


class TestChecks:
    async def test_an_unknown_service_is_not_found(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory)
        refused = await _refused(
            broker, session_factory, world.agent.id, service="nowhere"
        )
        assert (refused.status_code, refused.code) == (404, "not_found")

    async def test_a_service_with_no_adapter_is_unavailable(
        self, session_factory
    ) -> None:
        broker = ServiceBroker(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            catalog=CATALOG,
            adapters={},
            disabled={},
            store=STORE,
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
        )
        world = await _world(session_factory)
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code, refused.retryable) == (
            503,
            "internal",
            False,
        )
        assert refused.message == broker.availability("github")
        assert broker.connectable("github") is False

    async def test_an_owner_no_longer_in_the_workspace_is_forbidden(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory)
        async with session_factory() as session:
            await session.execute(
                delete(TenantMember).where(TenantMember.user_id == world.owner.id)
            )
            await session.commit()
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (403, "forbidden")

    async def test_no_grant_is_grant_missing_naming_the_fix(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory)
        async with session_factory() as session:
            await session.execute(delete(ServiceGrant))
            await session.commit()
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (403, "grant_missing")
        assert "builder" in refused.message and "Connections" in refused.message

    async def test_a_grant_made_on_someone_elses_connection_is_forbidden(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory)
        async with session_factory() as session:
            other = await _user(session, "bob")
            await _connect(session, other.id, account_id="2002")
            await session.execute(
                delete(ServiceGrant).where(ServiceGrant.id == world.grant.id)
            )
            await STORE.save_grant(
                session,
                agent_id=world.agent.id,
                owner_id=other.id,
                service="github",
                access="read",
                tool_mode="allow",
                tools=[],
                resources=RESOURCES,
                account_id="2002",
                created_by=other.id,
            )
            await session.commit()
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (403, "forbidden")

    async def test_another_owners_controller_is_forbidden(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory)
        refused = await _refused(
            broker,
            session_factory,
            world.agent.id,
            Principal.controller("controller-2", "someone-else"),
        )
        assert (refused.status_code, refused.code) == (403, "forbidden")

    async def test_a_relink_to_another_account_needs_a_new_grant(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        async with session_factory() as session:
            await _connect(session, world.owner.id, account_id="1001")
            await session.commit()
        await _issue(broker, session_factory, world.agent.id)

        async with session_factory() as session:
            await _connect(session, world.owner.id, account_id="2002")
            await session.commit()
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (409, "grant_account_changed")
        assert len(vendor.issued) == 1

    async def test_write_on_a_read_only_connection_is_forbidden(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory, access="write", consent="read")
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (403, "forbidden")
        assert "only reading" in refused.message

    async def test_a_read_grant_asks_for_the_read_level(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory, access="read", consent="read")
        await _issue(broker, session_factory, world.agent.id)
        [record] = await _issuances(session_factory)
        assert record.permissions == {
            "permissions": {"contents": "read", "pull_requests": "read"}
        }


class TestRevocation:
    async def test_one_call_revokes_more_than_one_batch(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        tokens = [
            (await _issue(broker, session_factory, world.agent.id)).token
            for _ in range(20)
        ]
        async with session_factory() as session:
            grant = await STORE.get_grant(session, world.agent.id, "github")
            assert grant is not None
            warning = await broker.revoke_grant(session, grant, world.owner.id)

        assert warning is None
        assert sorted(vendor.revoked) == sorted(tokens)

    async def test_removing_a_grant_revokes_its_tokens_at_once(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        token = await _issue(broker, session_factory, world.agent.id)
        async with session_factory() as session:
            grant = await STORE.get_grant(session, world.agent.id, "github")
            assert grant is not None
            assert await broker.revoke_grant(session, grant, world.owner.id) is None

        assert vendor.revoked == [token.token]
        [record] = await _issuances(session_factory)
        assert (record.revoke_requested, record.encrypted_token) == (True, None)
        refused = await _refused(broker, session_factory, world.agent.id)
        assert refused.code == "grant_missing"

    async def test_disconnecting_removes_grants_and_revokes_everything(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        token = await _issue(broker, session_factory, world.agent.id)
        async with session_factory() as session:
            assert await broker.disconnect(session, world.owner.id, "github") is None

        assert vendor.revoked == [token.token]
        assert [s.values["refresh_token"] for s in vendor.connections_revoked] == [
            "ghr_refresh_0"
        ]
        assert await _connection(session_factory, world.owner.id) is None
        refused = await _refused(broker, session_factory, world.agent.id)
        assert refused.code == "grant_missing"

    async def test_a_revocation_the_vendor_fails_stays_queued_with_a_warning(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        await _issue(broker, session_factory, world.agent.id)

        async def unreachable(token: str) -> None:
            raise ServiceAdapterError("GitHub is unreachable.")

        vendor.revoke_issued = unreachable  # type: ignore[method-assign]
        async with session_factory() as session:
            grant = await STORE.get_grant(session, world.agent.id, "github")
            assert grant is not None
            warning = await broker.revoke_grant(session, grant, world.owner.id)
        assert warning is not None and "1 hour" in warning
        [record] = await _issuances(session_factory)
        assert record.revoke_requested and record.encrypted_token is not None
        assert record.attempts == 1

    async def test_the_tick_revokes_the_tokens_of_a_deleted_agent(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        token = await _issue(broker, session_factory, world.agent.id)
        async with session_factory() as session:
            await session.execute(delete(Agent).where(Agent.id == world.agent.id))
            await session.commit()

        await maintain_once(session_factory, broker, prune=False)
        assert vendor.revoked == [token.token]
        [record] = await _issuances(session_factory)
        assert record.encrypted_token is None

    async def test_the_tick_leaves_live_granted_tokens_alone_and_prunes_old_records(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        await _issue(broker, session_factory, world.agent.id)
        old = datetime.now(UTC) - timedelta(days=31)
        async with session_factory() as session:
            session.add(
                ServiceTokenIssuance(
                    grant_id=world.grant.id,
                    agent_id=world.agent.id,
                    owner_id=world.owner.id,
                    service="github",
                    principal="agent_key",
                    controller_id=None,
                    permissions={},
                    resources={},
                    expires_at=old + timedelta(hours=1),
                    token_sha256="0" * 64,
                    encrypted_token=None,
                    revoke_requested=False,
                    attempts=0,
                    created_at=old,
                )
            )
            await session.commit()

        await maintain_once(session_factory, broker, prune=True)
        assert vendor.revoked == []
        [record] = await _issuances(session_factory)
        assert record.encrypted_token is not None

    async def test_a_workspace_holding_no_token_costs_one_read(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        await _issue(broker, session_factory, world.agent.id)
        async with session_factory() as session:
            await session.execute(
                ServiceTokenIssuance.__table__.update().values(
                    encrypted_token=None,
                    expires_at=datetime.now(UTC) - timedelta(minutes=5),
                )
            )
            await session.commit()

        statements: list[str] = []

        def seen(conn, cursor, statement, parameters, context, executemany) -> None:
            statements.append(statement)

        async with session_factory() as session:
            engine = session.bind.sync_engine
            event.listen(engine, "before_cursor_execute", seen)
            try:
                assert await broker.revoke_pending(session, ()) is False
            finally:
                event.remove(engine, "before_cursor_execute", seen)

        reads = [s for s in statements if "service_token_issuances" in s]
        assert len(reads) == 1 and reads[0].lstrip().upper().startswith("SELECT")
        assert not any("pg_advisory_xact_lock" in s for s in statements)
        assert vendor.revoked == []


class TestReauthorization:
    async def test_a_sign_in_github_refuses_on_issue_needs_reauthorization(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        vendor.issue_error = ReauthorizationRequiredError(
            "GitHub access expired or was revoked."
        )
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (409, "connector_revoked")
        assert "reconnect GitHub" in refused.message
        connection = await _connection(session_factory, world.owner.id)
        assert connection is not None
        assert (connection.status, connection.error_code) == (
            "needs_reauthorization",
            "sign_in_refused",
        )


class TestConnectOnly:
    async def test_a_service_that_cannot_issue_is_connectable_but_not_grantable(
        self, session_factory
    ) -> None:
        vendor = FakeVendor()
        vendor.can_issue = False
        broker = ServiceBroker(
            session_factory=session_factory,
            keyring=TEST_KEYRING,
            catalog=CATALOG,
            adapters={"github": vendor},
            disabled={},
            store=STORE,
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
        )
        world = await _world(session_factory, expires_in=60)

        reason = broker.availability("github")
        assert reason is not None and "not granted to agents" in reason
        unavailable = broker.unavailable("github")
        assert unavailable is not None and unavailable.code == "not_fully_set_up"
        assert broker.server_setup_needed("github") is False
        assert broker.connectable("github") is True
        assert broker.connectable("asana") is False
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code, refused.retryable) == (
            503,
            "internal",
            False,
        )
        assert refused.message == reason
        async with session_factory() as session:
            agent = await session.get(Agent, world.agent.id)
            assert agent is not None
            with pytest.raises(ServiceError) as caught:
                await broker.set_grant(
                    session,
                    agent=agent,
                    actor_id=world.owner.id,
                    service="github",
                    access="read",
                    tool_mode=None,
                    tools=None,
                    resources=RESOURCES,
                )
            assert (caught.value.status_code, caught.value.message) == (422, reason)
            token = await broker.connection_access_token(
                session, world.owner.id, "github"
            )
        assert token == "gho_access_1"
        assert vendor.refreshes == 1 and vendor.issued == []


READ_ONLY = (
    "This server's GitHub App lets agents read only, so GitHub can't be granted "
    "for writing. Whoever runs your Switch server can change that in Switch "
    "Console, under Admin → Connector apps."
)


class TestReadOnlyApp:
    """A GitHub App short of the write level's permissions lets agents read
    only: a write grant on it is refused before GitHub is asked, and so is a
    token for one made before. Read grants are untouched."""

    async def test_a_write_grant_is_refused_saying_who_can_change_that(
        self, broker, session_factory, vendor
    ) -> None:
        vendor.read_only = True
        world = await _world(session_factory, access="read")
        assert broker.read_only("github") == READ_ONLY
        async with session_factory() as session:
            agent = await session.get(Agent, world.agent.id)
            assert agent is not None
            with pytest.raises(ServiceError) as caught:
                await broker.set_grant(
                    session,
                    agent=agent,
                    actor_id=world.owner.id,
                    service="github",
                    access="write",
                    tool_mode=None,
                    tools=None,
                    resources=RESOURCES,
                )
        assert (
            caught.value.status_code,
            caught.value.code,
            caught.value.message,
            caught.value.retryable,
        ) == (403, "forbidden", READ_ONLY, False)
        async with session_factory() as session:
            with pytest.raises(ServiceError) as checked:
                await broker.check_grant_terms(
                    session,
                    owner_id=world.owner.id,
                    service="github",
                    access="write",
                    repositories=["example-org/app"],
                )
        assert checked.value.message == READ_ONLY
        # Refused before GitHub, or the owner's sign-in, was asked anything.
        assert vendor.checked == [] and vendor.resolved == []
        assert vendor.refreshes == 0
        async with session_factory() as session:
            grant = await session.get(ServiceGrant, (TENANT_ZERO_ID, world.grant.id))
            assert grant is not None and grant.access == "read"

    async def test_a_read_grant_is_made_as_ever(
        self, broker, session_factory, vendor
    ) -> None:
        vendor.read_only = True
        world = await _world(session_factory, access="read")
        async with session_factory() as session:
            agent = await session.get(Agent, world.agent.id)
            assert agent is not None
            grant, _ = await broker.set_grant(
                session,
                agent=agent,
                actor_id=world.owner.id,
                service="github",
                access="read",
                tool_mode=None,
                tools=None,
                resources=RESOURCES,
            )
        assert grant.access == "read"
        token = await _issue(broker, session_factory, world.agent.id)
        assert vendor.issued == [("gho_access_0", token.token)]

    async def test_a_write_grant_made_before_gets_no_token(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory, access="write")
        vendor.read_only = True
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (
            refused.status_code,
            refused.code,
            refused.message,
            refused.retryable,
        ) == (403, "forbidden", READ_ONLY, False)
        assert vendor.issued == [] and await _issuances(session_factory) == []
        # The grant is kept: once the App can write again, so can the agent.
        vendor.read_only = False
        assert broker.read_only("github") is None
        token = await _issue(broker, session_factory, world.agent.id)
        assert vendor.issued == [("gho_access_0", token.token)]


class TestAccessEndsInFlight:
    async def test_a_token_issued_as_the_agents_access_ends_is_taken_back(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)

        async def access_ends() -> None:
            async with session_factory() as session:
                await broker.queue_agent_revocation(session, world.agent.id, "github")
                await session.commit()

        vendor.during_issue = access_ends
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code, refused.retryable) == (
            503,
            "internal",
            True,
        )
        assert vendor.revoked == [vendor.issued[0][1]]
        assert await _issuances(session_factory) == []


def _switched_off(
    session_factory: async_sessionmaker[AsyncSession],
    vendor: FakeVendor,
    disabled: dict[str, str],
) -> ServiceBroker:
    return ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={"github": vendor},
        disabled=disabled,
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )


class TestSwitchedOff:
    async def test_a_switched_off_service_says_why_and_is_neither_connected_nor_granted(
        self, session_factory, vendor
    ) -> None:
        reason = "Coming to this server soon."
        broker = _switched_off(session_factory, vendor, {"github": reason})
        world = await _world(session_factory)

        assert broker.availability("github") == reason
        unavailable = broker.unavailable("github")
        assert unavailable is not None and unavailable.code == "switched_off"
        assert broker.connectable("github") is False
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code, refused.retryable) == (
            403,
            "forbidden",
            False,
        )
        assert refused.message == reason
        assert vendor.issued == [] and vendor.refreshes == 0
        async with session_factory() as session:
            agent = await session.get(Agent, world.agent.id)
            assert agent is not None
            with pytest.raises(ServiceError) as caught:
                await broker.set_grant(
                    session,
                    agent=agent,
                    actor_id=world.owner.id,
                    service="github",
                    access="read",
                    tool_mode=None,
                    tools=None,
                    resources=RESOURCES,
                )
            assert (caught.value.status_code, caught.value.message) == (422, reason)
            with pytest.raises(ServiceError) as caught:
                await broker.connect(
                    session,
                    user_id=world.owner.id,
                    service="github",
                    consent="write",
                    granted_scopes=[],
                    account_id="1001",
                    external_identity="ada-gh",
                    secret=ConnectionSecret(_secret(expires_in=3600)),
                    oauth_client_id=None,
                )
            assert (caught.value.status_code, caught.value.message) == (403, reason)

    async def test_disconnecting_a_switched_off_service_still_works(
        self, session_factory, vendor
    ) -> None:
        broker = _switched_off(session_factory, vendor, {"github": ""})
        world = await _world(session_factory)
        async with session_factory() as session:
            await broker.disconnect(session, world.owner.id, "github")
        assert await _connection(session_factory, world.owner.id) is None
        assert len(vendor.connections_revoked) == 1

    async def test_an_empty_reason_reads_switched_off(
        self, session_factory, vendor
    ) -> None:
        broker = _switched_off(session_factory, vendor, {"github": ""})
        assert broker.availability("github") == "Switched off on this server."

    async def test_a_service_outside_the_catalog_stops_the_server(
        self, session_factory, vendor
    ) -> None:
        with pytest.raises(ValueError, match="not in the catalog: \\['nowhere'\\]"):
            _switched_off(session_factory, vendor, {"nowhere": ""})


# `example`, revoked at the vendor on disconnect, which ends its tokens too.
REVOKES_TOKENS = OAUTH_ENTRY.replace(
    "    remove_access: Remove Switch under Connected apps in Example.\n",
    "    revocation_url: https://auth.example.test/revoke\n"
    "    revocation_ends_tokens: true\n",
)


def pass_through_catalog(
    root: Path, *, max_lifetime: int = 3600, entry: str = OAUTH_ENTRY
) -> dict:
    """The shipped catalog and `example`, a pass-through OAuth vendor."""
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(
        root,
        entry.replace("max_lifetime: 3600", f"max_lifetime: {max_lifetime}"),
    )
    return load_catalog(root)


class PassThrough:
    def __init__(self, broker: ServiceBroker, vendor: FakeVendor, world: World) -> None:
        self.broker = broker
        self.vendor = vendor
        self.world = world


async def _pass_through(
    session_factory: async_sessionmaker[AsyncSession],
    root: Path,
    *,
    expires_in: float,
    max_lifetime: int = 3600,
    entry: str = OAUTH_ENTRY,
) -> PassThrough:
    vendor = FakeVendor()
    vendor.pass_through = True
    vendor.revocable = False
    vendor.refreshed_lifetime = timedelta(hours=1)
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=pass_through_catalog(root, max_lifetime=max_lifetime, entry=entry),
        adapters={"example": vendor},
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
            granted_scopes=["read:items", "write:items"],
            account_id="acct-1",
            external_identity="ada@example.test",
            encrypted_secret=TEST_KEYRING.encrypt(
                json.dumps(
                    {
                        "access_token": "owner_access_0",
                        "expires_at": time.time() + expires_in,
                        "refresh_token": "owner_refresh_0",
                    }
                )
            ),
            oauth_client_id=None,
        )
        grant = await STORE.save_grant(
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
    return PassThrough(broker, vendor, World(owner, agent, grant))


class TestPassThrough:
    async def test_the_grant_names_the_vendors_mcp_servers_and_skill(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        async with session_factory() as session:
            agent = await session.get(Agent, pt.world.agent.id)
            assert agent is not None
            [grant] = await pt.broker.grants_for(session, agent, Principal.agent_key())
        assert grant["mcp_servers"] == [
            {
                "name": "example",
                "url": "https://mcp.example.test/v1/mcp",
                "headers": {"Authorization": "Bearer {token}"},
            }
        ]
        assert grant["cli_tools"] == []
        assert grant["skill"]["name"] == "example"

    async def test_the_grant_names_the_vendors_cli_as_the_catalog_has_it(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=CLI_ENTRY
        )
        async with session_factory() as session:
            agent = await session.get(Agent, pt.world.agent.id)
            assert agent is not None
            [grant] = await pt.broker.grants_for(session, agent, Principal.agent_key())
        assert grant["mcp_servers"] == []
        assert grant["cli_tools"] == [
            {
                "name": "example-cli",
                "binary": "excli",
                "token_env": "EXCLI_TOKEN",
                "env": None,
                "config_env": "EXCLI_CONFIG_DIR",
                "allow": ["items", "boards"],
                "deny": ["auth", "--profile"],
                "path_flags": {"--upload": "read", "--output": "write", "-o": "write"},
                "path_args": [{"after": "+put", "direction": "read"}],
                "output_cap_bytes": 65536,
                "timeout_s": 120,
                "token_refused": {
                    "exit_code": 1,
                    "json_path": "error.code",
                    "value": 401,
                },
                "release": {
                    "version": "1.2.3",
                    "targets": {
                        "linux-x64": {
                            "url": "https://downloads.example.test/excli-1.2.3-linux-x64.tar.gz",
                            "sha256": "a" * 64,
                            "path": "excli",
                        },
                        "win32-x64": {
                            "url": "https://downloads.example.test/excli-1.2.3-win32-x64.zip",
                            "sha256": "b" * 64,
                            "path": "bin/excli.exe",
                        },
                    },
                },
            }
        ]
        # The answer is JSON, as the route sends it.
        assert json.loads(json.dumps(grant)) == grant

    async def test_hands_out_the_owners_token_unrevocable_with_its_own_expiry(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        token = await _issue(
            pt.broker, session_factory, pt.world.agent.id, service="example"
        )
        assert token.token == "owner_access_0"
        assert pt.vendor.refreshes == 0
        remaining = (token.expires_at - datetime.now(UTC)).total_seconds()
        assert 49 * 60 < remaining <= 50 * 60
        assert token.use_until == token.expires_at
        [record] = await _issuances(session_factory)
        assert record.encrypted_token is None
        assert record.token_sha256 == hashlib.sha256(b"owner_access_0").hexdigest()

    async def test_renews_while_fifteen_minutes_remain_where_minted_waits_for_five(
        self, session_factory, tmp_path, broker, vendor
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=10 * 60)
        token = await _issue(
            pt.broker, session_factory, pt.world.agent.id, service="example"
        )
        assert pt.vendor.refreshes == 1
        assert token.token == "gho_access_1"

        world = await _world(session_factory, expires_in=10 * 60)
        await _issue(broker, session_factory, world.agent.id)
        assert vendor.refreshes == 0

    async def test_holds_back_a_token_past_the_catalogs_lifetime_and_revokes_nothing(
        self, session_factory, tmp_path
    ) -> None:
        """The owner's token runs down to the cap, so the refusal is retryable."""
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=2 * 3600)
        refused = await _refused(
            pt.broker, session_factory, pt.world.agent.id, service="example"
        )
        assert (refused.status_code, refused.code, refused.retryable) == (
            503,
            "internal",
            True,
        )
        assert "lasts longer than an hour" in refused.message
        assert pt.vendor.revoked == []
        assert await _issuances(session_factory) == []

    async def test_refuses_the_owners_token_handed_out_with_a_shorter_expiry(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        """The lifetime checked is the vendor's: an adapter cannot pass a
        long-lived owner's token off as one that lapses within the cap."""
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=8 * 3600)
        issue = pt.vendor.issue

        async def claims_an_hour(access: AccessToken, request) -> IssuedToken:
            issued = await issue(access, request)
            return IssuedToken(
                token=issued.token,
                expires_at=datetime.now(UTC) + timedelta(minutes=50),
                resources={},
                revocable=False,
            )

        monkeypatch.setattr(pt.vendor, "issue", claims_an_hour)
        refused = await _refused(
            pt.broker, session_factory, pt.world.agent.id, service="example"
        )
        assert (refused.status_code, refused.code) == (500, "internal")
        assert "with another expiry" in refused.message
        assert await _issuances(session_factory) == []

    async def test_a_longer_lived_token_is_used_for_an_hour_at_most(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=100 * 60, max_lifetime=7200
        )
        token = await _issue(
            pt.broker, session_factory, pt.world.agent.id, service="example"
        )
        now = datetime.now(UTC)
        assert (token.expires_at - now).total_seconds() > 99 * 60
        assert 59 * 60 < (token.use_until - now).total_seconds() <= 3600

    async def test_an_adapter_offering_the_owners_token_as_revocable_is_refused(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        pt.vendor.revocable = True
        refused = await _refused(
            pt.broker, session_factory, pt.world.agent.id, service="example"
        )
        assert (refused.status_code, refused.code) == (500, "internal")
        assert "as revocable" in refused.message
        assert pt.vendor.revoked == []
        assert await _issuances(session_factory) == []

    async def test_a_grant_is_on_at_the_connections_level_with_no_choice(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        async with session_factory() as session:
            planner = await add_agent(
                session, name="writer", owner_id=pt.world.owner.id
            )
            await session.commit()
            grant, warning = await pt.broker.set_grant(
                session,
                agent=planner,
                actor_id=pt.world.owner.id,
                service="example",
                access=None,
                tool_mode=None,
                tools=None,
                resources={},
            )
        assert (grant.access, grant.resources, warning) == ("write", {}, None)

        async with session_factory() as session:
            for access, tools in (("read", None), (None, ["search_items"])):
                with pytest.raises(ServiceError) as caught:
                    await pt.broker.set_grant(
                        session,
                        agent=planner,
                        actor_id=pt.world.owner.id,
                        service="example",
                        access=access,  # type: ignore[arg-type]
                        tool_mode=None,
                        tools=tools,
                        resources={},
                    )
                assert caught.value.status_code == 422
                assert "on or off" in caught.value.message

    async def test_a_connection_made_read_only_narrows_every_grant_at_once(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        async with session_factory() as session:
            decided = await pt.broker.decide(
                session, pt.world.agent.id, Principal.agent_key(), "example"
            )
            assert decided.access == "write"
            await session.execute(
                update(ServiceConnection)
                .where(ServiceConnection.user_id == pt.world.owner.id)
                .values(consent="read")
            )
            await session.commit()
            decided = await pt.broker.decide(
                session, pt.world.agent.id, Principal.agent_key(), "example"
            )
        assert (decided.access, decided.reach) == ("read", {"scopes": ["read:items"]})

    async def test_removing_the_grant_or_the_sweep_never_revokes_the_owners_token(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")
        async with session_factory() as session:
            grant = await STORE.get_grant(session, pt.world.agent.id, "example")
            assert grant is not None
            warning = await pt.broker.revoke_grant(session, grant, pt.world.owner.id)
        await maintain_once(session_factory, pt.broker, prune=False)
        assert pt.vendor.revoked == []
        assert pt.vendor.connections_revoked == []
        # Nothing could take it back, so the record says it was withdrawn and
        # the warning says until when it may keep working.
        async with session_factory() as session:
            [record] = await session.scalars(select(ServiceTokenIssuance))
        assert (record.revoke_requested, record.encrypted_token) == (True, None)
        assert warning == (
            "Example access already given to agents cannot be taken back and may "
            f"keep working until {record.expires_at.astimezone(UTC):%Y-%m-%d %H:%M} UTC."
        )

    async def test_withdrawing_access_marks_only_the_live_pass_through_tokens(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")
        async with session_factory() as session:
            [live] = await session.scalars(select(ServiceTokenIssuance))
            expired = ServiceTokenIssuance(
                tenant_id=TENANT_ZERO_ID,
                grant_id=live.grant_id,
                agent_id=live.agent_id,
                owner_id=live.owner_id,
                service="example",
                principal="agent_key",
                controller_id=None,
                permissions={},
                resources={},
                expires_at=datetime.now(UTC) - timedelta(minutes=5),
                token_sha256="0" * 64,
                encrypted_token=None,
                revoke_requested=False,
                attempts=0,
            )
            session.add(expired)
            await session.commit()
            live_id, expired_id = live.id, expired.id

        async with session_factory() as session:
            await pt.broker.queue_revocation(
                session, ServiceTokenIssuance.agent_id == pt.world.agent.id
            )
            await session.commit()
            warning = await pt.broker.revoke_withdrawn(
                session, (ServiceTokenIssuance.agent_id == pt.world.agent.id,)
            )
        async with session_factory() as session:
            marked = {
                row.id: row.revoke_requested
                for row in await session.scalars(select(ServiceTokenIssuance))
            }
        assert marked == {live_id: True, expired_id: False}
        assert warning is not None and warning.startswith("Example access already")

    async def test_the_sweep_marks_a_pass_through_token_whose_owner_left(
        self, session_factory, tmp_path
    ) -> None:
        """A workspace holding only pass-through tokens is still swept."""
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")
        async with session_factory() as session:
            await session.execute(
                delete(TenantMember).where(TenantMember.user_id == pt.world.owner.id)
            )
            await session.commit()
        await maintain_once(session_factory, pt.broker, prune=False)
        async with session_factory() as session:
            [record] = await session.scalars(select(ServiceTokenIssuance))
        assert (record.revoke_requested, record.encrypted_token) == (True, None)
        assert pt.vendor.revoked == []

    async def test_disconnecting_another_service_names_only_what_it_withdrew(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=50 * 60)
        await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")
        async with session_factory() as session:
            await pt.broker.queue_revocation(
                session, ServiceTokenIssuance.agent_id == pt.world.agent.id
            )
            await session.commit()
            # A service this server has no adapter for: its sign-in cannot be
            # revoked, so the secret is never read.
            warning = await pt.broker.finish_disconnect(
                session,
                pt.world.owner.id,
                [("unset", None)],  # type: ignore[list-item]
            )
        assert warning is not None
        assert "unset is not set up on this server" in warning
        assert "Example access" not in warning

    async def test_a_disconnect_revoked_where_that_ends_its_tokens_names_none(
        self, session_factory, tmp_path
    ) -> None:
        """Revoking the sign-in at a vendor whose revocation ends its tokens
        takes back what agents were given, so nothing is said to keep working."""
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=REVOKES_TOKENS
        )
        await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")
        async with session_factory() as session:
            warning = await pt.broker.disconnect(session, pt.world.owner.id, "example")
        assert len(pt.vendor.connections_revoked) == 1
        assert warning is None

    async def test_a_disconnect_whose_revocation_leaves_its_tokens_says_until_when(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(
            session_factory,
            tmp_path / "c",
            expires_in=50 * 60,
            entry=REVOKES_TOKENS.replace("    revocation_ends_tokens: true\n", ""),
        )
        await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")
        async with session_factory() as session:
            warning = await pt.broker.disconnect(session, pt.world.owner.id, "example")
        assert len(pt.vendor.connections_revoked) == 1
        assert warning is not None and warning.startswith("Example access already")

    async def test_a_disconnect_whose_revocation_failed_says_until_when(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=REVOKES_TOKENS
        )
        await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")

        async def refuses(secret: ConnectionSecret) -> None:
            raise ServiceAdapterError("Example refused to revoke the sign-in.")

        monkeypatch.setattr(pt.vendor, "revoke_connection", refuses)
        async with session_factory() as session:
            warning = await pt.broker.disconnect(session, pt.world.owner.id, "example")
        assert warning is not None
        assert "Example could not revoke the sign-in." in warning
        assert "Example access already given to agents cannot be taken back" in warning


def _workspace_refusal(name: str) -> str:
    return (
        f"{name} is not enabled in this workspace. Ask a workspace admin; they "
        "switch it on under Connectors in Switch Console."
    )


class Gated:
    """A broker with the workspace switch wired, over the shipped catalog and
    `example`, a pass-through OAuth vendor. Ada owns `builder`, connected to
    GitHub and `example` and granted both."""

    def __init__(
        self,
        broker: ServiceBroker,
        github: FakeVendor,
        example: FakeVendor,
        world: World,
    ) -> None:
        self.broker = broker
        self.github = github
        self.example = example
        self.world = world


async def _gated(
    session_factory: async_sessionmaker[AsyncSession],
    root: Path,
    *,
    gate: bool,
    disabled: dict[str, str] | None = None,
) -> Gated:
    github = FakeVendor()
    example = FakeVendor()
    example.pass_through = True
    example.revocable = False
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=pass_through_catalog(root),
        adapters={"github": github, "example": example},
        disabled=disabled or {},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=gate,
        public_url=None,
    )
    world = await _world(session_factory)
    async with session_factory() as session:
        await STORE.save_connection(
            session,
            user_id=world.owner.id,
            service="example",
            consent="write",
            granted_scopes=["read:items", "write:items"],
            account_id="acct-1",
            external_identity="ada@example.test",
            encrypted_secret=TEST_KEYRING.encrypt(
                json.dumps(
                    {
                        "access_token": "owner_access_0",
                        "expires_at": time.time() + 50 * 60,
                        "refresh_token": "owner_refresh_0",
                    }
                )
            ),
            oauth_client_id=None,
        )
        await STORE.save_grant(
            session,
            agent_id=world.agent.id,
            owner_id=world.owner.id,
            service="example",
            access="write",
            tool_mode="deny",
            tools=[],
            resources={},
            account_id="acct-1",
            created_by=world.owner.id,
        )
        await session.commit()
    return Gated(broker, github, example, world)


async def _on_by_default(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """Make the workspace one that had members before services started off."""
    async with session_factory() as session:
        await session.execute(
            update(Tenant)
            .where(Tenant.id == TENANT_ZERO_ID)
            .values(services_on_by_default=True)
        )
        await session.commit()


async def _switch(
    session_factory: async_sessionmaker[AsyncSession],
    service: str,
    enabled: bool,
    admin_id: str,
) -> None:
    async with session_factory() as session:
        await WorkspaceServiceStore().set_enabled(session, service, enabled, admin_id)
        await session.commit()


async def _issue_github(g: Gated, session_factory) -> None:
    await _issue(g.broker, session_factory, g.world.agent.id)


async def _set_grant_github(g: Gated, session_factory) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, g.world.agent.id)
        assert agent is not None
        await g.broker.set_grant(
            session,
            agent=agent,
            actor_id=g.world.owner.id,
            service="github",
            access="read",
            tool_mode=None,
            tools=None,
            resources=RESOURCES,
        )


NEW_GITHUB_SIGN_IN = {**_secret(expires_in=3600), "access_token": "gho_access_new"}
NEW_EXAMPLE_SIGN_IN = {
    "access_token": "owner_access_new",
    "expires_at": time.time() + 3600,
    "refresh_token": "owner_refresh_new",
}
DATADOG_KEY = {"api_key": "k", "application_key": "a", "site": "datadoghq.eu"}


async def _connect_github(g: Gated, session_factory) -> None:
    async with session_factory() as session:
        await g.broker.connect(
            session,
            user_id=g.world.owner.id,
            service="github",
            consent="write",
            granted_scopes=[],
            account_id="1001",
            external_identity="ada-gh",
            secret=ConnectionSecret(dict(NEW_GITHUB_SIGN_IN)),
            oauth_client_id=None,
        )


async def _connect_key(g: Gated, session_factory) -> None:
    async with session_factory() as session:
        await g.broker.connect(
            session,
            user_id=g.world.owner.id,
            service="datadog",
            consent="write",
            granted_scopes=[],
            account_id="dd-org",
            external_identity="Key · datadoghq.eu",
            secret=ConnectionSecret(dict(DATADOG_KEY)),
            oauth_client_id=None,
        )


async def _relink_oauth(g: Gated, session_factory) -> None:
    async with session_factory() as session:
        await g.broker.connect(
            session,
            user_id=g.world.owner.id,
            service="example",
            consent="write",
            granted_scopes=["read:items", "write:items"],
            account_id="acct-1",
            external_identity="ada@example.test",
            secret=ConnectionSecret(dict(NEW_EXAMPLE_SIGN_IN)),
            oauth_client_id=None,
        )


# Each entry point, the service it acts on, and that service's name.
ENTRY_POINTS = {
    "issue": (_issue_github, "github", "GitHub"),
    "set_grant": (_set_grant_github, "github", "GitHub"),
    "connect_github": (_connect_github, "github", "GitHub"),
    "relink_oauth": (_relink_oauth, "example", "Example"),
}


class TestWorkspaceSwitch:
    @pytest.mark.parametrize("entry_point", sorted(ENTRY_POINTS))
    @pytest.mark.parametrize(
        ("gate", "row", "on_by_default"),
        [(False, False, False), (True, True, False), (True, None, True)],
        ids=["gate_off_row_off", "gate_on_enabled", "gate_on_no_row_on_by_default"],
    )
    async def test_allowed(
        self, session_factory, tmp_path, entry_point, gate, row, on_by_default
    ) -> None:
        call, service, _ = ENTRY_POINTS[entry_point]
        g = await _gated(session_factory, tmp_path / "c", gate=gate)
        if on_by_default:
            await _on_by_default(session_factory)
        if row is not None:
            await _switch(session_factory, service, row, g.world.owner.id)
        await call(g, session_factory)

    @pytest.mark.parametrize("entry_point", sorted(ENTRY_POINTS))
    async def test_a_new_workspace_has_every_service_off_until_an_admin_switches_it_on(
        self, session_factory, tmp_path, entry_point
    ) -> None:
        call, service, name = ENTRY_POINTS[entry_point]
        g = await _gated(session_factory, tmp_path / "c", gate=True)
        async with session_factory() as session:
            assert await g.broker.workspace_disabled(session) == set(g.broker._catalog)

        with pytest.raises(ServiceError) as caught:
            await call(g, session_factory)
        assert (caught.value.status_code, caught.value.code) == (403, "forbidden")
        assert caught.value.message == _workspace_refusal(name)

        await _switch(session_factory, service, True, g.world.owner.id)
        await call(g, session_factory)

    @pytest.mark.parametrize("entry_point", sorted(ENTRY_POINTS))
    async def test_switched_off_in_the_workspace_is_refused_naming_who_and_where(
        self, session_factory, tmp_path, entry_point
    ) -> None:
        call, service, name = ENTRY_POINTS[entry_point]
        g = await _gated(session_factory, tmp_path / "c", gate=True)
        await _switch(session_factory, service, False, g.world.owner.id)
        before = await _all_connections(session_factory)

        with pytest.raises(ServiceError) as caught:
            await call(g, session_factory)

        refused = caught.value
        assert (refused.status_code, refused.code, refused.retryable) == (
            403,
            "forbidden",
            False,
        )
        assert refused.message == _workspace_refusal(name)
        assert g.github.issued == [] and g.github.refreshes == 0
        assert g.github.checked == []
        assert await _all_connections(session_factory) == before

    @pytest.mark.parametrize("entry_point", sorted(ENTRY_POINTS))
    async def test_the_servers_own_reason_is_checked_first(
        self, session_factory, tmp_path, entry_point
    ) -> None:
        call, service, _ = ENTRY_POINTS[entry_point]
        g = await _gated(
            session_factory,
            tmp_path / "c",
            gate=True,
            disabled={service: "Maintenance"},
        )
        await _switch(session_factory, service, True, g.world.owner.id)
        with pytest.raises(ServiceError) as caught:
            await call(g, session_factory)
        assert caught.value.message == "Maintenance"
        # A grant reads the server's switch as unavailable, as it always has.
        assert caught.value.status_code == (422 if entry_point == "set_grant" else 403)

    async def test_a_new_sign_in_refused_by_the_workspace_is_revoked_at_the_vendor(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=True)
        await _switch(session_factory, "example", False, g.world.owner.id)
        with pytest.raises(ServiceError):
            await _relink_oauth(g, session_factory)
        assert [secret.values for secret in g.example.connections_revoked] == [
            NEW_EXAMPLE_SIGN_IN
        ]

        await _switch(session_factory, "github", False, g.world.owner.id)
        with pytest.raises(ServiceError):
            await _connect_github(g, session_factory)
        assert [secret.access_token for secret in g.github.connections_revoked] == [
            "gho_access_new"
        ]

    @pytest.mark.parametrize("enabled", [True, False])
    async def test_a_key_that_never_expires_is_not_stored(
        self, session_factory, tmp_path, enabled
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=True)
        await _switch(session_factory, "datadog", enabled, g.world.owner.id)
        with pytest.raises(ServiceError) as caught:
            await _connect_key(g, session_factory)
        assert (caught.value.status_code, caught.value.code) == (403, "forbidden")
        assert caught.value.message == (
            "Datadog keys do not expire and only Datadog can revoke them, so "
            "Switch does not hand them to agents."
        )
        assert "datadog" not in {
            service for service, _, _ in await _all_connections(session_factory)
        }

    async def test_switching_off_keeps_the_grant_and_switching_on_restores_it(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=True)
        await _switch(session_factory, "github", False, g.world.owner.id)

        refused = await _refused(g.broker, session_factory, g.world.agent.id)
        assert (refused.status_code, refused.code) == (403, "forbidden")
        async with session_factory() as session:
            grant = await STORE.get_grant(session, g.world.agent.id, "github")
        assert grant is not None
        assert (grant.id, grant.revision) == (g.world.grant.id, g.world.grant.revision)

        await _switch(session_factory, "github", True, g.world.owner.id)
        token = await _issue(g.broker, session_factory, g.world.agent.id)
        assert token.grant_revision == g.world.grant.revision

    async def test_a_switched_off_service_drops_out_of_the_sessions_grants(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=True)
        await _on_by_default(session_factory)

        async def listed() -> list[str]:
            async with session_factory() as session:
                agent = await session.get(Agent, g.world.agent.id)
                assert agent is not None
                grants = await g.broker.grants_for(
                    session, agent, Principal.agent_key()
                )
            return sorted(grant["service"] for grant in grants)

        assert await listed() == ["example", "github"]
        await _switch(session_factory, "example", False, g.world.owner.id)
        assert await listed() == ["github"]
        await _switch(session_factory, "example", True, g.world.owner.id)
        assert await listed() == ["example", "github"]

    async def test_with_the_gate_off_a_row_changes_nothing(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=False)
        await _switch(session_factory, "example", False, g.world.owner.id)
        async with session_factory() as session:
            agent = await session.get(Agent, g.world.agent.id)
            assert agent is not None
            grants = await g.broker.grants_for(session, agent, Principal.agent_key())
            assert await g.broker.workspace_disabled(session) == set()
        assert sorted(grant["service"] for grant in grants) == ["example", "github"]

    async def test_disconnecting_a_service_switched_off_still_works(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=True)
        await _switch(session_factory, "github", False, g.world.owner.id)
        async with session_factory() as session:
            await g.broker.disconnect(session, g.world.owner.id, "github")
        assert await _connection(session_factory, g.world.owner.id) is None
        assert len(g.github.connections_revoked) == 1


class TestSessionGrants:
    """A session is given a grant only where a token for it would be issued,
    so it never holds tools whose every call is refused."""

    async def _listed(self, g: Gated, session_factory) -> list[str]:
        async with session_factory() as session:
            agent = await session.get(Agent, g.world.agent.id)
            assert agent is not None
            grants = await g.broker.grants_for(session, agent, Principal.agent_key())
        return sorted(grant["service"] for grant in grants)

    async def test_a_service_switched_off_on_the_server_is_left_out(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(
            session_factory,
            tmp_path / "c",
            gate=False,
            disabled={"example": "Maintenance"},
        )

        assert await self._listed(g, session_factory) == ["github"]
        refused = await _refused(
            g.broker, session_factory, g.world.agent.id, service="example"
        )
        assert refused.message == "Maintenance"

    async def test_a_service_whose_app_is_removed_is_left_out_until_it_is_back(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=False)
        g.broker.replace_adapter("example", None)

        assert await self._listed(g, session_factory) == ["github"]
        refused = await _refused(
            g.broker, session_factory, g.world.agent.id, service="example"
        )
        assert (refused.status_code, refused.code) == (503, "internal")
        assert refused.message == g.broker.availability("example")

        g.broker.replace_adapter("example", g.example)
        assert await self._listed(g, session_factory) == ["example", "github"]

    async def test_github_whose_app_cannot_issue_is_left_out(
        self, session_factory, tmp_path
    ) -> None:
        g = await _gated(session_factory, tmp_path / "c", gate=False)
        g.github.can_issue = False

        assert await self._listed(g, session_factory) == ["example"]
        refused = await _refused(g.broker, session_factory, g.world.agent.id)
        assert refused.message == g.broker.availability("github")
        assert g.github.issued == []


async def _all_connections(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[tuple[str, str, str]]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(ServiceConnection).order_by(ServiceConnection.service)
        )
        return [(row.service, row.account_id, row.encrypted_secret) for row in rows]


class TestReplacedClient:
    async def _recorded(
        self, session_factory: async_sessionmaker[AsyncSession], world: World, client
    ) -> None:
        async with session_factory() as session:
            await session.execute(
                update(ServiceConnection)
                .where(ServiceConnection.user_id == world.owner.id)
                .values(oauth_client_id=client)
            )
            await session.commit()

    async def test_a_connection_through_a_replaced_client_must_reconnect(
        self, broker, session_factory, vendor
    ) -> None:
        """Told at once, with no vendor call: a refresh token the old client
        issued is no use to the new one."""
        world = await _world(session_factory, expires_in=60)
        await self._recorded(session_factory, world, "old-client")
        vendor.client_id = "new-client"
        connection = await _connection(session_factory, world.owner.id)
        assert connection is not None
        # Read as needing reconnecting before anything asks for a token.
        assert connection.status == "active"
        assert broker.connection_status(connection) == "needs_reauthorization"

        refused = await _refused(broker, session_factory, world.agent.id)

        assert refused.code == CONNECTOR_REVOKED
        assert refused.message == (
            "GitHub was connected through an app this server no longer uses. "
            "The agent's owner must reconnect GitHub from Connectors in Switch "
            "Console."
        )
        assert vendor.refreshes == 0 and vendor.issued == []
        connection = await _connection(session_factory, world.owner.id)
        assert connection is not None
        assert (connection.status, connection.error_code) == (
            "needs_reauthorization",
            CLIENT_REPLACED,
        )

    async def test_the_owner_is_told_to_reconnect_it_themselves(
        self, broker, session_factory, vendor
    ) -> None:
        """The owner reading their own connection, as GitHub's repository
        picker does: once as the replaced client is found, and again once it
        is recorded."""
        world = await _world(session_factory, expires_in=60)
        await self._recorded(session_factory, world, "old-client")
        vendor.client_id = "new-client"

        for _ in range(2):
            with pytest.raises(ServiceError) as caught:
                async with session_factory() as session:
                    await broker.connection_access_token(
                        session, world.owner.id, "github"
                    )
            assert (caught.value.status_code, caught.value.code) == (
                409,
                CONNECTOR_REVOKED,
            )
            assert caught.value.message == (
                "GitHub was connected through an app this server no longer "
                "uses. Reconnect GitHub from Connectors in Switch Console."
            )
        assert vendor.refreshes == 0

    async def test_a_refused_sign_in_tells_the_owner_to_reconnect(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory, expires_in=60)
        vendor.refresh_error = ReauthorizationRequiredError(
            "GitHub refused the sign-in."
        )

        with pytest.raises(ServiceError) as caught:
            async with session_factory() as session:
                await broker.connection_access_token(session, world.owner.id, "github")

        assert caught.value.message == (
            "GitHub refused the sign-in. Reconnect GitHub from Connectors in "
            "Switch Console."
        )
        connection = await _connection(session_factory, world.owner.id)
        assert connection is not None
        assert connection.error_code == "refresh_refused"

    async def test_the_same_client_issues_as_before(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        await self._recorded(session_factory, world, "example-client")
        vendor.client_id = "example-client"

        token = await _issue(broker, session_factory, world.agent.id)
        assert token.resources == RESOURCES

    async def test_a_disconnect_after_the_app_is_removed_says_why_nothing_was_revoked(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        broker.replace_adapter("github", None)
        async with session_factory() as session:
            warning = await broker.disconnect(session, world.owner.id, "github")
        assert warning == (
            "GitHub is not set up on this server, so Switch could not revoke "
            "the sign-in. Revoke it at GitHub."
        )
        assert vendor.connections_revoked == []
        assert await _connection(session_factory, world.owner.id) is None

    async def test_a_vendor_that_answers_badly_keeps_the_general_warning(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)

        async def refused(secret: object) -> None:
            raise ServiceAdapterError("GitHub answered 500.")

        vendor.revoke_connection = refused  # type: ignore[method-assign]
        async with session_factory() as session:
            warning = await broker.disconnect(session, world.owner.id, "github")
        assert warning == (
            "GitHub could not revoke the sign-in. Revoke it in your GitHub settings."
        )

    async def test_an_unrecorded_client_keeps_todays_behaviour(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        await self._recorded(session_factory, world, None)
        vendor.client_id = "new-client"

        token = await _issue(broker, session_factory, world.agent.id)
        assert token.resources == RESOURCES
        connection = await _connection(session_factory, world.owner.id)
        assert connection is not None
        assert broker.client_replaced(connection) is False

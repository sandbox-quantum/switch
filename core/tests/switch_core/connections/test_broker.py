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
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.broker import (
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
    HostedLaunch,
    HostedMachine,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    TenantMember,
    User,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.test_loader import OAUTH_ENTRY, _write_example
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.hosted_machine_helpers import seed_launch, seed_machine

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
        assert "Settings, Connections" in again.message
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
        )
        world = await _world(session_factory)
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code, refused.retryable) == (
            503,
            "internal",
            False,
        )
        assert "not available on this server" in refused.message
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


async def _launch(
    session_factory: async_sessionmaker[AsyncSession],
    world: World,
    *,
    state: str,
    desired_state: str,
    machine_state: str = "ready",
    machine_desired: str = "running",
) -> str:
    async with session_factory() as session:
        machine = await seed_machine(
            session,
            owner_id=world.owner.id,
            slot_id="slot-a",
            state=machine_state,
            desired_state=machine_desired,
            stop_reason=None if machine_desired == "running" else "idle",
            revision=1,
            generation=1,
        )
        launch = await seed_launch(
            session,
            machine=machine,
            request_id=str(uuid.uuid4()),
            name=world.agent.name,
            state=state,
            desired_state=desired_state,
            revision=1,
            agent_id=world.agent.id,
            spec={"installation_id": 7, "repository_id": 70},
        )
        await session.commit()
        return launch.id


class TestCloudLaunch:
    async def test_a_running_cloud_agent_is_issued(
        self, broker, session_factory
    ) -> None:
        world = await _world(session_factory)
        await _launch(session_factory, world, state="ready", desired_state="running")
        token = await _issue(broker, session_factory, world.agent.id)
        assert token.resources == RESOURCES

    @pytest.mark.parametrize(
        ("state", "desired_state"),
        [("ready", "stopped"), ("error", "running"), ("deleting", "running")],
        ids=["stopped", "error", "deleting"],
    )
    async def test_a_cloud_agent_whose_launch_is_not_running_is_refused(
        self, broker, session_factory, vendor, state, desired_state
    ) -> None:
        world = await _world(session_factory)
        await _launch(session_factory, world, state=state, desired_state=desired_state)
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (403, "forbidden")
        assert "launch or machine is not running" in refused.message
        assert vendor.issued == []
        assert await _issuances(session_factory) == []

    @pytest.mark.parametrize(
        ("machine_state", "machine_desired"),
        [("ready", "stopped"), ("stopped", "stopped"), ("error", "running")],
        ids=["stopping", "asleep", "failed"],
    )
    async def test_a_cloud_agent_whose_machine_is_not_running_is_refused(
        self, broker, session_factory, vendor, machine_state, machine_desired
    ) -> None:
        world = await _world(session_factory)
        await _launch(
            session_factory,
            world,
            state="ready",
            desired_state="running",
            machine_state=machine_state,
            machine_desired=machine_desired,
        )
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code) == (403, "forbidden")
        assert "launch or machine is not running" in refused.message
        assert vendor.issued == []

    @pytest.mark.parametrize(
        "machine_state", ["stopped", "retained"], ids=["waking", "reclaimed"]
    )
    async def test_a_waking_machine_is_asked_to_retry_not_refused(
        self, broker, session_factory, vendor, machine_state
    ) -> None:
        world = await _world(session_factory)
        await _launch(
            session_factory,
            world,
            state="ready",
            desired_state="running",
            machine_state=machine_state,
            machine_desired="running",
        )
        refused = await _refused(broker, session_factory, world.agent.id)
        assert (refused.status_code, refused.code, refused.retryable) == (
            503,
            "internal",
            True,
        )
        assert "starting" in refused.message
        assert vendor.issued == []

    async def test_a_machine_stopped_after_issuing_has_its_tokens_revoked(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        await _launch(session_factory, world, state="ready", desired_state="running")
        token = await _issue(broker, session_factory, world.agent.id)
        async with session_factory() as session:
            await session.execute(
                update(HostedMachine).values(
                    desired_state="stopped", stop_reason="idle"
                )
            )
            await session.commit()
        async with session_factory() as session:
            await broker.revoke_pending(session, ())
        assert vendor.revoked == [token.token]

    async def test_a_launch_stopped_while_issuing_takes_the_token_back(
        self, broker, session_factory, vendor
    ) -> None:
        world = await _world(session_factory)
        launch_id = await _launch(
            session_factory, world, state="ready", desired_state="running"
        )

        async def stop_the_launch() -> None:
            async with session_factory() as session:
                await session.execute(
                    update(HostedLaunch)
                    .where(HostedLaunch.id == launch_id)
                    .values(desired_state="stopped")
                )
                await session.commit()

        vendor.during_issue = stop_the_launch
        refused = await _refused(broker, session_factory, world.agent.id)
        assert "launch or machine is not running" in refused.message
        assert vendor.revoked == [vendor.issued[0][1]]
        assert await _issuances(session_factory) == []


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
                ServiceTokenIssuance.__table__.update().values(encrypted_token=None)
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
        )
        world = await _world(session_factory, expires_in=60)

        reason = broker.availability("github")
        assert reason is not None and "not granted to agents" in reason
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


class TestLaunchChangesInFlight:
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
    )


class TestSwitchedOff:
    async def test_a_switched_off_service_says_why_and_is_neither_connected_nor_granted(
        self, session_factory, vendor
    ) -> None:
        reason = "Coming to this server soon."
        broker = _switched_off(session_factory, vendor, {"github": reason})
        world = await _world(session_factory)

        assert broker.availability("github") == reason
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


def pass_through_catalog(root: Path, *, max_lifetime: int = 3600) -> dict:
    """The shipped catalog and `example`, a pass-through OAuth/MCP vendor."""
    shutil.copytree(CATALOG_ROOT, root)
    _write_example(
        root,
        OAUTH_ENTRY.replace("max_lifetime: 3600", f"max_lifetime: {max_lifetime}"),
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
) -> PassThrough:
    vendor = FakeVendor()
    vendor.pass_through = True
    vendor.revocable = False
    vendor.refreshed_lifetime = timedelta(hours=1)
    broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=pass_through_catalog(root, max_lifetime=max_lifetime),
        adapters={"example": vendor},
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
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
            {"name": "example", "url": "https://mcp.example.test/v1/mcp"}
        ]
        assert grant["skill"]["name"] == "example"

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

    async def test_refuses_a_token_past_the_catalogs_lifetime_and_revokes_nothing(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(session_factory, tmp_path / "c", expires_in=2 * 3600)
        refused = await _refused(
            pt.broker, session_factory, pt.world.agent.id, service="example"
        )
        assert (refused.status_code, refused.code, refused.retryable) == (
            500,
            "internal",
            False,
        )
        assert "does not expire within an hour" in refused.message
        assert pt.vendor.revoked == []

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
        assert warning is None
        await maintain_once(session_factory, pt.broker, prune=False)
        assert pt.vendor.revoked == []
        assert pt.vendor.connections_revoked == []

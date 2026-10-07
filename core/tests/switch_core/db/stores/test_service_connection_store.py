"""The service-connection store against Postgres.

What is worth pinning here is what the schema promises rather than the
queries: one connection per person and service, re-linked in place; one grant
per agent and service, gone with its agent or its connection, and only ever on
its owner's own connection; issuance records that outlive both, lose their
ciphertext when the token expires, and are pruned after retention. And that a
second tenant reads none of it.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ConnectionSecret
from switch_core.db.models import (
    Agent,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import (
    ServiceConnectionChanged,
    ServiceConnectionStore,
)
from tests.conftest import TEST_KEYRING, RLSHarness
from tests.switch_core.gateway.agent_route_harness import add_agent

STORE = ServiceConnectionStore()
SECRET = {
    "access_token": "gho_access_value_for_tests",
    "expires_at": 2_000_000_000,
    "refresh_token": "ghr_refresh_value_for_tests",
    "refresh_expires_at": 2_100_000_000,
}


async def _user(session: AsyncSession, name: str) -> User:
    user = User(
        name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
    )
    session.add(user)
    await session.flush()
    return user


async def _connect(
    session: AsyncSession,
    user_id: str,
    *,
    account_id: str = "1001",
    consent: str = "write",
    secret: dict | None = None,
) -> None:
    await STORE.save_connection(
        session,
        user_id=user_id,
        service="github",
        consent=consent,
        granted_scopes=[],
        account_id=account_id,
        external_identity=f"login-{account_id}",
        encrypted_secret=TEST_KEYRING.encrypt(json.dumps(secret or SECRET)),
    )


async def _grant(
    session: AsyncSession, agent: Agent, owner_id: str, *, account_id: str = "1001"
) -> ServiceGrant:
    return await STORE.save_grant(
        session,
        agent_id=agent.id,
        owner_id=owner_id,
        service="github",
        access="read",
        tool_mode="allow",
        tools=[],
        resources={"installation_id": 7, "repository_ids": [70]},
        account_id=account_id,
        created_by=owner_id,
    )


def _issuance(
    grant: ServiceGrant, *, created_at: datetime, expires_at: datetime
) -> ServiceTokenIssuance:
    return ServiceTokenIssuance(
        grant_id=grant.id,
        agent_id=grant.agent_id,
        owner_id=grant.owner_id,
        service="github",
        principal="agent_key",
        controller_id=None,
        permissions={"permissions": {"contents": "read"}},
        resources={"installation_id": 7, "repository_ids": [70]},
        expires_at=expires_at,
        token_sha256="0" * 64,
        encrypted_token=TEST_KEYRING.encrypt("ghs_issued_value"),
        revoke_requested=False,
        attempts=0,
        created_at=created_at,
    )


class TestConnections:
    async def test_one_per_person_and_service_relinked_in_place(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            await _connect(session, owner.id)
            await STORE.mark_needs_reauthorization(
                session, owner.id, "github", "refresh_refused"
            )
            await _connect(session, owner.id, account_id="2002", consent="read")
            await session.commit()

            rows = list(await session.scalars(select(ServiceConnection)))
            assert len(rows) == 1
            connection = rows[0]
            assert (connection.account_id, connection.consent) == ("2002", "read")
            assert (connection.status, connection.error_code) == ("active", None)
            assert connection.secret_revision == 2

            session.add(
                ServiceConnection(
                    user_id=owner.id,
                    service="github",
                    status="active",
                    consent="read",
                    granted_scopes=[],
                    account_id="3003",
                    external_identity="other",
                    encrypted_secret="x",
                    secret_revision=1,
                )
            )
            with pytest.raises(IntegrityError):
                await session.flush()

    async def test_the_secret_round_trips_and_stays_out_of_repr(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            await _connect(session, owner.id)
            await session.commit()
            connection = await STORE.get_connection(session, owner.id, "github")
            assert connection is not None
            assert SECRET["refresh_token"] not in connection.encrypted_secret
            secret = ConnectionSecret(
                json.loads(TEST_KEYRING.decrypt(connection.encrypted_secret))
            )
            assert secret.values == SECRET
            assert secret.access_token == SECRET["access_token"]
            for shown in (repr(connection), repr(secret)):
                assert SECRET["access_token"] not in shown
                assert SECRET["refresh_token"] not in shown

    async def test_a_refreshed_secret_replaces_only_the_revision_it_read(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            await _connect(session, owner.id)
            assert (
                await STORE.replace_secret(
                    session, owner.id, "github", revision=1, encrypted_secret="new"
                )
                == 2
            )
            with pytest.raises(ServiceConnectionChanged):
                await STORE.replace_secret(
                    session, owner.id, "github", revision=1, encrypted_secret="stale"
                )


class TestGrants:
    async def test_one_per_agent_and_service_replaced_in_place(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="builder", owner_id=owner.id)
            await _connect(session, owner.id)
            first = await _grant(session, agent, owner.id)
            replaced = await STORE.save_grant(
                session,
                agent_id=agent.id,
                owner_id=owner.id,
                service="github",
                access="write",
                tool_mode="deny",
                tools=[],
                resources={"installation_id": 7, "repository_ids": [70, 71]},
                account_id="1001",
                created_by=owner.id,
            )
            assert replaced.id == first.id
            assert replaced.access == "write"
            assert [g.id for g in await STORE.list_grants(session, agent.id)] == [
                first.id
            ]

    async def test_deleting_the_agent_deletes_its_grants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="builder", owner_id=owner.id)
            await _connect(session, owner.id)
            await _grant(session, agent, owner.id)
            await session.commit()
            await session.execute(delete(Agent).where(Agent.id == agent.id))
            await session.commit()
            assert await session.scalar(select(func.count(ServiceGrant.id))) == 0

    async def test_disconnecting_deletes_the_grants_on_the_connection(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="builder", owner_id=owner.id)
            await _connect(session, owner.id)
            grant = await _grant(session, agent, owner.id)
            session.add(
                _issuance(
                    grant,
                    created_at=datetime.now(UTC),
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                )
            )
            await session.commit()
            await STORE.delete_connection(session, owner.id, "github")
            await session.commit()
            assert await STORE.list_grants(session, agent.id) == []
            # The record outlives both.
            assert (
                await session.scalar(select(func.count(ServiceTokenIssuance.id))) == 1
            )

    async def test_a_grant_can_only_name_its_owners_own_connection(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session, "ada")
            other = await _user(session, "bob")
            agent = await add_agent(session, name="builder", owner_id=owner.id)
            await _connect(session, other.id)
            await session.commit()
            with pytest.raises(IntegrityError, match="fk_service_grants_connection"):
                await _grant(session, agent, owner.id)


class TestIssuances:
    async def test_pruning_removes_only_records_past_retention(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="builder", owner_id=owner.id)
            await _connect(session, owner.id)
            grant = await _grant(session, agent, owner.id)
            old = _issuance(
                grant,
                created_at=now - timedelta(days=31),
                expires_at=now - timedelta(days=31) + timedelta(hours=1),
            )
            kept = _issuance(
                grant,
                created_at=now - timedelta(days=29),
                expires_at=now - timedelta(days=29) + timedelta(hours=1),
            )
            session.add_all([old, kept])
            await session.commit()
            assert await STORE.prune(session, now - timedelta(days=30)) == 1
            await session.commit()
            assert list(await session.scalars(select(ServiceTokenIssuance.id))) == [
                kept.id
            ]

    async def test_an_expired_token_loses_its_ciphertext_and_keeps_its_record(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            owner = await _user(session, "ada")
            agent = await add_agent(session, name="builder", owner_id=owner.id)
            await _connect(session, owner.id)
            grant = await _grant(session, agent, owner.id)
            expired = _issuance(
                grant,
                created_at=now - timedelta(hours=2),
                expires_at=now - timedelta(hours=1),
            )
            live = _issuance(grant, created_at=now, expires_at=now + timedelta(hours=1))
            session.add_all([expired, live])
            await session.commit()
            await STORE.clear_expired(session, now)
            await session.commit()
            rows = {
                row.id: row
                for row in await session.scalars(
                    select(ServiceTokenIssuance).execution_options(
                        populate_existing=True
                    )
                )
            }
            assert rows[expired.id].encrypted_token is None
            assert rows[expired.id].token_sha256 == "0" * 64
            assert rows[live.id].encrypted_token is not None


@pytest.mark.no_ambient_tenant
class TestTenantIsolation:
    async def _tenant(self, owner: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
        suffix = uuid.uuid4().hex[:8]
        async with owner() as session:
            session.add(Tenant(id=f"tenant-{suffix}", slug=suffix, name=suffix))
            user = User(name=suffix, email=f"{suffix}@example.invalid", role="user")
            session.add(user)
            await session.flush()
            session.add(
                TenantMember(
                    tenant_id=f"tenant-{suffix}", user_id=user.id, role="owner"
                )
            )
            await session.commit()
            return f"tenant-{suffix}", user.id

    async def test_another_tenant_reads_none_of_it(
        self, rls_harness: RLSHarness
    ) -> None:
        tenant_a, user_a = await self._tenant(rls_harness.owner)
        tenant_b, user_b = await self._tenant(rls_harness.owner)
        now = datetime.now(UTC)
        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            agent = await add_agent(session, name="builder", owner_id=user_a)
            await _connect(session, user_a)
            grant = await _grant(session, agent, user_a)
            session.add(
                _issuance(grant, created_at=now, expires_at=now + timedelta(hours=1))
            )
            await session.commit()
            agent_id = agent.id

        async with tenant_session(rls_harness.restricted, tenant_b) as session:
            assert await STORE.get_connection(session, user_a, "github") is None
            assert await STORE.list_connections(session, user_a) == []
            assert await STORE.list_grants(session, agent_id) == []
            for model in (ServiceConnection, ServiceGrant, ServiceTokenIssuance):
                assert (
                    await session.scalar(select(func.count()).select_from(model)) == 0
                )

            # Tenant B's own connection, granted to tenant A's agent.
            await _connect(session, user_b)
            with pytest.raises(IntegrityError, match="fk_service_grants_agent"):
                await STORE.save_grant(
                    session,
                    agent_id=agent_id,
                    owner_id=user_b,
                    service="github",
                    access="read",
                    tool_mode="allow",
                    tools=[],
                    resources={},
                    account_id="1001",
                    created_by=user_b,
                )

"""Changes made in the directory applied in Switch, taking away as well as
granting (`organization_mirror.apply_from_directory`), against Postgres, on
the restricted role row-level security applies to; `owner` only arranges
fixtures and reads results."""

from __future__ import annotations

import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import organization_mirror
from switch_core.connections.broker import ServiceBroker, ServiceError
from switch_core.connections.loader import CATALOG
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.audit import AuditAction, OrganizationAuditAction
from switch_core.db.models import (
    Agent,
    ApiKey,
    AuditEvent,
    Client,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    Package,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.keys import Keyring
from switch_core.organization_access import AccessRevocation
from switch_core.organization_mirror import MirrorDependencies, apply_from_directory
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

_KEYRING = Keyring.parse(
    "test:" + "organization-mirror-test-secret-" + "0" * 32, legacy_secret=None
)


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _dependencies(
    session_factory: async_sessionmaker[AsyncSession],
) -> MirrorDependencies:
    return MirrorDependencies(
        revocation=_revocation(session_factory),
        organization_store=OrganizationStore(),
        user_store=UserStore(),
    )


def _revocation(session_factory: async_sessionmaker[AsyncSession]) -> AccessRevocation:
    return AccessRevocation(
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        broker=ServiceBroker(
            session_factory=session_factory,
            keyring=_KEYRING,
            catalog=CATALOG,
            adapters={},
            organization_apps=None,
            disabled={},
            store=ServiceConnectionStore(),
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
        ),
        protocol=SimpleNamespace(  # type: ignore[arg-type]
            api_key_cache=SimpleNamespace(invalidate=lambda key_hash: None)
        ),
        sign_in_flows=SignInFlows(session_factory, _KEYRING),
    )


class _World:
    """A linked organization with Ada and Bea its `org_admin`s: `joined`, a
    workspace Ada is a member of (Bea owns it), and `reached`, one she
    stands in only as `org_admin`. Ada holds a personal key in each."""

    def __init__(self, organization_id: str, joined: str, reached: str) -> None:
        self.organization_id = organization_id
        self.workos_organization_id = _id("org_workos")
        self.joined = joined
        self.reached = reached
        self.ada = _id("ada")
        self.bea = _id("bea")

    @classmethod
    async def make(
        cls,
        owner: async_sessionmaker[AsyncSession],
        *,
        bea_role: str = "org_admin",
        ada_administers_joined: bool = False,
    ) -> _World:
        world = cls(_id("org"), _id("joined"), _id("reached"))
        async with owner() as session:
            session.add(
                Organization(
                    id=world.organization_id,
                    slug=world.organization_id,
                    name="Acme",
                    workos_organization_id=world.workos_organization_id,
                )
            )
            for user_id in (world.ada, world.bea):
                session.add(
                    User(
                        id=user_id,
                        name=user_id,
                        email=f"{user_id}@example.invalid",
                        role="user",
                    )
                )
            await session.flush()
            for tenant_id in (world.joined, world.reached):
                session.add(
                    Tenant(
                        id=tenant_id,
                        slug=tenant_id,
                        name=tenant_id,
                        organization_id=world.organization_id,
                    )
                )
            session.add_all(
                [
                    OrganizationMember(
                        organization_id=world.organization_id,
                        user_id=world.ada,
                        role="org_admin",
                    ),
                    OrganizationMember(
                        organization_id=world.organization_id,
                        user_id=world.bea,
                        role=bea_role,
                    ),
                ]
            )
            await session.flush()
            session.add(
                TenantMember(
                    tenant_id=world.joined,
                    user_id=world.ada,
                    role="admin" if ada_administers_joined else "member",
                )
            )
            if not ada_administers_joined:
                session.add(
                    TenantMember(
                        tenant_id=world.joined, user_id=world.bea, role="admin"
                    )
                )
            for tenant_id in (world.joined, world.reached):
                session.add(_key(tenant_id, world.ada, "personal"))
            await session.commit()
        return world


def _key(tenant_id: str, user_id: str, type_: str) -> ApiKey:
    return ApiKey(
        id=_id("key"),
        tenant_id=tenant_id,
        user_id=user_id,
        key_hash=uuid.uuid4().hex,
        encrypted_key="unused-in-tests",
        label="test-key",
        type=type_,
    )


async def _agent(owner, tenant_id: str, owner_id: str) -> str:
    async with owner() as session:
        client = Client(
            tenant_id=tenant_id,
            transport_user_id=f"@bot-{uuid.uuid4().hex[:8]}:test",
            display_name="bot",
            type="agent",
        )
        key = _key(tenant_id, owner_id, "agent")
        session.add_all([client, key])
        await session.flush()
        agent = Agent(
            tenant_id=tenant_id,
            name=_id("agent"),
            description="test agent",
            agent_type="other",
            connector_type="claude-code",
            integration_profile={},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=owner_id,
        )
        session.add(agent)
        await session.commit()
        return agent.id


async def _role(owner, organization_id: str, user_id: str) -> str | None:
    async with owner() as session:
        member = await session.get(OrganizationMember, (organization_id, user_id))
    return None if member is None else member.role


async def _keys(owner, tenant_id: str, user_id: str) -> list[str]:
    async with owner() as session:
        return list(
            await session.scalars(
                select(ApiKey.type).where(
                    ApiKey.tenant_id == tenant_id, ApiKey.user_id == user_id
                )
            )
        )


async def _organization_events(owner, organization_id: str) -> list[tuple[str, dict]]:
    async with owner() as session:
        rows = await session.scalars(
            select(OrganizationAuditEvent)
            .where(OrganizationAuditEvent.organization_id == organization_id)
            .order_by(OrganizationAuditEvent.occurred_at)
        )
        return [(event.action, event.details) for event in rows]


async def _workspace_actions(owner, tenant_id: str) -> list[str]:
    async with owner() as session:
        return list(
            await session.scalars(
                select(AuditEvent.action).where(AuditEvent.tenant_id == tenant_id)
            )
        )


async def _apply(
    rls_harness: RLSHarness,
    world: _World,
    wanted: str | None,
    *,
    workos_organization_id: str | None = None,
) -> None:
    await apply_from_directory(
        rls_harness.restricted,
        _dependencies(rls_harness.restricted),
        organization_id=world.organization_id,
        workos_organization_id=workos_organization_id or world.workos_organization_id,
        user_id=world.ada,
        wanted=wanted,
        source="directory_event",
    )


class TestTakingAway:
    async def test_a_removal_ends_every_access_through_the_organization(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        world = await _World.make(owner)

        await _apply(rls_harness, world, None)

        assert await _role(owner, world.organization_id, world.ada) is None
        async with owner() as session:
            assert await session.get(TenantMember, (world.joined, world.ada)) is None
        assert await _keys(owner, world.joined, world.ada) == []
        assert await _keys(owner, world.reached, world.ada) == []
        assert await _workspace_actions(owner, world.joined) == [
            AuditAction.MEMBER_REMOVED
        ]
        assert await _workspace_actions(owner, world.reached) == [
            AuditAction.ORGANIZATION_ADMIN_ACCESS_ENDED
        ]
        [(action, details)] = await _organization_events(owner, world.organization_id)
        assert action == OrganizationAuditAction.MEMBER_REMOVED_FROM_DIRECTORY
        assert details == {
            "source": "directory_event",
            "from_role": "org_admin",
            "role": None,
        }

    async def test_a_demotion_ends_what_only_org_admin_reached(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        world = await _World.make(owner)

        await _apply(rls_harness, world, "member")

        assert await _role(owner, world.organization_id, world.ada) == "member"
        assert await _keys(owner, world.joined, world.ada) == ["personal"]
        assert await _keys(owner, world.reached, world.ada) == []
        [(action, _)] = await _organization_events(owner, world.organization_id)
        assert action == OrganizationAuditAction.MEMBER_DEMOTED_FROM_DIRECTORY

    async def test_what_only_org_admin_reached_passes_to_an_admin_there(
        self, rls_harness: RLSHarness
    ) -> None:
        """Ending access that came only from being `org_admin` leaves what Ada
        owns in that workspace with someone who can still reach it, as a
        removal does."""
        owner = rls_harness.owner
        world = await _World.make(owner)
        cleo = _id("cleo")
        async with owner() as session:
            session.add(
                User(id=cleo, name=cleo, email=f"{cleo}@example.invalid", role="user")
            )
            await session.flush()
            session.add(
                TenantMember(tenant_id=world.reached, user_id=cleo, role="admin")
            )
            package = Package(
                tenant_id=world.reached,
                owner_id=world.ada,
                name="kit",
                description="",
                instructions="",
                read_visibility="private",
                write_visibility="private",
            )
            session.add(package)
            await session.commit()
            package_id = package.id

        await _apply(rls_harness, world, "member")

        async with owner() as session:
            moved = await session.get(Package, package_id)
            assert moved is not None and moved.owner_id == cleo
            ended = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.tenant_id == world.reached,
                    AuditEvent.action == AuditAction.ORGANIZATION_ADMIN_ACCESS_ENDED,
                )
            )
            assert ended is not None and ended.details is not None
            assert ended.details["handed_over_to"] == cleo
            assert ended.details["handed_over"] == {"package": 1}

    async def test_nothing_is_applied_once_the_organization_follows_another(
        self, rls_harness: RLSHarness
    ) -> None:
        """A role read from a WorkOS organization the organization no longer
        follows (unlinked or relinked meanwhile) is not WorkOS's say here."""
        owner = rls_harness.owner
        world = await _World.make(owner)

        await _apply(rls_harness, world, None, workos_organization_id=_id("org_old"))

        assert await _role(owner, world.organization_id, world.ada) == "org_admin"
        assert await _organization_events(owner, world.organization_id) == []

    async def test_the_same_role_changes_nothing(self, rls_harness: RLSHarness) -> None:
        owner = rls_harness.owner
        world = await _World.make(owner)

        await _apply(rls_harness, world, "org_admin")

        assert await _organization_events(owner, world.organization_id) == []
        assert await _keys(owner, world.reached, world.ada) == ["personal"]


class TestConflicts:
    """WorkOS is the record, so its change is applied even where it breaks a
    rule Switch keeps, and what it broke is recorded for the admins."""

    async def test_the_last_org_admin_is_removed_all_the_same(
        self, rls_harness: RLSHarness, caplog: pytest.LogCaptureFixture
    ) -> None:
        owner = rls_harness.owner
        world = await _World.make(owner, bea_role="member")

        await _apply(rls_harness, world, None)

        assert await _role(owner, world.organization_id, world.ada) is None
        events = await _organization_events(owner, world.organization_id)
        assert (
            OrganizationAuditAction.DIRECTORY_CONFLICT,
            {"source": "directory_event", "kind": "last_org_admin"},
        ) in events
        assert any(
            record.levelname == "ERROR" and "broke a rule" in record.message
            for record in caplog.records
        )

    async def test_agents_stay_with_the_keys_they_run_on(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        world = await _World.make(owner)
        agent_id = await _agent(owner, world.joined, world.ada)

        await _apply(rls_harness, world, None)

        async with owner() as session:
            agent = await session.get(Agent, agent_id)
        assert agent is not None and agent.owner_id == world.ada
        assert await _keys(owner, world.joined, world.ada) == ["agent"]
        assert (
            OrganizationAuditAction.DIRECTORY_CONFLICT,
            {
                "source": "directory_event",
                "kind": "agents_left_with_owner",
                "workspace": world.joined,
            },
        ) in await _organization_events(owner, world.organization_id)

    async def test_a_workspace_left_with_no_admin_is_recorded(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        world = await _World.make(owner, ada_administers_joined=True)

        await _apply(rls_harness, world, None)

        async with owner() as session:
            assert await session.get(TenantMember, (world.joined, world.ada)) is None
        assert (
            OrganizationAuditAction.DIRECTORY_CONFLICT,
            {
                "source": "directory_event",
                "kind": "workspace_left_without_admin",
                "workspace": world.joined,
            },
        ) in await _organization_events(owner, world.organization_id)


class TestGranting:
    async def test_someone_listed_is_added_with_where_it_came_from(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        world = await _World.make(owner)
        cy = _id("cy")
        async with owner() as session:
            session.add(
                User(id=cy, name=cy, email=f"{cy}@example.invalid", role="user")
            )
            await session.commit()

        await apply_from_directory(
            rls_harness.restricted,
            _dependencies(rls_harness.restricted),
            organization_id=world.organization_id,
            workos_organization_id=world.workos_organization_id,
            user_id=cy,
            wanted="member",
            source="daily_check",
        )

        assert await _role(owner, world.organization_id, cy) == "member"
        [(action, details)] = await _organization_events(owner, world.organization_id)
        assert action == OrganizationAuditAction.MEMBER_ADDED_FROM_DIRECTORY
        assert details == {"source": "daily_check", "role": "member"}


class TestARetryAfterAFailure:
    async def test_finds_the_workspaces_left_and_their_conflicts_recorded(
        self, rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ada is the only admin of `joined` and owns an agent there; a second
        workspace she is in has a busy connection the first time."""
        owner = rls_harness.owner
        world = await _World.make(owner, ada_administers_joined=True)
        await _agent(owner, world.joined, world.ada)
        busy = _id("busy")
        async with owner() as session:
            session.add(
                Tenant(
                    id=busy,
                    slug=busy,
                    name="Busy",
                    organization_id=world.organization_id,
                )
            )
            await session.flush()
            session.add(TenantMember(tenant_id=busy, user_id=world.ada, role="member"))
            await session.commit()
        real = organization_mirror.remove_membership

        async def busy_once(session, revocation, membership, **kwargs):
            if membership.tenant_id == busy:
                raise ServiceError(
                    409, "internal", "A connection is busy.", retryable=True
                )
            return await real(session, revocation, membership, **kwargs)

        monkeypatch.setattr(organization_mirror, "remove_membership", busy_once)
        with pytest.raises(ServiceError):
            await _apply(rls_harness, world, None)
        monkeypatch.setattr(organization_mirror, "remove_membership", real)
        await _apply(rls_harness, world, None)

        conflicts = [
            details["kind"]
            for action, details in await _organization_events(
                owner, world.organization_id
            )
            if action == OrganizationAuditAction.DIRECTORY_CONFLICT
        ]
        assert sorted(conflicts) == [
            "agents_left_with_owner",
            "workspace_left_without_admin",
        ]
        assert await _role(owner, world.organization_id, world.ada) is None

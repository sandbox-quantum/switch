"""`/organizations/current/members`: an organization's `org_admin`s list its
members, grant or take back `org_admin` and remove members, never below one
`org_admin`. Also the workspace roster's organization admins, and the
platform operator's access, which every workspace it enters records."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import ServiceBroker
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
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt, decode_jwt
from switch_core.gateway.organizations import router as organizations_router
from switch_core.gateway.tenants import router as tenants_router
from switch_core.keys import Keyring

_KEYRING = Keyring.parse(
    "test:" + "organization-routes-test-secret-" + "0" * 32, legacy_secret=None
)


class _FakeClientLifecycle:
    """`ClientLifecycleService.create_tenant`'s database half, without the
    admin client it provisions."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_tenant(self, name: str, slug: str, organization_id: str) -> Tenant:
        tenant = Tenant(
            id=str(uuid.uuid4()), name=name, slug=slug, organization_id=organization_id
        )
        async with tenant_session(self._session_factory, tenant.id) as session:
            await TenantStore().create(session, tenant)
            await session.commit()
        return tenant


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    signup_mode: str = "open",
    max_workspaces_per_user: int = 3,
) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(organizations_router)
    app.include_router(tenants_router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_organization_store] = lambda: (
        OrganizationStore()
    )
    app.dependency_overrides[gw_deps.get_client_lifecycle] = lambda: (
        _FakeClientLifecycle(session_factory)
    )
    app.dependency_overrides[gw_deps.get_agent_store] = lambda: AgentStore()
    app.dependency_overrides[gw_deps.get_api_key_store] = lambda: ApiKeyStore()
    app.dependency_overrides[gw_deps.get_protocol] = lambda: SimpleNamespace(
        api_key_cache=SimpleNamespace(invalidate=lambda key_hash: None)
    )
    app.state.sign_in_flows = SignInFlows(session_factory, _KEYRING)
    app.state.service_broker = ServiceBroker(
        session_factory=session_factory,
        keyring=_KEYRING,
        catalog=CATALOG,
        adapters={},
        disabled={},
        store=ServiceConnectionStore(),
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
        gateway_signup_mode=signup_mode,
        gateway_max_workspaces_per_user=max_workspaces_per_user,
    )
    return app


def _client(app: FastAPI, user_id: str, tenant_id: str | None) -> httpx.AsyncClient:
    token = create_jwt(
        user_id, f"{user_id}@example.invalid", "user", _KEYRING, tenant_id
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _workspace(
    session_factory: async_sessionmaker[AsyncSession],
    members: dict[str, tuple[str, str]],
) -> str:
    """A workspace in an organization of its own, with `members`
    (name -> (workspace role, organization role)). Users are named by id."""
    organization_id = f"org-{uuid.uuid4().hex[:8]}"
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Organization(id=organization_id, slug=organization_id, name="Acme"))
        await session.flush()
        session.add(
            Tenant(
                id=tenant_id,
                slug=tenant_id,
                name="Acme",
                organization_id=organization_id,
            )
        )
        for name, (workspace_role, organization_role) in members.items():
            session.add(
                User(id=name, name=name, email=f"{name}@example.invalid", role="user")
            )
            await session.flush()
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=name, role=workspace_role)
            )
            session.add(
                OrganizationMember(
                    organization_id=organization_id,
                    user_id=name,
                    role=organization_role,
                )
            )
        await session.commit()
    return tenant_id


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:6]}"


class TestListing:
    async def test_an_org_admin_sees_every_member_and_their_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.get("/organizations/current/members")

        assert response.status_code == 200, response.text
        assert {row["user_id"]: row["role"] for row in response.json()} == {
            ada: "org_admin",
            bob: "member",
        }

    async def test_a_workspace_admin_who_is_no_org_admin_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("admin", "member")}
        )

        async with _client(_app(session_factory), bob, tenant_id) as client:
            response = await client.get("/organizations/current/members")

        assert response.status_code == 403


class TestChangingRoles:
    async def test_an_org_admin_grants_org_admin_and_it_is_audited(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert response.status_code == 200, response.text
        assert response.json()["role"] == "org_admin"
        [event] = await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.ROLE_CHANGED
        )
        assert event.actor_user_id == ada and event.target_id == bob
        assert event.details == {
            "from": "member",
            "to": "org_admin",
            "workspace_id": tenant_id,
        }

    async def test_a_member_cannot_grant_themselves_org_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("admin", "member")}
        )

        async with _client(_app(session_factory), bob, tenant_id) as client:
            response = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert response.status_code == 403

    async def test_the_last_org_admin_cannot_be_demoted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.patch(
                f"/organizations/current/members/{ada}", json={"role": "member"}
            )

        assert response.status_code == 409

    async def test_an_unknown_role_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.patch(
                f"/organizations/current/members/{ada}", json={"role": "owner"}
            )

        assert response.status_code == 422

    async def test_a_demoted_org_admin_can_then_be_demoted_in_the_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The way out of the workspace's 409: demote in the organization,
        then in the workspace."""
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("admin", "org_admin")}
        )

        async with _client(_app(session_factory), ada, tenant_id) as client:
            refused = await client.patch(
                f"/tenants/{tenant_id}/members/{bob}", json={"role": "member"}
            )
            in_organization = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )
            in_workspace = await client.patch(
                f"/tenants/{tenant_id}/members/{bob}", json={"role": "member"}
            )

        assert refused.status_code == 409
        assert in_organization.status_code == 200, in_organization.text
        assert in_workspace.status_code == 200, in_workspace.text
        assert in_workspace.json()["role"] == "member"


async def _operator(session_factory: async_sessionmaker[AsyncSession]) -> str:
    operator_id = _name("operator")
    async with session_factory() as session:
        session.add(
            User(
                id=operator_id,
                name=operator_id,
                email=f"{operator_id}@example.invalid",
                role="admin",
            )
        )
        await session.commit()
    return operator_id


async def _events(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    action: AuditAction,
) -> list[AuditEvent]:
    async with tenant_session(session_factory, tenant_id) as session:
        return list(
            await session.scalars(select(AuditEvent).where(AuditEvent.action == action))
        )


async def _organization_events(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    action: OrganizationAuditAction,
) -> list[OrganizationAuditEvent]:
    """`action`'s events in the log of `tenant_id`'s organization."""
    async with tenant_session(session_factory, tenant_id) as session:
        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None
        return list(
            await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.organization_id == tenant.organization_id,
                    OrganizationAuditEvent.action == action,
                )
            )
        )


class TestRemoving:
    async def test_someone_still_in_a_workspace_of_it_is_refused_by_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.delete(f"/organizations/current/members/{bob}")

        assert response.status_code == 409
        assert "Acme" in response.json()["detail"]

    async def test_someone_in_none_of_its_workspaces_is_removed_and_it_is_audited(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )
        async with tenant_session(session_factory, tenant_id) as session:
            await session.delete(await session.get(TenantMember, (tenant_id, bob)))
            await session.commit()

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.delete(f"/organizations/current/members/{bob}")
            listed = await client.get("/organizations/current/members")

        assert response.status_code == 200, response.text
        assert [row["user_id"] for row in listed.json()] == [ada]
        [event] = await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.MEMBER_REMOVED
        )
        assert event.target_id == bob
        assert (
            await _events(session_factory, tenant_id, AuditAction.MEMBER_REMOVED) == []
        )

    async def test_the_last_org_admin_cannot_be_removed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.delete(f"/organizations/current/members/{ada}")

        assert response.status_code == 409
        assert "last organization admin" in response.json()["detail"]


class TestTheWorkspaceRoster:
    async def test_lists_org_admins_with_no_membership_as_admin_via_the_organization(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob, cy = _name("ada"), _name("bob"), _name("cy")
        tenant_id = await _workspace(
            session_factory,
            {
                ada: ("owner", "org_admin"),
                bob: ("member", "member"),
                cy: ("member", "org_admin"),
            },
        )
        async with tenant_session(session_factory, tenant_id) as session:
            await session.delete(await session.get(TenantMember, (tenant_id, cy)))
            await session.commit()

        async with _client(_app(session_factory), bob, tenant_id) as client:
            response = await client.get(f"/tenants/{tenant_id}/members")

        assert response.status_code == 200, response.text
        rows = {
            row["user_id"]: (
                row["role"],
                row["organization_role"],
                row["via_organization"],
            )
            for row in response.json()
        }
        assert rows == {
            ada: ("owner", "org_admin", False),
            bob: ("member", "member", False),
            cy: ("admin", "org_admin", True),
        }


class TestThePlatformOperator:
    async def test_entering_a_workspace_is_recorded_there(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})
        operator_id = await _operator(session_factory)

        async with _client(_app(session_factory), operator_id, None) as client:
            switched = await client.post(f"/tenants/{tenant_id}/switch")

        assert switched.status_code == 200, switched.text
        [event] = await _events(session_factory, tenant_id, AuditAction.PLATFORM_ACCESS)
        assert event.actor_user_id == operator_id
        assert event.details == {"event": "entered"}

    async def test_reads_are_not_recorded_and_every_write_is(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("admin", "member")}
        )
        operator_id = await _operator(session_factory)

        async with _client(_app(session_factory), operator_id, tenant_id) as client:
            current = await client.get("/tenants/current")
            write = await client.patch(
                f"/tenants/{tenant_id}/members/{bob}", json={"role": "member"}
            )

        assert current.status_code == 200, current.text
        assert current.json()["administers"] is True
        assert write.status_code == 200, write.text
        [event] = await _events(session_factory, tenant_id, AuditAction.PLATFORM_ACCESS)
        assert event.details == {
            "event": "write",
            "method": "PATCH",
            "route": "/tenants/{tenant_id}/members/{user_id}",
        }

    async def test_an_operator_there_through_a_role_is_not_marked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A self-hosted server's operator is its first organization's
        `org_admin`, and is there as that."""
        operator_id = await _operator(session_factory)
        bob = _name("bob")
        tenant_id = await _workspace(session_factory, {bob: ("admin", "member")})
        async with session_factory() as session:
            tenant = await session.get(Tenant, tenant_id)
            assert tenant is not None and tenant.organization_id is not None
            session.add(
                OrganizationMember(
                    organization_id=tenant.organization_id,
                    user_id=operator_id,
                    role="org_admin",
                )
            )
            await session.commit()

        async with _client(_app(session_factory), operator_id, None) as client:
            await client.post(f"/tenants/{tenant_id}/switch")
        async with _client(_app(session_factory), operator_id, tenant_id) as client:
            write = await client.patch(
                f"/tenants/{tenant_id}/members/{bob}", json={"role": "member"}
            )

        assert write.status_code == 200, write.text
        assert (
            await _events(session_factory, tenant_id, AuditAction.PLATFORM_ACCESS) == []
        )

    async def test_only_the_operator_lists_every_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})
        operator_id = await _operator(session_factory)

        async with _client(_app(session_factory), operator_id, None) as client:
            listed = await client.get("/operator/workspaces")
        async with _client(_app(session_factory), ada, tenant_id) as client:
            refused = await client.get("/operator/workspaces")

        assert listed.status_code == 200, listed.text
        [row] = [row for row in listed.json() if row["id"] == tenant_id]
        assert row["organization_name"] == "Acme"
        assert refused.status_code == 403

    async def test_restores_an_org_admin_only_where_there_is_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        bob, cy = _name("bob"), _name("cy")
        orphaned = await _workspace(session_factory, {bob: ("owner", "member")})
        governed = await _workspace(
            session_factory,
            {cy: ("owner", "org_admin"), _name("dee"): ("member", "member")},
        )
        operator_id = await _operator(session_factory)

        async with _client(_app(session_factory), operator_id, orphaned) as client:
            restored = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )
        async with _client(_app(session_factory), operator_id, governed) as client:
            refused = await client.get("/organizations/current/members")

        assert restored.status_code == 200, restored.text
        assert restored.json()["role"] == "org_admin"
        assert refused.status_code == 403
        [event] = await _events(session_factory, orphaned, AuditAction.PLATFORM_ACCESS)
        assert event.details is not None and event.details["method"] == "PATCH"
        [changed] = await _organization_events(
            session_factory, orphaned, OrganizationAuditAction.ROLE_CHANGED
        )
        assert changed.actor_user_id == operator_id
        assert changed.details is not None
        assert changed.details["platform_access"] is True


async def _user(session_factory: async_sessionmaker[AsyncSession], role: str) -> str:
    user_id = _name("newcomer")
    async with session_factory() as session:
        session.add(
            User(
                id=user_id,
                name=user_id,
                email=f"{user_id}@example.invalid",
                role=role,
            )
        )
        await session.commit()
    return user_id


async def _organization_id(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> str | None:
    async with tenant_session(session_factory, tenant_id) as session:
        tenant = await session.get(Tenant, tenant_id)
    assert tenant is not None
    return tenant.organization_id


async def _workspaces_created(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> int:
    async with session_factory() as session:
        user = await session.get(User, user_id)
    assert user is not None
    return user.workspaces_created


class TestCreatingAnOrganization:
    async def test_anyone_signed_in_creates_one_with_its_first_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = await _user(session_factory, "user")

        async with _client(_app(session_factory), ada, None) as client:
            response = await client.post(
                "/organizations", json={"name": "Acme", "workspace_name": "Research"}
            )

        assert response.status_code == 201, response.text
        body = response.json()
        organization, workspace = body["organization"], body["workspace"]
        assert (organization["name"], organization["slug"], organization["role"]) == (
            "Acme",
            "acme",
            "org_admin",
        )
        assert (workspace["name"], workspace["role"]) == ("Research", "owner")
        assert workspace["organization_id"] == organization["id"]
        assert (
            await _organization_id(session_factory, workspace["id"])
            == (organization["id"])
        )
        token = response.cookies.get("switch_auth")
        assert token is not None
        assert decode_jwt(token, _KEYRING)["tenant_id"] == workspace["id"]
        assert await _workspaces_created(session_factory, ada) == 1
        async with tenant_session(session_factory, workspace["id"]) as session:
            membership = await session.get(TenantMember, (workspace["id"], ada))
            organization_member = await session.get(
                OrganizationMember, (organization["id"], ada)
            )
        assert membership is not None and membership.role == "owner"
        assert organization_member is not None
        assert organization_member.role == "org_admin"
        async with tenant_session(session_factory, workspace["id"]) as session:
            logged = [
                (event.action, event.target_id)
                for event in await session.scalars(
                    select(OrganizationAuditEvent).order_by(
                        OrganizationAuditEvent.occurred_at
                    )
                )
                if event.organization_id == organization["id"]
            ]
        assert logged == [
            (OrganizationAuditAction.ORGANIZATION_CREATED, organization["id"]),
            (OrganizationAuditAction.WORKSPACE_CREATED, workspace["id"]),
        ]

    async def test_the_first_workspace_takes_the_organization_name_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = await _user(session_factory, "user")

        async with _client(_app(session_factory), ada, None) as client:
            response = await client.post("/organizations", json={"name": "Globex"})

        assert response.status_code == 201, response.text
        assert response.json()["workspace"]["name"] == "Globex"

    async def test_an_unusable_workspace_name_is_refused_before_anything_is_written(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = await _user(session_factory, "user")
        name = _name("Nameless")

        async with _client(_app(session_factory), ada, None) as client:
            response = await client.post(
                "/organizations", json={"name": name, "workspace_name": "!!!"}
            )

        assert response.status_code == 400
        async with session_factory() as session:
            assert (
                await session.scalar(
                    select(Organization).where(Organization.name == name)
                )
                is None
            )
        assert await _workspaces_created(session_factory, ada) == 0

    async def test_invite_only_sign_up_refuses_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = await _user(session_factory, "user")

        app = _app(session_factory, signup_mode="invite_only")
        async with _client(app, ada, None) as client:
            response = await client.post("/organizations", json={"name": "Initech"})

        assert response.status_code == 403
        assert await _workspaces_created(session_factory, ada) == 0


class TestCreatingAWorkspace:
    async def test_an_org_admin_adds_one_to_the_organization(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("member", "org_admin")})

        async with _client(_app(session_factory), ada, tenant_id) as client:
            response = await client.post(
                "/organizations/current/workspaces", json={"name": "Second"}
            )

        assert response.status_code == 201, response.text
        workspace = response.json()
        organization_id = await _organization_id(session_factory, tenant_id)
        assert workspace["organization_id"] == organization_id
        assert await _organization_id(session_factory, workspace["id"]) == (
            organization_id
        )
        assert workspace["role"] == "owner"
        # The session stays in the workspace it was in.
        assert response.cookies.get("switch_auth") is None
        assert await _workspaces_created(session_factory, ada) == 1
        [event] = await _events(
            session_factory, workspace["id"], AuditAction.TENANT_CREATED
        )
        assert event.actor_user_id == ada
        [added] = await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.WORKSPACE_CREATED
        )
        assert (added.actor_user_id, added.target_id) == (ada, workspace["id"])
        assert (
            await _organization_events(
                session_factory, tenant_id, OrganizationAuditAction.ORGANIZATION_CREATED
            )
            == []
        )
        async with tenant_session(session_factory, workspace["id"]) as session:
            membership = await session.get(TenantMember, (workspace["id"], ada))
        assert membership is not None and membership.role == "owner"

    async def test_a_workspace_admin_who_is_no_org_admin_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("admin", "member")}
        )

        async with _client(_app(session_factory), bob, tenant_id) as client:
            response = await client.post(
                "/organizations/current/workspaces", json={"name": "Second"}
            )

        assert response.status_code == 403
        assert await _workspaces_created(session_factory, bob) == 0

    async def test_invite_only_sign_up_does_not_stop_an_org_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})

        app = _app(session_factory, signup_mode="invite_only")
        async with _client(app, ada, tenant_id) as client:
            response = await client.post(
                "/organizations/current/workspaces", json={"name": "Second"}
            )

        assert response.status_code == 201, response.text

    async def test_it_counts_against_the_creator_allowance(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})

        app = _app(session_factory, max_workspaces_per_user=1)
        async with _client(app, ada, tenant_id) as client:
            first = await client.post(
                "/organizations/current/workspaces", json={"name": "Second"}
            )
            second = await client.post(
                "/organizations/current/workspaces", json={"name": "Third"}
            )

        assert first.status_code == 201, first.text
        assert second.status_code == 403


class TestListingOrganizationsAndWorkspaces:
    async def test_an_org_admin_sees_every_workspace_and_a_member_their_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )
        app = _app(session_factory)
        async with _client(app, ada, tenant_id) as client:
            created = await client.post(
                "/organizations/current/workspaces", json={"name": "Second"}
            )
            assert created.status_code == 201, created.text
            as_admin = await client.get("/organizations/current/workspaces")
        async with _client(app, bob, tenant_id) as client:
            as_member = await client.get("/organizations/current/workspaces")

        assert as_admin.status_code == 200, as_admin.text
        assert {row["id"] for row in as_admin.json()} == {
            tenant_id,
            created.json()["id"],
        }
        assert as_member.status_code == 200, as_member.text
        assert [row["id"] for row in as_member.json()] == [tenant_id]

    async def test_the_platform_operator_sees_every_workspace_of_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """There on the operator flag alone, the operator may enter every
        workspace of the organization, and is shown each as its admin."""
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})
        app = _app(session_factory)
        async with _client(app, ada, tenant_id) as client:
            created = await client.post(
                "/organizations/current/workspaces", json={"name": "Second"}
            )
            assert created.status_code == 201, created.text
        operator = await _operator(session_factory)

        async with _client(app, operator, tenant_id) as client:
            response = await client.get("/organizations/current/workspaces")

        assert response.status_code == 200, response.text
        assert {(row["id"], row["role"]) for row in response.json()} == {
            (tenant_id, "admin"),
            (created.json()["id"], "admin"),
        }

    async def test_the_caller_sees_each_of_their_organizations_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = await _user(session_factory, "user")
        app = _app(session_factory)
        async with _client(app, ada, None) as client:
            acme = await client.post("/organizations", json={"name": "Acme"})
            assert acme.status_code == 201, acme.text
        acme_workspace = acme.json()["workspace"]["id"]
        async with _client(app, ada, acme_workspace) as client:
            second = await client.post(
                "/organizations/current/workspaces", json={"name": "Second"}
            )
            assert second.status_code == 201, second.text
            globex = await client.post("/organizations", json={"name": "Globex"})
            assert globex.status_code == 201, globex.text
            listed = await client.get("/organizations")

        assert listed.status_code == 200, listed.text
        assert [(row["name"], row["role"]) for row in listed.json()] == [
            ("Acme", "org_admin"),
            ("Globex", "org_admin"),
        ]


class TestTheOrganizationAuditLog:
    async def test_an_org_admin_reads_it_newest_first(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )

        async with _client(_app(session_factory), ada, tenant_id) as client:
            for role in ("org_admin", "member"):
                changed = await client.patch(
                    f"/organizations/current/members/{bob}", json={"role": role}
                )
                assert changed.status_code == 200, changed.text
            response = await client.get("/organizations/current/audit-events")
            older = await client.get(
                "/organizations/current/audit-events",
                params={"before": response.json()[0]["occurred_at"]},
            )

        assert response.status_code == 200, response.text
        assert [
            (row["details"]["from"], row["details"]["to"]) for row in response.json()
        ] == [
            ("org_admin", "member"),
            ("member", "org_admin"),
        ]
        assert [row["id"] for row in older.json()] == [response.json()[1]["id"]]

    async def test_a_workspace_admin_who_is_no_org_admin_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("admin", "member")}
        )

        async with _client(_app(session_factory), bob, tenant_id) as client:
            response = await client.get("/organizations/current/audit-events")

        assert response.status_code == 403


class TestTheCurrentOrganization:
    async def test_a_member_and_the_operator_are_told_its_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        bob = _name("bob")
        tenant_id = await _workspace(session_factory, {bob: ("member", "member")})
        operator_id = await _operator(session_factory)

        async with _client(_app(session_factory), bob, tenant_id) as client:
            as_member = await client.get("/organizations/current")
        async with _client(_app(session_factory), operator_id, tenant_id) as client:
            as_operator = await client.get("/organizations/current")

        assert as_member.status_code == 200, as_member.text
        assert (as_member.json()["name"], as_member.json()["role"]) == (
            "Acme",
            "member",
        )
        assert as_operator.status_code == 200, as_operator.text
        assert as_operator.json()["role"] is None


class TestNamesInTheOrganizationAuditLog:
    async def test_people_no_longer_members_are_named(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The operator who restored an admin was never a member, and a
        removed member no longer is; both are named all the same."""
        bob, cy = _name("bob"), _name("cy")
        tenant_id = await _workspace(
            session_factory, {bob: ("owner", "member"), cy: ("member", "member")}
        )
        operator_id = await _operator(session_factory)
        app = _app(session_factory)
        async with _client(app, operator_id, tenant_id) as client:
            restored = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )
            assert restored.status_code == 200, restored.text
        async with tenant_session(session_factory, tenant_id) as session:
            membership = await session.get(TenantMember, (tenant_id, cy))
            assert membership is not None
            await session.delete(membership)
            await session.commit()
        async with _client(app, bob, tenant_id) as client:
            removed = await client.delete(f"/organizations/current/members/{cy}")
            assert removed.status_code == 200, removed.text
            response = await client.get("/organizations/current/audit-events")

        assert response.status_code == 200, response.text
        by_action = {row["action"]: row for row in response.json()}
        assert by_action["organization.role_changed"]["actor_name"] == operator_id
        assert by_action["organization.member_removed"]["target_name"] == cy
        assert by_action["organization.member_removed"]["actor_name"] == bob


class TestMarkingTheOperatorsOrganizationChanges:
    """`platform_access` on an organization event follows the organization's
    own decision, not whether the operator administers the bound workspace."""

    async def _operator_in(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        tenant_id: str,
        *,
        workspace_role: str,
        organization_role: str | None,
    ) -> str:
        operator_id = await _operator(session_factory)
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
            assert tenant is not None and tenant.organization_id is not None
            session.add(
                TenantMember(
                    tenant_id=tenant_id, user_id=operator_id, role=workspace_role
                )
            )
            if organization_role is not None:
                session.add(
                    OrganizationMember(
                        organization_id=tenant.organization_id,
                        user_id=operator_id,
                        role=organization_role,
                    )
                )
            await session.commit()
        return operator_id

    async def test_restoring_an_admin_is_marked_though_the_operator_owns_the_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        bob = _name("bob")
        tenant_id = await _workspace(session_factory, {bob: ("member", "member")})
        operator_id = await self._operator_in(
            session_factory, tenant_id, workspace_role="owner", organization_role=None
        )

        async with _client(_app(session_factory), operator_id, tenant_id) as client:
            restored = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert restored.status_code == 200, restored.text
        [event] = await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.ROLE_CHANGED
        )
        assert event.details is not None
        assert event.details.get("platform_access") is True

    async def test_a_change_made_as_org_admin_is_not_marked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        bob = _name("bob")
        tenant_id = await _workspace(session_factory, {bob: ("member", "member")})
        operator_id = await self._operator_in(
            session_factory,
            tenant_id,
            workspace_role="member",
            organization_role="org_admin",
        )

        async with _client(_app(session_factory), operator_id, tenant_id) as client:
            changed = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert changed.status_code == 200, changed.text
        [event] = await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.ROLE_CHANGED
        )
        assert event.details is not None
        assert "platform_access" not in event.details


async def _second_workspace(
    session_factory: async_sessionmaker[AsyncSession], beside: str
) -> str:
    """Another workspace in `beside`'s organization, with nobody in it."""
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        first = await session.get(Tenant, beside)
        assert first is not None
        session.add(
            Tenant(
                id=tenant_id,
                slug=tenant_id,
                name="Acme Two",
                organization_id=first.organization_id,
            )
        )
        await session.commit()
    return tenant_id


async def _personal_key(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, user_id: str
) -> str:
    key_hash = uuid.uuid4().hex
    async with session_factory() as session:
        session.add(
            ApiKey(
                tenant_id=tenant_id,
                user_id=user_id,
                key_hash=key_hash,
                encrypted_key="unused-in-tests",
                label="test-key",
                type="registration",
            )
        )
        await session.commit()
    return key_hash


async def _agent(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, owner_id: str
) -> None:
    async with session_factory() as session:
        client = Client(
            tenant_id=tenant_id,
            transport_user_id=f"@bot-{uuid.uuid4().hex[:8]}:test",
            display_name="bot",
            type="agent",
        )
        session.add(client)
        await session.flush()
        key = ApiKey(
            tenant_id=tenant_id,
            user_id=owner_id,
            key_hash=uuid.uuid4().hex,
            encrypted_key="unused-in-tests",
            label="agent-key",
            type="agent",
        )
        session.add(key)
        await session.flush()
        session.add(
            Agent(
                tenant_id=tenant_id,
                name=f"agent-{uuid.uuid4().hex[:6]}",
                description="test agent",
                agent_type="other",
                connector_type="claude-code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=owner_id,
            )
        )
        await session.commit()


async def _key_exists(
    session_factory: async_sessionmaker[AsyncSession], key_hash: str
) -> bool:
    async with session_factory() as session:
        return (
            await session.scalar(select(ApiKey.id).where(ApiKey.key_hash == key_hash))
        ) is not None


class TestLosingOrgAdmin:
    """An `org_admin` stands in every workspace of the organization, including
    those they hold no membership row in. Demoting or removing them takes
    away what they made there, as removing a workspace member does."""

    async def test_demoting_removes_their_keys_where_they_had_no_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        first = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "org_admin")}
        )
        second = await _second_workspace(session_factory, first)
        kept = await _personal_key(session_factory, first, bob)
        dropped = await _personal_key(session_factory, second, bob)

        async with _client(_app(session_factory), ada, first) as client:
            response = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )

        assert response.status_code == 200, response.text
        assert response.json()["role"] == "member"
        assert await _key_exists(session_factory, kept)
        assert not await _key_exists(session_factory, dropped)
        ended = await _events(
            session_factory, second, AuditAction.ORGANIZATION_ADMIN_ACCESS_ENDED
        )
        assert [
            (event.target_id, (event.details or {}).get("api_keys_deleted"))
            for event in ended
        ] == [(bob, 1)]

    async def test_demoting_is_refused_while_they_own_agents_there(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        first = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "org_admin")}
        )
        second = await _second_workspace(session_factory, first)
        await _agent(session_factory, second, bob)
        key = await _personal_key(session_factory, second, bob)

        async with _client(_app(session_factory), ada, first) as client:
            response = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )

        assert response.status_code == 409
        assert "Acme Two" in response.json()["detail"]
        assert await _key_exists(session_factory, key)
        organization_id = await _organization_id(session_factory, first)
        async with session_factory() as session:
            member = await session.get(OrganizationMember, (organization_id, bob))
            assert member is not None and member.role == "org_admin"

    async def test_removing_removes_their_keys_where_they_had_no_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        first = await _workspace(session_factory, {ada: ("owner", "org_admin")})
        second = await _second_workspace(session_factory, first)
        organization_id = await _organization_id(session_factory, first)
        assert organization_id is not None
        async with session_factory() as session:
            session.add(
                User(id=bob, name=bob, email=f"{bob}@example.invalid", role="user")
            )
            await session.flush()
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=bob, role="org_admin"
                )
            )
            await session.commit()
        dropped = await _personal_key(session_factory, second, bob)

        async with _client(_app(session_factory), ada, first) as client:
            response = await client.delete(f"/organizations/current/members/{bob}")

        assert response.status_code == 200, response.text
        assert not await _key_exists(session_factory, dropped)

    async def test_two_admins_demoting_each_other_at_once_leave_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("owner", "org_admin")}
        )
        app = _app(session_factory)

        async with (
            _client(app, ada, tenant_id) as as_ada,
            _client(app, bob, tenant_id) as as_bob,
        ):
            responses = await asyncio.gather(
                as_ada.patch(
                    f"/organizations/current/members/{bob}", json={"role": "member"}
                ),
                as_bob.patch(
                    f"/organizations/current/members/{ada}", json={"role": "member"}
                ),
            )

        # The refusal is 409 when the two overlap and the lock decides, and 403
        # when one finished before the other was authorized: either way, one.
        first, second = sorted(response.status_code for response in responses)
        assert first == 200 and second in (403, 409)
        organization_id = await _organization_id(session_factory, tenant_id)
        assert organization_id is not None
        async with session_factory() as session:
            admins = await OrganizationStore().count_admins(session, organization_id)
        assert admins == 1

    async def test_two_admins_removing_each_other_at_once_leave_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob, cy = _name("ada"), _name("bob"), _name("cy")
        first = await _workspace(session_factory, {cy: ("owner", "member")})
        organization_id = await _organization_id(session_factory, first)
        assert organization_id is not None
        async with session_factory() as session:
            for name in (ada, bob):
                session.add(
                    User(
                        id=name, name=name, email=f"{name}@example.invalid", role="user"
                    )
                )
                await session.flush()
                session.add(
                    OrganizationMember(
                        organization_id=organization_id, user_id=name, role="org_admin"
                    )
                )
            await session.commit()
        app = _app(session_factory)

        async with (
            _client(app, ada, first) as as_ada,
            _client(app, bob, first) as as_bob,
        ):
            responses = await asyncio.gather(
                as_ada.delete(f"/organizations/current/members/{bob}"),
                as_bob.delete(f"/organizations/current/members/{ada}"),
            )

        # The refusal is 409 when the two overlap and the lock decides, and 403
        # when one finished before the other was authorized: either way, one.
        first, second = sorted(response.status_code for response in responses)
        assert first == 200 and second in (403, 409)
        async with session_factory() as session:
            assert await OrganizationStore().count_admins(session, organization_id) == 1

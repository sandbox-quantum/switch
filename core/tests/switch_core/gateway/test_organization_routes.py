"""`/organizations/current/members`: an organization's `org_admin`s list its
members, grant or take back `org_admin` and remove members, never below one
`org_admin`. Also the workspace roster's organization admins, and the
platform operator's access, which every workspace it enters records."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    AuditEvent,
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.stores.user_store import UserStore
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
        async with tenant_session(session_factory, tenant_id) as session:
            event = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.ORGANIZATION_ROLE_CHANGED
                )
            )
        assert event is not None
        assert event.actor_user_id == ada and event.target_id == bob
        assert event.details is not None
        assert (event.details["from"], event.details["to"]) == ("member", "org_admin")

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
        [event] = await _events(
            session_factory, tenant_id, AuditAction.ORGANIZATION_MEMBER_REMOVED
        )
        assert event.target_id == bob

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
        assert tenant_id in {row["id"] for row in listed.json()}
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

    async def test_the_first_workspace_takes_the_organization_name_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada = await _user(session_factory, "user")

        async with _client(_app(session_factory), ada, None) as client:
            response = await client.post("/organizations", json={"name": "Globex"})

        assert response.status_code == 201, response.text
        assert response.json()["workspace"]["name"] == "Globex"

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
        assert event.details is not None
        assert event.details["organization_created"] is False
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

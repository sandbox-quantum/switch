"""`/organizations/current/members`: an organization's `org_admin`s list its
members and grant or take back `org_admin`, never below one."""

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
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.organizations import router as organizations_router
from switch_core.gateway.tenants import router as tenants_router
from switch_core.keys import Keyring

_KEYRING = Keyring.parse(
    "test:" + "organization-routes-test-secret-" + "0" * 32, legacy_secret=None
)


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(organizations_router)
    app.include_router(tenants_router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_organization_store] = lambda: (
        OrganizationStore()
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
    )
    return app


def _client(app: FastAPI, user_id: str, tenant_id: str) -> httpx.AsyncClient:
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

"""Leaving an organization you are in none of the workspaces of.

Against real Postgres, with the app `test_organization_routes.py` builds.
Removing someone from their last workspace in an organization leaves them in
the organization; they are offered leaving it, and may, unless they are its
org admin, still in one of its workspaces, or its members are kept in a
directory.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    OrganizationAuditEvent,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import organization_session
from switch_core.gateway import dependencies as gw_deps
from switch_core.organization_directory import LocalDirectory
from tests.switch_core.gateway.test_organization_routes import (
    _app,
    _client,
    _name,
    _workspace,
)

pytestmark = pytest.mark.asyncio


async def _organization_of(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> str:
    async with session_factory() as session:
        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None and tenant.organization_id is not None
        return tenant.organization_id


async def _member_of(
    session_factory: async_sessionmaker[AsyncSession],
    organization_id: str,
    user_id: str,
) -> bool:
    async with organization_session(session_factory, organization_id) as session:
        return (
            await session.get(OrganizationMember, (organization_id, user_id))
            is not None
        )


async def test_someone_removed_from_their_last_workspace_leaves_the_organization(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada, bob = _name("ada"), _name("bob")
    tenant_id = await _workspace(
        session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
    )
    organization_id = await _organization_of(session_factory, tenant_id)
    app = _app(session_factory)
    async with _client(app, ada, tenant_id) as client:
        removed = await client.delete(f"/tenants/{tenant_id}/members/{bob}")

    async with _client(app, bob, None) as client:
        offered = await client.get("/organizations/without-workspace")
        left = await client.post(f"/organizations/{organization_id}/leave")
        offered_after = await client.get("/organizations/without-workspace")

    assert removed.status_code == 200, removed.text
    assert offered.status_code == 200, offered.text
    assert offered.json() == [{"id": organization_id, "name": "Acme"}]
    assert left.status_code == 200, left.text
    assert offered_after.json() == []
    assert not await _member_of(session_factory, organization_id, bob)
    async with organization_session(session_factory, organization_id) as session:
        [event] = (
            await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.action == "organization.member_left"
                )
            )
        ).all()
    assert (event.actor_user_id, event.target_id) == (bob, bob)


async def test_their_last_workspace_names_the_organization_without_a_note(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Someone removed before removals were noted is still offered the
    organization their last workspace belongs to."""
    ada, bob = _name("ada"), _name("bob")
    tenant_id = await _workspace(
        session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
    )
    organization_id = await _organization_of(session_factory, tenant_id)
    async with session_factory() as session:
        membership = await session.get(TenantMember, (tenant_id, bob))
        assert membership is not None
        await session.delete(membership)
        user = await session.get(User, bob)
        assert user is not None
        user.metadata_ = {"last_tenant_id": tenant_id}
        await session.commit()

    async with _client(_app(session_factory), bob, None) as client:
        offered = await client.get("/organizations/without-workspace")

    assert offered.json() == [{"id": organization_id, "name": "Acme"}]


async def test_who_may_not_leave_this_way_is_told_why(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada, bob, cy = _name("ada"), _name("bob"), _name("cy")
    tenant_id = await _workspace(
        session_factory,
        {
            ada: ("admin", "org_admin"),
            bob: ("member", "member"),
            cy: ("member", "org_admin"),
        },
    )
    organization_id = await _organization_of(session_factory, tenant_id)
    outsider = _name("outsider")
    async with session_factory() as session:
        session.add(
            User(
                id=outsider,
                name=outsider,
                email=f"{outsider}@example.invalid",
                role="user",
            )
        )
        await session.commit()
    app = _app(session_factory)

    async with _client(app, bob, tenant_id) as client:
        still_in = await client.post(f"/organizations/{organization_id}/leave")
        offered = await client.get("/organizations/without-workspace")
    async with _client(app, cy, tenant_id) as client:
        org_admin = await client.post(f"/organizations/{organization_id}/leave")
    async with _client(app, outsider, None) as client:
        stranger = await client.post(f"/organizations/{organization_id}/leave")

    assert still_in.status_code == 409, still_in.text
    assert "still in its workspaces" in still_in.json()["detail"]
    assert offered.json() == []
    assert org_admin.status_code == 409, org_admin.text
    assert "org admin" in org_admin.json()["detail"]
    assert stranger.status_code == 404, stranger.text
    assert await _member_of(session_factory, organization_id, bob)
    assert await _member_of(session_factory, organization_id, cy)


class _KeptInADirectory(LocalDirectory):
    def keeps_members_of(self, organization: object) -> bool:
        return True


async def test_a_directory_keeps_its_members_and_nobody_leaves_it_here(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada, bob = _name("ada"), _name("bob")
    tenant_id = await _workspace(
        session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
    )
    organization_id = await _organization_of(session_factory, tenant_id)
    async with session_factory() as session:
        membership = await session.get(TenantMember, (tenant_id, bob))
        assert membership is not None
        await session.delete(membership)
        await session.commit()
    app = _app(session_factory)
    app.dependency_overrides[gw_deps.get_organization_directory] = _KeptInADirectory

    async with _client(app, bob, None) as client:
        left = await client.post(f"/organizations/{organization_id}/leave")

    assert left.status_code == 409, left.text
    assert "directory" in left.json()["detail"]
    assert await _member_of(session_factory, organization_id, bob)

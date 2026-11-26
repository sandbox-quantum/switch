"""Joining a linked organization with one workspace joins its workspace:
being in the organization is being in its workspace, as every product
sharing the directory has it. Against Postgres.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
)
from switch_core.organization_directory import DirectoryMembership
from switch_core.organization_mirror import bring_in_memberships
from tests.switch_core.gateway.test_organization_routes import (
    _name,
    _second_workspace,
    _user,
    _workspace,
)


async def _linked_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str]:
    """A workspace in an organization of its own, linked to a WorkOS
    organization. Returns (tenant, organization, WorkOS organization)."""
    ada = _name("ada")
    tenant_id = await _workspace(session_factory, {ada: ("admin", "org_admin")})
    workos_organization_id = f"org_{uuid.uuid4().hex[:10]}"
    async with session_factory() as session:
        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None and tenant.organization_id is not None
        organization = await session.get(Organization, tenant.organization_id)
        assert organization is not None
        organization.workos_organization_id = workos_organization_id
        await session.commit()
        return tenant_id, organization.id, workos_organization_id


async def _member_of(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, user_id: str
) -> str | None:
    async with session_factory() as session:
        return await session.scalar(
            select(TenantMember.role).where(
                TenantMember.tenant_id == tenant_id, TenantMember.user_id == user_id
            )
        )


async def test_someone_joining_at_sign_in_joins_its_one_workspace(
    session_factory,
) -> None:
    tenant_id, organization_id, workos_organization_id = await _linked_workspace(
        session_factory
    )
    dee = await _user(session_factory, "user")

    await bring_in_memberships(
        session_factory, dee, [DirectoryMembership(workos_organization_id, "member")]
    )

    assert await _member_of(session_factory, tenant_id, dee) == "member"
    async with session_factory() as session:
        member = await session.get(OrganizationMember, (organization_id, dee))
    assert member is not None and member.role == "member"


async def test_an_org_admin_joining_joins_it_too(session_factory) -> None:
    tenant_id, _, workos_organization_id = await _linked_workspace(session_factory)
    dee = await _user(session_factory, "user")

    await bring_in_memberships(
        session_factory,
        dee,
        [DirectoryMembership(workos_organization_id, "org_admin")],
    )

    assert await _member_of(session_factory, tenant_id, dee) == "member"


async def test_an_organization_with_several_workspaces_leaves_it_to_its_admins(
    session_factory,
) -> None:
    tenant_id, _, workos_organization_id = await _linked_workspace(session_factory)
    other = await _second_workspace(session_factory, tenant_id)
    dee = await _user(session_factory, "user")

    await bring_in_memberships(
        session_factory, dee, [DirectoryMembership(workos_organization_id, "member")]
    )

    assert await _member_of(session_factory, tenant_id, dee) is None
    assert await _member_of(session_factory, other, dee) is None


async def test_an_archived_workspace_is_not_joined(session_factory) -> None:
    tenant_id, _, workos_organization_id = await _linked_workspace(session_factory)
    async with session_factory() as session:
        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None
        tenant.archived_at = datetime.now(UTC)
        await session.commit()
    dee = await _user(session_factory, "user")

    await bring_in_memberships(
        session_factory, dee, [DirectoryMembership(workos_organization_id, "member")]
    )

    assert await _member_of(session_factory, tenant_id, dee) is None

"""Who stands in a workspace: a membership row, or `org_admin` of its
organization. Asked through the restricted role, from a workspace session,
as the broker, the token upkeep and the hosted controller ask it."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.standing import stands_in, stands_in_tenant
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _organization(
    owner: async_sessionmaker[AsyncSession],
    *,
    in_workspace: dict[str, str],
    in_organization: dict[str, str],
) -> str:
    """A workspace in an organization of its own. `in_workspace` are given a
    membership row (user -> workspace role); `in_organization` an
    organization row only (user -> organization role)."""
    organization_id, tenant_id = _id("org"), _id("tenant")
    async with owner() as session:
        session.add(Organization(id=organization_id, slug=organization_id, name="O"))
        await session.flush()
        session.add(
            Tenant(
                id=tenant_id, slug=tenant_id, name="W", organization_id=organization_id
            )
        )
        for user_id in {*in_workspace, *in_organization}:
            if await session.get(User, user_id) is None:
                session.add(
                    User(
                        id=user_id,
                        name=user_id,
                        email=f"{user_id}@example.invalid",
                        role="user",
                    )
                )
        await session.flush()
        for user_id, role in in_workspace.items():
            session.add(TenantMember(tenant_id=tenant_id, user_id=user_id, role=role))
        for user_id, role in in_organization.items():
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=user_id, role=role
                )
            )
        await session.commit()
    return tenant_id


async def test_a_member_and_an_org_admin_stand_in_it_and_nobody_else(
    rls_harness: RLSHarness,
) -> None:
    member, admin, plain, outsider = (_id(name) for name in ("m", "a", "p", "o"))
    tenant_id = await _organization(
        rls_harness.owner,
        in_workspace={member: "member"},
        in_organization={admin: "org_admin", plain: "member"},
    )
    await _organization(
        rls_harness.owner, in_workspace={}, in_organization={outsider: "org_admin"}
    )

    async with tenant_session(rls_harness.restricted, tenant_id) as session:
        found = {
            user_id: await stands_in(session, tenant_id, user_id)
            for user_id in (member, admin, plain, outsider)
        }
        users = await session.scalars(
            select(User.id).where(
                User.id.in_([member, admin, plain, outsider]),
                stands_in_tenant(tenant_id, User.id),
            )
        )

    assert found == {member: True, admin: True, plain: False, outsider: False}
    assert set(users) == {member, admin}

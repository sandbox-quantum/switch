"""Whether someone stands in a workspace: a membership row there, or `org_admin`
of the organization it belongs to, who administers it without one.

For the places that ask the question in SQL, or of a bare session, rather
than through `UserStore.effective_tenant_role`. A check that read only
`tenant_members` would treat an organization's admin as an outsider in every
workspace they have not been added to by hand.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.models import OrganizationMember, Tenant, TenantMember


def organization_admin_of(
    tenant_id: str, user_id: ColumnElement[str] | InstrumentedAttribute[str] | str
) -> ColumnElement[bool]:
    """`user_id` is `org_admin` of the organization `tenant_id` belongs to."""
    return exists().where(
        OrganizationMember.user_id == user_id,
        OrganizationMember.role == ORGANIZATION_ADMIN_ROLE,
        OrganizationMember.organization_id
        == select(Tenant.organization_id)
        .where(Tenant.id == tenant_id)
        .scalar_subquery(),
    )


def stands_in_tenant(
    tenant_id: str, user_id: ColumnElement[str] | InstrumentedAttribute[str] | str
) -> ColumnElement[bool]:
    """`user_id` holds a membership row in `tenant_id`, or administers it as
    its organization's `org_admin`."""
    return or_(
        exists().where(
            TenantMember.tenant_id == tenant_id, TenantMember.user_id == user_id
        ),
        organization_admin_of(tenant_id, user_id),
    )


async def stands_in(session: AsyncSession, tenant_id: str, user_id: str) -> bool:
    return bool(await session.scalar(select(stands_in_tenant(tenant_id, user_id))))

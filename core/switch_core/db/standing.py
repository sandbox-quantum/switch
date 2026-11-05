"""Whether someone stands in a workspace: a membership row there, or `org_admin`
of the organization it belongs to, who administers it without one.

For the places that ask the question in SQL, or of a bare session, rather
than through `UserStore.effective_tenant_role`. A check that read only
`tenant_members` would treat an organization's admin as an outsider in every
workspace they have not been added to by hand.

Also the lock that keeps a credential from outliving the standing it was made
under. A bearer credential resolves its workspace from its own row and never
consults membership again (`gateway/workspace_access.py`), and the request that
makes one checks standing once, when it authenticates. So ending someone's
standing removes what they made, and a request that authenticated just before
and wrote just after would leave a credential behind with nothing to answer to.
The two sides meet on the person's `users` row:

- Whoever ends someone's standing locks that row (`lock_for_ending_standing`)
  in the transaction that removes what they made, and in the one that ends
  the standing itself.
- A key made for someone references that row, so writing it takes
  `FOR KEY SHARE` on it for the foreign key, which waits behind that lock.
  After writing it, and before committing, the maker asks again
  (`require_standing`).

So the write either commits first, and is removed with the rest, or waits,
finds the standing gone, and is rolled back.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.models import OrganizationMember, Tenant, TenantMember, User


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


class StandingLost(PermissionError):
    """Whoever something was being made for no longer stands in its workspace."""


async def lock_for_ending_standing(session: AsyncSession, user_id: str) -> None:
    """Hold `user_id`'s row until `session` ends: nothing that references it
    is written meanwhile, so this transaction sees everything made for them."""
    await session.execute(select(User.id).where(User.id == user_id).with_for_update())


async def require_standing(session: AsyncSession, tenant_id: str, user_id: str) -> None:
    """Raise `StandingLost` unless `user_id` may still bind `tenant_id`: they
    stand in it, or are the platform operator, who may enter any workspace.

    Call after flushing what is being made for them and before committing it.
    The flush is what waits behind `lock_for_ending_standing`, and this reads
    what has committed since."""
    if await stands_in(session, tenant_id, user_id):
        return
    role = await session.scalar(select(User.role).where(User.id == user_id))
    if role != "admin":
        raise StandingLost("You no longer have access to this workspace")

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TenantMember


class TenantMembershipError(Exception):
    """A user has zero, or more than one, tenant memberships.

    Phase 1 has exactly one tenant, so exactly one membership row is the only
    correct state: zero means the user was never enrolled (a bug in whatever
    created the account), and more than one is Phase 2's tenant-switching
    shape arriving early. Either way this must not be resolved by picking
    one — see `docs/old/multi-tenancy-phase1-db.md`, "Setting the tenant".
    """


class TenantMemberStore:
    async def create(
        self, session: AsyncSession, *, tenant_id: str, user_id: str, role: str
    ) -> None:
        session.add(TenantMember(tenant_id=tenant_id, user_id=user_id, role=role))
        await session.flush()

    async def get_sole_tenant_id(self, session: AsyncSession, user_id: str) -> str:
        """The one tenant this user belongs to, raising if that isn't true.

        Must run on a session with no tenant bound yet — this *is* how the
        tenant gets found, so it cannot presuppose one (see `get_system_session`
        in `gateway/dependencies.py`).
        """
        result = await session.execute(
            select(TenantMember.tenant_id).where(TenantMember.user_id == user_id)
        )
        tenant_ids = result.scalars().all()
        if len(tenant_ids) != 1:
            raise TenantMembershipError(
                f"user {user_id} has {len(tenant_ids)} tenant memberships; "
                "expected exactly 1"
            )
        return tenant_ids[0]

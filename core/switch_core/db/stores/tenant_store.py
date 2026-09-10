from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Tenant


class TenantStore:
    async def get_all_ids(self, session: AsyncSession) -> list[str]:
        """Every tenant in the deployment, oldest first.

        The one question a tenant-scoped session cannot answer: `tenants`
        carries the same policy as everything else, comparing on `id`, so a
        bound session sees exactly its own row. Callers that need the whole
        list — the startup work that has to do something once per tenant —
        ask on an `unscoped_session`.

        Ordered by creation so a fan-out over the result is deterministic and
        tenant zero, which predates every other row, comes first.
        """
        result = await session.execute(
            select(Tenant.id).order_by(Tenant.created_at, Tenant.id)
        )
        return list(result.scalars().all())

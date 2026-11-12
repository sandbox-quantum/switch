"""A workspace's choice of decision backend for auto-route (`decision_settings`).

No row means the workspace uses the server default. Every query names the
workspace it is for, so a caller resolving another room's workspace (the
decision worker) and a request bound to its own read the same way.
"""

from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import DecisionSettings


class DecisionSettingsStore:
    async def get(
        self, session: AsyncSession, tenant_id: str
    ) -> DecisionSettings | None:
        result = await session.execute(
            select(DecisionSettings)
            .where(DecisionSettings.tenant_id == tenant_id)
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def get_for_update(
        self, session: AsyncSession, tenant_id: str
    ) -> DecisionSettings | None:
        """The row, locked until the caller's transaction ends: a save reads
        the stored key to keep it, and two saves at once must not each keep a
        key the other replaced."""
        result = await session.execute(
            select(DecisionSettings)
            .where(DecisionSettings.tenant_id == tenant_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def save(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        backend: str,
        endpoint: str | None,
        api_key_encrypted: str | None,
        threshold: float | None,
    ) -> DecisionSettings:
        """Write the workspace's row exactly as given, replacing any there."""
        values = {
            "backend": backend,
            "endpoint": endpoint,
            "api_key_encrypted": api_key_encrypted,
            "threshold": threshold,
        }
        await session.execute(
            insert(DecisionSettings)
            .values(tenant_id=tenant_id, **values)
            .on_conflict_do_update(
                index_elements=[DecisionSettings.tenant_id],
                set_={**values, "updated_at": func.now()},
            )
        )
        await session.flush()
        saved = await self.get(session, tenant_id)
        assert saved is not None
        return saved

    async def clear(self, session: AsyncSession, tenant_id: str) -> None:
        """Back to the server default."""
        await session.execute(
            delete(DecisionSettings).where(DecisionSettings.tenant_id == tenant_id)
        )
        await session.flush()

"""Which catalog services a workspace admin switched off for the workspace.

No row means on. Every query runs in the bound tenant.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import WorkspaceServiceSetting, require_tenant_id


class WorkspaceServiceStore:
    async def disabled_services(self, session: AsyncSession) -> set[str]:
        return set(
            await session.scalars(
                select(WorkspaceServiceSetting.service).where(
                    WorkspaceServiceSetting.tenant_id == require_tenant_id(),
                    WorkspaceServiceSetting.enabled.is_(False),
                )
            )
        )

    async def is_enabled(self, session: AsyncSession, service: str) -> bool:
        enabled = await session.scalar(
            select(WorkspaceServiceSetting.enabled).where(
                WorkspaceServiceSetting.tenant_id == require_tenant_id(),
                WorkspaceServiceSetting.service == service,
            )
        )
        return enabled is not False

    async def list_settings(
        self, session: AsyncSession
    ) -> dict[str, WorkspaceServiceSetting]:
        """Every switch an admin has touched in the workspace, by service."""
        return {
            setting.service: setting
            for setting in await session.scalars(
                select(WorkspaceServiceSetting)
                .where(WorkspaceServiceSetting.tenant_id == require_tenant_id())
                .execution_options(populate_existing=True)
            )
        }

    async def set_enabled(
        self, session: AsyncSession, service: str, enabled: bool, user_id: str
    ) -> None:
        await session.execute(
            insert(WorkspaceServiceSetting)
            .values(
                tenant_id=require_tenant_id(),
                service=service,
                enabled=enabled,
                updated_by=user_id,
            )
            .on_conflict_do_update(
                index_elements=["tenant_id", "service"],
                set_={
                    "enabled": enabled,
                    "updated_by": user_id,
                    "updated_at": func.now(),
                },
            )
        )

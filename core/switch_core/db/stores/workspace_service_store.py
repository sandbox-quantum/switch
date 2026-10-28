"""Which catalog services a workspace admin switched on or off for the workspace.

No row means the workspace's default, `Tenant.services_on_by_default`: off
for a workspace made since services started off. Every query runs in the
bound tenant.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Tenant, WorkspaceServiceSetting, require_tenant_id


class WorkspaceServiceStore:
    async def on_by_default(self, session: AsyncSession) -> bool:
        """Whether a service no admin has switched is on in the workspace."""
        tenant_id = require_tenant_id()
        on = await session.scalar(
            select(Tenant.services_on_by_default).where(Tenant.id == tenant_id)
        )
        if on is None:
            raise LookupError(f"No workspace {tenant_id!r}.")
        return on

    async def disabled_services(
        self, session: AsyncSession, services: Iterable[str]
    ) -> set[str]:
        """Those of `services` that are off in the workspace."""
        default = await self.on_by_default(session)
        settings = await self.list_settings(session)
        return {
            service
            for service in services
            if not (settings[service].enabled if service in settings else default)
        }

    async def is_enabled(self, session: AsyncSession, service: str) -> bool:
        enabled = await session.scalar(
            select(WorkspaceServiceSetting.enabled).where(
                WorkspaceServiceSetting.tenant_id == require_tenant_id(),
                WorkspaceServiceSetting.service == service,
            )
        )
        if enabled is None:
            return await self.on_by_default(session)
        return enabled

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

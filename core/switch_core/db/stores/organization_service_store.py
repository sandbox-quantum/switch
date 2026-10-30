"""Which catalog services an organization switched on or off for its
workspaces, and whether each is locked.

No row means the organization has no say in that service. Every method names
the organization; the table's policy (`db/rls_ddl.py`) also holds the session
to the organization it has bound, directly or through a bound workspace.
"""

from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import OrganizationServiceSetting


class OrganizationServiceStore:
    async def list_settings(
        self, session: AsyncSession, organization_id: str
    ) -> dict[str, OrganizationServiceSetting]:
        """Every service the organization has a say in, by service."""
        return {
            setting.service: setting
            for setting in await session.scalars(
                select(OrganizationServiceSetting)
                .where(OrganizationServiceSetting.organization_id == organization_id)
                .execution_options(populate_existing=True)
            )
        }

    async def set(
        self,
        session: AsyncSession,
        organization_id: str,
        service: str,
        *,
        enabled: bool,
        locked: bool,
        user_id: str,
    ) -> None:
        await session.execute(
            insert(OrganizationServiceSetting)
            .values(
                organization_id=organization_id,
                service=service,
                enabled=enabled,
                locked=locked,
                updated_by=user_id,
            )
            .on_conflict_do_update(
                index_elements=["organization_id", "service"],
                set_={
                    "enabled": enabled,
                    "locked": locked,
                    "updated_by": user_id,
                    "updated_at": func.now(),
                },
            )
        )

    async def clear(
        self, session: AsyncSession, organization_id: str, service: str
    ) -> bool:
        """Give up the organization's say in `service`; whether it had one."""
        result = await session.execute(
            delete(OrganizationServiceSetting).where(
                OrganizationServiceSetting.organization_id == organization_id,
                OrganizationServiceSetting.service == service,
            )
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]

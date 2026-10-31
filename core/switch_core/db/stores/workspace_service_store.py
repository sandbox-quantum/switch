"""Which catalog services a workspace admin switched on or off for the workspace.

No row means the workspace's default, `Tenant.services_on_by_default`: off
for a workspace made since services started off. Every query runs in the
bound tenant.

With `organizations`, the workspace's organization has a say too
(`organization_service_settings`), and whether a service is on is the first
of: the organization's setting, if locked; the workspace's own; the
organization's, unlocked; the workspace's default. Without, the organization's
settings are never read: that is a server with `organization_connector_apps`
off.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    OrganizationServiceSetting,
    Tenant,
    WorkspaceServiceSetting,
    require_tenant_id,
)


@dataclass(frozen=True)
class ServiceSwitch:
    """Whether a service is on in the workspace, and whether its organization
    locked it so, out of the workspace admin's reach."""

    enabled: bool
    locked: bool


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

    async def switches(
        self, session: AsyncSession, services: Iterable[str], *, organizations: bool
    ) -> dict[str, ServiceSwitch]:
        """Each of `services`, on or off in the workspace, and whether its
        organization locked it."""
        default = await self.on_by_default(session)
        own = await self.list_settings(session)
        organization = (
            await self.organization_settings(session) if organizations else {}
        )
        switches: dict[str, ServiceSwitch] = {}
        for service in services:
            set_above = organization.get(service)
            if set_above is not None and set_above.locked:
                switches[service] = ServiceSwitch(set_above.enabled, locked=True)
            elif service in own:
                switches[service] = ServiceSwitch(own[service].enabled, locked=False)
            elif set_above is not None:
                switches[service] = ServiceSwitch(set_above.enabled, locked=False)
            else:
                switches[service] = ServiceSwitch(default, locked=False)
        return switches

    async def disabled_services(
        self, session: AsyncSession, services: Iterable[str], *, organizations: bool
    ) -> set[str]:
        """Those of `services` that are off in the workspace."""
        return {
            service
            for service, switch in (
                await self.switches(session, services, organizations=organizations)
            ).items()
            if not switch.enabled
        }

    async def is_enabled(
        self, session: AsyncSession, service: str, *, organizations: bool
    ) -> bool:
        switches = await self.switches(session, [service], organizations=organizations)
        return switches[service].enabled

    async def organization_settings(
        self, session: AsyncSession
    ) -> dict[str, OrganizationServiceSetting]:
        """What the workspace's organization set, by service; none for a
        workspace in no organization."""
        return {
            setting.service: setting
            for setting in await session.scalars(
                select(OrganizationServiceSetting)
                .join(
                    Tenant,
                    Tenant.organization_id
                    == OrganizationServiceSetting.organization_id,
                )
                .where(Tenant.id == require_tenant_id())
                .execution_options(populate_existing=True)
            )
        }

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

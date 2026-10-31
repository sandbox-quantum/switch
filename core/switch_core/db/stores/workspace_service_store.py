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

from sqlalchemy import Text, and_, column, delete, func, literal, select, values
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

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


@dataclass(frozen=True)
class OrganizationSetting:
    """What an organization set for a service: on or off, locked or not."""

    enabled: bool
    locked: bool


def resolve(
    default: bool, own: bool | None, organization: OrganizationSetting | None
) -> ServiceSwitch:
    """The first of: the organization's setting, if locked; the workspace's
    own; the organization's, unlocked; the workspace's default."""
    if organization is not None and organization.locked:
        return ServiceSwitch(organization.enabled, locked=True)
    if own is not None:
        return ServiceSwitch(own, locked=False)
    if organization is not None:
        return ServiceSwitch(organization.enabled, locked=False)
    return ServiceSwitch(default, locked=False)


@dataclass(frozen=True)
class _Sides:
    """For one service: the workspace's default, its admin's own switch (None
    if never touched), and its organization's setting (None if it has none)."""

    default: bool
    own: bool | None
    organization: OrganizationSetting | None


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

    async def _sides(
        self, session: AsyncSession, services: list[str], *, organizations: bool
    ) -> dict[str, _Sides]:
        """Every side of each of `services`, in one query: it is on the path
        of every token an agent is issued."""
        tenant_id = require_tenant_id()
        if not services:
            return {}
        wanted = values(column("service", Text), name="wanted").data(
            [(service,) for service in services]
        )
        own = aliased(WorkspaceServiceSetting)
        above = aliased(OrganizationServiceSetting)
        query = (
            select(
                wanted.c.service,
                Tenant.services_on_by_default,
                own.enabled,
                above.enabled,
                above.locked,
            )
            .select_from(wanted)
            .join(Tenant, Tenant.id == tenant_id)
            .outerjoin(
                own, and_(own.tenant_id == Tenant.id, own.service == wanted.c.service)
            )
            .outerjoin(
                above,
                and_(
                    literal(organizations),
                    above.organization_id == Tenant.organization_id,
                    above.service == wanted.c.service,
                ),
            )
        )
        sides = {
            service: _Sides(
                default=default,
                own=own_enabled,
                organization=(
                    None
                    if above_enabled is None
                    else OrganizationSetting(above_enabled, above_locked)
                ),
            )
            for service, default, own_enabled, above_enabled, above_locked in (
                await session.execute(query)
            ).tuples()
        }
        if len(sides) != len(set(services)):
            raise LookupError(f"No workspace {tenant_id!r}.")
        return sides

    async def switches(
        self, session: AsyncSession, services: Iterable[str], *, organizations: bool
    ) -> dict[str, ServiceSwitch]:
        """Each of `services`, on or off in the workspace, and whether its
        organization locked it."""
        return {
            service: resolve(side.default, side.own, side.organization)
            for service, side in (
                await self._sides(session, list(services), organizations=organizations)
            ).items()
        }

    async def switches_under(
        self,
        session: AsyncSession,
        services: Iterable[str],
        organization: dict[str, OrganizationSetting],
    ) -> dict[str, tuple[ServiceSwitch, bool]]:
        """Each of `services` in the workspace were its organization's
        settings `organization`, as one the organization already holds or is
        about to make; and whether the workspace's admin set it themselves."""
        return {
            service: (
                resolve(side.default, side.own, organization.get(service)),
                side.own is not None,
            )
            for service, side in (
                await self._sides(session, list(services), organizations=False)
            ).items()
        }

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

    async def clear(self, session: AsyncSession, service: str) -> bool:
        """Drop the workspace admin's own switch, so the organization's
        setting or the workspace's default applies; whether there was one."""
        result = await session.execute(
            delete(WorkspaceServiceSetting).where(
                WorkspaceServiceSetting.tenant_id == require_tenant_id(),
                WorkspaceServiceSetting.service == service,
            )
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]

"""An organization's admins switch catalog services on or off for every
workspace in it, and lock them there.

Whether a service is on in a workspace is the first of
(`db/stores/workspace_service_store.py`): the organization's setting, if
locked; the workspace admin's own; the organization's, unlocked; the
workspace's default. So an unlocked setting is a default each workspace may
override, and a locked one is out of every workspace admin's reach: off and
locked is how an organization keeps a service out of all its workspaces.
Clearing the setting gives up the organization's say.

A change that leaves the service off in a workspace withdraws what it was
issued there, as a workspace admin's switch does: tokens are queued for
revocation, revoked before the answer where the vendor allows, and the
warning says what could not be. Grants are kept.

`org_admin` only, acting on the bound workspace's organization. Mounted only
with both `service_connections` and `organization_connector_apps` on, the
flag the rest of the organization's say in services ships under.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import ServiceBroker, get_service_broker
from switch_core.connections.loader import CATALOG
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import (
    OrganizationServiceSetting,
    ServiceConnection,
    ServiceTokenIssuance,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_service_store import OrganizationServiceStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.auth import get_current_user, organization_workspace_ids
from switch_core.gateway.dependencies import (
    get_organization_store,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.organizations import require_organization_admin

router = APIRouter(prefix="/organizations/current/services")
SETTINGS = OrganizationServiceStore()
WORKSPACES = WorkspaceServiceStore()


def _services() -> list[str]:
    return [
        entry.definition.slug for entry in CATALOG.values() if entry.definition.enabled
    ]


def _definition_name(service: str) -> str:
    entry = CATALOG.get(service)
    if entry is None or not entry.definition.enabled:
        raise HTTPException(status_code=404, detail=f"No service named {service!r}.")
    return entry.definition.name


async def _admin_of(
    session: AsyncSession,
    user_store: UserStore,
    organization_store: OrganizationStore,
    user: User,
) -> str:
    """The bound workspace's organization, which `user` must administer."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    return access.organization_id


async def _reach(
    session_factory: async_sessionmaker[AsyncSession], workspace_ids: list[str]
) -> tuple[dict[str, int], dict[str, int]]:
    """In how many of the workspaces each service is on, and how many people
    there have it connected: what an admin weighs before switching it. One
    short session per workspace, after the request's has let its go."""
    on: dict[str, int] = {}
    connected: dict[str, int] = {}
    for tenant_id in workspace_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            switches = await WORKSPACES.switches(
                session, _services(), organizations=True
            )
            counts = await session.execute(
                select(
                    ServiceConnection.service,
                    func.count(func.distinct(ServiceConnection.user_id)),
                )
                .where(
                    ServiceConnection.tenant_id == tenant_id,
                    ServiceConnection.status == "active",
                )
                .group_by(ServiceConnection.service)
            )
            for service, count in counts.tuples():
                connected[service] = connected.get(service, 0) + count
        for service, switch in switches.items():
            if switch.enabled:
                on[service] = on.get(service, 0) + 1
    return on, connected


async def _withdraw_where_off(
    session_factory: async_sessionmaker[AsyncSession],
    broker: ServiceBroker,
    workspace_ids: list[str],
    service: str,
) -> str | None:
    """After a change has committed: in each workspace where `service` is now
    off, withdraw what it was issued there, as a workspace admin's switch
    does. The warnings, once each, of what could not be taken back yet."""
    issued_for_it = (ServiceTokenIssuance.service == service,)
    warnings: list[str] = []
    for tenant_id in workspace_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            if await WORKSPACES.is_enabled(session, service, organizations=True):
                continue
            await broker.queue_revocation(session, *issued_for_it)
            await session.commit()
            warning = await broker.revoke_withdrawn(session, issued_for_it)
        if warning is not None and warning not in warnings:
            warnings.append(warning)
    return " ".join(warnings) or None


def _setting_body(setting: OrganizationServiceSetting | None) -> dict[str, bool] | None:
    return (
        None
        if setting is None
        else {"enabled": setting.enabled, "locked": setting.locked}
    )


@router.get("")
async def list_organization_services(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, Any]:
    """Every catalog service that can be connected, what the organization set
    for it, if anything, and how far it reaches across the organization."""
    organization_id = await _admin_of(session, user_store, organization_store, user)
    settings = await SETTINGS.list_settings(session, organization_id)
    authors = {
        author.id: author.name
        for author in await session.scalars(
            select(User).where(
                User.id.in_(
                    {
                        setting.updated_by
                        for setting in settings.values()
                        if setting.updated_by is not None
                    }
                )
            )
        )
    }
    # The request's connection goes back before the scan opens one per workspace.
    await session.commit()
    workspace_ids = await organization_workspace_ids(
        session_factory, user.id, organization_id
    )
    on, connected = await _reach(session_factory, workspace_ids)
    services = []
    for entry in CATALOG.values():
        definition = entry.definition
        if not definition.enabled:
            continue
        setting = settings.get(definition.slug)
        updated_at: datetime | None = None if setting is None else setting.updated_at
        services.append(
            {
                "slug": definition.slug,
                "name": definition.name,
                "setting": _setting_body(setting),
                "updated_by_name": (
                    None
                    if setting is None or setting.updated_by is None
                    else authors.get(setting.updated_by)
                ),
                "updated_at": None if updated_at is None else updated_at.isoformat(),
                "workspaces_on": on.get(definition.slug, 0),
                "connected_members": connected.get(definition.slug, 0),
            }
        )
    return {"workspaces": len(workspace_ids), "services": services}


class SettingBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    locked: bool


@router.put("/{service}")
async def set_organization_service(
    service: str,
    body: SettingBody,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, Any]:
    """Set `service` on or off for the organization's workspaces, locked or
    not. Where that leaves it off, what was issued for it is withdrawn."""
    organization_id = await _admin_of(session, user_store, organization_store, user)
    _definition_name(service)
    previous = (await SETTINGS.list_settings(session, organization_id)).get(service)
    details: dict[str, Any] = {
        "service": service,
        "enabled": body.enabled,
        "locked": body.locked,
        "previous": _setting_body(previous),
    }
    await SETTINGS.set(
        session,
        organization_id,
        service,
        enabled=body.enabled,
        locked=body.locked,
        updated_by=user.id,
    )
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=user.id,
        action=OrganizationAuditAction.SERVICE_SET,
        target_type="service",
        target_id=service,
        details=details,
    )
    await session.commit()
    workspace_ids = await organization_workspace_ids(
        session_factory, user.id, organization_id
    )
    warning = await _withdraw_where_off(session_factory, broker, workspace_ids, service)
    return {
        "slug": service,
        "setting": {"enabled": body.enabled, "locked": body.locked},
        "warning": warning,
    }


@router.delete("/{service}")
async def clear_organization_service(
    service: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, Any]:
    """Give up the organization's say in `service`: each workspace is back to
    its own switch, or its default. Where that leaves it off, what was issued
    for it is withdrawn."""
    organization_id = await _admin_of(session, user_store, organization_store, user)
    name = _definition_name(service)
    previous = (await SETTINGS.list_settings(session, organization_id)).get(service)
    if previous is None:
        raise HTTPException(
            status_code=404,
            detail=f"Your organization has no setting for {name}.",
        )
    details = {"service": service, "previous": _setting_body(previous)}
    await SETTINGS.clear(session, organization_id, service)
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=user.id,
        action=OrganizationAuditAction.SERVICE_CLEARED,
        target_type="service",
        target_id=service,
        details=details,
    )
    await session.commit()
    workspace_ids = await organization_workspace_ids(
        session_factory, user.id, organization_id
    )
    warning = await _withdraw_where_off(session_factory, broker, workspace_ids, service)
    return {"slug": service, "setting": None, "warning": warning}

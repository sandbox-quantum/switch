"""A workspace admin's switch for each catalog service, for the whole workspace.

Off by default: a service no admin has switched takes the workspace's default
(`Tenant.services_on_by_default`), off for every workspace made since services
started off and on for those that had members by then. Off, nobody in the
workspace can connect it, grant it or be issued a token for it, and it drops
out of the grants every agent's session reads, so the session's host restarts
it without the service within about half a minute. Grants are kept, so
switching it back on returns them. A token already handed out may be used
until that restart; one the vendor can revoke (GitHub's) is revoked here, and
one no vendor can revoke alone is marked withdrawn and stays valid until it
expires, which the answer's warning says.

With `organization_connector_apps` on, the workspace's organization has a say
(`gateway/organization_services.py`): a service it locked is out of the
workspace admin's reach, and one it set unlocked is the workspace's default.

Every member may read the list, to see what the workspace offers; only its
admins may change it, or see how many people and agents a change reaches.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.connections.broker import (
    ServiceBroker,
    get_service_broker,
    organization_locked,
)
from switch_core.connections.loader import CATALOG
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    Organization,
    OrganizationServiceSetting,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    Tenant,
    User,
    WorkspaceServiceSetting,
    require_tenant_id,
)
from switch_core.db.stores.workspace_service_store import (
    ServiceSwitch,
    WorkspaceServiceStore,
)
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_tenant_admin,
)
from switch_core.gateway.connector_apps import organization_apps_on
from switch_core.gateway.dependencies import get_session

router = APIRouter(prefix="/workspace/services")
STORE = WorkspaceServiceStore()


async def _counts(session: AsyncSession, column: Any, model: Any) -> dict[str, int]:
    rows = await session.execute(
        select(model.service, func.count(func.distinct(column)))
        .where(model.tenant_id == require_tenant_id())
        .group_by(model.service)
    )
    return {service: count for service, count in rows.tuples()}


def _deciding_setting(
    switch: ServiceSwitch,
    own: WorkspaceServiceSetting | None,
    organization: OrganizationServiceSetting | None,
) -> WorkspaceServiceSetting | OrganizationServiceSetting | None:
    """The setting that decides `switch`, so the list names whoever made it;
    none where the workspace's default does."""
    if switch.decided_by in ("organization_locked", "organization_default"):
        return organization
    if switch.decided_by == "workspace":
        return own
    return None


async def _organization_name(session: AsyncSession) -> str | None:
    name: str | None = await session.scalar(
        select(Organization.name)
        .join(Tenant, Tenant.organization_id == Organization.id)
        .where(Tenant.id == require_tenant_id())
    )
    return name


@router.get("")
async def list_workspace_services(
    _: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    organizations: Annotated[bool, Depends(organization_apps_on)],
) -> dict[str, Any]:
    """Every catalog service that can be connected, whether the workspace has
    it on and which setting says so, and, for an admin, who it reaches: what
    they weigh before switching it off."""
    settings = await STORE.list_settings(session)
    above = await STORE.organization_settings(session) if organizations else {}
    switches = await STORE.switches(
        session,
        [entry.definition.slug for entry in CATALOG.values()],
        organizations=organizations,
    )
    authors = {setting.updated_by for setting in settings.values()} | {
        setting.updated_by
        for setting in above.values()
        if setting.updated_by is not None
    }
    names = {
        user.id: user.name
        for user in await session.scalars(select(User).where(User.id.in_(authors)))
    }
    # Who a switch reaches is an admin's to weigh, and nobody else's to see.
    connected = (
        await _counts(session, ServiceConnection.user_id, ServiceConnection)
        if is_admin
        else {}
    )
    granted = (
        await _counts(session, ServiceGrant.agent_id, ServiceGrant) if is_admin else {}
    )
    services = []
    for entry in CATALOG.values():
        definition = entry.definition
        if not definition.enabled:
            continue
        switch = switches[definition.slug]
        organization = above.get(definition.slug)
        setting = _deciding_setting(switch, settings.get(definition.slug), organization)
        updated_at: datetime | None = None if setting is None else setting.updated_at
        standing = await broker.standing(session, definition.slug)
        unavailable = standing.unavailable
        services.append(
            {
                "slug": definition.slug,
                "name": definition.name,
                "category": definition.category,
                "description": definition.description,
                "auth_type": definition.auth.type,
                "enabled": switch.enabled,
                # Which setting that is: `Decider` in
                # `db/stores/workspace_service_store.py`.
                "decided_by": switch.decided_by,
                # Locked by the workspace's organization: the admin's switch
                # does nothing until an organization admin unlocks it.
                "organization_locked": switch.locked,
                # The organization's unlocked setting, which applies once the
                # workspace drops its own; null where it has none, or locked it.
                "organization_default": (
                    None
                    if organization is None or organization.locked
                    else organization.enabled
                ),
                # Whether the caller may switch it here: an admin, on a
                # service the organization has not locked.
                "can_change": is_admin and not switch.locked,
                "updated_by_name": (
                    None
                    if setting is None or setting.updated_by is None
                    else names.get(setting.updated_by)
                ),
                # Whether this workspace's admin set it themselves, which an
                # organization's unlocked setting does not override.
                "workspace_set": definition.slug in settings,
                "updated_at": None if updated_at is None else updated_at.isoformat(),
                # Whose app it signs in through here: "organization" where the
                # workspace's organization saved its own, else "server".
                "app_source": standing.source,
                # Why nobody here can use it whatever the switch says, such as
                # its app not being set up or the server having it off; null
                # when they can. The same every member reads for their own
                # connections (`/service-connections`).
                "unavailable_reason": None
                if unavailable is None
                else unavailable.reason,
                "unavailable_code": None if unavailable is None else unavailable.code,
                # Who switching it off reaches, for an admin to weigh; null for
                # anyone else.
                "connected_members": (
                    connected.get(definition.slug, 0) if is_admin else None
                ),
                "granted_agents": granted.get(definition.slug, 0) if is_admin else None,
            }
        )
    return {
        "can_change": is_admin,
        "on_by_default": await STORE.on_by_default(session),
        # Named only where the organization has a say, so nothing reads as
        # if it could set a connector when it can't.
        "organization_name": (
            await _organization_name(session) if organizations else None
        ),
        "services": services,
    }


class SwitchBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool


@router.put("/{service}")
async def set_workspace_service(
    service: str,
    body: SwitchBody,
    user: Annotated[User, Depends(require_tenant_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    organizations: Annotated[bool, Depends(organization_apps_on)],
) -> dict[str, Any]:
    """Switch `service` on or off for the workspace.

    Off queues every live token this workspace was issued for it, in the same
    transaction, and revokes them before answering; `warning` says when some
    could not be revoked yet, which the periodic tick keeps trying, and until
    when those no vendor can revoke alone stay valid.
    """
    entry = CATALOG.get(service)
    if entry is None or not entry.definition.enabled:
        raise HTTPException(status_code=404, detail=f"No service named {service!r}.")
    if organizations:
        await STORE.hold_organization_setting(session, service)
    switch = (await STORE.switches(session, [service], organizations=organizations))[
        service
    ]
    if switch.locked:
        raise HTTPException(
            status_code=409,
            detail=organization_locked(entry.definition.name, switch.enabled),
        )
    await STORE.set_enabled(session, service, body.enabled, user.id)
    issued_for_it = (ServiceTokenIssuance.service == service,)
    if not body.enabled:
        await broker.queue_revocation(session, *issued_for_it)
    await record_audit_event(
        session,
        tenant_id=require_tenant_id(),
        actor_user_id=user.id,
        action=(
            AuditAction.WORKSPACE_SERVICE_ENABLED
            if body.enabled
            else AuditAction.WORKSPACE_SERVICE_DISABLED
        ),
        target_type="service",
        target_id=service,
        details={"service": service},
    )
    await session.commit()
    warning = (
        None if body.enabled else await broker.revoke_withdrawn(session, issued_for_it)
    )
    return {"slug": service, "enabled": body.enabled, "warning": warning}


@router.delete("/{service}")
async def clear_workspace_service(
    service: str,
    user: Annotated[User, Depends(require_tenant_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    organizations: Annotated[bool, Depends(organization_apps_on)],
) -> dict[str, Any]:
    """Drop the workspace's own switch for `service`, so its organization's
    setting applies, or else the workspace's default. Where that leaves it
    off, what was issued for it is withdrawn, as switching it off does.
    Refused while the organization has it locked, as switching it is: the
    workspace's own choice is what applies once it unlocks."""
    entry = CATALOG.get(service)
    if entry is None or not entry.definition.enabled:
        raise HTTPException(status_code=404, detail=f"No service named {service!r}.")
    none_here = HTTPException(
        status_code=404,
        detail=f"This workspace has no switch of its own for {entry.definition.name}.",
    )
    if organizations:
        await STORE.hold_organization_setting(session, service)
    if service not in await STORE.list_settings(session):
        raise none_here
    before = (await STORE.switches(session, [service], organizations=organizations))[
        service
    ]
    if before.locked:
        raise HTTPException(
            status_code=409,
            detail=organization_locked(entry.definition.name, before.enabled),
        )
    if not await STORE.clear(session, service):
        raise none_here
    switch = (await STORE.switches(session, [service], organizations=organizations))[
        service
    ]
    issued_for_it = (ServiceTokenIssuance.service == service,)
    if not switch.enabled:
        await broker.queue_revocation(session, *issued_for_it)
    await record_audit_event(
        session,
        tenant_id=require_tenant_id(),
        actor_user_id=user.id,
        action=AuditAction.WORKSPACE_SERVICE_CLEARED,
        target_type="service",
        target_id=service,
        details={"service": service, "enabled": switch.enabled},
    )
    await session.commit()
    warning = (
        None
        if switch.enabled
        else await broker.revoke_withdrawn(session, issued_for_it)
    )
    return {"slug": service, "enabled": switch.enabled, "warning": warning}

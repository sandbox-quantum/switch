"""An organization's admins switch catalog services on or off for every
workspace in it, and lock them there.

Whether a service is on in a workspace is the first of
(`db/stores/workspace_service_store.py`): the organization's setting, if
locked; the workspace admin's own; the organization's, unlocked; the
workspace's default. So an unlocked setting reaches only the workspaces
whose admin never set the service themselves, and a locked one is out of
every workspace admin's reach: off and locked is how an organization keeps a
service out of all its workspaces. Clearing the setting gives up the
organization's say.

A change that leaves the service off in a workspace withdraws what it was
issued there, as a workspace admin's switch does, and must not leave a token
live behind a lock. A workspace's tokens can only be queued from a session
bound to it, so one transaction cannot cover the setting and every
workspace. Instead, every workspace the change would switch off has its
tokens queued first, each in its own transaction, and if any cannot be, the
setting is not saved. Then the setting commits. Then each of those
workspaces is swept again, for a token issued in between, and the vendor
revocations run; a workspace that fails there is logged and named in the
warning, and the rest carry on. A queued token the vendor has not revoked
yet is retried by the periodic tick. Grants are kept.

`org_admin` only, acting on the bound workspace's organization. Mounted only
with both `service_connections` and `organization_connector_apps` on, the
flag the rest of the organization's say in services ships under.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
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
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_service_store import OrganizationServiceStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.stores.workspace_service_store import (
    OrganizationSetting,
    WorkspaceServiceStore,
)
from switch_core.gateway.auth import get_current_user, organization_workspaces
from switch_core.gateway.dependencies import (
    get_organization_store,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.organizations import require_organization_admin

logger = logging.getLogger(__name__)

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


def _setting_of(row: OrganizationServiceSetting) -> OrganizationSetting:
    return OrganizationSetting(enabled=row.enabled, locked=row.locked)


def _setting_body(setting: OrganizationSetting | None) -> dict[str, bool] | None:
    return (
        None
        if setting is None
        else {"enabled": setting.enabled, "locked": setting.locked}
    )


async def _reach(
    session_factory: async_sessionmaker[AsyncSession],
    workspaces: list[Tenant],
    settings: dict[str, OrganizationSetting],
) -> tuple[dict[str, int], dict[str, int], dict[str, int]]:
    """For each service: in how many of the workspaces it is on, in how many
    their admin set it themselves, and how many people, each once, have it
    connected across them. A workspace's rows are readable only bound to it,
    so each is read on its own short session, in two queries, after the
    request's has let its connection go."""
    services = _services()
    on: dict[str, int] = {}
    own: dict[str, int] = {}
    people: dict[str, set[str]] = {}
    for workspace in workspaces:
        async with tenant_session(session_factory, workspace.id) as session:
            switches = await WORKSPACES.switches_under(session, services, settings)
            connected = await session.execute(
                select(ServiceConnection.service, ServiceConnection.user_id)
                .where(
                    ServiceConnection.tenant_id == workspace.id,
                    ServiceConnection.status == "active",
                )
                .distinct()
            )
            for service, user_id in connected.tuples():
                people.setdefault(service, set()).add(user_id)
        for service, (switch, set_here) in switches.items():
            if switch.enabled:
                on[service] = on.get(service, 0) + 1
            if set_here:
                own[service] = own.get(service, 0) + 1
    return on, own, {service: len(users) for service, users in people.items()}


async def _queue_where_off(
    session_factory: async_sessionmaker[AsyncSession],
    broker: ServiceBroker,
    workspaces: list[Tenant],
    service: str,
    setting: OrganizationSetting | None,
) -> list[Tenant]:
    """Before the setting is saved: queue what each workspace `setting` would
    switch `service` off in was issued for it, each in its own transaction.
    The workspaces it would switch off. Raises if any cannot be queued, so
    the caller saves nothing: no lock is put in force with tokens behind it
    left live."""
    issued_for_it = (ServiceTokenIssuance.service == service,)
    off: list[Tenant] = []
    for workspace in workspaces:
        try:
            async with tenant_session(session_factory, workspace.id) as session:
                (switch, _) = (
                    await WORKSPACES.switches_under(
                        session,
                        [service],
                        {} if setting is None else {service: setting},
                    )
                )[service]
                if switch.enabled:
                    continue
                await broker.queue_revocation(session, *issued_for_it)
                await session.commit()
        except Exception:
            logger.exception(
                "Could not queue %s's tokens in workspace %s before an "
                "organization switched it off there; the change is not saved",
                service,
                workspace.id,
            )
            raise HTTPException(
                status_code=503,
                detail=f"Switch couldn't withdraw {_definition_name(service)} from "
                f"{workspace.name}, so nothing was changed. Try again.",
            ) from None
        off.append(workspace)
    return off


async def _withdraw(
    session_factory: async_sessionmaker[AsyncSession],
    broker: ServiceBroker,
    workspaces: list[Tenant],
    service: str,
) -> str | None:
    """After the setting has committed: in each workspace it switched
    `service` off in, queue again what was issued in between, then revoke.
    A workspace that fails is logged and named; the rest carry on. The
    warnings, once each, of what could not be taken back yet."""
    issued_for_it = (ServiceTokenIssuance.service == service,)
    warnings: list[str] = []
    failed: list[str] = []
    for workspace in workspaces:
        try:
            async with tenant_session(session_factory, workspace.id) as session:
                await broker.queue_revocation(session, *issued_for_it)
                await session.commit()
                warning = await broker.revoke_withdrawn(session, issued_for_it)
        except Exception:
            logger.exception(
                "Could not finish withdrawing %s in workspace %s after its "
                "organization switched it off there",
                service,
                workspace.id,
            )
            failed.append(workspace.name)
            continue
        if warning is not None and warning not in warnings:
            warnings.append(warning)
    if failed:
        warnings.append(
            f"Switch couldn't finish withdrawing {_definition_name(service)} in "
            f"{', '.join(failed)}. What it had queued there is revoked by its "
            "periodic retry; tokens issued since may stay valid until they expire."
        )
    return " ".join(warnings) or None


async def _apply(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    broker: ServiceBroker,
    user: User,
    organization_id: str,
    service: str,
    previous: OrganizationSetting | None,
    setting: OrganizationSetting | None,
) -> str | None:
    """Put `setting` (None: no say) in force for `service`, withdrawing it
    wherever that switches it off, as the module describes."""
    # Only switching off, or giving up a setting of on, can leave a workspace
    # without the service.
    can_switch_off = (setting is not None and not setting.enabled) or (
        setting is None and previous is not None and previous.enabled
    )
    # The request's connection goes back before the scans open one per workspace.
    await session.commit()
    workspaces = (
        await organization_workspaces(session_factory, user.id, organization_id)
        if can_switch_off
        else []
    )
    off = await _queue_where_off(session_factory, broker, workspaces, service, setting)
    if setting is None:
        await SETTINGS.clear(session, organization_id, service)
    else:
        await SETTINGS.set(
            session,
            organization_id,
            service,
            enabled=setting.enabled,
            locked=setting.locked,
            updated_by=user.id,
        )
    details: dict[str, Any] = {"service": service, "previous": _setting_body(previous)}
    if setting is not None:
        details.update(enabled=setting.enabled, locked=setting.locked)
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=user.id,
        action=(
            OrganizationAuditAction.SERVICE_CLEARED
            if setting is None
            else OrganizationAuditAction.SERVICE_SET
        ),
        target_type="service",
        target_id=service,
        details=details,
    )
    await session.commit()
    return await _withdraw(session_factory, broker, off, service)


@router.get("")
async def list_organization_services(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
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
    workspaces = await organization_workspaces(
        session_factory, user.id, organization_id
    )
    on, own, connected = await _reach(
        session_factory,
        workspaces,
        {service: _setting_of(row) for service, row in settings.items()},
    )
    services = []
    for entry in CATALOG.values():
        definition = entry.definition
        if not definition.enabled:
            continue
        setting = settings.get(definition.slug)
        updated_at: datetime | None = None if setting is None else setting.updated_at
        server_off = broker.server_switched_off(definition.slug)
        services.append(
            {
                "slug": definition.slug,
                "name": definition.name,
                "setting": None
                if setting is None
                else _setting_body(_setting_of(setting)),
                "updated_by_name": (
                    None
                    if setting is None or setting.updated_by is None
                    else authors.get(setting.updated_by)
                ),
                "updated_at": None if updated_at is None else updated_at.isoformat(),
                # Off on the whole server, whatever any workspace says.
                "server_switched_off": server_off,
                "workspaces_on": 0 if server_off else on.get(definition.slug, 0),
                # Workspaces whose admin set it themselves: an unlocked
                # setting does not reach them.
                "workspaces_set_own": own.get(definition.slug, 0),
                "connected_members": connected.get(definition.slug, 0),
            }
        )
    return {"workspaces": len(workspaces), "services": services}


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
    row = (await SETTINGS.list_settings(session, organization_id)).get(service)
    previous = None if row is None else _setting_of(row)
    setting = OrganizationSetting(enabled=body.enabled, locked=body.locked)
    if previous == setting:
        return {"slug": service, "setting": _setting_body(setting), "warning": None}
    warning = await _apply(
        session,
        session_factory,
        broker,
        user,
        organization_id,
        service,
        previous,
        setting,
    )
    return {"slug": service, "setting": _setting_body(setting), "warning": warning}


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
    row = (await SETTINGS.list_settings(session, organization_id)).get(service)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"Your organization has no setting for {name}.",
        )
    warning = await _apply(
        session,
        session_factory,
        broker,
        user,
        organization_id,
        service,
        _setting_of(row),
        None,
    )
    return {"slug": service, "setting": None, "warning": warning}

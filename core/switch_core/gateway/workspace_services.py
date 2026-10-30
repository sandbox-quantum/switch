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
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.connections.broker import ServiceBroker, get_service_broker
from switch_core.connections.loader import CATALOG
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    User,
    require_tenant_id,
)
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.auth import require_tenant_admin
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


@router.get("")
async def list_workspace_services(
    _: Annotated[User, Depends(require_tenant_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """Every service the catalog enables, whether the workspace has it on,
    and who it reaches: what an admin weighs before switching it off. One this
    server cannot connect (its app not set up, or switched off here) is
    listed too. A member counts as connected while their connection works, by
    the status their own Connectors page shows, not one that needs
    reconnecting."""
    settings = await STORE.list_settings(session)
    on_by_default = await STORE.on_by_default(session)
    names = {
        user.id: user.name
        for user in await session.scalars(
            select(User).where(
                User.id.in_({setting.updated_by for setting in settings.values()})
            )
        )
    }
    connected = Counter(
        connection.service
        for connection in await session.scalars(
            select(ServiceConnection).where(
                ServiceConnection.tenant_id == require_tenant_id()
            )
        )
        if broker.connection_status(connection) == "active"
    )
    granted = await _counts(session, ServiceGrant.agent_id, ServiceGrant)
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
                "enabled": on_by_default if setting is None else setting.enabled,
                "updated_by_name": (
                    None if setting is None else names.get(setting.updated_by)
                ),
                "updated_at": None if updated_at is None else updated_at.isoformat(),
                "connected_members": connected.get(definition.slug, 0),
                "granted_agents": granted.get(definition.slug, 0),
            }
        )
    return {"services": services}


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

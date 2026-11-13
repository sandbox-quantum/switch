"""Organization › Devices: every device and managed agent in the
organization's workspaces, for its `org_admin`s, and removing any of them.

An organization admin is an admin of each of its workspaces already, so each
workspace is read as its own Devices page reads it (`workspace_devices`), on
that workspace's own session, and each row says which workspace it is in.
Removing a device or stopping managing an agent is the workspace route's
(`gateway_routes.py`), made in the workspace named in the path, which must
be one of the organization's: one elsewhere is answered 404, as one that
does not exist.

Mounted with the rest of agent management (`wiring.mount_gateway_routes`),
so only where it is on.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import Principal
from switch_core.connections.broker import ServiceBroker, get_service_broker
from switch_core.db.models import ServiceTokenIssuance, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, organization_workspaces
from switch_core.gateway.dependencies import (
    get_organization_store,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.organization_workspaces import (
    WORKSPACE,
    acting_org_admin,
    in_organization_workspace,
)
from switch_core.management.dependencies import get_management
from switch_core.management.errors import ManagementRoute
from switch_core.management.gateway_routes import revoke_controller_tokens
from switch_core.management.service import ManagementService
from switch_core.management.workspace_devices import workspace_devices

router = APIRouter(route_class=ManagementRoute, tags=["agent management"])

Management = Annotated[ManagementService, Depends(get_management)]
Session = Annotated[AsyncSession, Depends(get_session)]
SessionFactory = Annotated[
    async_sessionmaker[AsyncSession], Depends(get_session_factory)
]
Users = Annotated[UserStore, Depends(get_user_store)]
Organizations = Annotated[OrganizationStore, Depends(get_organization_store)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Broker = Annotated[ServiceBroker, Depends(get_service_broker)]


@router.get("/organizations/current/devices")
async def list_organization_devices(
    session: Session,
    session_factory: SessionFactory,
    user_store: Users,
    organization_store: Organizations,
    management: Management,
    user: CurrentUser,
) -> dict[str, list[dict[str, Any]]]:
    """`{devices, managed_agents}` in every workspace of the organization,
    archived ones included, each as its workspace's Devices page lists it to
    an admin, with `workspace_id` and `workspace_name`."""
    acting = await acting_org_admin(session, user_store, organization_store, user)
    viewer = Principal(user.id, True)
    devices: list[dict[str, Any]] = []
    managed_agents: list[dict[str, Any]] = []
    for tenant in await organization_workspaces(
        session_factory, user.id, acting.access.organization_id
    ):
        async with tenant_session(session_factory, tenant.id) as bound:
            found = await workspace_devices(
                bound, management, user_store, tenant.id, viewer
            )
        where = {"workspace_id": tenant.id, "workspace_name": tenant.name}
        devices.extend({**device, **where} for device in found["devices"])
        managed_agents.extend({**agent, **where} for agent in found["managed_agents"])
    return {"devices": devices, "managed_agents": managed_agents}


@router.delete(f"{WORKSPACE}/devices/{{controller_id}}")
async def remove_organization_device(
    workspace_id: str,
    controller_id: str,
    session: Session,
    session_factory: SessionFactory,
    user_store: Users,
    organization_store: Organizations,
    management: Management,
    broker: Broker,
    user: CurrentUser,
) -> dict[str, bool]:
    """Remove a device in one of the organization's workspaces, as an admin
    of that workspace removes it from its Devices page."""
    acting = await acting_org_admin(session, user_store, organization_store, user)
    async with in_organization_workspace(session_factory, acting, workspace_id) as (
        bound,
        _,
    ):
        await management.remove_controller(
            bound, workspace_id, controller_id, owner_id=None
        )
        await revoke_controller_tokens(
            bound, broker, ServiceTokenIssuance.controller_id == controller_id
        )
    return {"ok": True}


@router.delete(f"{WORKSPACE}/managed-agents/{{agent_id}}")
async def stop_managing_organization_agent(
    workspace_id: str,
    agent_id: str,
    session: Session,
    session_factory: SessionFactory,
    user_store: Users,
    organization_store: Organizations,
    management: Management,
    broker: Broker,
    user: CurrentUser,
) -> dict[str, bool]:
    """Stop managing an agent in one of the organization's workspaces, as an
    admin of that workspace does from its Devices page. The agent itself
    stays, with its rooms."""
    acting = await acting_org_admin(session, user_store, organization_store, user)
    async with in_organization_workspace(session_factory, acting, workspace_id) as (
        bound,
        _,
    ):
        await management.delete_managed_agent(
            bound, workspace_id, agent_id, owner_id=None
        )
        await revoke_controller_tokens(
            bound, broker, ServiceTokenIssuance.agent_id == agent_id
        )
    return {"ok": True}

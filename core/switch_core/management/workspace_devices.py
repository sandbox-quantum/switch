"""A workspace's devices, the agents managed on them and the operations sent
to them, as one person may see them: everyone's to an admin of the workspace
or of its organization, their own to anyone else. Removed devices are left
out.

Organization › Devices reads each of its workspaces through this too, on
that workspace's own session, so a row says nothing of which workspace it is
in.
"""

from __future__ import annotations

from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal
from switch_core.db.models import AgentController, AgentDefinition
from switch_core.db.stores.user_store import UserStore
from switch_core.management.placement import is_revoked
from switch_core.management.schemas import (
    agent_status_from,
    operation_view,
    wire_time,
    wire_time_or_none,
)
from switch_core.management.service import OPERATION_LIST_LIMIT, ManagementService

DeviceType = Literal["computer", "remote_ssh", "cloud"]


def device_type(controller: AgentController) -> DeviceType:
    """What the device is, as people tell them apart. A controller Switch
    Console starts on an SSH host says Console updates it; Console's own says
    so too, but enrolls as a `console` controller. Older controllers say
    neither, and read as computers."""
    if controller.kind == "ec2":
        return "cloud"
    status = controller.status or {}
    updated_by = (status.get("controller") or {}).get("updated_by")
    if controller.kind == "daemon" and updated_by == "console":
        return "remote_ssh"
    return "computer"


def _reported_providers(controller: AgentController) -> list[str]:
    providers = (controller.status or {}).get("providers")
    return [
        entry["provider"]
        for entry in (providers if isinstance(providers, list) else [])
        if isinstance(entry, dict) and isinstance(entry.get("provider"), str)
    ]


def _device(
    controller: AgentController,
    state: str,
    placed: list[AgentDefinition],
    owner_name: str,
    viewer: Principal,
) -> dict[str, Any]:
    owns = controller.owner_id == viewer.id
    cloud = controller.kind == "ec2"
    # What it last reported running, while it is connected: an offline
    # device's last report says nothing of now.
    running = 0
    for row in placed if state == "online" else []:
        status = agent_status_from(controller, row.agent_id)
        if status is not None and status.get("process") == "running":
            running += 1
    return {
        "id": controller.id,
        "name": controller.name,
        "description": controller.description,
        "kind": controller.kind,
        "type": device_type(controller),
        "platform": controller.platform,
        "version": controller.version,
        "state": state,
        "last_seen_at": wire_time_or_none(controller.last_seen_at),
        "created_at": wire_time(controller.created_at),
        "owner_id": controller.owner_id,
        "owner_name": owner_name,
        "providers": _reported_providers(controller),
        "agents_total": len(placed),
        "agents_running": running,
        # Its owner renames it and asks it to re-check its providers; it is
        # removed by its owner or an admin. Switch does both for a cloud
        # device (`service.refuse_cloud`).
        "can_edit": owns and not cloud,
        "can_recheck": owns,
        "can_remove": (owns or viewer.is_admin) and not cloud,
    }


def _managed_agent(
    row: AgentDefinition,
    name: str,
    display_name: str | None,
    controller: AgentController | None,
    state: str | None,
    owner_name: str,
    viewer: Principal,
) -> dict[str, Any]:
    owns = row.owner_id == viewer.id
    status = agent_status_from(controller, row.agent_id)
    return {
        "agent_id": row.agent_id,
        "name": name,
        "display_name": display_name,
        "provider": row.definition.get("provider"),
        "controller_id": row.controller_id,
        "controller_name": None if controller is None else controller.name,
        "controller_kind": None if controller is None else controller.kind,
        "controller_state": state,
        "desired_state": row.desired_state,
        # What its device last reported of it: null before it has, and for
        # one placed nowhere.
        "process": None if status is None else status.get("process"),
        "owner_id": row.owner_id,
        "owner_name": owner_name,
        # Its owner starts, stops, restarts and edits it; it is stopped being
        # managed, or deleted, by its owner or an admin.
        "can_edit": owns,
        "can_delete": owns or viewer.is_admin,
    }


async def workspace_devices(
    session: AsyncSession,
    management: ManagementService,
    user_store: UserStore,
    tenant_id: str,
    viewer: Principal,
) -> dict[str, list[dict[str, Any]]]:
    """`{devices, managed_agents, operations}` in the workspace `session` is
    bound to: everyone's when `viewer.is_admin`, else the viewer's own.
    `viewer.is_admin` is the caller's to have checked; nothing here does."""
    if viewer.is_admin:
        controllers = await management.controllers.list_for_tenant(session, tenant_id)
        definitions = await management.definitions.list_for_tenant(session, tenant_id)
    else:
        assert viewer.id is not None
        controllers = await management.controllers.list_for_owner(
            session, tenant_id, viewer.id
        )
        definitions = await management.definitions.list_for_owner(
            session, tenant_id, viewer.id
        )
    leases = await management.leases(session)
    states = {c.id: management.state_of(c, leases) for c in controllers}
    by_id = {c.id: c for c in controllers}
    owners = await user_store.names_by_id(
        session,
        {c.owner_id for c in controllers} | {row.owner_id for row, _ in definitions},
    )
    placed: dict[str, list[AgentDefinition]] = {}
    for row, _agent in definitions:
        if row.controller_id is not None:
            placed.setdefault(row.controller_id, []).append(row)
    devices = [
        _device(c, states[c.id], placed.get(c.id, []), owners[c.owner_id], viewer)
        for c in controllers
        if not is_revoked(c)
    ]
    managed_agents = []
    for row, agent in definitions:
        controller = None if row.controller_id is None else by_id.get(row.controller_id)
        if row.controller_id is not None and controller is None:
            # Placed on a device the viewer's list leaves out: someone else's,
            # which placing never does, but a definition does not stop. The
            # agent's own owner still sees where it is.
            controller = await management.controllers.get(
                session, tenant_id, row.controller_id
            )
        managed_agents.append(
            _managed_agent(
                row,
                agent.name,
                agent.display_name,
                controller,
                None if controller is None else management.state_of(controller, leases),
                owners[row.owner_id],
                viewer,
            )
        )
    operations = await management.operations.list_for_controllers(
        session, tenant_id, list(by_id), OPERATION_LIST_LIMIT
    )
    return {
        "devices": devices,
        "managed_agents": managed_agents,
        "operations": [operation_view(operation) for operation in operations],
    }

from datetime import UTC, datetime
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import (
    CloudMachine,
    MachineWorkspace,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_CONNECT_TIMEOUT,
    CloudMachineConflict,
    CloudMachineStore,
    claim_conflict,
    idle_sleeping,
    lock_claims,
    managed_agent_ids,
    owner_stopped,
    workspace_on,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.cloud_controllers import workspace_reported
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.providers.hosted import HostedControllerSettings

router = APIRouter(prefix="/hosted-machines")

RETIRED_STATES = frozenset({"retained", "deleting", "deleted"})

MACHINES_DISABLED = "This server does not support cloud agents."


def hosted_settings(request: Request) -> HostedControllerSettings | None:
    return cast(
        HostedControllerSettings | None, request.app.state.hosted_controller_settings
    )


def controller_settings(request: Request) -> HostedControllerSettings:
    settings = hosted_settings(request)
    if settings is None:
        raise HTTPException(503, MACHINES_DISABLED)
    return settings


def machines_enabled(config: SwitchConfig, settings: HostedControllerSettings) -> bool:
    """Whether the bound tenant may use cloud machines on this server."""
    return (
        config.hosted_agents_enabled
        and config.hosted_launch_capacity > 0
        and (
            settings.allowed_tenant_ids is None
            or require_tenant_id() in settings.allowed_tenant_ids
        )
    )


def _usage(heartbeat: dict | None, key: str) -> dict | None:
    reading = None if heartbeat is None else heartbeat.get(key)
    if reading is None:
        return None
    return {
        "total_bytes": reading["total_bytes"],
        "available_bytes": reading["available_bytes"],
    }


WORKSPACE_CONNECT_TIMEOUT = (
    "The cloud machine started, but its controller for this workspace did not "
    "connect to Switch within 10 minutes. Retry it in Switch Console, or ask your "
    "administrator to check the machine's startup logs."
)


def workspace_state(
    machine: CloudMachine, workspace: MachineWorkspace, now: datetime
) -> tuple[str, str | None]:
    """The machine's state as the bound workspace sees it, and why it is in
    error: a ready machine is still starting here until this workspace's
    controller has reported, and in error if it never does. A machine on its
    way down is as it is everywhere."""
    if (
        machine.state != "ready"
        or machine.desired_state != "running"
        or workspace_reported(machine, workspace.id)
    ):
        return machine.state, machine.error
    if (
        machine.running_observed_at is not None
        and now - machine.running_observed_at > MACHINE_CONNECT_TIMEOUT
    ):
        return "error", WORKSPACE_CONNECT_TIMEOUT
    return "provisioning", None


async def machine_summary(
    session: AsyncSession, machine: CloudMachine, workspace: MachineWorkspace
) -> dict:
    """The machine as its owner sees it from the bound workspace: `agents` are
    the workspace's managed agents placed on the controller the machine
    enrolled as here, `controller_id` (null until it has)."""
    state, error = workspace_state(machine, workspace, datetime.now(UTC))
    return {
        "machine_id": machine.id,
        "state": state,
        "desired_state": machine.desired_state,
        "stop_reason": machine.stop_reason,
        "sleeping": idle_sleeping(machine),
        "revision": machine.revision,
        "instance_type": machine.instance_type,
        "error": error,
        "error_code": machine.error_code,
        "retain_until": None
        if machine.retain_until is None
        else machine.retain_until.isoformat(),
        "heartbeat_at": None
        if machine.heartbeat_at is None
        else machine.heartbeat_at.isoformat(),
        "disk": _usage(machine.heartbeat, "disk"),
        "memory": _usage(machine.heartbeat, "memory"),
        "agents": await managed_agent_ids(session, workspace.controller_id),
        "controller_id": workspace.controller_id,
    }


class MachineUnavailable(Exception):
    """This server offers the bound tenant no cloud machines; the message is the 503 detail."""


async def ensure_machine(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    owner_id: str,
    config: SwitchConfig,
    settings: HostedControllerSettings | None,
) -> tuple[CloudMachine, MachineWorkspace]:
    """The owner's machine, claimed or joined by the bound workspace and
    started, so it warms before an agent needs it.

    A machine its owner stopped, or one in error or being removed, is
    returned as it is when it already serves the workspace.
    Raises `MachineUnavailable` when the server offers the tenant no cloud
    machines and `CloudMachineConflict` when none can be had. The caller
    commits.
    """
    if settings is None or not machines_enabled(config, settings):
        raise MachineUnavailable(MACHINES_DISABLED)
    machines = CloudMachineStore()
    await lock_claims(session)
    existing = await machines.live_for_owner(session, owner_id)
    if existing is not None:
        existing = await machines.locked(session, existing.id)
        workspace = (
            None if existing is None else await workspace_on(session, existing.id)
        )
        if (
            existing is not None
            and workspace is not None
            and (
                owner_stopped(existing)
                or claim_conflict(existing, datetime.now(UTC)) is not None
            )
        ):
            return existing, workspace
    return await machines.claim(
        session,
        factory,
        owner_id=owner_id,
        capacity=config.hosted_launch_capacity,
        now=datetime.now(UTC),
    )


async def _owned(
    session: AsyncSession, machine_id: str, owner_id: str
) -> tuple[CloudMachine, MachineWorkspace]:
    """The owner's machine, as it serves the bound workspace."""
    machine = await CloudMachineStore().owned(session, machine_id, owner_id)
    workspace = None if machine is None else await workspace_on(session, machine.id)
    if machine is None or workspace is None:
        raise HTTPException(404, "Cloud machine not found.")
    return machine, workspace


@router.get("")
async def owned_machines(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings | None, Depends(hosted_settings)],
) -> dict:
    """The owner's machine, when it serves the bound workspace: in another
    workspace it is the same machine, joined from there. `available` says
    whether the bound workspace may claim one here at all, so a client can
    offer cloud agents only where claiming one can work."""
    available = settings is not None and machines_enabled(config, settings)
    machine = await CloudMachineStore().live_for_owner(session, user.id)
    workspace = None if machine is None else await workspace_on(session, machine.id)
    if machine is None or workspace is None:
        return {"available": available, "machines": []}
    return {
        "available": available,
        "machines": [await machine_summary(session, machine, workspace)],
    }


@router.post("/ensure")
async def ensure(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings | None, Depends(hosted_settings)],
) -> dict:
    try:
        machine, workspace = await ensure_machine(
            session, factory, user.id, config, settings
        )
    except MachineUnavailable as error:
        raise HTTPException(503, str(error)) from None
    except CloudMachineConflict as error:
        raise HTTPException(409, str(error)) from None
    await session.commit()
    return await machine_summary(session, machine, workspace)


@router.get("/{machine_id}")
async def status(
    machine_id: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    machine, workspace = await _owned(session, machine_id, user.id)
    return await machine_summary(session, machine, workspace)


class MachineLifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["stop", "start", "retry"]
    revision: int = Field(ge=1)


@router.post("/{machine_id}/lifecycle")
async def lifecycle(
    machine_id: str,
    body: MachineLifecycleRequest,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    machines = CloudMachineStore()
    _machine, workspace = await _owned(session, machine_id, user.id)
    machine = await machines.locked(session, machine_id)
    assert machine is not None
    if machine.revision != body.revision and not (
        idle_sleeping(machine) and machine.revision == body.revision + 1
    ):
        raise HTTPException(409, "revision mismatch")
    retrying_retire = (
        body.action == "retry"
        and machine.state == "error"
        and machine.desired_state == "retained"
    )
    if not retrying_retire and (
        machine.state in RETIRED_STATES or machine.desired_state in RETIRED_STATES
    ):
        raise HTTPException(409, f"machine is {machine.desired_state}")
    now = datetime.now(UTC)
    if body.action == "stop":
        machines.stop(machine, "owner", now)
    elif body.action == "start":
        machines.start(machine, now)
    else:
        if machine.state != "error":
            raise HTTPException(409, "Only a machine in error can be retried.")
        machines.retry(machine, now)
    await session.commit()
    return {"machine": await machine_summary(session, machine, workspace)}

from datetime import UTC, datetime
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import HostedMachine, User, require_tenant_id
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineConflict,
    HostedMachineStore,
    claim_conflict,
    idle_sleeping,
    lock_claims,
    owner_stopped,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.providers.hosted import HostedControllerSettings

router = APIRouter(prefix="/hosted-machines")

RETIRED_STATES = frozenset({"retained", "deleting", "deleted"})

MACHINES_DISABLED = "Switch cloud machines are not enabled on this server."


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
    """Whether the bound tenant may claim cloud machines on this server."""
    return config.hosted_agents_enabled and settings.tenant_id == require_tenant_id()


def _usage(heartbeat: dict | None, key: str) -> dict | None:
    reading = None if heartbeat is None else heartbeat.get(key)
    if reading is None:
        return None
    return {
        "total_bytes": reading["total_bytes"],
        "available_bytes": reading["available_bytes"],
    }


async def machine_summary(session: AsyncSession, machine: HostedMachine) -> dict:
    """The machine as its owner sees it: `agents` are the managed agents
    placed on the controller it enrolled as, `controller_id` (null until it
    has)."""
    return {
        "machine_id": machine.id,
        "state": machine.state,
        "desired_state": machine.desired_state,
        "stop_reason": machine.stop_reason,
        "sleeping": idle_sleeping(machine),
        "revision": machine.revision,
        "instance_type": machine.instance_type,
        "error": machine.error,
        "error_code": machine.error_code,
        "retain_until": None
        if machine.retain_until is None
        else machine.retain_until.isoformat(),
        "heartbeat_at": None
        if machine.heartbeat_at is None
        else machine.heartbeat_at.isoformat(),
        "disk": _usage(machine.heartbeat, "disk"),
        "memory": _usage(machine.heartbeat, "memory"),
        "agents": await HostedMachineStore().managed_agent_ids(session, machine),
        "controller_id": machine.controller_id,
    }


class MachineUnavailable(Exception):
    """This server offers the bound tenant no cloud machines; the message is the 503 detail."""


async def ensure_machine(
    session: AsyncSession,
    owner_id: str,
    config: SwitchConfig,
    settings: HostedControllerSettings | None,
) -> HostedMachine:
    """The owner's machine, claimed and started so it warms before an agent needs it.

    A machine its owner stopped, or one in error or being removed, is
    returned as it is.
    Raises `MachineUnavailable` when the server offers the tenant no cloud
    machines and `HostedMachineConflict` when none can be had. The caller
    commits.
    """
    if settings is None or not machines_enabled(config, settings):
        raise MachineUnavailable(MACHINES_DISABLED)
    machines = HostedMachineStore()
    await lock_claims(session)
    existing = await machines.live_for_owner(session, owner_id)
    if existing is not None:
        existing = await machines.locked(session, existing.id)
        if existing is not None and (
            owner_stopped(existing)
            or claim_conflict(existing, datetime.now(UTC)) is not None
        ):
            return existing
    return await machines.claim(
        session,
        owner_id=owner_id,
        capacity=config.hosted_launch_capacity,
        now=datetime.now(UTC),
    )


async def _owned(
    session: AsyncSession, machine_id: str, owner_id: str
) -> HostedMachine:
    machine = await HostedMachineStore().owned(session, machine_id, owner_id)
    if machine is None:
        raise HTTPException(404, "Cloud machine not found.")
    return machine


@router.get("")
async def owned_machines(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    machines = await session.scalars(
        select(HostedMachine)
        .where(
            HostedMachine.tenant_id == require_tenant_id(),
            HostedMachine.owner_id == user.id,
            HostedMachine.state != "deleted",
        )
        .order_by(HostedMachine.created_at)
    )
    return {"machines": [await machine_summary(session, row) for row in machines]}


@router.post("/ensure")
async def ensure(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings | None, Depends(hosted_settings)],
) -> dict:
    try:
        machine = await ensure_machine(session, user.id, config, settings)
    except MachineUnavailable as error:
        raise HTTPException(503, str(error)) from None
    except HostedMachineConflict as error:
        raise HTTPException(409, str(error)) from None
    await session.commit()
    return await machine_summary(session, machine)


@router.get("/{machine_id}")
async def status(
    machine_id: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    return await machine_summary(session, await _owned(session, machine_id, user.id))


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
    machines = HostedMachineStore()
    await _owned(session, machine_id, user.id)
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
    return {"machine": await machine_summary(session, machine)}

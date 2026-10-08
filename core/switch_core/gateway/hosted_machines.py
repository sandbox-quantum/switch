from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api.hosted_worker_routes import post_mailbox_notices
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.config import SwitchConfig
from switch_core.db.models import HostedMachine, User, require_tenant_id
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineConflict,
    HostedMachineStore,
    claim_conflict,
    idle_sleeping,
    lock_launches,
    owner_stopped,
)
from switch_core.db.stores.hosted_mailbox_store import HostedMailboxStore, MailboxNotice
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_protocol, get_session
from switch_core.gateway.hosted_launches import (
    LAUNCH_DISABLED,
    hosted_settings,
    launch_enabled,
    ring_mailbox_cancel,
)
from switch_core.providers.hosted import HostedControllerSettings

router = APIRouter(prefix="/hosted-machines")

RETIRED_STATES = frozenset({"retained", "deleting", "deleted"})


def _usage(heartbeat: dict | None, key: str) -> dict | None:
    reading = None if heartbeat is None else heartbeat.get(key)
    if reading is None:
        return None
    return {
        "total_bytes": reading["total_bytes"],
        "available_bytes": reading["available_bytes"],
    }


async def machine_summary(session: AsyncSession, machine: HostedMachine) -> dict:
    """The machine as its owner sees it. `agents` are its launches on a
    worker machine, and the managed agents placed on its controller on a
    controller machine, whose `controller_id` is the controller it enrolled as
    (null until it has)."""
    store = HostedMachineStore()
    agents = (
        await store.managed_agent_ids(session, machine)
        if machine.runtime == "controller"
        else [launch.id for launch in await store.launches(session, machine.id)]
    )
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
        "agents": agents,
        "runtime": machine.runtime,
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
    if settings is None or not launch_enabled(config, settings):
        raise MachineUnavailable(LAUNCH_DISABLED)
    machines = HostedMachineStore()
    await lock_launches(session)
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
        slots=list(settings.machine_slots),
        capacity=config.hosted_launch_capacity,
        runtime=config.hosted_machine_runtime,
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
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
    cancelled: list[MailboxNotice] = []
    cancel_requested: dict[str, list[tuple[str, str]]] = {}
    if body.action == "stop":
        machines.stop(machine, "owner", now)
        mailbox = HostedMailboxStore()
        for candidate in await machines.launches(session, machine.id):
            launch = await HostedLaunchStore().locked(session, candidate.id)
            if launch is None or launch.desired_state == "deleted":
                continue
            split = await mailbox.stop(session, launch.id)
            cancelled.extend(split.cancelled)
            if launch.agent_id and split.cancel_requested:
                cancel_requested[launch.agent_id] = split.cancel_requested
    elif body.action == "start":
        machines.start(machine, now)
    else:
        if machine.state != "error":
            raise HTTPException(409, "Only a machine in error can be retried.")
        machines.retry(machine, now)
    await session.commit()
    for agent_id, entries in cancel_requested.items():
        ring_mailbox_cancel(protocol, agent_id, entries)
    await post_mailbox_notices(protocol, cancelled)
    return {"machine": await machine_summary(session, machine)}

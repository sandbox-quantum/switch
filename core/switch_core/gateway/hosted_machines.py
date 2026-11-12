from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import (
    AgentController,
    CloudMachine,
    MachineWorkspace,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_CONNECT_TIMEOUT,
    MACHINE_PAUSED,
    MACHINE_STOPPED_BY_ADMIN,
    MACHINE_TURNED_OFF,
    CloudMachineConflict,
    CloudMachineStore,
    admin_stopped,
    claim_conflict,
    idle_sleeping,
    lock_claims,
    managed_agent_ids,
    owner_stopped,
    workspace_on,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.cloud_controllers import (
    revoke_machine_controller,
    workspace_reported,
)
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.hosted_v2 import process_hosted_v2
from switch_core.observability.hosted import record_machine_event
from switch_core.providers.hosted import (
    NOT_AVAILABLE,
    HostedControllerSettings,
    tenant_allowed,
)
from switch_core.telemetry import emit_after_commit
from switch_core.visibility.box_provision import ask_for_box, box_provisioning_on
from switch_core.visibility.hosted_access import block_reason_in
from switch_core.visibility.reason_codes import StopReason

router = APIRouter(prefix="/hosted-machines")

RETIRED_STATES = frozenset({"retained", "deleting", "deleted"})

MACHINES_DISABLED = NOT_AVAILABLE


def hosted_settings(request: Request) -> HostedControllerSettings | None:
    return cast(
        HostedControllerSettings | None, request.app.state.hosted_controller_settings
    )


def controller_settings(request: Request) -> HostedControllerSettings:
    settings = hosted_settings(request)
    if settings is None:
        raise HTTPException(503, MACHINES_DISABLED)
    return settings


def machines_enabled(
    config: SwitchConfig, settings: HostedControllerSettings, user_id: str
) -> bool:
    """Whether this account, in the bound tenant, may use cloud machines on
    this server. An account off `allowed_user_ids` gets the same answer as a
    workspace off `allowed_tenant_ids`, so neither tells it which list it
    missed."""
    return (
        config.hosted_agents_enabled
        and config.hosted_launch_capacity > 0
        and tenant_allowed(settings.allowed_tenant_ids, require_tenant_id())
        and (settings.allowed_user_ids is None or user_id in settings.allowed_user_ids)
    )


def _usage(heartbeat: dict | None, key: str) -> dict | None:
    reading = None if heartbeat is None else heartbeat.get(key)
    if reading is None:
        return None
    usage = {
        "total_bytes": reading["total_bytes"],
        "available_bytes": reading["available_bytes"],
    }
    # Which disk it is: "workspace" (the agents' volume) or "unknown"; absent
    # from older boxes. The apps show a disk only for "workspace".
    if reading.get("scope") in ("workspace", "unknown"):
        usage["scope"] = reading["scope"]
    return usage


# Bounds for what Your cloud reads back from the stored report: the same as
# the status schema's, so a figure outside them reads as not reported.
_MAX_BYTES = 1 << 50
_MAX_SESSIONS = 1000
_MAX_CALLS = 1_000_000_000


def _bounded(value: object, top: int, *, low: int = 0) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if low <= value <= top else None


def next_utc_midnight(now: datetime) -> datetime:
    """When the gateway's daily count resets: the next 00:00 UTC."""
    today = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return today + timedelta(days=1)


def your_cloud(status: dict | None, now: datetime) -> dict:
    """Your cloud's figures, from the workspace
    controller's last report: room to work, sessions awake, and AI calls today
    against the cap. Each is null when the report doesn't carry it."""
    machine = (status or {}).get("machine")
    machine = machine if isinstance(machine, dict) else {}
    total = _bounded(machine.get("mem_total_bytes"), _MAX_BYTES, low=1)
    free = _bounded(machine.get("mem_free_bytes"), _MAX_BYTES)
    running = _bounded(machine.get("sessions_running"), _MAX_SESSIONS)
    most = _bounded(machine.get("sessions_max"), _MAX_SESSIONS)
    cap = _bounded(machine.get("gateway_daily_cap"), _MAX_CALLS, low=1)
    used = _bounded(machine.get("gateway_calls_today"), _MAX_CALLS)
    capped = machine.get("gateway_capped")
    return {
        "room": None
        if total is None or free is None
        else {"used_bytes": max(0, total - free), "total_bytes": total},
        "awake": None
        if running is None or most is None
        else {"running": running, "max": most},
        "ai_calls_today": None
        if cap is None or used is None
        else {
            "used": used,
            "cap": cap,
            "capped": capped is True or used >= cap,
            "resets_at": next_utc_midnight(now).isoformat(),
        },
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
    now = datetime.now(UTC)
    state, error = workspace_state(machine, workspace, now)
    # The v1/v2 switch: with v2 off, the summary is exactly as before v2.
    v2 = process_hosted_v2()
    controller = (
        None
        if not v2 or workspace.controller_id is None
        else await session.get(AgentController, workspace.controller_id)
    )
    return {
        "machine_id": machine.id,
        "state": state,
        "desired_state": machine.desired_state,
        "stop_reason": _wire_stop_reason(machine, v2),
        "stopped_by_admin": admin_stopped(machine),
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
        # v1 or v2 (`vm` or `box`): Console shows v2's card and states only for
        # a box. With hosted agents v2 off, absent, as before v2.
        **({"backend": machine.backend} if v2 else {}),
        # Your cloud: from this workspace's controller only.
        **(
            your_cloud(None if controller is None else controller.status, now)
            if v2
            else {}
        ),
    }


def _wire_stop_reason(machine: CloudMachine, v2: bool) -> str | None:
    """`stop_reason` as Console reads it, which takes only `idle` or `owner`:
    an administrator's stop shows there as the owner's, for builds that predate
    `stopped_by_admin`, and so do a pause and a turn-off: stopped, and a start
    is refused with the block's own words. Why it's blocked comes from the stop
    reason codes."""
    if admin_stopped(machine):
        return "owner" if machine.desired_state == "stopped" else None
    if v2 and machine.stop_reason in ("paused", "turned_off"):
        return "owner"
    return machine.stop_reason


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
    if settings is None or not machines_enabled(config, settings, owner_id):
        raise MachineUnavailable(MACHINES_DISABLED)
    machines = CloudMachineStore()
    v2 = process_hosted_v2()
    # Turned off in this workspace by its admin: no box for it.
    # A pause is refused by the claim itself (`claim_conflict`).
    if (
        v2
        and await block_reason_in(session, owner_id, require_tenant_id())
        is StopReason.TURNED_OFF_BY_ADMIN
    ):
        raise CloudMachineConflict(MACHINE_TURNED_OFF)
    await lock_claims(session)
    existing = await machines.live_for_owner(session, owner_id)
    workspace = None
    if not v2 and existing is not None and existing.backend == "box":
        # The v1/v2 switch: with v2 off, a v2 box is never claimed, joined,
        # started or revived, and no VM is made over it.
        raise MachineUnavailable(MACHINES_DISABLED)
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
    change = _claim_change(existing, workspace)
    claimed = await machines.claim(
        session,
        factory,
        owner_id=owner_id,
        capacity=config.hosted_launch_capacity,
        now=datetime.now(UTC),
        # A user keeps one machine id for life, so the box made for them
        # matches the namespace they already have. With box provisioning off, as before.
        revoke=revoke_machine_controller if box_provisioning_on(config) else None,
        # With box provisioning on, a new machine is a cluster box it makes; off, a v1 one.
        backend="box" if box_provisioning_on(config) else "vm",
    )
    if change is not None:
        emit_after_commit(
            session, current_telemetry(), "cloud_machine_requested", {"change": change}
        )
        record_machine_event(session, "requested", change, claimed[0].backend)
    return claimed


def _claim_change(
    existing: CloudMachine | None, workspace: MachineWorkspace | None
) -> str | None:
    """What claiming the owner's machine will change, as `claim` decides it,
    or None when it only marks a running machine active. The first that
    applies, when a claim does two of these at once."""
    if existing is None:
        return "new"
    if workspace is None:
        return "joined_workspace"
    if existing.desired_state == "retained":
        return "unretained"
    if existing.desired_state == "stopped":
        return "restarted"
    return None


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
    available = settings is not None and machines_enabled(config, settings, user.id)
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
    # A new user's machine asks for its box, just after the claim commits.
    await ask_for_box(
        factory,
        machine_id=machine.id,
        config=config,
        settings=settings,
        now=datetime.now(UTC),
    )
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
    if admin_stopped(machine):
        raise HTTPException(409, MACHINE_STOPPED_BY_ADMIN)
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
    if not process_hosted_v2() and machine.backend == "box":
        # The v1/v2 switch: with v2 off, a v2 box takes no start, stop or retry.
        raise HTTPException(409, MACHINES_DISABLED)
    # Paused, or turned off here: every action is refused, so the owner can't
    # undo an operator's pause or an admin's switch.
    blocked = (
        await block_reason_in(session, user.id, workspace.tenant_id)
        if process_hosted_v2()
        else None
    )
    if blocked is StopReason.PAUSED_BY_SWITCH:
        raise HTTPException(409, MACHINE_PAUSED)
    if blocked is StopReason.TURNED_OFF_BY_ADMIN:
        raise HTTPException(409, MACHINE_TURNED_OFF)
    now = datetime.now(UTC)
    if body.action == "stop":
        if machine.desired_state != "stopped":
            emit_after_commit(
                session,
                current_telemetry(),
                "cloud_machine_stopped",
                {"reason": "owner"},
            )
            record_machine_event(session, "stopped", "owner", machine.backend)
        machines.stop(machine, "owner", now)
    elif body.action == "start":
        if machine.desired_state == "stopped":
            emit_after_commit(
                session,
                current_telemetry(),
                "cloud_machine_woken",
                {"trigger": "owner", "stopped_by": machine.stop_reason or "unknown"},
            )
            record_machine_event(session, "woken", "owner", machine.backend)
        machines.start(machine, now)
    else:
        if machine.state != "error":
            raise HTTPException(409, "Only a machine in error can be retried.")
        machines.retry(machine, now)
    await session.commit()
    return {"machine": await machine_summary(session, machine, workspace)}

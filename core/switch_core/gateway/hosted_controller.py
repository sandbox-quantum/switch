import logging
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.config import SwitchConfig
from switch_core.db.models import (
    HostedLaunch,
    HostedMachine,
    HostedOperation,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_CONNECT_TIMEOUT,
    HostedMachineStore,
    bump_revision,
    idle_sleeping,
    lock_launch,
    retention_expired,
)
from switch_core.gateway.cloud_controllers import (
    CloudEnrollmentUnavailable,
    controller_machine_idle,
    enrollment_code,
    live_controller,
)
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session_factory,
)
from switch_core.gateway.hosted_launches import controller_settings, finish_removal
from switch_core.providers.github_revocations import revoke_pending
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import tenant_scope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hosted-controller")

QUEUED_TIMEOUT = timedelta(minutes=10)
DELETING_RESUME_AFTER = timedelta(minutes=5)
AGENT_STOP_TIMEOUT = timedelta(minutes=10)


async def controller_session(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    """Authenticate the operator controller and bind its configured tenant.

    The bearer credential can provision only this tenant's machines; it is
    never accepted as a user or agent credential on other routes.
    """
    supplied = request.headers.get("authorization", "")
    if not secrets.compare_digest(
        supplied, "Bearer " + settings.token.get_secret_value()
    ):
        raise HTTPException(401, "Invalid cloud controller credential.")
    with tenant_scope(settings.tenant_id):
        async with factory() as session:
            yield session


def machine_item(machine: HostedMachine) -> dict:
    return {
        "machine_id": machine.id,
        "slot_id": machine.slot_id,
        "generation": machine.generation,
        "state": machine.state,
        "desired_state": machine.desired_state,
        "revision": machine.revision,
        "data_volume_id": machine.data_volume_id,
        "retain_until": machine.retain_until.isoformat()
        if machine.retain_until
        else None,
        "bundle_revision": machine.machine_capability_revision
        if machine.runtime == "worker"
        else machine.enrollment_code_revision,
        "runtime": machine.runtime,
    }


def _idle_stops(machine: HostedMachine, idle_minutes: int) -> bool:
    """Whether an idle machine is put to sleep: a message addressed to one of
    its agents wakes it again."""
    return idle_minutes > 0


def _connect_timed_out(machine: HostedMachine, now: datetime) -> bool:
    return (
        machine.state == "provisioning"
        and machine.running_observed_at is not None
        and now - machine.running_observed_at > MACHINE_CONNECT_TIMEOUT
        and (
            machine.heartbeat_at is None
            or machine.heartbeat_at <= machine.running_observed_at
        )
    )


def _start_timed_out(machine: HostedMachine, now: datetime) -> bool:
    return (
        machine.state == "provisioning"
        and machine.running_observed_at is None
        and now - machine.updated_at > MACHINE_CONNECT_TIMEOUT
    )


def _stop_timed_out(
    launch: HostedLaunch, machine: HostedMachine, now: datetime
) -> bool:
    return (
        launch.state == "stopping"
        and now - launch.updated_at > AGENT_STOP_TIMEOUT
        and machine.state == "ready"
    )


def _errored_unclaimed(
    machine: HostedMachine, now: datetime, idle_minutes: int
) -> bool:
    return (
        idle_minutes > 0
        and machine.state == "error"
        and machine.desired_state not in {"retained", "deleted"}
        and now - machine.updated_at > timedelta(minutes=idle_minutes)
    )


def _needs_sweep(machine: HostedMachine, now: datetime, idle_minutes: int) -> bool:
    return (
        (machine.state == "queued" and now - machine.updated_at > QUEUED_TIMEOUT)
        or _connect_timed_out(machine, now)
        or _start_timed_out(machine, now)
        or (machine.state in {"retained", "error"} and retention_expired(machine, now))
        or _errored_unclaimed(machine, now, idle_minutes)
        or idle_sleeping(machine)
        or (
            _idle_stops(machine, idle_minutes)
            and machine.state == "ready"
            and machine.desired_state == "running"
        )
    )


async def _should_sleep(
    session: AsyncSession,
    machine: HostedMachine,
    protocol: AgentCore,
    idle_after: timedelta,
    now: datetime,
) -> bool:
    """Whether every counted agent on the machine is provably idle.

    Counted agents are the ones meant to run and not in error. A busy one
    renews its own activity, so it keeps the machine awake for another window.
    A controller machine is idle when its own status reports say so.
    """
    if machine.runtime == "controller":
        return controller_machine_idle(machine, idle_after, now)
    idle = True
    for candidate in await HostedMachineStore().launches(session, machine.id):
        await lock_launch(session, candidate.id)
        launch = await session.get(
            HostedLaunch, (require_tenant_id(), candidate.id), populate_existing=True
        )
        if (
            launch is None
            or launch.desired_state != "running"
            or launch.state in {"error", "deleted"}
        ):
            continue
        evidence = await HostedLaunchStore().idle_evidence(
            session, launch, protocol.connections
        )
        if evidence.busy:
            launch.active_at = now
            idle = False
        elif (
            now - launch.active_at < idle_after
            or evidence.report is None
            or evidence.report.received_at <= launch.active_at
        ):
            idle = False
    return idle and now - machine.active_at >= idle_after


async def _resume_removals(
    session: AsyncSession,
    protocol: AgentCore,
    config: SwitchConfig,
    now: datetime,
) -> None:
    """Finish removals that were interrupted between their two commits."""
    stalled = list(
        await session.scalars(
            select(HostedLaunch.id).where(
                HostedLaunch.tenant_id == require_tenant_id(),
                HostedLaunch.state == "deleting",
                HostedLaunch.updated_at < now - DELETING_RESUME_AFTER,
            )
        )
    )
    for launch_id in stalled:
        launch, machine = await HostedMachineStore().locked_launch(session, launch_id)
        if launch is None or machine is None or launch.state != "deleting":
            await session.commit()
            continue
        try:
            await finish_removal(session, protocol, config, launch, machine, now)
        except Exception:
            logger.error(
                "Cloud launch %s: finishing its interrupted removal failed",
                launch_id,
                exc_info=True,
            )
            await session.rollback()
            continue
        await session.commit()


async def _sweep(
    session: AsyncSession,
    machine: HostedMachine,
    protocol: AgentCore,
    idle_minutes: int,
    retention_days: int,
    now: datetime,
) -> None:
    store = HostedMachineStore()
    if machine.state == "queued" and now - machine.updated_at > QUEUED_TIMEOUT:
        machine.state = "error"
        machine.error_code = "machine_connect_timeout"
        machine.error = "The cloud machine was not scheduled within 10 minutes. Retry it in Switch Console, or contact your administrator if it still cannot start."
        machine.updated_at = now
    elif _connect_timed_out(machine, now):
        machine.state = "error"
        machine.error_code = "machine_connect_timeout"
        machine.error = "The cloud machine started but did not connect to Switch within 10 minutes. Retry it in Switch Console, or ask your administrator to check the machine's startup logs."
        machine.updated_at = now
    elif _start_timed_out(machine, now):
        machine.state = "error"
        machine.error_code = "machine_connect_timeout"
        machine.error = "The cloud machine did not start within 10 minutes. Retry it in Switch Console, or contact your administrator if it still cannot start."
        machine.updated_at = now
    elif machine.state in {"retained", "error"} and retention_expired(machine, now):
        machine.desired_state = "deleted"
        bump_revision(machine, now)
    elif _errored_unclaimed(machine, now, idle_minutes) and not await store.ever_hosted(
        session, machine
    ):
        await store.release_if_empty(
            session, machine, retention_days=retention_days, now=now
        )
    elif idle_sleeping(machine):
        await store.release_if_empty(
            session, machine, retention_days=retention_days, now=now
        )
    elif (
        _idle_stops(machine, idle_minutes)
        and machine.state == "ready"
        and machine.desired_state == "running"
        and await _should_sleep(
            session, machine, protocol, timedelta(minutes=idle_minutes), now
        )
    ):
        if not await store.release_if_empty(
            session, machine, retention_days=retention_days, now=now
        ):
            store.stop(machine, "idle", now)


async def _expire_operations(session: AsyncSession) -> None:
    launch_ids = list(
        await session.scalars(
            select(HostedOperation.launch_id)
            .where(
                HostedOperation.tenant_id == require_tenant_id(),
                HostedOperation.state.in_(["queued", "claimed"]),
            )
            .distinct()
        )
    )
    for launch_id in launch_ids:
        launch, _ = await HostedMachineStore().locked_launch(session, launch_id)
        if launch is not None:
            await HostedLaunchStore().fail_stale_operations(
                session, launch.id, launch.revision
            )
        await session.commit()


async def _time_out_stopping_launches(session: AsyncSession, now: datetime) -> None:
    launch_ids = list(
        await session.scalars(
            select(HostedLaunch.id)
            .join(
                HostedMachine,
                (HostedMachine.tenant_id == HostedLaunch.tenant_id)
                & (HostedMachine.id == HostedLaunch.machine_id),
            )
            .where(
                HostedLaunch.tenant_id == require_tenant_id(),
                HostedLaunch.state == "stopping",
                HostedLaunch.updated_at < now - AGENT_STOP_TIMEOUT,
                HostedMachine.state == "ready",
            )
        )
    )
    for launch_id in launch_ids:
        launch, machine = await HostedMachineStore().locked_launch(session, launch_id)
        if (
            launch is not None
            and machine is not None
            and _stop_timed_out(launch, machine, now)
        ):
            launch.state = "error"
            launch.error_code = "agent_stop_timeout"
            launch.error = (
                "The agent did not stop within 10 minutes. Retry it in Switch Console."
            )
            launch.updated_at = now
        await session.commit()


@router.get("/machines")
async def machines(
    session: Annotated[AsyncSession, Depends(controller_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict:
    store = HostedMachineStore()
    now = datetime.now(UTC)
    await _resume_removals(session, protocol, config, now)
    candidates = list(
        await session.scalars(
            select(HostedMachine)
            .where(
                HostedMachine.tenant_id == require_tenant_id(),
                HostedMachine.state != "deleted",
            )
            .order_by(HostedMachine.created_at)
        )
    )
    for candidate in candidates:
        if not _needs_sweep(candidate, now, config.hosted_idle_stop_minutes):
            continue
        machine = await store.locked(session, candidate.id)
        if machine is not None:
            await _sweep(
                session,
                machine,
                protocol,
                config.hosted_idle_stop_minutes,
                config.hosted_disk_retention_days,
                now,
            )
        await session.commit()
    await _expire_operations(session)
    await _time_out_stopping_launches(session, now)
    rows = await session.scalars(
        select(HostedMachine)
        .where(
            HostedMachine.tenant_id == require_tenant_id(),
            HostedMachine.state != "deleted",
        )
        .order_by(HostedMachine.created_at)
        .execution_options(populate_existing=True)
    )
    response = {"machines": [machine_item(machine) for machine in rows]}
    await session.commit()
    await revoke_pending(session, config, ())
    return response


async def _locked_machine(session: AsyncSession, machine_id: str) -> HostedMachine:
    machine = await HostedMachineStore().locked(session, machine_id)
    if machine is None:
        raise HTTPException(404, "Cloud machine not found.")
    return machine


@router.post("/machines/{machine_id}/prepare")
async def prepare(
    machine_id: str,
    response: Response,
    session: Annotated[AsyncSession, Depends(controller_session)],
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    machine = await _locked_machine(session, machine_id)
    if machine.state == "deleted" or machine.desired_state == "deleted":
        raise HTTPException(409, "machine is deleted")
    now = datetime.now(UTC)
    if await session.get(TenantMember, (require_tenant_id(), machine.owner_id)) is None:
        machine.state = "error"
        machine.error = "The cloud machine's owner is no longer a workspace member."
        machine.updated_at = now
        await session.commit()
        raise HTTPException(
            409, "The cloud machine's owner is no longer a workspace member."
        )
    if machine.runtime == "controller":
        result = await _prepare_controller(session, machine, settings, config, now)
        await session.commit()
        return result
    capability = HostedMachineStore().issue_capability(machine, config.keyring)
    if machine.state == "queued":
        machine.state = "provisioning"
        machine.updated_at = now
    result = {
        "machine_id": machine.id,
        "slot_id": machine.slot_id,
        "generation": machine.generation,
        "revision": machine.revision,
        "bundle_revision": machine.machine_capability_revision,
        "machine_capability": capability,
        "api_endpoint": settings.agent_api_endpoint,
    }
    await session.commit()
    return result


async def _prepare_controller(
    session: AsyncSession,
    machine: HostedMachine,
    settings: HostedControllerSettings,
    config: SwitchConfig,
    now: datetime,
) -> dict:
    """What a controller machine boots from at its current revision: the
    controller it enrolled as, or, until it has one that is not revoked, a
    one-time code to enroll with. Never a long-lived credential: the machine
    keeps the one it enrolls with on its own disk."""
    controller = await live_controller(session, machine)
    try:
        code = (
            None
            if controller is not None
            else await enrollment_code(session, machine, config.keyring, now)
        )
    except CloudEnrollmentUnavailable as error:
        raise HTTPException(409, str(error)) from None
    if machine.state == "queued":
        machine.state = "provisioning"
        machine.updated_at = now
    return {
        "machine_id": machine.id,
        "slot_id": machine.slot_id,
        "generation": machine.generation,
        "revision": machine.revision,
        "bundle_revision": machine.revision,
        "runtime": "controller",
        "api_endpoint": settings.agent_api_endpoint,
        "controller": {
            "id": controller.id if controller is not None else None,
            "enrollment_code": code,
        },
    }


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal[
        "provisioning",
        "running",
        "error",
        "stopping",
        "stopped",
        "retained",
        "deleting",
        "deleted",
    ]
    revision: int = Field(ge=1)
    error: str | None = Field(default=None, max_length=512)
    error_code: Literal["machine_needs_attention"] | None = None
    data_volume_id: str | None = Field(default=None, max_length=256)
    instance_id: str | None = Field(default=None, max_length=256)
    instance_type: str | None = Field(default=None, max_length=256)


ERROR_REPLACING_STATES = {"error", "retained", "deleting", "deleted"}

STALE_ERROR_IGNORED_STATES = {"deleted", "queued", "provisioning"}

OBSERVED_ERROR = "The cloud machine could not start. Retry it in Switch Console, or contact your administrator if it keeps failing."


@router.post("/machines/{machine_id}/observation")
async def observe(
    machine_id: str,
    body: Observation,
    session: Annotated[AsyncSession, Depends(controller_session)],
) -> dict:
    machine = await _locked_machine(session, machine_id)
    now = datetime.now(UTC)
    if body.revision != machine.revision:
        if body.revision > machine.revision:
            logger.warning(
                "Cloud machine %s: ignoring an observation for revision %s, ahead of Core's %s.",
                machine.id,
                body.revision,
                machine.revision,
            )
        elif (
            body.state == "error" or body.error is not None
        ) and machine.state not in STALE_ERROR_IGNORED_STATES:
            machine.state = "error"
            machine.error = body.error or OBSERVED_ERROR
            machine.error_code = body.error_code
            machine.updated_at = now
            await session.commit()
        return machine_item(machine)
    if machine.state == "deleted" or (
        machine.state == "error" and body.state not in ERROR_REPLACING_STATES
    ):
        return machine_item(machine)
    for field in ("data_volume_id", "instance_id", "instance_type"):
        if (value := getattr(body, field)) is not None:
            setattr(machine, field, value)
    previous = machine.state
    if body.state == "running":
        if machine.state != "ready":
            machine.state = "provisioning"
            if machine.running_observed_at is None:
                machine.running_observed_at = now
    elif body.state == "provisioning":
        if machine.state != "ready":
            machine.state = "provisioning"
    elif body.state == "error":
        machine.state = "error"
        machine.error = body.error or OBSERVED_ERROR
        machine.error_code = body.error_code
    else:
        machine.state = body.state
        machine.error = None
        machine.error_code = None
    if body.state == "deleted":
        for launch in await HostedMachineStore().launches(session, machine.id):
            logger.error(
                "Cloud machine %s was deleted while launch %s (state %s) was still on it.",
                machine.id,
                launch.id,
                launch.state,
            )
    if machine.state != previous:
        machine.updated_at = now
    await session.commit()
    return machine_item(machine)

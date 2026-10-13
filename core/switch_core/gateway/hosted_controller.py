import logging
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import CloudMachine, TenantMember
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_CONNECT_TIMEOUT,
    CloudMachineStore,
    WorkspaceOnMachine,
    bump_revision,
    ever_hosted,
    idle_sleeping,
    retention_expired,
    workspace_on,
    workspaces_on,
)
from switch_core.gateway.cloud_controllers import (
    CloudEnrollmentUnavailable,
    controller_machine_idle,
    controller_reports,
    enrollment_code,
    live_controller,
)
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import no_tenant, tenant_scope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hosted-controller")

QUEUED_TIMEOUT = timedelta(minutes=10)


async def controller_session(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    """Authenticate the operator controller, on a session with no tenant bound.

    A cloud machine belongs to its owner rather than to a workspace, so this
    session reads machines and nothing scoped; what a machine runs in each
    workspace is read with that workspace bound (`workspaces_on`). The bearer
    credential is never accepted as a user or agent credential on other routes.
    """
    supplied = request.headers.get("authorization", "")
    if not secrets.compare_digest(
        supplied, "Bearer " + settings.token.get_secret_value()
    ):
        raise HTTPException(401, "Invalid cloud controller credential.")
    with no_tenant():
        async with factory() as session:
            yield session


def machine_item(machine: CloudMachine) -> dict:
    return {
        "machine_id": machine.id,
        "state": machine.state,
        "desired_state": machine.desired_state,
        "revision": machine.revision,
        "data_volume_id": machine.data_volume_id,
        "retain_until": machine.retain_until.isoformat()
        if machine.retain_until
        else None,
        "bundle_revision": machine.revision,
    }


def _idle_stops(machine: CloudMachine, idle_minutes: int) -> bool:
    """Whether an idle machine is put to sleep: a message addressed to one of
    its agents wakes it again."""
    return idle_minutes > 0


def _connect_timed_out(machine: CloudMachine, now: datetime) -> bool:
    return (
        machine.state == "provisioning"
        and machine.running_observed_at is not None
        and now - machine.running_observed_at > MACHINE_CONNECT_TIMEOUT
        and (
            machine.heartbeat_at is None
            or machine.heartbeat_at <= machine.running_observed_at
        )
    )


def _start_timed_out(machine: CloudMachine, now: datetime) -> bool:
    return (
        machine.state == "provisioning"
        and machine.running_observed_at is None
        and now - machine.updated_at > MACHINE_CONNECT_TIMEOUT
    )


def _errored_unclaimed(machine: CloudMachine, now: datetime, idle_minutes: int) -> bool:
    return (
        idle_minutes > 0
        and machine.state == "error"
        and machine.desired_state not in {"retained", "deleted"}
        and now - machine.updated_at > timedelta(minutes=idle_minutes)
    )


def _needs_sweep(machine: CloudMachine, now: datetime, idle_minutes: int) -> bool:
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


async def _sweep(
    session: AsyncSession,
    machine: CloudMachine,
    workspaces: list[WorkspaceOnMachine],
    idle_minutes: int,
    retention_days: int,
    now: datetime,
) -> None:
    store = CloudMachineStore()
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
    elif _errored_unclaimed(machine, now, idle_minutes) and not ever_hosted(workspaces):
        await store.release_if_empty(
            machine, workspaces, retention_days=retention_days, now=now
        )
    elif idle_sleeping(machine):
        await store.release_if_empty(
            machine, workspaces, retention_days=retention_days, now=now
        )
    elif (
        _idle_stops(machine, idle_minutes)
        and machine.state == "ready"
        and machine.desired_state == "running"
        and controller_machine_idle(machine, timedelta(minutes=idle_minutes), now)
    ):
        if not await store.release_if_empty(
            machine, workspaces, retention_days=retention_days, now=now
        ):
            store.stop(machine, "idle", now)


@router.get("/machines")
async def machines(
    session: Annotated[AsyncSession, Depends(controller_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    store = CloudMachineStore()
    now = datetime.now(UTC)
    candidates = list(
        await session.scalars(
            select(CloudMachine)
            .where(CloudMachine.state != "deleted")
            .order_by(CloudMachine.created_at)
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
                await workspaces_on(factory, machine.id),
                config.hosted_idle_stop_minutes,
                config.hosted_disk_retention_days,
                now,
            )
        await session.commit()
    rows = await session.scalars(
        select(CloudMachine)
        .where(CloudMachine.state != "deleted")
        .order_by(CloudMachine.created_at)
        .execution_options(populate_existing=True)
    )
    response = {"machines": [machine_item(machine) for machine in rows]}
    await session.commit()
    return response


async def _locked_machine(session: AsyncSession, machine_id: str) -> CloudMachine:
    machine = await CloudMachineStore().locked(session, machine_id)
    if machine is None:
        raise HTTPException(404, "Cloud machine not found.")
    return machine


@router.post("/machines/{machine_id}/prepare")
async def prepare(
    machine_id: str,
    response: Response,
    session: Annotated[AsyncSession, Depends(controller_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    """What the machine boots from at its current revision: per workspace it
    serves, the controller it enrolled as there, or, until it has one that is
    not revoked, a one-time code to enroll with. Never a long-lived credential:
    the machine keeps the ones it enrolls with on its own disk."""
    response.headers["Cache-Control"] = "no-store"
    machine = await _locked_machine(session, machine_id)
    if machine.state == "deleted" or machine.desired_state == "deleted":
        raise HTTPException(409, "machine is deleted")
    now = datetime.now(UTC)
    controllers = []
    for workspace in await workspaces_on(factory, machine.id):
        with tenant_scope(workspace.tenant_id):
            async with factory() as scoped:
                if (
                    await scoped.get(
                        TenantMember, (workspace.tenant_id, machine.owner_id)
                    )
                    is None
                ):
                    logger.warning(
                        "Cloud machine %s: its owner left workspace %s, so it runs no controller there.",
                        machine.id,
                        workspace.tenant_id,
                    )
                    continue
                row = await workspace_on(scoped, machine.id)
                assert row is not None
                controller = await live_controller(scoped, row)
                try:
                    code = (
                        None
                        if controller is not None
                        else await enrollment_code(
                            scoped, row, machine.revision, config.keyring, now
                        )
                    )
                except CloudEnrollmentUnavailable as error:
                    raise HTTPException(409, str(error)) from None
                await scoped.commit()
                controllers.append(
                    {
                        "key": row.id,
                        "id": controller.id if controller is not None else None,
                        "enrollment_code": code,
                    }
                )
    served = {entry["key"] for entry in controllers}
    reports = controller_reports(machine)
    if set(reports) - served:
        # A workspace the machine no longer runs a controller for must not keep
        # it awake with a report that will never be fresh again.
        machine.heartbeat = {
            **(machine.heartbeat or {}),
            "controllers": {
                key: report for key, report in reports.items() if key in served
            },
        }
    if not controllers:
        machine.state = "error"
        machine.error = "The cloud machine's owner is no longer a member of any workspace it serves."
        machine.updated_at = now
        await session.commit()
        raise HTTPException(409, machine.error)
    if machine.state == "queued":
        machine.state = "provisioning"
        machine.updated_at = now
    result = {
        "machine_id": machine.id,
        "revision": machine.revision,
        "bundle_revision": machine.revision,
        "api_endpoint": settings.agent_api_endpoint,
        "controllers": controllers,
    }
    await session.commit()
    return result


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
    if machine.state != previous:
        machine.updated_at = now
    await session.commit()
    return machine_item(machine)

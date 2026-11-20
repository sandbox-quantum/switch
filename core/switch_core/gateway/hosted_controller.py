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
from switch_core.db.models import CloudMachine
from switch_core.db.standing import stands_in
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_CONNECT_TIMEOUT,
    CloudMachineStore,
    WorkspaceOnMachine,
    admin_stopped,
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
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_config,
    get_session_factory,
)
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.logging_context import STRUCTURED_FIELDS
from switch_core.observability.hosted import (
    after_commit,
    reconciler_heard,
    record_cloud_error,
    record_controller_errors,
    record_credential_refusal,
    record_machine_event,
)
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.telemetry import emit_after_commit
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
        # Counted by reason and route only, never the credential.
        record_credential_refusal(
            "missing" if not supplied else "wrong", "hosted_controller"
        )
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
    """Whether Switch has a lifecycle change to make to the machine. Never for
    one an administrator holds stopped: its disk stays until they release it."""
    return not admin_stopped(machine) and (
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
    if admin_stopped(machine):
        return
    if machine.state == "queued" and now - machine.updated_at > QUEUED_TIMEOUT:
        machine.state = "error"
        machine.error_code = "machine_connect_timeout"
        machine.error = "The cloud machine was not scheduled within 10 minutes. Retry it in Switch Console, or contact your administrator if it still cannot start."
        machine.updated_at = now
        _report_failure(session, machine, "not_scheduled")
    elif _connect_timed_out(machine, now):
        machine.state = "error"
        machine.error_code = "machine_connect_timeout"
        machine.error = "The cloud machine started but did not connect to Switch within 10 minutes. Retry it in Switch Console, or ask your administrator to check the machine's startup logs."
        machine.updated_at = now
        # A machine that has reported before ran once and didn't come back: a
        # failed wake or restart. One that never has is a first launch, even
        # retried (a retry moves the revision on too).
        _report_failure(
            session,
            machine,
            "never_connected",
            finer="wake_failed" if machine.heartbeat_at is not None else None,
        )
    elif _start_timed_out(machine, now):
        machine.state = "error"
        machine.error_code = "machine_connect_timeout"
        machine.error = "The cloud machine did not start within 10 minutes. Retry it in Switch Console, or contact your administrator if it still cannot start."
        machine.updated_at = now
        _report_failure(session, machine, "never_started")
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
        if await store.release_if_empty(
            machine, workspaces, retention_days=retention_days, now=now
        ):
            # Idle with no agents left: released with its disk kept rather
            # than stopped. Still the machine going quiet, so it's counted.
            record_machine_event(session, "stopped", "retained")
        else:
            store.stop(machine, "idle", now)
            emit_after_commit(
                session, current_telemetry(), "cloud_machine_idle_stopped", {}
            )
            record_machine_event(session, "stopped", "idle")


# The finer words the hosted metric and log line use beside product
# telemetry's reasons.
MachineFailure = Literal["wake_failed", "stop_failed", "launch_refused"]

FailureReason = Literal[
    "not_scheduled",
    "never_started",
    "never_connected",
    "owner_left",
    "needs_attention",
    "reported",
]


def _observed_failure(error_code: str | None) -> FailureReason:
    """An error the machine reported: `needs_attention` for the one code an
    observation can carry, `reported` for any other."""
    return "needs_attention" if error_code == "machine_needs_attention" else "reported"


# Every desired state that means the machine should be going down.
STOPPING_STATES = frozenset({"stopped", "retained", "deleted"})


def _stop_failure(machine: CloudMachine) -> MachineFailure | None:
    """`stop_failed` for an error observed while the machine is wanted
    stopped, retained (stopped, disk kept) or deleted."""
    return "stop_failed" if machine.desired_state in STOPPING_STATES else None


def _observed_finer(
    machine: CloudMachine, reason: FailureReason
) -> MachineFailure | None:
    """The hosted metric's finer word for an error a machine reported:
    `stop_failed` while it's wanted down; `launch_refused` for a machine that
    needs attention and has never been ready, so a launch that was refused or
    never came up (a bad image, a box that never got ready) counts as a launch
    failing; otherwise none."""
    if (stop := _stop_failure(machine)) is not None:
        return stop
    if reason == "needs_attention" and machine.first_ready_at is None:
        return "launch_refused"
    return None


def _report_failure(
    session: AsyncSession,
    machine: CloudMachine,
    reason: FailureReason,
    *,
    finer: MachineFailure | None = None,
) -> None:
    """A machine has failed: product telemetry with `reason`, and the hosted
    metric and log line with `finer` where the operator can tell more
    (`wake_failed`, `stop_failed`) than product telemetry's fixed set says."""
    emit_after_commit(
        session, current_telemetry(), "cloud_machine_failed", {"reason": reason}
    )
    word = finer or reason
    record_machine_event(session, "failed", word)
    # One line with a fixed event name, the reason and the machine id only
    # Under `switch.event`, not `event.name`, which some pipelines treat as
    # a product event.
    logger.warning(
        "Cloud machine %s failed: %s",
        machine.id,
        word,
        extra={
            STRUCTURED_FIELDS: {
                "switch": {
                    "event": "hosted.machine_failed",
                    "reason": word,
                    "machine": machine.id,
                }
            }
        },
    )


@router.get("/machines")
async def machines(
    session: Annotated[AsyncSession, Depends(controller_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    reconciler_heard()
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
                if not await stands_in(scoped, workspace.tenant_id, machine.owner_id):
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
        if machine.state != "error":
            _report_failure(session, machine, "owner_left")
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


class CloudErrorCount(BaseModel):
    """How many cloud calls of one kind the reconciler saw fail since it last
    reported, as fixed words only: which call, and what kind of error. Never
    the provider's own code or message."""

    model_config = ConfigDict(extra="forbid")
    call: Literal["launch", "start", "stop", "terminate", "volume", "describe", "other"]
    kind: Literal["capacity", "throttled", "permission", "other"]
    count: int = Field(ge=1, le=1_000_000)


# What a reconciler error can be about, for its count by kind.
ReconcilerErrorKind = Literal["cloud", "core_api", "state", "other"]


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
    # The reconciler's errors, as strict types (fixed words, capped counts, no
    # free text): its failed cloud calls by call and kind, and its own errors
    # by kind, since it last reported. Counted, never stored.
    cloud_errors: list[CloudErrorCount] | None = Field(default=None, max_length=28)
    reconciler_errors: (
        dict[ReconcilerErrorKind, Annotated[int, Field(ge=0, le=1_000_000)]] | None
    ) = None


ERROR_REPLACING_STATES = {"error", "retained", "deleting", "deleted"}

STALE_ERROR_IGNORED_STATES = {"deleted", "queued", "provisioning"}

OBSERVED_ERROR = "The cloud machine could not start. Retry it in Switch Console, or contact your administrator if it keeps failing."


@router.post("/machines/{machine_id}/observation")
async def observe(
    machine_id: str,
    body: Observation,
    session: Annotated[AsyncSession, Depends(controller_session)],
) -> dict:
    reconciler_heard()
    machine = await _locked_machine(session, machine_id)
    # Counted once this answer's transaction commits. Every answer from here
    # is a 200 and commits, so the reconciler forgets only what was counted;
    # a batch counts twice only if Core's answer is lost after the commit.
    cloud_errors = [(e.call, e.kind, e.count) for e in body.cloud_errors or []]
    reconciler_errors = dict(body.reconciler_errors or {})
    if cloud_errors or reconciler_errors:

        def count() -> None:
            for call, kind, number in cloud_errors:
                record_cloud_error(call, kind, number)
            if reconciler_errors:
                record_controller_errors(reconciler_errors)

        after_commit(session, count)
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
            if machine.state != "error":
                reason = _observed_failure(body.error_code)
                _report_failure(
                    session, machine, reason, finer=_observed_finer(machine, reason)
                )
            machine.state = "error"
            machine.error = body.error or OBSERVED_ERROR
            machine.error_code = body.error_code
            machine.updated_at = now
        # Commits even with nothing changed, so the error counts above count.
        await session.commit()
        return machine_item(machine)
    if machine.state == "deleted" or (
        machine.state == "error" and body.state not in ERROR_REPLACING_STATES
    ):
        await session.commit()
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
        if machine.state != "error":
            reason = _observed_failure(body.error_code)
            _report_failure(
                session, machine, reason, finer=_observed_finer(machine, reason)
            )
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

import logging
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.refusals import (
    client_address,
    method_of,
    refusal_guard,
)
from switch_core.config import SwitchConfig
from switch_core.db.models import CloudMachine
from switch_core.db.standing import stands_in
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_CONNECT_TIMEOUT,
    MACHINE_PAUSED,
    MACHINE_TURNED_OFF,
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
    clear_spent_codes,
    controller_machine_idle,
    controller_reports,
    enrollment_code,
    live_controller,
)
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.gateway.hosted_machines import MACHINES_DISABLED, controller_settings
from switch_core.hosted_v2 import process_hosted_v2, require_hosted_v2
from switch_core.observability.hosted import record_evictions
from switch_core.providers.hosted import (
    HostedControllerSettings,
    open_to_all,
)
from switch_core.tenant_context import no_tenant, tenant_scope
from switch_core.visibility.alerts import (
    CLUSTER_CONDITIONS,
    apply_verdicts,
    cluster_verdicts,
)
from switch_core.visibility.box_facts import with_box_facts
from switch_core.visibility.box_provision import (
    ask_for_box,
    box_provisioning_on,
    expire_provisions,
    open_provision_machines,
)
from switch_core.visibility.cluster_report import (
    NODE_NAME,
    SHARED_SERVICES,
    ClusterReport,
    keep_cluster_report,
)
from switch_core.visibility.hosted_access import block_reason_in
from switch_core.visibility.reason_codes import StopReason
from switch_core.visibility.recent_moves import recent_moves

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
        _refuse(request, supplied)
    with no_tenant():
        async with factory() as session:
            yield session


def _refuse(
    request: Request,
    supplied: str,
    route: str = "hosted_controller",
    reason: str | None = None,
) -> NoReturn:
    """A refused cloud-controller credential (B91): one WARN through the
    shared refusal guard, never the credential, then a 401. An address that
    keeps being refused gets a 429 at once instead. The correct token is
    checked first, by the caller, so it is served even from a locked address:
    the operator and the scaler can share one cluster address with anything
    else."""
    if not process_hosted_v2():
        # The v1/v2 switch: with v2 off, exactly as before v2 (no lockout).
        raise HTTPException(401, "Invalid cloud controller credential.")
    guard = refusal_guard()
    address = client_address(request.scope)
    method = method_of(request.scope)
    if guard.locked(address):
        guard.refused(address, reason="locked_out", route=route, method=method)
        raise HTTPException(
            429,
            "Too many refused credentials from this address; try again later.",
            headers={"Retry-After": str(guard.retry_after_s(address))},
        )
    guard.refused(
        address,
        reason=reason or ("missing" if not supplied else "wrong"),
        route=route,
        method=method,
    )
    raise HTTPException(401, "Invalid cloud controller credential.")


def machine_item(machine: CloudMachine) -> dict:
    item = {
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
    # `vm` or `box` (V0): `serve` acts only on `vm`, the box side only on
    # `box`. An older Core sends none, and every row it has is a `vm`. With
    # hosted agents v2 off, a v1 machine's row is upstream's, with no key; a
    # box's still says `box`, so `serve` leaves it alone (tech lead, point 2).
    if process_hosted_v2() or machine.backend == "box":
        item["backend"] = machine.backend
    return item


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


# When this process last cleared spent enrolment codes: the clear reads each
# workspace on its own session, so it runs at most once a minute, not on every
# poll. A code lives 15 minutes, so its copy outlives it by a minute at most.
_codes_cleared_at: datetime | None = None
CODES_CLEAR_EVERY = timedelta(minutes=1)


def _codes_due(now: datetime) -> bool:
    global _codes_cleared_at
    if _codes_cleared_at is not None and now - _codes_cleared_at < CODES_CLEAR_EVERY:
        return False
    _codes_cleared_at = now
    return True


async def _ask_for_waiting_boxes(
    factory: async_sessionmaker[AsyncSession],
    candidates: list[CloudMachine],
    being_made: frozenset[str],
    config: SwitchConfig,
    settings: HostedControllerSettings,
    now: datetime,
) -> None:
    """V0: ask again for boxes a cap held back, or a crash missed, between the
    claim and its request. Only for machines still starting, whose owner isn't
    paused and is still on the lists in a workspace they're turned on in; a
    machine that has ever run, or has a box, is skipped by the request itself."""
    for machine in candidates:
        if machine.id in being_made or machine.state not in {"provisioning", "queued"}:
            continue
        if machine.desired_state != "running" or machine.backend != "box":
            continue
        # The gates are checked by the request itself (security).
        await ask_for_box(
            factory, machine_id=machine.id, config=config, settings=settings, now=now
        )


@router.get("/machines")
async def machines(
    session: Annotated[AsyncSession, Depends(controller_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
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
    v2 = process_hosted_v2()
    if not v2:
        # The v1/v2 switch: with v2 off, no v2 box runs. Each is stopped as
        # asleep, its data kept, so a message wakes it once v2 is on again.
        for candidate in candidates:
            if candidate.backend != "box" or candidate.desired_state != "running":
                continue
            machine = await store.locked(session, candidate.id)
            if (
                machine is not None
                and machine.backend == "box"
                and machine.desired_state == "running"
            ):
                store.stop(machine, "idle", now)
                logger.info(
                    "Cloud machine %s: a v2 box, stopped while hosted agents v2 is off.",
                    machine.id,
                )
            await session.commit()
    # V0: a machine whose box is still being made is left alone: its start
    # clocks run from the box's existence, not the claim.
    being_made = await open_provision_machines(session, now) if v2 else frozenset()
    for candidate in candidates:
        if candidate.id in being_made:
            continue
        if not v2 and candidate.backend == "box":
            # With v2 off, a v2 box is only kept stopped (above): never retained,
            # expired or deleted, so its data stays until v2 is on again. The box
            # scaler scales a box down only for `stopped`, so a box retained in
            # this same pass would also be left running.
            continue
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
    if v2 and _codes_due(now):
        # Stored enrolment codes live no longer than the codes (security). A v2
        # box's only: a v1 machine's are kept, as upstream (sweep row 17).
        for candidate in candidates:
            if candidate.backend == "box":
                await clear_spent_codes(factory, candidate.id, now)
    if box_provisioning_on(config):
        await expire_provisions(session, now)
        await session.commit()
        await _ask_for_waiting_boxes(
            factory, candidates, being_made, config, settings, now
        )
    rows = await session.scalars(
        select(CloudMachine)
        .where(CloudMachine.state != "deleted")
        .order_by(CloudMachine.created_at)
        .execution_options(populate_existing=True)
    )
    response: dict = {"machines": [machine_item(machine) for machine in rows]}
    # For the operator only (this route takes the controller's token): the
    # server lets every workspace and account claim a machine. Absent when
    # either list narrows it; owners' routes never carry it.
    if v2 and open_to_all(settings, config.hosted_launch_capacity):
        response["open_to_all"] = True
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
    v2 = process_hosted_v2()
    if not v2 and machine.backend == "box":
        # The v1/v2 switch: with v2 off, no v2 box boots or enrols.
        raise HTTPException(409, MACHINES_DISABLED)
    now = datetime.now(UTC)
    controllers = []
    # Why each served workspace got no controller, when it was a V3 block.
    blocked_reasons: list[StopReason] = []
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
                # Paused, or turned off in this workspace (visibility V3): no
                # controller and no enrollment code, so nothing new can connect.
                blocked = (
                    await block_reason_in(scoped, machine.owner_id, workspace.tenant_id)
                    if v2
                    else None
                )
                if blocked is not None:
                    logger.info(
                        "Cloud machine %s: no controller in workspace %s (%s).",
                        machine.id,
                        workspace.tenant_id,
                        blocked.value,
                    )
                    blocked_reasons.append(blocked)
                    continue
                row = await workspace_on(scoped, machine.id)
                assert row is not None
                controller = await live_controller(scoped, row)
                try:
                    code = (
                        None
                        if controller is not None
                        else await enrollment_code(
                            scoped,
                            row,
                            machine.revision,
                            config.keyring,
                            now,
                            # B111's fresh codes: a v2 box's only (row 16).
                            fresh=v2 and machine.backend == "box",
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
    if not controllers and blocked_reasons:
        # Paused, or turned off everywhere it serves (visibility V3): nothing
        # to boot, but the box isn't broken. It's left as it is (never marked
        # in error, which the clean-up would act on), and stays stopped.
        await session.commit()
        raise HTTPException(
            409,
            MACHINE_PAUSED
            if StopReason.PAUSED_BY_SWITCH in blocked_reasons
            else MACHINE_TURNED_OFF,
        )
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


class _UpstreamObservation(BaseModel):
    """An observation as upstream reads it, with no v2 fields."""

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


class Observation(_UpstreamObservation):
    # Boxes pushed off their machine since the operator's last accepted
    # observation (its eviction watch). Logged, counted, and kept as times in
    # the heartbeat's `box` key for V5's alerts; V2's `box_moved` for 15 minutes.
    evictions: int | None = Field(default=None, ge=0, le=1_000_000)
    # The box pod's container restarts since the last accepted observation,
    # and the node it runs on (V5's A2, V4's Boxes tab).
    restarts: int | None = Field(default=None, ge=0, le=1_000_000)
    node: str | None = Field(default=None, pattern=NODE_NAME, max_length=253)


ERROR_REPLACING_STATES = {"error", "retained", "deleting", "deleted"}

STALE_ERROR_IGNORED_STATES = {"deleted", "queued", "provisioning"}

OBSERVED_ERROR = "The cloud machine could not start. Retry it in Switch Console, or contact your administrator if it keeps failing."


def _refuse_v2_fields_while_off(body: Observation) -> None:
    """The v1/v2 switch (sweep row 14): with hosted agents v2 off, an
    observation naming v2's fields is refused as upstream refuses any unknown
    field, with the same 422 (`extra_forbidden`), before anything is read."""
    if process_hosted_v2():
        return
    v2_fields = set(Observation.model_fields) - set(_UpstreamObservation.model_fields)
    named = [name for name in body.model_fields_set if name in v2_fields]
    if named:
        raise RequestValidationError(
            [
                {
                    "type": "extra_forbidden",
                    "loc": ("body", name),
                    "msg": "Extra inputs are not permitted",
                    "input": getattr(body, name),
                }
                for name in named
            ]
        )


@router.post("/machines/{machine_id}/observation")
async def observe(
    machine_id: str,
    body: Observation,
    session: Annotated[AsyncSession, Depends(controller_session)],
) -> dict:
    _refuse_v2_fields_while_off(body)
    machine = await _locked_machine(session, machine_id)
    now = datetime.now(UTC)
    if body.evictions:
        # Real whatever the revision: the box restarted without anyone asking.
        record_evictions(body.evictions)
        logger.warning(
            "Cloud machine %s: its box was pushed off its machine %d time(s) since the last observation.",
            machine.id,
            body.evictions,
        )
        # On this cluster a box only moves by eviction, so this is V2's `box_moved` (platform),
        # remembered in memory for 15 minutes.
        recent_moves.record(machine.id, now)
    # Kept whatever the revision too: they describe the box as it is now.
    box_changed = bool(body.evictions or body.restarts or body.node is not None)
    if box_changed:
        machine.heartbeat = with_box_facts(
            machine.heartbeat,
            node=body.node,
            restarts=body.restarts,
            evictions=body.evictions,
            now=now,
        )
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
        # Box facts are kept whichever branch ran, an ignored observation too.
        if box_changed or machine.state == "error":
            await session.commit()
        return machine_item(machine)
    if machine.state == "deleted" or (
        machine.state == "error" and body.state not in ERROR_REPLACING_STATES
    ):
        if box_changed:
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


# A cluster report is at most 200 nodes and a short list of services; this is
# well above that, and is checked before anything is parsed (security, V5).
MAX_CLUSTER_REPORT_BYTES = 64 * 1024


async def _capped_body(request: Request, cap: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > cap):
        raise HTTPException(413, "The cluster report is too large.")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > cap:
            raise HTTPException(413, "The cluster report is too large.")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/cluster", dependencies=[Depends(require_hosted_v2)])
async def cluster_report(
    request: Request,
    _session: Annotated[AsyncSession, Depends(controller_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    """The operator's cluster report, every 30 s (V5, V4): each node's zone,
    memory and safety-check state, and each shared service's copies.

    Strict, capped, and never echoed: a refusal says which check failed, not
    what was sent. It's kept as the latest report for the Machines tab, and
    the machine and service alerts (A3, A4, A6) are decided on it here.
    """
    raw = await _capped_body(request, MAX_CLUSTER_REPORT_BYTES)
    try:
        report = ClusterReport.model_validate_json(raw)
    except ValidationError:
        raise HTTPException(422, "The cluster report isn't valid.") from None
    if any(service.name not in SHARED_SERVICES for service in report.services):
        raise HTTPException(422, "The cluster report names a service not on the list.")
    keep_cluster_report(report)
    written = 0
    if config.hosted_agents_enabled:
        written = await apply_verdicts(
            factory, cluster_verdicts(report), CLUSTER_CONDITIONS
        )
    return {"kept": True, "alerts_written": written}

"""Switch cloud machines, which run the agent controller.

A cloud machine is its owner's, whichever workspaces it serves
(`CloudMachine`). For each workspace it boots a `switch-agent-controller` of
its own, and enrolls it with a one-time code Core mints in that workspace and
hands over when it prepares the machine. The controller it enrolls as is
linked to the workspace's row on the machine (`MachineWorkspace.controller_id`);
the owner's managed agents placed on it run there, each as a Linux user of its
own, and its status reports are what make the machine ready.

Enrollment codes and controllers belong to agent management, which Core does
not import (`management/wiring.py` installs it here with
`set_cloud_enrollment`); Core keeps the machine side.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    AgentController,
    AgentControllerEnrollmentCode,
    CloudMachine,
    MachineWorkspace,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineStore,
    await_reconnect,
    bump_revision,
    idle_sleeping,
    workspaces_on,
)
from switch_core.gateway.dependencies import current_telemetry
from switch_core.hosted_v2 import process_hosted_v2
from switch_core.keys import Keyring
from switch_core.logging_context import STRUCTURED_FIELDS
from switch_core.observability.hosted import (
    box_summary,
    record_box_report,
    record_machine_event,
    record_provisioned,
    reports_memory,
)
from switch_core.telemetry import emit_after_commit

# How recent the machine's last status report must be for its silence to count
# as idle rather than as a machine that stopped reporting.
FRESH_HEARTBEAT = timedelta(minutes=5)

logger = logging.getLogger(__name__)


class CloudEnrollment(Protocol):
    """What agent management does for a cloud machine's controller."""

    async def machine_enrollment_code(
        self, session: AsyncSession, workspace: MachineWorkspace, now: datetime
    ) -> str:
        """A new one-time code the machine's controller for the bound workspace
        enrolls with. The caller commits."""
        ...

    async def machine_enrollment_code_live(
        self, session: AsyncSession, code: str, now: datetime
    ) -> bool:
        """Whether `code` can still enroll: unused and unexpired."""
        ...

    async def retire_machine_enrollment_code(
        self, session: AsyncSession, code: str
    ) -> None:
        """Make an unused `code` stop working. A code something already
        enrolled with is left alone: its controller depends on nothing it
        holds, and that row is the record of what it enrolled. The caller
        commits."""
        ...

    async def revoke_machine_controller(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> None:
        """Revoke a cleaned-up machine's old controller as its row is revived:
        its credential, open operations and sealed logins go, so nothing of
        the old box works again. Already revoked is fine. The caller commits."""
        ...


_enrollment: CloudEnrollment | None = None


def set_cloud_enrollment(enrollment: CloudEnrollment | None) -> None:
    global _enrollment
    _enrollment = enrollment


class CloudEnrollmentUnavailable(Exception):
    """Controller machines need agent management, and this server does not run it."""


def cloud_enrollment() -> CloudEnrollment:
    if _enrollment is None:
        raise CloudEnrollmentUnavailable(
            "Cloud machines need agent management: turn on the agent_management feature flag."
        )
    return _enrollment


async def live_controller(
    session: AsyncSession, workspace: MachineWorkspace
) -> AgentController | None:
    """The controller the machine enrolled as in the workspace, unless it was
    revoked since."""
    if workspace.controller_id is None:
        return None
    controller = await session.get(
        AgentController, workspace.controller_id, populate_existing=True
    )
    if (
        controller is None
        or controller.tenant_id != require_tenant_id()
        or controller.revoked_at is not None
    ):
        return None
    return controller


async def enrollment_code(
    session: AsyncSession,
    workspace: MachineWorkspace,
    revision: int,
    keyring: Keyring,
    now: datetime,
    *,
    fresh: bool = True,
) -> str:
    """The code the machine's controller for the workspace enrolls with at the
    machine's `revision`: the same one for every retry of a revision while it
    can still enroll, and a new one for a new revision, or once the stored one
    has expired or been used (a box whose first start comes after its code's
    15 minutes gets a fresh one, never a dead one). A new code makes the
    old unused one stop working, so a box has one live code at a time. Callers
    hold the machine's lock (`CloudMachineStore.locked`), so two at once can't
    both mint. The caller commits.

    `fresh=False` is the v1/v2 switch with v2 off: exactly as before v2, the
    stored code for the revision is reused as it is, and nothing is retired."""
    if not fresh:
        if (
            workspace.enrollment_code_revision == revision
            and workspace.enrollment_code_encrypted is not None
        ):
            return keyring.decrypt(workspace.enrollment_code_encrypted)
        code = await cloud_enrollment().machine_enrollment_code(session, workspace, now)
        workspace.enrollment_code_encrypted = keyring.encrypt(code)
        workspace.enrollment_code_revision = revision
        return code
    enrollment = cloud_enrollment()
    if (
        workspace.enrollment_code_revision == revision
        and workspace.enrollment_code_encrypted is not None
    ):
        stored = keyring.decrypt(workspace.enrollment_code_encrypted)
        if await enrollment.machine_enrollment_code_live(session, stored, now):
            return stored
        await enrollment.retire_machine_enrollment_code(session, stored)
    elif workspace.enrollment_code_encrypted is not None:
        # A new revision: the previous revision's code, if unused, stops working.
        await enrollment.retire_machine_enrollment_code(
            session, keyring.decrypt(workspace.enrollment_code_encrypted)
        )
    code = await enrollment.machine_enrollment_code(session, workspace, now)
    workspace.enrollment_code_encrypted = keyring.encrypt(code)
    workspace.enrollment_code_revision = revision
    return code


async def retire_workspace_code(
    session: AsyncSession, workspace: MachineWorkspace, keyring: Keyring
) -> None:
    """Stop the workspace's stored enrolment code working, if unused, and
    forget it, so the next `prepare` mints a fresh one. For a pause or a
    turn-off: a code from before can't enrol after a resume.
    The caller commits."""
    if workspace.enrollment_code_encrypted is None:
        return
    try:
        enrollment = cloud_enrollment()
    except CloudEnrollmentUnavailable:
        return
    await enrollment.retire_machine_enrollment_code(
        session, keyring.decrypt(workspace.enrollment_code_encrypted)
    )
    workspace.enrollment_code_encrypted = None
    workspace.enrollment_code_revision = None


async def machine_of_controller(
    session: AsyncSession, controller_id: str
) -> tuple[CloudMachine, MachineWorkspace] | None:
    """The live machine running `controller_id` for the bound workspace,
    locked, with the workspace's row on it; None for any other controller."""
    workspace = await session.scalar(
        select(MachineWorkspace).where(
            MachineWorkspace.tenant_id == require_tenant_id(),
            MachineWorkspace.controller_id == controller_id,
        )
    )
    if workspace is None:
        return None
    machine = await CloudMachineStore().locked(session, workspace.machine_id)
    if machine is None or machine.state == "deleted":
        return None
    return machine, workspace


async def enroll_revoked_again(
    session: AsyncSession, controller_id: str, now: datetime
) -> CloudMachine | None:
    """After the bound workspace's controller on a cloud machine is revoked,
    give the machine a new revision, so it is prepared again with a new code
    for that workspace and, running, relaunched on the same disk to enroll.
    The other workspaces keep their enrollment. A machine that is not meant to
    run enrolls at its next start. None for a controller on no cloud machine.
    The caller commits."""
    found = await machine_of_controller(session, controller_id)
    if found is None:
        return None
    machine, _workspace = found
    if machine.desired_state == "running":
        bump_revision(machine, now)
        await_reconnect(machine)
    return machine


def controller_reports(machine: CloudMachine) -> dict[str, dict[str, Any]]:
    """Per workspace on the machine (its `MachineWorkspace` id), what its
    controller last reported: `{at, sessions_running}`."""
    return dict((machine.heartbeat or {}).get("controllers") or {})


def workspace_reported(machine: CloudMachine, workspace_id: str) -> bool:
    """Whether the workspace's controller has reported since the machine was
    last seen starting: its agents can run."""
    report = controller_reports(machine).get(workspace_id)
    return (
        report is not None
        and machine.running_observed_at is not None
        and datetime.fromisoformat(report["at"]) > machine.running_observed_at
    )


def _reading(free: Any, total: Any) -> dict[str, int] | None:
    if isinstance(free, int) and isinstance(total, int) and total > 0:
        return {"total_bytes": total, "available_bytes": free}
    return None


DISK_SCOPES = frozenset({"workspace", "unknown"})


def _disk_reading(machine_reading: dict[str, Any], v2: bool) -> dict[str, Any] | None:
    """The disk figures, with the controller's `scope` (v2 only): "workspace"
    when they are the agents' own volume, "unknown" otherwise. Unmarked (an
    older controller) they may be its own small volume. The apps show a disk
    only for "workspace"."""
    reading: dict[str, Any] | None = _reading(
        machine_reading.get("disk_free_bytes"),
        machine_reading.get("disk_total_bytes"),
    )
    scope = machine_reading.get("disk_scope")
    if reading is not None and v2 and scope is not None:
        # Anything outside the fixed set is "unknown", as the status schema reads it.
        reading["scope"] = (
            scope if isinstance(scope, str) and scope in DISK_SCOPES else "unknown"
        )
    return reading


def _log_new_login_problems(
    machine_id: str, before: Any, summary: dict[str, Any]
) -> None:
    """One line with a fixed event name when a provider's login problem
    first shows in a machine's reports, not on every report: the provider and
    reason (fixed words) and the machine id only."""
    previous = (
        before.get("metrics", {}).get("login_problems", {})
        if isinstance(before, dict) and isinstance(before.get("metrics"), dict)
        else {}
    )
    for key in sorted(summary.get("login_problems", {})):
        if key in previous:
            continue
        provider, _, reason = key.partition(":")
        logger.warning(
            "Cloud machine %s: the %s login is %s",
            machine_id,
            provider,
            reason,
            extra={
                STRUCTURED_FIELDS: {
                    "switch": {
                        "event": "hosted.provider_login_problem",
                        "provider": provider,
                        "reason": reason,
                        "machine": machine_id,
                    }
                }
            },
        )


async def record_controller_status(
    session: AsyncSession,
    controller_id: str,
    machine_reading: dict[str, Any],
    agents: list[Any] | None = None,
    providers: list[Any] | None = None,
) -> None:
    """A status report from a cloud machine's controller is its heartbeat: it
    records the machine's disk and memory, and makes a machine that started
    at this revision ready. The caller commits.

    It also keeps the report's metrics summary beside it: counts and fixed
    words only (`observability.hosted.box_summary`), which the hosted metrics
    sampler reads. Never the report's ids or text."""
    found = await machine_of_controller(session, controller_id)
    if found is None:
        return
    machine, workspace = found
    now = datetime.now(UTC)
    sessions = machine_reading.get("sessions_running")
    reports = controller_reports(machine)
    v2 = process_hosted_v2()
    before = reports.get(workspace.id)
    summary = box_summary(
        machine_reading, agents or [], providers or [], machine.backend
    )
    _log_new_login_problems(machine.id, before, summary)
    reports[workspace.id] = {
        "at": now.isoformat(),
        "sessions_running": sessions if isinstance(sessions, int) else None,
        "metrics": summary,
    }
    if reports_memory(reports, workspace.id, now):
        record_box_report(machine_reading, machine.backend)
    machine.heartbeat = {
        # Keys this function doesn't own (the operator's `box` facts) stay.
        **((machine.heartbeat or {}) if v2 else {}),
        "disk": _disk_reading(machine_reading, v2),
        "memory": _reading(
            machine_reading.get("mem_free_bytes"),
            machine_reading.get("mem_total_bytes"),
        ),
        "controllers": reports,
    }
    machine.heartbeat_at = now
    if isinstance(sessions, int) and sessions > 0:
        machine.active_at = now
    if (
        machine.state == "provisioning"
        and machine.desired_state == "running"
        and machine.running_observed_at is not None
    ):
        machine.state = "ready"
        machine.error = None
        machine.error_code = None
        machine.updated_at = now
        # Revision 1 is the machine as first claimed: anything since (a wake, a
        # restart, a workspace joining) bumped it. Only the first is timed,
        # since nothing records when a later start began.
        new_machine = machine.revision == 1
        emit_after_commit(
            session,
            current_telemetry(),
            "cloud_machine_ready",
            {
                "new_machine": new_machine,
                "provisioning_seconds": (
                    max((now - machine.created_at).total_seconds(), 0.0)
                    if new_machine
                    else -1
                ),
            },
        )
        record_machine_event(
            session, "ready", "new" if new_machine else "restart", machine.backend
        )
        if new_machine:
            # Clamped like the telemetry above: `created_at` is the
            # database's clock, so a fast first report can read a hair negative.
            record_provisioned(
                max((now - machine.created_at).total_seconds(), 0.0),
                machine.backend,
            )


async def wake_controller_machine(
    session: AsyncSession,
    controller_id: str,
    now: datetime,
    trigger: Literal["message", "agent_placed"],
) -> CloudMachine | None:
    """The cloud machine running `controller_id`, started again if it was put
    to sleep when idle, and kept awake otherwise. A machine its owner stopped
    is left stopped. None for a controller that runs on no cloud machine. The
    caller holds no other machine lock, and commits; `trigger` is what woke
    it, for telemetry."""
    found = await machine_of_controller(session, controller_id)
    if found is None:
        return None
    machine, workspace = found
    if not process_hosted_v2():
        # The v1/v2 switch: with v2 off, exactly as before v2, and a v2 box
        # never wakes (it stays stopped, its data kept).
        if machine.backend == "box":
            return machine
        store = CloudMachineStore()
        if idle_sleeping(machine):
            store.start(machine, now)
            emit_after_commit(
                session,
                current_telemetry(),
                "cloud_machine_woken",
                {"trigger": trigger, "stopped_by": "idle"},
            )
            record_machine_event(session, "woken", trigger, machine.backend)
        elif machine.desired_state == "running":
            machine.active_at = now
        return machine
    # Paused, or turned off in this controller's workspace: a
    # message or a placement never wakes the box for it.
    from switch_core.visibility.hosted_access import block_reason_in

    if (
        await block_reason_in(session, machine.owner_id, workspace.tenant_id)
        is not None
    ):
        return machine
    store = CloudMachineStore()
    # A box stopped as `turned_off` for another workspace (its only one then,
    # since joined by this one) wakes for this one: that workspace's controller
    # stays revoked and refused, so only this workspace's agents come back.
    if idle_sleeping(machine) or machine.stop_reason == "turned_off":
        store.start(machine, now)
        emit_after_commit(
            session,
            current_telemetry(),
            "cloud_machine_woken",
            {"trigger": trigger, "stopped_by": "idle"},
        )
        record_machine_event(session, "woken", trigger, machine.backend)
    elif machine.desired_state == "running":
        machine.active_at = now
    return machine


async def wake_lifted_machine(
    session: AsyncSession, controller_id: str, now: datetime
) -> CloudMachine | None:
    """For a message to an agent whose controller is revoked: its hosted
    box, woken as `wake_controller_machine` wakes one, but only when that
    revoke was an operator's pause or an admin's turn-off (`revoked_by`).
    `wake_controller_machine` still refuses while the block holds, so this
    wakes a box only once it's lifted, and it then enrols a new controller
    with a fresh one-time code; the revoked one stays revoked. None for any
    other revoke (the owner's removal, a replaced or revived controller, or a
    path added later), or a controller on no cloud machine. The caller holds
    no other machine lock, and commits. With hosted agents v2 off, always None."""
    if not process_hosted_v2():
        return None
    controller = await session.get(
        AgentController, controller_id, populate_existing=True
    )
    if (
        controller is None
        or controller.tenant_id != require_tenant_id()
        or controller.revoked_at is None
        or controller.revoked_by not in ("pause", "turn_off")
    ):
        return None
    return await wake_controller_machine(session, controller_id, now, "message")


def controller_machine_idle(
    machine: CloudMachine, idle_after: timedelta, now: datetime
) -> bool:
    """Whether a controller machine has been idle for `idle_after`: the last
    status report of every controller it runs is recent and says no session
    runs, and neither a session nor a message addressed to its agents has kept
    it active since."""
    reports = controller_reports(machine).values()
    return (
        bool(reports)
        and all(
            report.get("sessions_running") == 0
            and now - datetime.fromisoformat(report["at"]) <= FRESH_HEARTBEAT
            for report in reports
        )
        and now - machine.active_at >= idle_after
    )


async def clear_spent_codes(
    session_factory: async_sessionmaker[AsyncSession],
    machine_id: str,
    now: datetime,
) -> int:
    """Forget each of the machine's stored enrolment codes that can no longer
    enrol: expired, used, or retired (the encrypted copy lives only as long as
    the code). Each workspace on its own session
    with it bound, its row locked so a `prepare` minting at the same moment
    can't be undone. Returns how many were cleared; commits each."""
    cleared = 0
    # The machine's workspaces through the store's own lookup, then each one's
    # row read with that workspace bound (`tenant_session`).
    for served in await workspaces_on(session_factory, machine_id):
        tenant_id = served.tenant_id
        async with tenant_session(session_factory, tenant_id) as session:
            workspace = await session.scalar(
                select(MachineWorkspace)
                .where(
                    MachineWorkspace.tenant_id == tenant_id,
                    MachineWorkspace.machine_id == machine_id,
                    MachineWorkspace.enrollment_code_encrypted.is_not(None),
                )
                .with_for_update()
            )
            if workspace is None:
                continue
            live = await session.scalar(
                select(AgentControllerEnrollmentCode.id)
                .where(
                    AgentControllerEnrollmentCode.tenant_id == tenant_id,
                    AgentControllerEnrollmentCode.machine_workspace_id == workspace.id,
                    AgentControllerEnrollmentCode.api_key_id.is_not(None),
                    AgentControllerEnrollmentCode.used_at.is_(None),
                    AgentControllerEnrollmentCode.expires_at > now,
                )
                .limit(1)
            )
            if live is None:
                workspace.enrollment_code_encrypted = None
                workspace.enrollment_code_revision = None
                cleared += 1
            await session.commit()
    return cleared


async def revoke_machine_controller(
    session: AsyncSession, tenant_id: str, controller_id: str
) -> None:
    """The revoke `CloudMachineStore.claim` takes to revive a machine.
    Raises `CloudEnrollmentUnavailable` without agent management, so a row
    whose old controller can't be revoked isn't revived."""
    await cloud_enrollment().revoke_machine_controller(
        session, tenant_id, controller_id
    )

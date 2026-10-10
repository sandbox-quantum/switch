"""Switch cloud machines, which run the agents controller.

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

from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    AgentController,
    CloudMachine,
    MachineWorkspace,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import CloudMachineStore, idle_sleeping
from switch_core.keys import Keyring

# How recent the machine's last status report must be for its silence to count
# as idle rather than as a machine that stopped reporting.
FRESH_HEARTBEAT = timedelta(minutes=5)


class CloudEnrollment(Protocol):
    """What agent management does for a cloud machine's controller."""

    async def machine_enrollment_code(
        self, session: AsyncSession, workspace: MachineWorkspace, now: datetime
    ) -> str:
        """A new one-time code the machine's controller for the bound workspace
        enrolls with. The caller commits."""
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
) -> str:
    """The code the machine's controller for the workspace enrolls with at the
    machine's `revision`: the same one for every retry of a revision, a new one
    for a new revision. The caller commits."""
    if (
        workspace.enrollment_code_revision == revision
        and workspace.enrollment_code_encrypted is not None
    ):
        return keyring.decrypt(workspace.enrollment_code_encrypted)
    code = await cloud_enrollment().machine_enrollment_code(session, workspace, now)
    workspace.enrollment_code_encrypted = keyring.encrypt(code)
    workspace.enrollment_code_revision = revision
    return code


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


async def record_controller_status(
    session: AsyncSession, controller_id: str, machine_reading: dict[str, Any]
) -> None:
    """A status report from a cloud machine's controller is its heartbeat: it
    records the machine's disk and memory, and makes a machine that started
    at this revision ready. The caller commits."""
    found = await machine_of_controller(session, controller_id)
    if found is None:
        return
    machine, workspace = found
    now = datetime.now(UTC)
    sessions = machine_reading.get("sessions_running")
    reports = controller_reports(machine)
    reports[workspace.id] = {
        "at": now.isoformat(),
        "sessions_running": sessions if isinstance(sessions, int) else None,
    }
    machine.heartbeat = {
        "disk": _reading(
            machine_reading.get("disk_free_bytes"),
            machine_reading.get("disk_total_bytes"),
        ),
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


async def wake_controller_machine(
    session: AsyncSession, controller_id: str, now: datetime
) -> CloudMachine | None:
    """The cloud machine running `controller_id`, started again if it was put
    to sleep when idle, and kept awake otherwise. A machine its owner stopped
    is left stopped. None for a controller that runs on no cloud machine. The
    caller holds no other machine lock, and commits."""
    found = await machine_of_controller(session, controller_id)
    if found is None:
        return None
    machine, _workspace = found
    store = CloudMachineStore()
    if idle_sleeping(machine):
        store.start(machine, now)
    elif machine.desired_state == "running":
        machine.active_at = now
    return machine


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

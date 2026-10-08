"""Switch cloud machines that run the agents controller.

A machine claimed with `HOSTED_MACHINE_RUNTIME=controller` boots the same
`switch-agent-controller` any machine can run, and enrolls it with a one-time
code Core mints for the machine and hands over when it prepares it. The
controller it enrolls as is linked to the machine (`controller_id`); the
owner's managed agents placed on it run there, each as a Linux user of its
own, and its status reports are what make the machine ready.

Enrollment codes and controllers belong to agent management, which Core does
not import (`management/wiring.py` installs it here with
`set_cloud_enrollment`); Core keeps the machine side.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    AgentController,
    HostedMachine,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import HostedMachineStore
from switch_core.keys import Keyring


class CloudEnrollment(Protocol):
    """What agent management does for a cloud machine's controller."""

    async def machine_enrollment_code(
        self, session: AsyncSession, machine: HostedMachine, now: datetime
    ) -> str:
        """A new one-time code the machine's controller enrolls with. The caller commits."""
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
            "Cloud machines that run the agents controller need agent management: set "
            "AGENT_MANAGEMENT_ENABLED, or HOSTED_MACHINE_RUNTIME=worker."
        )
    return _enrollment


async def live_controller(
    session: AsyncSession, machine: HostedMachine
) -> AgentController | None:
    """The controller the machine enrolled as, unless it was revoked since."""
    if machine.controller_id is None:
        return None
    controller = await session.get(
        AgentController, machine.controller_id, populate_existing=True
    )
    if (
        controller is None
        or controller.tenant_id != require_tenant_id()
        or controller.revoked_at is not None
    ):
        return None
    return controller


async def enrollment_code(
    session: AsyncSession, machine: HostedMachine, keyring: Keyring, now: datetime
) -> str:
    """The code the machine enrolls with at its current revision: the same one
    for every retry of a revision, a new one for a new revision. The caller
    commits."""
    if (
        machine.enrollment_code_revision == machine.revision
        and machine.enrollment_code_encrypted is not None
    ):
        return keyring.decrypt(machine.enrollment_code_encrypted)
    code = await cloud_enrollment().machine_enrollment_code(session, machine, now)
    machine.enrollment_code_encrypted = keyring.encrypt(code)
    machine.enrollment_code_revision = machine.revision
    return code


async def machine_of_controller(
    session: AsyncSession, controller_id: str
) -> HostedMachine | None:
    """The live machine running `controller_id`, locked; None for any other controller."""
    machine_id = await session.scalar(
        select(HostedMachine.id).where(
            HostedMachine.tenant_id == require_tenant_id(),
            HostedMachine.controller_id == controller_id,
            HostedMachine.state != "deleted",
        )
    )
    if machine_id is None:
        return None
    return await HostedMachineStore().locked(session, machine_id)


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
    machine = await machine_of_controller(session, controller_id)
    if machine is None or machine.runtime != "controller":
        return
    now = datetime.now(UTC)
    machine.heartbeat = {
        "disk": _reading(
            machine_reading.get("disk_free_bytes"),
            machine_reading.get("disk_total_bytes"),
        ),
        "memory": _reading(
            machine_reading.get("mem_free_bytes"),
            machine_reading.get("mem_total_bytes"),
        ),
    }
    machine.heartbeat_at = now
    sessions = machine_reading.get("sessions_running")
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

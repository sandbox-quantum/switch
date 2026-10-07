"""What Core knows about a cloud machine that runs the shared agent controller:
whether it is idle enough to sleep, the machine reading its controller's
status reports carry, and waking it when one of its agents is wanted.

The controller's status report is the machine's heartbeat: it says how much
disk and memory the machine has and, per agent, whether the agent is working.
A machine sleeps only on evidence, so anything Core cannot account for keeps
it awake.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    AgentController,
    AgentControllerOperation,
    AgentDefinition,
    HostedMachine,
    HostedWakeMailbox,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineStore,
    idle_sleeping,
    machine_starting,
    record_free_disk,
)
from switch_core.db.stores.hosted_mailbox_store import BUSY_STATES

QUEUED_OPERATION_STATES = ("pending", "claimed")


@dataclass(frozen=True)
class ControllerIdleEvidence:
    """Why the machine is not idle; idle when there is no reason."""

    reasons: tuple[str, ...]

    @property
    def idle(self) -> bool:
        return not self.reasons


def _parsed(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


async def controller_idle_evidence(
    session: AsyncSession,
    machine: HostedMachine,
    *,
    pending_relays: Callable[[str], int],
    report_within: timedelta,
    idle_after: timedelta,
    now: datetime,
) -> ControllerIdleEvidence:
    """Whether a machine on the agent controller is provably idle.

    Idle only when its controller reported within two report intervals,
    every agent meant to run there reported itself not busy and inactive for
    `idle_after`, nothing addressed it for as long, and no control relay,
    controller operation or wake mailbox entry waits on it. Read under the
    machine lock.
    """
    reasons: list[str] = []
    if now - machine.active_at < idle_after:
        reasons.append("recently_addressed")
    if machine.controller_id is None:
        return ControllerIdleEvidence((*reasons, "no_controller"))
    controller_id = machine.controller_id
    controller = await session.get(AgentController, controller_id)
    status = None if controller is None else controller.status
    if (
        controller is None
        or status is None
        or controller.last_seen_at is None
        or now - controller.last_seen_at > report_within * 2
    ):
        reasons.append("no_fresh_report")
        status = None
    agent_ids = list(
        await session.scalars(
            select(AgentDefinition.agent_id).where(
                AgentDefinition.tenant_id == require_tenant_id(),
                AgentDefinition.controller_id == controller_id,
                AgentDefinition.desired_state == "running",
            )
        )
    )
    if status is not None:
        activity = status.get("activity")
        if not isinstance(activity, list):
            reasons.append("activity_unreported")
        else:
            by_agent = {
                entry.get("agent_id"): entry
                for entry in activity
                if isinstance(entry, dict)
            }
            for agent_id in agent_ids:
                entry = by_agent.get(agent_id)
                if entry is None:
                    reasons.append("agent_unreported")
                    continue
                if entry.get("busy") is not False:
                    reasons.append("agent_busy")
                last = entry.get("last_activity_at")
                if last is not None:
                    at = _parsed(last)
                    if at is None or now - at < idle_after:
                        reasons.append("agent_recently_active")
    if pending_relays(controller_id) > 0:
        reasons.append("relay_pending")
    if await session.scalar(
        select(
            exists().where(
                AgentControllerOperation.tenant_id == require_tenant_id(),
                AgentControllerOperation.controller_id == controller_id,
                AgentControllerOperation.state.in_(QUEUED_OPERATION_STATES),
            )
        )
    ):
        reasons.append("operation_pending")
    if agent_ids and await session.scalar(
        select(
            exists().where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.agent_id.in_(agent_ids),
                HostedWakeMailbox.state.in_(BUSY_STATES),
            )
        )
    ):
        reasons.append("mailbox_pending")
    return ControllerIdleEvidence(tuple(dict.fromkeys(reasons)))


def _reading(free: Any, total: Any) -> dict[str, int] | None:
    if not isinstance(free, int) or not isinstance(total, int):
        return None
    return {"total_bytes": total, "available_bytes": free}


async def record_controller_heartbeat(
    session: AsyncSession, controller_id: str, status: dict[str, Any], now: datetime
) -> HostedMachine | None:
    """Keep the machine that runs ec2 controller `controller_id` as its latest
    status report describes it: its disk and memory, `disk_full` while its
    disk is nearly full, when it was last heard from, and ready once the
    instance Core saw running has reported.

    Takes the machine lock; the caller commits. None when no live machine
    runs the controller.
    """
    store = HostedMachineStore()
    candidate = await store.linking_controller(session, controller_id)
    if candidate is None:
        return None
    machine = await store.locked(session, candidate.id)
    if machine is None or machine.controller_id != controller_id:
        return None
    reading = status.get("machine")
    reading = reading if isinstance(reading, dict) else {}
    machine.heartbeat = {
        "disk": _reading(
            reading.get("disk_free_bytes"), reading.get("disk_total_bytes")
        ),
        "memory": _reading(
            reading.get("mem_free_bytes"), reading.get("mem_total_bytes")
        ),
        "sessions_running": reading.get("sessions_running"),
    }
    machine.heartbeat_at = now
    if (
        machine.state == "provisioning"
        and machine.running_observed_at is not None
        and now > machine.running_observed_at
    ):
        machine.state = "ready"
        machine.error = None
        machine.error_code = None
        machine.updated_at = now
    disk = machine.heartbeat["disk"]
    if disk is not None:
        record_free_disk(machine, disk["available_bytes"])
    return machine


async def wake_controller_machine(
    session: AsyncSession, controller_id: str, now: datetime
) -> HostedMachine | None:
    """Start the idle-sleeping machine that runs ec2 controller
    `controller_id`, and count the request as activity on an awake one.

    A machine its owner stopped, or one in error, is left as it is. Takes the
    machine lock; the caller commits. None when no live machine runs the
    controller.
    """
    store = HostedMachineStore()
    candidate = await store.linking_controller(session, controller_id)
    if candidate is None:
        return None
    machine = await store.locked(session, candidate.id)
    if machine is None or machine.controller_id != controller_id:
        return None
    if machine.state == "error":
        return machine
    if idle_sleeping(machine) or machine.desired_state == "running":
        store.start(machine, now)
    return machine


async def wake_for_placement(
    session: AsyncSession, controller_id: str, now: datetime
) -> bool:
    """Start the machine that runs ec2 controller `controller_id` for an agent
    being placed on it, and say whether the placement may wait for it.

    It may while the machine is idle-sleeping or already starting: its
    controller is not reporting because the machine is down, and it pulls
    its assignment when it reconnects. A machine its owner stopped, one in
    error, or one that is up while its controller is silent may not. Takes
    the machine lock; the caller commits.
    """
    store = HostedMachineStore()
    candidate = await store.linking_controller(session, controller_id)
    if candidate is None:
        return False
    machine = await store.locked(session, candidate.id)
    if (
        machine is None
        or machine.controller_id != controller_id
        or machine.state == "error"
        or not (idle_sleeping(machine) or machine_starting(machine))
    ):
        return False
    store.start(machine, now)
    return True

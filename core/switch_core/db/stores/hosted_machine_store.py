from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal, cast
from uuid import uuid4

from sqlalchemy import exists, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    AgentDefinition,
    HostedMachine,
    require_tenant_id,
)

MACHINE_CONNECT_TIMEOUT = timedelta(minutes=10)
MACHINE_NEEDS_ATTENTION = (
    "Your cloud machine needs attention. Retry it in Switch Console."
)
MACHINE_NEEDS_ADMIN = (
    "Your cloud machine needs attention. Contact your server administrator."
)
MACHINE_BEING_REMOVED = (
    "Your previous cloud machine is being removed. Try again in a minute."
)


class HostedMachineConflict(Exception):
    """A machine cannot take the requested change; the message is the 409 detail."""


async def _advisory_lock(session: AsyncSession, key: str) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": key},
    )


async def lock_claims(session: AsyncSession) -> None:
    """The tenant-wide lock taken before claiming a machine."""
    await _advisory_lock(session, f"hosted-launches:{require_tenant_id()}")


async def lock_machine(session: AsyncSession, machine_id: str) -> None:
    """The per-machine lock, taken after the tenant lock."""
    await _advisory_lock(session, f"hosted-machine:{require_tenant_id()}:{machine_id}")


def idle_sleeping(machine: HostedMachine) -> bool:
    return machine.desired_state == "stopped" and machine.stop_reason == "idle"


def owner_stopped(machine: HostedMachine) -> bool:
    return machine.desired_state == "stopped" and machine.stop_reason == "owner"


def machine_starting(machine: HostedMachine) -> bool:
    return machine.desired_state == "running" and machine.state in {
        "queued",
        "provisioning",
        "stopping",
        "stopped",
        "retained",
    }


def retention_expired(machine: HostedMachine, now: datetime) -> bool:
    return (
        machine.desired_state == "retained"
        and machine.retain_until is not None
        and machine.retain_until <= now
    )


def claim_conflict(machine: HostedMachine, now: datetime) -> str | None:
    """The reason a live machine cannot be claimed, or None when it can."""
    if machine.state == "error" and machine.error_code == "machine_needs_attention":
        return MACHINE_NEEDS_ADMIN
    if (
        machine.desired_state == "deleted"
        or machine.state == "deleting"
        or (machine.state == "error" and retention_expired(machine, now))
    ):
        return MACHINE_BEING_REMOVED
    if machine.state == "error":
        return MACHINE_NEEDS_ATTENTION
    return None


def bump_revision(machine: HostedMachine, now: datetime) -> None:
    machine.revision += 1
    machine.running_observed_at = None
    machine.updated_at = now


def await_reconnect(machine: HostedMachine) -> None:
    """Make a still-ready machine prove itself again at its new revision.

    A running observation leaves a ready machine ready, so without this a
    restart Core never saw the stop of would never re-check the heartbeat.
    """
    if machine.state == "ready":
        machine.state = "provisioning"


class HostedMachineStore:
    async def get(self, session: AsyncSession, machine_id: str) -> HostedMachine | None:
        return await session.get(
            HostedMachine, (require_tenant_id(), machine_id), populate_existing=True
        )

    async def locked(
        self, session: AsyncSession, machine_id: str
    ) -> HostedMachine | None:
        await lock_machine(session, machine_id)
        return await self.get(session, machine_id)

    async def owned(
        self, session: AsyncSession, machine_id: str, owner_id: str
    ) -> HostedMachine | None:
        return cast(
            HostedMachine | None,
            await session.scalar(
                select(HostedMachine).where(
                    HostedMachine.tenant_id == require_tenant_id(),
                    HostedMachine.id == machine_id,
                    HostedMachine.owner_id == owner_id,
                )
            ),
        )

    async def live_for_owner(
        self, session: AsyncSession, owner_id: str
    ) -> HostedMachine | None:
        return cast(
            HostedMachine | None,
            await session.scalar(
                select(HostedMachine).where(
                    HostedMachine.tenant_id == require_tenant_id(),
                    HostedMachine.owner_id == owner_id,
                    HostedMachine.state != "deleted",
                )
            ),
        )

    async def claim(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        slots: list[str],
        capacity: int,
        now: datetime,
    ) -> HostedMachine:
        """The owner's machine, reused or newly placed on a free slot.

        The caller holds `lock_claims`, so no other claim in the tenant can
        take the same slot or count towards capacity meanwhile.
        """
        tenant_id = require_tenant_id()
        machine = await self.live_for_owner(session, owner_id)
        if machine is not None:
            machine = await self.locked(session, machine.id)
        if machine is not None and machine.state != "deleted":
            if (conflict := claim_conflict(machine, now)) is not None:
                raise HostedMachineConflict(conflict)
            if machine.desired_state == "retained":
                machine.desired_state = "running"
                machine.retain_until = None
                machine.stop_reason = None
                machine.active_at = now
                bump_revision(machine, now)
                await_reconnect(machine)
            elif machine.desired_state == "stopped":
                self.start(machine, now)
            else:
                machine.active_at = now
            await session.flush()
            return machine

        used = set(
            await session.scalars(
                select(HostedMachine.slot_id).where(
                    HostedMachine.tenant_id == tenant_id,
                    HostedMachine.state != "deleted",
                )
            )
        )
        slot_id = next((slot for slot in slots if slot not in used), None)
        if len(used) >= capacity or slot_id is None:
            raise HostedMachineConflict("no machine slot available")
        generation = await session.scalar(
            select(func.max(HostedMachine.generation)).where(
                HostedMachine.tenant_id == tenant_id,
                HostedMachine.slot_id == slot_id,
            )
        )
        machine_id = str(uuid4())
        await lock_machine(session, machine_id)
        machine = HostedMachine(
            id=machine_id,
            owner_id=owner_id,
            slot_id=slot_id,
            generation=(generation or 0) + 1,
            state="queued",
            desired_state="running",
            active_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(machine)
        await session.flush()
        return machine

    def start(self, machine: HostedMachine, now: datetime) -> None:
        if machine.desired_state != "running":
            machine.desired_state = "running"
            machine.stop_reason = None
            bump_revision(machine, now)
            await_reconnect(machine)
        machine.active_at = now

    def stop(
        self,
        machine: HostedMachine,
        reason: Literal["idle", "owner"],
        now: datetime,
    ) -> None:
        machine.desired_state = "stopped"
        machine.stop_reason = reason
        bump_revision(machine, now)

    def retry(self, machine: HostedMachine, now: datetime) -> None:
        machine.state = "queued"
        machine.error = None
        machine.error_code = None
        bump_revision(machine, now)

    async def retain_if_empty(
        self,
        session: AsyncSession,
        machine: HostedMachine,
        *,
        retention_days: int,
        now: datetime,
    ) -> bool:
        """Retain the machine's disk once no managed agent is placed on its
        controller.

        Returns whether it did. The caller holds the machine lock and commits.
        """
        await session.flush()
        if await self.has_agents(session, machine):
            return False
        machine.desired_state = "retained"
        machine.stop_reason = None
        machine.retain_until = now + timedelta(days=retention_days)
        bump_revision(machine, now)
        return True

    async def release_if_empty(
        self,
        session: AsyncSession,
        machine: HostedMachine,
        *,
        retention_days: int,
        now: datetime,
    ) -> bool:
        """Retain an agentless machine, expiring at once if its controller
        never enrolled: then its disk holds nothing worth keeping. The caller
        holds the machine lock and commits.
        """
        if not await self.retain_if_empty(
            session, machine, retention_days=retention_days, now=now
        ):
            return False
        if not await self.ever_hosted(session, machine):
            machine.retain_until = now
        return True

    async def has_agents(self, session: AsyncSession, machine: HostedMachine) -> bool:
        """Whether a managed agent is still placed on the machine's controller."""
        return machine.controller_id is not None and bool(
            await session.scalar(
                select(
                    exists().where(
                        AgentDefinition.tenant_id == require_tenant_id(),
                        AgentDefinition.controller_id == machine.controller_id,
                    )
                )
            )
        )

    async def managed_agent_ids(
        self, session: AsyncSession, machine: HostedMachine
    ) -> list[str]:
        """The managed agents placed on the machine's controller."""
        if machine.controller_id is None:
            return []
        return list(
            await session.scalars(
                select(AgentDefinition.agent_id)
                .where(
                    AgentDefinition.tenant_id == require_tenant_id(),
                    AgentDefinition.controller_id == machine.controller_id,
                )
                .order_by(AgentDefinition.agent_id)
            )
        )

    async def ever_hosted(self, session: AsyncSession, machine: HostedMachine) -> bool:
        """Whether the machine's disk may hold anything worth keeping: its
        controller ever enrolled."""
        return machine.controller_id is not None

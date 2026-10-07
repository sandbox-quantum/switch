from __future__ import annotations

import secrets
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
from switch_core.gateway.cloud_controllers import CloudControllers
from switch_core.keys import Keyring

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
DISK_FULL_BELOW_BYTES = 1 << 30


class HostedMachineConflict(Exception):
    """A machine cannot take the requested change; the message is the 409 detail."""


async def _advisory_lock(session: AsyncSession, key: str) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": key},
    )


async def lock_launches(session: AsyncSession) -> None:
    """The tenant-wide lock taken before claiming a machine."""
    await _advisory_lock(session, f"hosted-launches:{require_tenant_id()}")


async def lock_machine(session: AsyncSession, machine_id: str) -> None:
    """The per-machine lock, taken after the tenant lock."""
    await _advisory_lock(session, f"hosted-machine:{require_tenant_id()}:{machine_id}")


def idle_sleeping(machine: HostedMachine) -> bool:
    return machine.desired_state == "stopped" and machine.stop_reason == "idle"


def record_free_disk(machine: HostedMachine, available_bytes: int) -> None:
    """Raise `disk_full` while the machine's disk is nearly full, unless it
    already shows another error, and clear it once there is room again."""
    if available_bytes < DISK_FULL_BELOW_BYTES:
        if machine.error_code is None:
            machine.error_code = "disk_full"
    elif machine.error_code == "disk_full":
        machine.error_code = None


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


def accepts_controller_exchange(machine: HostedMachine, instance_id: str) -> bool:
    """Whether an ec2 controller on `instance_id` may exchange its credential:
    the machine is meant to run, is starting or running, and Core has seen
    that instance as the machine's."""
    return (
        machine.desired_state == "running"
        and machine.state in {"provisioning", "ready"}
        and machine.instance_id is not None
        and secrets.compare_digest(machine.instance_id, instance_id)
    )


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

    async def linking_controller(
        self, session: AsyncSession, controller_id: str
    ) -> HostedMachine | None:
        """The live machine that runs as ec2 controller `controller_id`."""
        return cast(
            HostedMachine | None,
            await session.scalar(
                select(HostedMachine).where(
                    HostedMachine.tenant_id == require_tenant_id(),
                    HostedMachine.controller_id == controller_id,
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
        controllers: CloudControllers,
    ) -> HostedMachine:
        """The owner's machine, reused or newly placed on a free slot, linked
        to its ec2 controller.

        The caller holds `lock_launches`, so no other claim in the tenant can
        take the same slot or count towards capacity meanwhile.
        """
        machine = await self._claim(
            session, owner_id=owner_id, slots=slots, capacity=capacity, now=now
        )
        await controllers.cloud_controller(session, machine)
        await session.flush()
        return machine

    async def _claim(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        slots: list[str],
        capacity: int,
        now: datetime,
    ) -> HostedMachine:
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
            runtime="controller",
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

    def bump_agents(self, machine: HostedMachine) -> None:
        machine.agents_version += 1

    async def retain_if_empty(
        self,
        session: AsyncSession,
        machine: HostedMachine,
        *,
        retention_days: int,
        now: datetime,
    ) -> bool:
        """Retain the machine's disk once no agent is left on it.

        The machine's agents are every managed agent placed on its controller.
        Returns whether it did. The caller holds the machine lock and commits.
        """
        await session.flush()
        if machine.controller_id is not None and await session.scalar(
            select(
                exists().where(
                    AgentDefinition.tenant_id == require_tenant_id(),
                    AgentDefinition.controller_id == machine.controller_id,
                )
            )
        ):
            return False
        machine.desired_state = "retained"
        machine.stop_reason = None
        machine.retain_until = now + timedelta(days=retention_days)
        bump_revision(machine, now)
        return True

    @staticmethod
    def stored_controller_credential(
        machine: HostedMachine, keyring: Keyring
    ) -> str | None:
        """The controller credential issued at the machine's current revision,
        or None when this revision has not been issued one."""
        if (
            machine.controller_credential_revision == machine.revision
            and machine.controller_credential_encrypted is not None
        ):
            return keyring.decrypt(machine.controller_credential_encrypted)
        return None

    @staticmethod
    def store_controller_credential(
        machine: HostedMachine, credential: str, keyring: Keyring
    ) -> None:
        """Keep the credential just issued for the machine's current revision,
        so a retried prepare at that revision returns it again. The caller
        commits."""
        machine.controller_credential_encrypted = keyring.encrypt(credential)
        machine.controller_credential_revision = machine.revision

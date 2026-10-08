from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Literal, cast
from uuid import uuid4

from sqlalchemy import exists, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    AgentDefinition,
    HostedLaunch,
    HostedMachine,
    require_tenant_id,
)
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


class HostedMachineConflict(Exception):
    """A machine cannot take the requested change; the message is the 409 detail."""


def capability_hash(capability: str) -> str:
    return hashlib.sha256(capability.encode()).hexdigest()


async def _advisory_lock(session: AsyncSession, key: str) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": key},
    )


async def lock_launches(session: AsyncSession) -> None:
    """The tenant-wide lock taken before creating a launch or claiming a machine."""
    await _advisory_lock(session, f"hosted-launches:{require_tenant_id()}")


async def lock_machine(session: AsyncSession, machine_id: str) -> None:
    """The per-machine lock, taken after the tenant lock and before any launch lock."""
    await _advisory_lock(session, f"hosted-machine:{require_tenant_id()}:{machine_id}")


async def lock_launch(session: AsyncSession, launch_id: str) -> None:
    """The per-launch advisory lock every lifecycle, relay and attach step takes."""
    await _advisory_lock(session, f"hosted-launch:{require_tenant_id()}:{launch_id}")


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

    async def locked_launch(
        self, session: AsyncSession, launch_id: str
    ) -> tuple[HostedLaunch | None, HostedMachine | None]:
        """A launch and its machine, locked machine first, then launch."""
        tenant_id = require_tenant_id()
        launch = await session.get(HostedLaunch, (tenant_id, launch_id))
        if launch is None:
            return None, None
        machine_id = launch.machine_id
        if machine_id is not None:
            await lock_machine(session, machine_id)
        await lock_launch(session, launch_id)
        launch = await session.get(
            HostedLaunch, (tenant_id, launch_id), populate_existing=True
        )
        machine = None if machine_id is None else await self.get(session, machine_id)
        return launch, machine

    async def claim(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        slots: list[str],
        capacity: int,
        runtime: Literal["worker", "controller"],
        now: datetime,
    ) -> HostedMachine:
        """The owner's machine, reused or newly placed on a free slot; a new
        one runs `runtime`, a reused one keeps the runtime it was claimed with.

        The caller holds `lock_launches`, so no other claim in the tenant can
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
            runtime=runtime,
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

    async def launches(
        self, session: AsyncSession, machine_id: str
    ) -> list[HostedLaunch]:
        return list(
            await session.scalars(
                select(HostedLaunch)
                .where(
                    HostedLaunch.tenant_id == require_tenant_id(),
                    HostedLaunch.machine_id == machine_id,
                    HostedLaunch.state != "deleted",
                )
                .order_by(HostedLaunch.created_at)
            )
        )

    async def retain_if_empty(
        self,
        session: AsyncSession,
        machine: HostedMachine,
        *,
        retention_days: int,
        now: datetime,
    ) -> bool:
        """Retain the machine's disk once no agent is left on it: no launch
        on a worker machine, no managed agent placed on a controller machine's
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
        """Retain an agentless machine, expiring at once if it never had an agent.

        Launch rows are never hard-deleted, so a machine no row references has
        no disk worth keeping. The caller holds the machine lock and commits.
        """
        if not await self.retain_if_empty(
            session, machine, retention_days=retention_days, now=now
        ):
            return False
        if not await self.ever_hosted(session, machine):
            machine.retain_until = now
        return True

    async def has_agents(self, session: AsyncSession, machine: HostedMachine) -> bool:
        """Whether an agent is still meant to run on the machine."""
        if machine.runtime == "controller":
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
        return bool(
            await session.scalar(
                select(
                    exists().where(
                        HostedLaunch.tenant_id == require_tenant_id(),
                        HostedLaunch.machine_id == machine.id,
                        HostedLaunch.state != "deleted",
                        HostedLaunch.desired_state != "deleted",
                    )
                )
            )
        )

    async def managed_agent_ids(
        self, session: AsyncSession, machine: HostedMachine
    ) -> list[str]:
        """The managed agents placed on a controller machine's controller."""
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
        """Whether the machine ever had an agent whose disk is worth keeping:
        a launch row ever referenced a worker machine, deleted or not; a
        controller machine's controller ever enrolled."""
        if machine.runtime == "controller":
            return machine.controller_id is not None
        machine_id = machine.id
        return bool(
            await session.scalar(
                select(
                    exists().where(
                        HostedLaunch.tenant_id == require_tenant_id(),
                        HostedLaunch.machine_id == machine_id,
                    )
                )
            )
        )

    def issue_capability(self, machine: HostedMachine, keyring: Keyring) -> str:
        """The machine capability for the machine's current revision.

        The same bytes for every call at one revision; a new revision mints new
        ones and overwrites the old, so at most one is ever valid. The caller
        commits.
        """
        if (
            machine.machine_capability_revision == machine.revision
            and machine.machine_capability_encrypted is not None
        ):
            return keyring.decrypt(machine.machine_capability_encrypted)
        capability = secrets.token_urlsafe(32)
        machine.machine_capability_encrypted = keyring.encrypt(capability)
        machine.machine_capability_hash = capability_hash(capability)
        machine.machine_capability_revision = machine.revision
        return capability

    @staticmethod
    def capability_matches(machine: HostedMachine, capability: str) -> bool:
        """Whether `capability` is the one last issued for the machine.

        Not tied to the current revision: issuing rotates it, so the stored hash
        is the only valid one. Machine state is the caller's to check alongside.
        """
        return machine.machine_capability_hash is not None and secrets.compare_digest(
            machine.machine_capability_hash, capability_hash(capability)
        )

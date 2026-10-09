from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, cast
from uuid import uuid4

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    AgentDefinition,
    CloudMachine,
    MachineWorkspace,
    require_tenant_id,
)
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.tenant_context import tenant_scope

MACHINE_CONNECT_TIMEOUT = timedelta(minutes=10)
MACHINE_NEEDS_ATTENTION = (
    "Your cloud machine needs attention. Retry it in Switch Console."
)
MACHINE_NEEDS_ADMIN = (
    "Your cloud machine needs attention. Contact your server administrator."
)
MACHINES_FULL = "Every Switch cloud machine on this server is in use. Try again later."
MACHINE_BEING_REMOVED = (
    "Your previous cloud machine is being removed. Try again in a minute."
)
#: How many workspaces one machine serves: each runs its own agents controller.
MAX_MACHINE_WORKSPACES = 8
MACHINE_WORKSPACES_FULL = (
    f"Your cloud machine already serves {MAX_MACHINE_WORKSPACES} workspaces, the most "
    "it can. Contact your server administrator."
)


class CloudMachineConflict(Exception):
    """A machine cannot take the requested change; the message is the 409 detail."""


async def _advisory_lock(session: AsyncSession, key: str) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": key},
    )


async def lock_claims(session: AsyncSession) -> None:
    """The server-wide lock taken before claiming a machine or joining one."""
    await _advisory_lock(session, "cloud-machine-claims")


async def lock_machine(session: AsyncSession, machine_id: str) -> None:
    """The per-machine lock, taken after the claims lock."""
    await _advisory_lock(session, f"cloud-machine:{machine_id}")


@dataclass(frozen=True)
class WorkspaceOnMachine:
    """What one workspace runs on a machine, as read with that workspace bound."""

    tenant_id: str
    id: str
    controller_id: str | None
    agent_count: int


async def workspaces_on(
    factory: async_sessionmaker[AsyncSession], machine_id: str
) -> list[WorkspaceOnMachine]:
    """Every workspace the machine serves, oldest first: each read on a
    session of its own with that workspace bound, since the machine belongs
    to none of them."""
    found = []
    for tenant_id in await tenants_of_cloud_machine(factory, machine_id):
        with tenant_scope(tenant_id):
            async with factory() as session:
                workspace = await workspace_on(session, machine_id)
                if workspace is None:
                    continue
                found.append(
                    WorkspaceOnMachine(
                        tenant_id=tenant_id,
                        id=workspace.id,
                        controller_id=workspace.controller_id,
                        agent_count=len(
                            await managed_agent_ids(session, workspace.controller_id)
                        ),
                    )
                )
    return found


async def workspace_on(
    session: AsyncSession, machine_id: str
) -> MachineWorkspace | None:
    """The bound workspace's row on the machine, None when the machine does not serve it."""
    return cast(
        MachineWorkspace | None,
        await session.scalar(
            select(MachineWorkspace).where(
                MachineWorkspace.tenant_id == require_tenant_id(),
                MachineWorkspace.machine_id == machine_id,
            )
        ),
    )


async def managed_agent_ids(
    session: AsyncSession, controller_id: str | None
) -> list[str]:
    """The bound workspace's managed agents placed on `controller_id`."""
    if controller_id is None:
        return []
    return list(
        await session.scalars(
            select(AgentDefinition.agent_id)
            .where(
                AgentDefinition.tenant_id == require_tenant_id(),
                AgentDefinition.controller_id == controller_id,
            )
            .order_by(AgentDefinition.agent_id)
        )
    )


def idle_sleeping(machine: CloudMachine) -> bool:
    return machine.desired_state == "stopped" and machine.stop_reason == "idle"


def owner_stopped(machine: CloudMachine) -> bool:
    return machine.desired_state == "stopped" and machine.stop_reason == "owner"


def machine_starting(machine: CloudMachine) -> bool:
    return machine.desired_state == "running" and machine.state in {
        "queued",
        "provisioning",
        "stopping",
        "stopped",
        "retained",
    }


def retention_expired(machine: CloudMachine, now: datetime) -> bool:
    return (
        machine.desired_state == "retained"
        and machine.retain_until is not None
        and machine.retain_until <= now
    )


def claim_conflict(machine: CloudMachine, now: datetime) -> str | None:
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


def bump_revision(machine: CloudMachine, now: datetime) -> None:
    machine.revision += 1
    machine.running_observed_at = None
    machine.updated_at = now


def await_reconnect(machine: CloudMachine) -> None:
    """Make a still-ready machine prove itself again at its new revision.

    A running observation leaves a ready machine ready, so without this a
    restart Core never saw the stop of would never re-check the heartbeat.
    """
    if machine.state == "ready":
        machine.state = "provisioning"


class CloudMachineStore:
    async def get(self, session: AsyncSession, machine_id: str) -> CloudMachine | None:
        return await session.get(CloudMachine, machine_id, populate_existing=True)

    async def locked(
        self, session: AsyncSession, machine_id: str
    ) -> CloudMachine | None:
        await lock_machine(session, machine_id)
        return await self.get(session, machine_id)

    async def owned(
        self, session: AsyncSession, machine_id: str, owner_id: str
    ) -> CloudMachine | None:
        return cast(
            CloudMachine | None,
            await session.scalar(
                select(CloudMachine).where(
                    CloudMachine.id == machine_id,
                    CloudMachine.owner_id == owner_id,
                )
            ),
        )

    async def live_for_owner(
        self, session: AsyncSession, owner_id: str
    ) -> CloudMachine | None:
        return cast(
            CloudMachine | None,
            await session.scalar(
                select(CloudMachine).where(
                    CloudMachine.owner_id == owner_id,
                    CloudMachine.state != "deleted",
                )
            ),
        )

    async def claim(
        self,
        session: AsyncSession,
        factory: async_sessionmaker[AsyncSession],
        *,
        owner_id: str,
        capacity: int,
        now: datetime,
    ) -> tuple[CloudMachine, MachineWorkspace]:
        """The owner's machine, reused or newly claimed within `capacity`,
        serving the bound workspace.

        A machine joining a workspace takes a new revision, so it is prepared
        again with a controller for it. The caller holds `lock_claims`, so no
        other claim can count towards capacity or join the machine meanwhile.
        """
        machine = await self.live_for_owner(session, owner_id)
        if machine is not None:
            machine = await self.locked(session, machine.id)
        if machine is not None and machine.state != "deleted":
            if (conflict := claim_conflict(machine, now)) is not None:
                raise CloudMachineConflict(conflict)
            workspace = await workspace_on(session, machine.id)
            joined = workspace is None
            if joined:
                serving = await tenants_of_cloud_machine(factory, machine.id)
                if len(serving) >= MAX_MACHINE_WORKSPACES:
                    raise CloudMachineConflict(MACHINE_WORKSPACES_FULL)
                workspace = self._add_workspace(session, machine, now)
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
                if joined:
                    bump_revision(machine, now)
                    await_reconnect(machine)
            assert workspace is not None
            await session.flush()
            return machine, workspace

        live = await session.scalar(
            select(func.count())
            .select_from(CloudMachine)
            .where(CloudMachine.state != "deleted")
        )
        if (live or 0) >= capacity:
            raise CloudMachineConflict(MACHINES_FULL)
        machine_id = str(uuid4())
        await lock_machine(session, machine_id)
        machine = CloudMachine(
            id=machine_id,
            owner_id=owner_id,
            state="queued",
            desired_state="running",
            active_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(machine)
        await session.flush()
        workspace = self._add_workspace(session, machine, now)
        await session.flush()
        return machine, workspace

    def _add_workspace(
        self, session: AsyncSession, machine: CloudMachine, now: datetime
    ) -> MachineWorkspace:
        workspace = MachineWorkspace(
            id=str(uuid4()),
            machine_id=machine.id,
            owner_id=machine.owner_id,
            created_at=now,
        )
        session.add(workspace)
        return workspace

    def start(self, machine: CloudMachine, now: datetime) -> None:
        if machine.desired_state != "running":
            machine.desired_state = "running"
            machine.stop_reason = None
            bump_revision(machine, now)
            await_reconnect(machine)
        machine.active_at = now

    def stop(
        self,
        machine: CloudMachine,
        reason: Literal["idle", "owner"],
        now: datetime,
    ) -> None:
        machine.desired_state = "stopped"
        machine.stop_reason = reason
        bump_revision(machine, now)

    def retry(self, machine: CloudMachine, now: datetime) -> None:
        machine.state = "queued"
        machine.error = None
        machine.error_code = None
        bump_revision(machine, now)

    async def retain_if_empty(
        self,
        machine: CloudMachine,
        workspaces: list[WorkspaceOnMachine],
        *,
        retention_days: int,
        now: datetime,
    ) -> bool:
        """Retain the machine's disk once no workspace has a managed agent on it.

        Returns whether it did. The caller holds the machine lock, read
        `workspaces` under it (`workspaces_on`), and commits.
        """
        if any(workspace.agent_count for workspace in workspaces):
            return False
        machine.desired_state = "retained"
        machine.stop_reason = None
        machine.retain_until = now + timedelta(days=retention_days)
        bump_revision(machine, now)
        return True

    async def release_if_empty(
        self,
        machine: CloudMachine,
        workspaces: list[WorkspaceOnMachine],
        *,
        retention_days: int,
        now: datetime,
    ) -> bool:
        """Retain an agentless machine, expiring at once if no controller of
        it ever enrolled: then its disk holds nothing worth keeping. The caller
        holds the machine lock and commits.
        """
        if not await self.retain_if_empty(
            machine, workspaces, retention_days=retention_days, now=now
        ):
            return False
        if not ever_hosted(workspaces):
            machine.retain_until = now
        return True


def ever_hosted(workspaces: list[WorkspaceOnMachine]) -> bool:
    """Whether the machine's disk may hold anything worth keeping: a
    controller of it ever enrolled."""
    return any(workspace.controller_id is not None for workspace in workspaces)

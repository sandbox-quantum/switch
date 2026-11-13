from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, cast
from uuid import uuid4

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    AgentControllerEnrollmentCode,
    AgentDefinition,
    CloudMachine,
    MachineWorkspace,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.hosted_v2 import process_hosted_v2
from switch_core.tenant_context import tenant_scope

MACHINE_CONNECT_TIMEOUT = timedelta(minutes=10)
MACHINE_NEEDS_ATTENTION = (
    "Your cloud machine needs attention. Retry it in Switch Console."
)
MACHINE_NEEDS_ADMIN = (
    "Your cloud machine needs attention. Contact your server administrator."
)
MACHINES_FULL = "Every Switch cloud machine on this server is in use. Try again later."
MACHINE_STOPPED_BY_ADMIN = (
    "Your cloud machine was stopped by a server administrator. Contact them to "
    "have it released."
)
MACHINE_BEING_REMOVED = (
    "Your previous cloud machine is being removed. Try again in a minute."
)
#: How many workspaces one machine serves: each runs its own agent controller.
MAX_MACHINE_WORKSPACES = 8
#: The room-facing words for an operator's pause and an admin's turn-off.
#: Fixed text, never anything from the request.
MACHINE_PAUSED = "Your hosted agents are paused by Switch. Contact your admin."
MACHINE_TURNED_OFF = (
    "Hosted agents are turned off for you in this workspace. "
    "Ask your admin to turn them on."
)
MACHINE_WORKSPACES_FULL = (
    f"Your cloud machine already serves {MAX_MACHINE_WORKSPACES} workspaces, the most "
    "it can. Contact your server administrator."
)


# What a claim changed, the first of these that applies when it does two at
# once: a machine made for the owner, the owner's machine joining another
# workspace, a machine kept after its agents left running again, or a stopped
# machine started.
ClaimChange = Literal["new", "joined_workspace", "unretained", "restarted"]


@dataclass(frozen=True)
class Claimed:
    """The owner's machine as a claim left it, serving the bound workspace.
    `change` is None when the claim only marked a running machine active."""

    machine: CloudMachine
    workspace: MachineWorkspace
    change: ClaimChange | None


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


def admin_stopped(machine: CloudMachine) -> bool:
    """Whether a server administrator holds the machine stopped: neither its
    owner nor Switch may start it until they release it."""
    return machine.stop_reason == "admin"


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


async def owner_paused(session: AsyncSession, owner_id: str) -> bool:
    """Whether a Switch operator has paused this user. The mark
    is on the user, so it holds with no box, and through a box being replaced."""
    paused_at = await session.scalar(
        select(User.hosted_paused_at).where(User.id == owner_id)
    )
    return paused_at is not None


def claim_conflict(machine: CloudMachine, now: datetime) -> str | None:
    """The reason a live machine cannot be claimed, or None when it can."""
    if machine.stop_reason == "paused":
        return MACHINE_PAUSED
    if admin_stopped(machine):
        return MACHINE_STOPPED_BY_ADMIN
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


# Revokes one old controller of a revived machine, in the session given (bound
# to the controller's workspace); the caller commits. Agent management's, passed
# in by the gateway, since Core's store must not import it.
RevokeController = Callable[[AsyncSession, str, str], Awaitable[None]]


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
        revoke: RevokeController | None = None,
        backend: Literal["vm", "box"] = "vm",
    ) -> Claimed:
        """The owner's machine, reused or newly claimed within `capacity`,
        serving the bound workspace, and what the claim changed.

        With `revoke`, an owner whose machine was cleaned up gets that
        same row back, with the same id, rather than a new one: a user keeps
        one machine id for life (`_revive`). Without it, as before.
        `backend` marks a new row (box provisioning claims `box`). A revived row is always a
        `box`, and an existing live row keeps what it is.

        A machine joining a workspace takes a new revision, so it is prepared
        again with a controller for it. The caller holds `lock_claims`, so no
        other claim can count towards capacity or join the machine meanwhile.
        """
        # A paused user claims nothing, box or no box. The
        # pause is v2's: with it off, no read, as before v2.
        if process_hosted_v2() and await owner_paused(session, owner_id):
            raise CloudMachineConflict(MACHINE_PAUSED)
        machine = await self.live_for_owner(session, owner_id)
        if machine is not None:
            machine = await self.locked(session, machine.id)
        if machine is not None and machine.state != "deleted":
            if (conflict := claim_conflict(machine, now)) is not None:
                raise CloudMachineConflict(conflict)
            workspace = await workspace_on(session, machine.id)
            joined = workspace is None
            change: ClaimChange | None = "joined_workspace" if joined else None
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
                change = change or "unretained"
            elif machine.desired_state == "stopped":
                self.start(machine, now)
                change = change or "restarted"
            else:
                machine.active_at = now
                if joined:
                    bump_revision(machine, now)
                    await_reconnect(machine)
            assert workspace is not None
            await session.flush()
            return Claimed(machine=machine, workspace=workspace, change=change)

        live = await session.scalar(
            select(func.count())
            .select_from(CloudMachine)
            .where(CloudMachine.state != "deleted")
        )
        if (live or 0) >= capacity:
            raise CloudMachineConflict(MACHINES_FULL)
        if revoke is not None:
            revived = await self._revive(session, factory, owner_id, revoke, now)
            if revived is not None:
                # A new box for an owner with no live machine, as a new row is.
                machine, workspace = revived
                return Claimed(machine=machine, workspace=workspace, change="new")
        machine_id = str(uuid4())
        await lock_machine(session, machine_id)
        machine = CloudMachine(
            id=machine_id,
            owner_id=owner_id,
            state="queued",
            desired_state="running",
            backend=backend,
            active_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(machine)
        await session.flush()
        workspace = self._add_workspace(session, machine, now)
        await session.flush()
        return Claimed(machine=machine, workspace=workspace, change="new")

    async def _revive(
        self,
        session: AsyncSession,
        factory: async_sessionmaker[AsyncSession],
        owner_id: str,
        revoke: RevokeController,
        now: datetime,
    ) -> tuple[CloudMachine, MachineWorkspace] | None:
        """Bring back the owner's cleaned-up machine row, same id, to have a
        new box made for it. None when the owner has none.

        The rules: only the row's own owner revives it (the row is
        found by owner); nothing of the old box comes back (each old controller
        is revoked, so its credential, open operations and sealed logins are
        gone, and the stored code is forgotten); workspace rows stay only where
        the owner is still a member; and a `hosted.box_revived` entry records
        it. A paused owner never gets here (`claim` refuses first). Its old
        controller ids stay on the rows, revoked, so the new controller's
        enrolment moves the owner's agents across. The caller holds
        `lock_claims` and commits.
        """
        candidate = await session.scalar(
            select(CloudMachine)
            .where(CloudMachine.owner_id == owner_id, CloudMachine.state == "deleted")
            .order_by(CloudMachine.updated_at.desc())
            .limit(1)
        )
        if candidate is None:
            return None
        machine = await self.locked(session, candidate.id)
        if (
            machine is None
            or machine.state != "deleted"
            or machine.owner_id != owner_id
        ):
            return None
        for tenant_id in await tenants_of_cloud_machine(factory, machine.id):
            async with tenant_session(factory, tenant_id) as scoped:
                row = await workspace_on(scoped, machine.id)
                if row is None:
                    continue
                if row.controller_id is not None:
                    await revoke(scoped, tenant_id, row.controller_id)
                row.enrollment_code_encrypted = None
                row.enrollment_code_revision = None
                member = await scoped.get(TenantMember, (tenant_id, owner_id))
                if member is None:
                    # No link to a workspace the owner has left.
                    await scoped.execute(
                        update(AgentControllerEnrollmentCode)
                        .where(
                            AgentControllerEnrollmentCode.tenant_id == tenant_id,
                            AgentControllerEnrollmentCode.machine_workspace_id
                            == row.id,
                        )
                        .values(machine_workspace_id=None)
                    )
                    await scoped.execute(
                        delete(MachineWorkspace).where(
                            MachineWorkspace.tenant_id == tenant_id,
                            MachineWorkspace.id == row.id,
                        )
                    )
                await scoped.commit()
        machine.state = "queued"
        machine.desired_state = "running"
        # Revived for the box provisioner to make a box.
        machine.backend = "box"
        machine.stop_reason = None
        machine.retain_until = None
        machine.instance_type = None
        machine.instance_id = None
        machine.data_volume_id = None
        machine.heartbeat = None
        machine.heartbeat_at = None
        machine.first_ready_at = None
        machine.error = None
        machine.error_code = None
        machine.active_at = now
        bump_revision(machine, now)
        workspace = await workspace_on(session, machine.id)
        if workspace is None:
            workspace = self._add_workspace(session, machine, now)
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_REVIVED,
            target_type="box",
            target_id=_keyed_box(machine.id),
            details={"by": "core", "machine_id": machine.id},
        )
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
        # An operator's pause holds: nothing starts the box until a resume
        # clears it, whichever path asks.
        if machine.stop_reason == "paused":
            raise CloudMachineConflict(MACHINE_PAUSED)
        if admin_stopped(machine):
            raise CloudMachineConflict(MACHINE_STOPPED_BY_ADMIN)
        if machine.desired_state != "running":
            machine.desired_state = "running"
            machine.stop_reason = None
            bump_revision(machine, now)
            await_reconnect(machine)
        machine.active_at = now

    def stop(
        self,
        machine: CloudMachine,
        reason: Literal["idle", "owner", "paused", "turned_off", "admin"],
        now: datetime,
    ) -> None:
        # Only an administrator's release lifts their stop, only an operator's
        # resume clears a pause, and only turning the person on clears a
        # turn-off: no other stop replaces any of them. An administrator's stop
        # replaces either, and a pause may replace a turn-off.
        if admin_stopped(machine) and reason != "admin":
            return
        if machine.stop_reason == "paused" and reason not in ("paused", "admin"):
            return
        if machine.stop_reason == "turned_off" and reason not in (
            "paused",
            "turned_off",
            "admin",
        ):
            return
        machine.desired_state = "stopped"
        machine.stop_reason = reason
        bump_revision(machine, now)

    def admin_stop(self, machine: CloudMachine, now: datetime) -> None:
        """Hold the machine stopped until an administrator releases it. A
        retained machine stays retained, its disk kept, and cannot be claimed.
        The caller holds the machine lock and commits."""
        if admin_stopped(machine):
            raise CloudMachineConflict(
                "The cloud machine is already stopped by an administrator."
            )
        if machine.desired_state == "deleted" or machine.state in {
            "deleting",
            "deleted",
        }:
            raise CloudMachineConflict(
                f"The cloud machine is being deleted ({machine.state}); it cannot be stopped."
            )
        if machine.desired_state == "retained":
            machine.stop_reason = "admin"
            machine.updated_at = now
            return
        self.stop(machine, "admin", now)

    def admin_release(self, machine: CloudMachine, now: datetime) -> None:
        """Lift an administrator's stop: a stopped machine stays stopped, as
        if its owner had stopped it, until its owner starts it again. A machine
        in error is retried, since its error is usually the isolation the
        administrator has just undone; if the cause remains, the hosted
        controller reports the error again. The caller holds the machine lock
        and commits."""
        if not admin_stopped(machine):
            raise CloudMachineConflict(
                "The cloud machine was not stopped by an administrator."
            )
        machine.stop_reason = "owner" if machine.desired_state == "stopped" else None
        machine.updated_at = now
        if machine.state == "error":
            self.retry(machine, now)

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
        # A paused, turned-off or administrator-stopped machine stays as it was
        # left: clean-up never retains it, so its disk never expires.
        if machine.stop_reason in ("paused", "turned_off", "admin"):
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


def _keyed_box(machine_id: str) -> str | None:
    """The box's keyed id, as the box provisioning entries carry it; None before a
    key is loaded (a test that builds no app)."""
    # Imported here: visibility reads this store, so it can't be imported at
    # the top without a cycle.
    from switch_core.visibility.dependencies import process_keyed_id_key
    from switch_core.visibility.keyed_id import KeyedIdKind

    key = process_keyed_id_key()
    return None if key is None else key.keyed_id(KeyedIdKind.BOX, machine_id)

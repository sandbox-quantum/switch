from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, cast
from uuid import uuid4

from sqlalchemy import delete, func, literal_column, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    AgentControllerEnrollmentCode,
    AgentDefinition,
    CloudMachine,
    HostedMigration,
    HostedPoolBox,
    MachineWorkspace,
    ServerAuditEvent,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.tenant_context import tenant_scope

MACHINE_CONNECT_TIMEOUT = timedelta(minutes=10)
MACHINE_NEEDS_ATTENTION = (
    "Your cloud machine needs attention. Retry it in Switch Console."
)
MACHINE_NEEDS_ADMIN = (
    "Your cloud machine needs attention. Contact your server administrator."
)
MACHINES_FULL = "Every Switch Cloud machine on this server is in use. Try again later."
WORKSPACE_MACHINES_FULL = (
    "Every cloud machine this workspace may have is in use. Try again later, "
    "or ask your administrator."
)
MACHINE_SUSPENDED = (
    "This account is suspended. Contact your workspace admin or the server's operator."
)
MACHINE_STOPPED_BY_ADMIN = (
    "Your cloud machine was stopped by a server administrator. Contact them to "
    "have it released."
)
MACHINE_BEING_REMOVED = (
    "Your previous cloud machine is being removed. Try again in a minute."
)
#: How many workspaces one machine serves: each runs its own agent controller.
logger = logging.getLogger(__name__)

MAX_MACHINE_WORKSPACES = 8
#: The room-facing words for an operator's pause and an admin's turn-off.
#: Fixed text, never anything from the request.
MACHINE_PAUSED = "Your hosted agents are paused by Switch. Contact your admin."
MACHINE_TURNED_OFF = (
    "Hosted agents are turned off for you in this workspace. "
    "Ask your admin to turn them on."
)
#: While an operator moves the person's v1 machine to a v2 box (the
#: migration's freeze): fixed text, as above.
MACHINE_MIGRATING = (
    "Your hosted agents are being moved to a new machine. They'll be back shortly."
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
    # A new machine that took a warm pool box (its id is the pool box's).
    from_pool: bool = False


# No box removal was ever claimed for the machine (`visibility.box_removal`).
_NO_REMOVAL_CLAIMED = ~(
    select(ServerAuditEvent.id)
    .where(
        ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REMOVAL_CLAIMED.value,
        # Written as the removal index's own expression, so it's used.
        ServerAuditEvent.details.op("->>")(literal_column("'machine_id'"))
        == CloudMachine.id,
    )
    .exists()
)


def _not_removed() -> tuple:
    """The revival filter for a box removal."""
    return (_NO_REMOVAL_CLAIMED,)


# A machine whose warm pool bind failed (`box_provision.fail_bind`): deleted at
# once, never revived, so the person's next click gets a new machine.
BIND_FAILED = "bind_failed"


# The warm pool's pick inside a claim (`box_provision.claim_pool_box`): given
# the claim's session, the owner and the time, the id of a pool box it claimed
# for them (the new machine's id), or None for a box made from scratch.
PoolPick = Callable[[AsyncSession, str, datetime], Awaitable[str | None]]


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


async def _pool_boxes_counted(session: AsyncSession) -> int:
    """The warm pool's boxes that count towards the launch capacity and the
    box ceiling: requested and waiting (a claimed one is its machine's)."""
    counted = await session.scalar(
        select(func.count())
        .select_from(HostedPoolBox)
        .where(HostedPoolBox.state.in_(["requested", "waiting"]))
    )
    return counted or 0


class VmRowRefused(RuntimeError):
    """A claim tried to make or revive a v1 machine, which nothing may."""


def _only_boxes(machine: CloudMachine) -> None:
    """Hosted agents v1 is frozen: its machines keep running, but no claim
    makes a new one or revives a deleted one. Every machine a claim writes is
    a box; anything else is a bug, refused before it reaches the database.

    The one exception anywhere is `flip_back`, the migration's operator-only,
    audited rollback: it puts a migrated person's own machine back on their own
    retained v1 disk, and never makes a fresh one. `test_box_cluster` pins that
    no other code writes a `vm` machine."""
    if machine.backend != "box":
        raise VmRowRefused(
            f"A claim may only make a box, not a {machine.backend!r} machine."
        )


async def _refuse_if_workspace_full(session: AsyncSession, per_workspace: int) -> None:
    """Refuse a claim when the bound workspace already has `per_workspace`
    live boxes serving it (0: no limit). v1 machines aren't counted: they're
    frozen, and no new one is made. Counted on the workspace's own rows, read
    with it bound, under the caller's `lock_claims`."""
    if per_workspace <= 0:
        return
    serving = await session.scalar(
        select(func.count())
        .select_from(MachineWorkspace)
        .join(CloudMachine, CloudMachine.id == MachineWorkspace.machine_id)
        .where(
            MachineWorkspace.tenant_id == require_tenant_id(),
            CloudMachine.state != "deleted",
            CloudMachine.backend == "box",
        )
    )
    if (serving or 0) >= per_workspace:
        from switch_core.observability.hosted import record_claim_refused

        logger.warning(
            "A cloud machine claim was refused: workspace %s has %d live machines, "
            "its per-workspace limit.",
            _keyed_workspace(require_tenant_id()) or "(no keyed-id key)",
            serving,
        )
        record_claim_refused("workspace_full")
        raise CloudMachineConflict(WORKSPACE_MACHINES_FULL)


#: The steps a move has finished at: anything else is a move under way.
MOVE_FINISHED = frozenset({"done", "rolled_back", "cleaned"})
#: The steps at which the move holds the machine stopped (`migration`): the v1
#: machine frozen, or the box held for the copy.
MOVE_HOLD_STEPS = frozenset(
    {"freezing", "frozen", "snapshot", "holding", "held", "copy_failed", "copied"}
)


async def owner_moving(session: AsyncSession, owner_id: str) -> bool:
    """Whether an operator is moving this person's machine to a box: a move
    started and not yet done, rolled back or cleaned up. Their machine takes no
    new workspace until it ends, whatever its stop reason at the moment (the
    box runs unheld for its first start)."""
    step = await session.scalar(
        select(HostedMigration.step).where(HostedMigration.owner_id == owner_id)
    )
    return step is not None and step not in MOVE_FINISHED


async def move_holds(session: AsyncSession, owner_id: str) -> bool:
    """Whether this person's move is at a step where it holds their machine
    stopped (`MOVE_HOLD_STEPS`)."""
    step = await session.scalar(
        select(HostedMigration.step).where(HostedMigration.owner_id == owner_id)
    )
    return step in MOVE_HOLD_STEPS


async def owner_suspended(session: AsyncSession, owner_id: str) -> bool:
    """Whether the owner's account is suspended (`accounts/suspension.py`):
    their box is stopped as `suspended` and nothing starts, wakes or
    reconnects it until the suspension is lifted."""
    suspended_at = await session.scalar(
        select(User.suspended_at).where(User.id == owner_id)
    )
    return suspended_at is not None


async def suspend_box(
    session: AsyncSession, owner_id: str, now: datetime
) -> str | None:
    """Stop the owner's live box at once as their account is suspended:
    wanted stopped, `stop_reason` `suspended` (which no other stop but an
    administrator's replaces, and nothing starts), and a new revision, so the
    box scaler scales it to 0 on its next pass. Only a hosted agents v2 box:
    a v1 machine's controller is already refused and disconnected by the
    suspension. Returns the box's id, or None when there's none. The caller
    holds no other machine lock and commits."""
    store = CloudMachineStore()
    machine = await store.live_for_owner(session, owner_id)
    if machine is None or machine.backend != "box":
        return None
    machine = await store.locked(session, machine.id)
    if machine is None or machine.state == "deleted":
        return None
    if machine.stop_reason != "suspended":  # a re-run changes nothing
        store.stop(machine, "suspended", now)
    return machine.id


async def lift_box_suspension(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    owner_id: str,
    now: datetime,
) -> None:
    """When the owner's suspension is lifted, a box stopped for it stays
    stopped, held by whatever still holds it (`held_after_suspension`), or
    otherwise asleep (`idle`), so the next message wakes it through every gate
    again. The caller holds no other machine lock and commits."""
    store = CloudMachineStore()
    machine = await store.live_for_owner(session, owner_id)
    if machine is None:
        return
    machine = await store.locked(session, machine.id)
    if machine is not None and machine.stop_reason == "suspended":
        machine.stop_reason = await held_after_suspension(
            session, factory, machine.id, owner_id
        )
        machine.updated_at = now


async def held_after_suspension(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    machine_id: str,
    owner_id: str,
) -> Literal["paused", "migration", "turned_off", "idle"]:
    """The stop reason a box takes back when its owner's suspension is lifted:
    a suspension replaced a pause, a move's hold or a turn-off, and lifting it
    must not leave the box wakeable while one of those still applies. A pause
    first (it replaces both others), then a move holding the box, then a
    turn-off in every workspace the box serves (as a turn-off stops a box only
    when no other workspace needs it); otherwise `idle`."""
    if await owner_paused(session, owner_id):
        return "paused"
    if await move_holds(session, owner_id):
        return "migration"
    tenants = await tenants_of_cloud_machine(factory, machine_id)
    if not tenants:
        return "idle"
    for tenant_id in tenants:
        async with tenant_session(factory, tenant_id) as scoped:
            member = await scoped.get(TenantMember, (tenant_id, owner_id))
            if member is None or member.hosted_enabled is not False:
                return "idle"
    return "turned_off"


def claim_conflict(machine: CloudMachine, now: datetime) -> str | None:
    """The reason a live machine cannot be claimed, or None when it can."""
    if machine.stop_reason == "suspended":
        return MACHINE_SUSPENDED
    if machine.stop_reason == "paused":
        return MACHINE_PAUSED
    if admin_stopped(machine):
        return MACHINE_STOPPED_BY_ADMIN
    if machine.stop_reason == "migration":
        return MACHINE_MIGRATING
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


async def revoke_box_controllers(
    factory: async_sessionmaker[AsyncSession],
    machine: CloudMachine,
    workspaces: list[WorkspaceOnMachine],
    revoke: RevokeController,
) -> list[str]:
    """A hosted agents v2 box being deleted keeps its disk, and the disk holds
    its controller credential, so each of its workspace controllers is
    revoked, in its own workspace: Core forgets the credential and its own
    copy of the sealed logins, and a copy on the disk is refused. Already
    revoked is fine. A v1 machine's disk goes with it, so it's left as before.
    Returns the controller ids it revoked. Each workspace commits its own."""
    if machine.backend != "box":
        return []
    revoked: list[str] = []
    for workspace in workspaces:
        if workspace.controller_id is None:
            continue
        async with tenant_session(factory, workspace.tenant_id) as scoped:
            await revoke(scoped, workspace.tenant_id, workspace.controller_id)
            await scoped.commit()
        revoked.append(workspace.controller_id)
    return revoked


async def box_deleted(
    session: AsyncSession, machine: CloudMachine, now: datetime
) -> None:
    """A box machine wanted deleted whose box is at 0 counts as deleted: the
    box scaler never deletes a box, so this is the box's equivalent of a v1
    machine's terminate. Its disk is still in the cluster, so a durable
    `hosted.box_to_remove` entry names it for the removal step: the machine
    id and the owner's keyed id only. The caller holds the machine's lock and
    commits."""
    machine.state = "deleted"
    machine.error = None
    # A failed warm pool bind's mark stays, so the row is never revived.
    if machine.error_code != BIND_FAILED:
        machine.error_code = None
    machine.updated_at = now
    await _box_removal_entry(session, machine, ServerAuditAction.HOSTED_BOX_TO_REMOVE)


async def _box_removal_entry(
    session: AsyncSession, machine: CloudMachine, action: ServerAuditAction
) -> None:
    """A `hosted.box_to_remove` entry or its cancel, both with the same
    target and details: the machine id and the owner's keyed id only."""
    from switch_core.visibility.dependencies import process_keyed_id_key
    from switch_core.visibility.keyed_id import KeyedIdKind

    key = process_keyed_id_key()
    details: dict[str, str] = {"machine_id": machine.id}
    if key is not None:
        details["user"] = key.keyed_id(KeyedIdKind.USER, machine.owner_id)
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=action,
        target_type="box",
        target_id=_keyed_box(machine.id),
        details=details,
    )


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
        revoke: RevokeController,
        per_workspace: int,
        pool_pick: PoolPick | None,
    ) -> Claimed:
        """The owner's machine, reused or newly claimed within `capacity`,
        serving the bound workspace, and what the claim changed.

        An owner whose machine was cleaned up gets that same row back, with the
        same id, rather than a new one: a user keeps one machine id for life
        (`_revive`), its old controllers revoked through `revoke`. A new or
        revived row is always a box: no v1 machine is ever made. A live v1
        machine keeps serving its owner, joined and started as before.

        A machine joining a workspace takes a new revision, so it is prepared
        again with a controller for it. The caller holds `lock_claims`, so no
        other claim can count towards capacity or join the machine meanwhile.

        `per_workspace` (`hosted_launch_capacity_per_workspace`; 0 for none) caps the live machines serving the bound workspace: a new
        machine, or one joining this workspace, is refused at it.

        `pool_pick` (the warm pool's T1) runs only where a brand-new `box`
        row would be inserted, after every check above: an owner with a live
        or revivable row never takes a pool box. When it claims one, the new
        row takes the pool box's id, in this same transaction, so the claim,
        its audit entry and its bind request commit with the row or not at all.
        """
        # A person whose machine is being moved to a box claims nothing: a
        # workspace joining mid-move would be one the move didn't plan for.
        if await owner_moving(session, owner_id):
            raise CloudMachineConflict(MACHINE_MIGRATING)
        machine = await self.live_for_owner(session, owner_id)
        if machine is not None:
            machine = await self.locked(session, machine.id)
        # Pause and suspension are powers over boxes: a paused or suspended
        # person gets no box, while their v1 machine serves them as before.
        if machine is None or machine.state == "deleted" or machine.backend == "box":
            if await owner_paused(session, owner_id):
                raise CloudMachineConflict(MACHINE_PAUSED)
            if await owner_suspended(session, owner_id):
                raise CloudMachineConflict(MACHINE_SUSPENDED)
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
                if machine.backend == "box":
                    await _refuse_if_workspace_full(session, per_workspace)
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

        # Boxes only: v1 machines are frozen, and `capacity` is for boxes.
        live = await session.scalar(
            select(func.count())
            .select_from(CloudMachine)
            .where(CloudMachine.state != "deleted", CloudMachine.backend == "box")
        )
        # The warm pool's waiting and requested boxes count towards the
        # capacity too: they're machines made, or being made, for people.
        pooled = await _pool_boxes_counted(session)
        full = (live or 0) + pooled >= capacity
        picked: str | None = None
        if full:
            # Taking a waiting pool box adds nothing (it's counted already),
            # so a full server can still give one to someone who would get a
            # new row; never to an owner whose row would be revived.
            if pool_pick is None or await self._revivable(session, owner_id):
                raise CloudMachineConflict(MACHINES_FULL)
            await _refuse_if_workspace_full(session, per_workspace)
            picked = await pool_pick(session, owner_id, now)
            if picked is None:
                raise CloudMachineConflict(MACHINES_FULL)
        else:
            await _refuse_if_workspace_full(session, per_workspace)
            revived = await self._revive(session, factory, owner_id, revoke, now)
            if revived is not None:
                # A new box for an owner with no live machine, as a new
                # row is.
                machine, workspace = revived
                return Claimed(machine=machine, workspace=workspace, change="new")
        if picked is None and pool_pick is not None:
            picked = await pool_pick(session, owner_id, now)
        machine_id = picked or str(uuid4())
        await lock_machine(session, machine_id)
        machine = CloudMachine(
            id=machine_id,
            owner_id=owner_id,
            state="queued",
            desired_state="running",
            backend="box",
            active_at=now,
            created_at=now,
            updated_at=now,
        )
        _only_boxes(machine)
        session.add(machine)
        await session.flush()
        workspace = self._add_workspace(session, machine, now)
        await session.flush()
        return Claimed(
            machine=machine,
            workspace=workspace,
            change="new",
            from_pool=picked is not None,
        )

    async def _revivable(self, session: AsyncSession, owner_id: str) -> bool:
        """Whether the owner has a cleaned-up row `_revive` would bring back."""
        found = await session.scalar(
            select(CloudMachine.id)
            .where(
                CloudMachine.owner_id == owner_id,
                CloudMachine.state == "deleted",
                CloudMachine.error_code.is_distinct_from(BIND_FAILED),
                *_not_removed(),
            )
            .limit(1)
        )
        return found is not None

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
            .where(
                CloudMachine.owner_id == owner_id,
                CloudMachine.state == "deleted",
                # A warm pool claim whose bind failed is never brought back:
                # its box is reaped or removed, and the person starts afresh.
                CloudMachine.error_code.is_distinct_from(BIND_FAILED),
                # Nor is a box whose removal was claimed: its namespace may
                # already be listed for the remover, or gone.
                *_not_removed(),
            )
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
        # Again under the machine's lock, which a removal claim also takes: a
        # claim that won the race keeps the row deleted.
        from switch_core.visibility.box_removal import removal_claimed

        if await removal_claimed(session, machine.id):
            return None
        if machine.backend == "box":
            # Its disk is in use again: withdraw `box_deleted`'s entry, in
            # this same transaction, so nobody removes a live box's disk.
            await _box_removal_entry(
                session, machine, ServerAuditAction.HOSTED_BOX_TO_REMOVE_CANCELLED
            )
        await self._forget_controllers(factory, machine.id, owner_id, revoke)
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
        _only_boxes(machine)
        await session.flush()
        return machine, workspace

    async def _forget_controllers(
        self,
        factory: async_sessionmaker[AsyncSession],
        machine_id: str,
        owner_id: str,
        revoke: RevokeController,
    ) -> None:
        """Nothing of the machine's old controllers comes back: each is
        revoked (its credential, open operations and sealed logins go), each
        stored code is forgotten, and a workspace row stays only where the
        owner is still a member. The revoked ids stay on the rows, so the next
        controller to enrol moves the owner's agents across. Each workspace
        commits in its own scoped session. Shared by `_revive` and the
        migration's `flip_to_box` and `flip_back` (the same
        conditions)."""
        for tenant_id in await tenants_of_cloud_machine(factory, machine_id):
            async with tenant_session(factory, tenant_id) as scoped:
                row = await workspace_on(scoped, machine_id)
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

    async def flip_to_box(
        self,
        session: AsyncSession,
        factory: async_sessionmaker[AsyncSession],
        machine: CloudMachine,
        owner_id: str,
        revoke: RevokeController,
        now: datetime,
    ) -> None:
        """The migration's step 4: the person's frozen v1 machine row becomes
        a box, same id, for the box provisioner to make. The revive variant that
        starts from a stopped `vm` row rather than a `deleted` one.

        Refused unless the row is the person's own, a `vm`, frozen for the
        move (desired and observed `stopped`, `stop_reason` `migration`). The
        v1 controller stops listing a `box`, and leaves its stopped VM and
        disk as they are (the controller's own tests). The caller holds the
        machine lock and the migration's, has recorded the v1 values a
        rollback needs, and commits.
        """
        if (
            machine.owner_id != owner_id
            or machine.backend != "vm"
            or machine.desired_state != "stopped"
            or machine.state != "stopped"
            or machine.stop_reason != "migration"
        ):
            raise CloudMachineConflict("The machine isn't frozen for the move.")
        await self._forget_controllers(factory, machine.id, owner_id, revoke)
        await self._set_moving_from(factory, machine.id, hold=True)
        machine.backend = "box"
        machine.state = "queued"
        machine.desired_state = "running"
        machine.stop_reason = None
        machine.retain_until = None
        machine.instance_type = None
        machine.instance_id = None
        machine.data_volume_id = None
        machine.heartbeat = None
        machine.heartbeat_at = None
        machine.running_observed_at = None
        # A new box: its first ready counts as new, with its provisioning time.
        machine.first_ready_at = None
        machine.error = None
        machine.error_code = None
        machine.active_at = now
        bump_revision(machine, now)
        # The same entry a revival writes, so the box provisioner asks for a box
        # for a machine whose v1 controllers once enrolled (`box_provision`).
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_REVIVED,
            target_type="box",
            target_id=_keyed_box(machine.id),
            details={"by": "migration", "machine_id": machine.id},
        )
        await session.flush()

    async def flip_back(
        self,
        session: AsyncSession,
        factory: async_sessionmaker[AsyncSession],
        machine: CloudMachine,
        owner_id: str,
        revoke: RevokeController,
        *,
        instance_id: str | None,
        data_volume_id: str,
        instance_type: str | None,
        now: datetime,
    ) -> None:
        """The migration's rollback: the person's box, once stopped for it,
        becomes their `vm` again, with the v1 machine's disk, and starts. The
        box's controllers are revoked as `flip_to_box` revoked the v1 ones,
        and no old v1 controller comes back: the v1 machine enrols afresh with
        a new code and the agents move back. With that code in its boot data,
        the v1 controller starts a new VM on the same disk (the controller's
        own tests). The caller holds the locks and commits.
        """
        if (
            machine.owner_id != owner_id
            or machine.backend != "box"
            or machine.desired_state != "stopped"
            or machine.state != "stopped"
            or machine.stop_reason != "migration"
        ):
            raise CloudMachineConflict("The box isn't stopped for the rollback.")
        await self._forget_controllers(factory, machine.id, owner_id, revoke)
        await self._set_moving_from(factory, machine.id, hold=False)
        machine.backend = "vm"
        machine.state = "queued"
        machine.desired_state = "running"
        machine.stop_reason = None
        machine.retain_until = None
        machine.instance_id = instance_id
        machine.data_volume_id = data_volume_id
        machine.instance_type = instance_type
        machine.heartbeat = None
        machine.heartbeat_at = None
        machine.running_observed_at = None
        machine.error = None
        machine.error_code = None
        machine.active_at = now
        bump_revision(machine, now)
        await session.flush()

    async def release_hold(
        self,
        session: AsyncSession,
        factory: async_sessionmaker[AsyncSession],
        machine: CloudMachine,
        owner_id: str,
        revoke: RevokeController,
        now: datetime,
    ) -> None:
        """The migration's release, once the copy is verified: the box's
        first-start controllers are revoked and their codes forgotten, each
        workspace's v1 controller goes back as its `controller_id`, and the box
        starts. It enrols with a fresh code, and the enrolment moves the
        owner's agents from that v1 controller, ids kept. Refused unless the
        box is the person's, held stopped for the move. The caller holds the
        locks and commits."""
        if (
            machine.owner_id != owner_id
            or machine.backend != "box"
            or machine.desired_state != "stopped"
            or machine.state != "stopped"
            or machine.stop_reason != "migration"
        ):
            raise CloudMachineConflict("The box isn't held for the move.")
        await self._forget_controllers(factory, machine.id, owner_id, revoke)
        await self._set_moving_from(factory, machine.id, hold=False)
        machine.stop_reason = None
        self.start(machine, now)
        await session.flush()

    async def _set_moving_from(
        self,
        factory: async_sessionmaker[AsyncSession],
        machine_id: str,
        *,
        hold: bool,
    ) -> None:
        """`hold`: keep each workspace's current (v1) controller as the one the
        agents stay on, so no enrolment moves them meanwhile. Otherwise put it
        back as `controller_id`, so the next enrolment moves them from it."""
        for tenant_id in await tenants_of_cloud_machine(factory, machine_id):
            async with tenant_session(factory, tenant_id) as scoped:
                row = await workspace_on(scoped, machine_id)
                if row is None:
                    continue
                if hold:
                    if row.moving_from_controller_id is None:
                        row.moving_from_controller_id = row.controller_id
                elif row.moving_from_controller_id is not None:
                    row.controller_id = row.moving_from_controller_id
                    row.moving_from_controller_id = None
                await scoped.commit()

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
        # clears it, whichever path asks. So does a suspension, until it's
        # lifted.
        if machine.stop_reason == "suspended":
            raise CloudMachineConflict(MACHINE_SUSPENDED)
        if machine.stop_reason == "paused":
            raise CloudMachineConflict(MACHINE_PAUSED)
        if admin_stopped(machine):
            raise CloudMachineConflict(MACHINE_STOPPED_BY_ADMIN)
        # Nor does anything start a machine frozen for the move to a box: only
        # the migration itself clears that.
        if machine.stop_reason == "migration":
            raise CloudMachineConflict(MACHINE_MIGRATING)
        if machine.desired_state != "running":
            machine.desired_state = "running"
            machine.stop_reason = None
            bump_revision(machine, now)
            await_reconnect(machine)
        machine.active_at = now

    def stop(
        self,
        machine: CloudMachine,
        reason: Literal[
            "idle", "owner", "paused", "turned_off", "admin", "migration", "suspended"
        ],
        now: datetime,
    ) -> None:
        # Only an administrator's release lifts their stop, only an operator's
        # resume clears a pause, only turning the person on clears a
        # turn-off, and only lifting a suspension clears that: no other stop
        # replaces any of them. An administrator's stop replaces each, and a
        # suspension replaces a pause or a turn-off.
        if admin_stopped(machine) and reason != "admin":
            return
        if machine.stop_reason == "suspended" and reason not in ("suspended", "admin"):
            return
        if machine.stop_reason == "paused" and reason not in (
            "paused",
            "admin",
            "suspended",
        ):
            return
        # A migration's freeze holds the same way: only a pause, a suspension
        # or an administrator's stop replaces it (and the move then refuses to
        # carry on).
        if machine.stop_reason == "migration" and reason not in (
            "paused",
            "admin",
            "migration",
            "suspended",
        ):
            return
        if machine.stop_reason == "turned_off" and reason not in (
            "paused",
            "turned_off",
            "admin",
            "suspended",
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

    def admin_release(
        self, machine: CloudMachine, now: datetime, *, move_holds: bool
    ) -> None:
        """Lift an administrator's stop: a stopped machine stays stopped, as
        if its owner had stopped it, until its owner starts it again. When
        `move_holds` (`move_holds()`: a move to a box holds this machine at its
        current step), the move's hold comes back instead, so nothing but the
        move starts it and the move can carry on. A machine in error is
        retried, since its error is usually the isolation the administrator has
        just undone; if the cause remains, the hosted controller reports the
        error again. The caller holds the machine lock and commits."""
        if not admin_stopped(machine):
            raise CloudMachineConflict(
                "The cloud machine was not stopped by an administrator."
            )
        if move_holds:
            machine.stop_reason = "migration"
        else:
            machine.stop_reason = (
                "owner" if machine.desired_state == "stopped" else None
            )
        machine.updated_at = now
        if machine.state == "error":
            self.retry(machine, now)

    def retry(self, machine: CloudMachine, now: datetime) -> None:
        # A box Core marked as not made, or whose start Core gave up on and
        # stopped, was stopped by Core, not by anyone (no stop reason): Retry
        # wants it running again. A stop someone made
        # (owner, idle, admin, pause, turn-off) is left as it is.
        stopped_by_core = ("box_not_made",) + (
            # The late-start stop (hosted agents v2's boxes only).
            ("machine_needs_attention", "machine_connect_timeout", "no_room")
            if machine.backend == "box"
            else ()
        )
        if (
            machine.error_code in stopped_by_core
            and machine.desired_state == "stopped"
            and machine.stop_reason is None
        ):
            machine.desired_state = "running"
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
        # Nor does a v1 machine frozen for the move: retaining would end its VM,
        # which a rollback needs.
        if machine.stop_reason in (
            "paused",
            "turned_off",
            "admin",
            "migration",
            "suspended",
        ):
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


def _keyed_workspace(tenant_id: str) -> str | None:
    """The workspace's keyed id, for a log line; None before a key is loaded."""
    from switch_core.visibility.dependencies import process_keyed_id_key
    from switch_core.visibility.keyed_id import KeyedIdKind

    key = process_keyed_id_key()
    return None if key is None else key.keyed_id(KeyedIdKind.WORKSPACE, tenant_id)


def _keyed_box(machine_id: str) -> str | None:
    """The box's keyed id, as the box provisioning entries carry it; None before a
    key is loaded (a test that builds no app)."""
    # Imported here: visibility reads this store, so it can't be imported at
    # the top without a cycle.
    from switch_core.visibility.dependencies import process_keyed_id_key
    from switch_core.visibility.keyed_id import KeyedIdKind

    key = process_keyed_id_key()
    return None if key is None else key.keyed_id(KeyedIdKind.BOX, machine_id)

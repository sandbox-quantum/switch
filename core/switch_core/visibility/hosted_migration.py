"""Moving one person from their v1 machine to a v2 box.

An operator moves a person's v1 machine (an EC2 VM and its disk) to a v2 box
in place: the person's one machine row turns from `vm` into `box`, same id, and
the box provisioner makes the box. Everything a rollback needs is kept on the
person's `hosted_migrations` row. The steps, each run once and recorded:

1. **Freeze** (`freezing`): stop the v1 machine with `stop_reason` `migration`.
   Nothing else starts it again, and the idle clean-up never retains it, so
   its VM survives for a rollback. **Frozen** (`frozen`) once the v1
   controller reports it stopped.
2. **Snapshot** (`snapshot`): the id of the safety snapshot of its disk, taken
   outside Core, is recorded.
3. **Flip** (`flipped`): the row becomes a box (`flip_to_box`, the revive
   variant): the v1 controllers are revoked and their codes forgotten, and a
   workspace stays only where the person is still a member. Each workspace
   keeps its v1 controller as the one the agents stay on, so the box takes
   none of them when it enrols. the box provisioner makes the box, which starts
   once, so its disk exists.
4. **Hold** (`holding`, then `held`): Core stops the box with `stop_reason`
   `migration`, and nothing starts it (no message, no owner, no restart)
   until the copy is verified.
5. **Copy** (`copied`, or `copy_failed` to run it again): the copy job's
   counts are recorded, only while the box is held, and only for this same
   row and owner.
6. **Release** (`released`): the box's first-start controllers are revoked,
   each workspace's v1 controller goes back, and the box starts. It enrols
   with a fresh code, and the enrolment moves the agents, ids kept.
7. **Done** (`done`): every workspace's controller has enrolled and reported.

Then the person gives their AI logins again in Console (nothing moves them).
A rollback is open until the clean-up, which only records that the window has
passed: destroying the VM, disk and snapshot is outside Core.

Every call is a dry run unless `execute` is set: it says what would happen and
changes nothing. One run at a time per person (a lock, refused at once if
held). Operators only: the caller has checked that, and the operator is the
actor of every audit entry, which carries the person's and box's keyed ids and
counts, never names, file names or anything the person wrote. v2 only.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    Agent,
    AgentController,
    AgentDefinition,
    CloudMachine,
    HostedMigration,
    SealedProviderLogin,
    TenantMember,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import (
    MOVE_FINISHED,
    CloudMachineConflict,
    CloudMachineStore,
    RevokeController,
    admin_stopped,
    workspace_on,
)
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.hosted_v2 import process_hosted_v2
from switch_core.tenant_context import no_tenant
from switch_core.visibility.box_provision import NAMESPACE_PREFIX, boxes_made
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind

#: How long the v1 VM, disk and snapshot are kept after a move.
ROLLBACK_WINDOW = timedelta(days=7)
#: An EBS snapshot id, as EC2 writes them.
SNAPSHOT_ID = re.compile(r"^snap-[0-9a-f]{8,17}$")
#: An EBS volume id, as EC2 writes them.
VOLUME_ID = re.compile(r"^vol-[0-9a-f]{8,17}$")
#: The longest a copy may report taking.
MAX_COPY_SECONDS = 7 * 24 * 3600
#: The most a copy report may claim: far beyond any one person's disk.
MAX_FILES = 50_000_000
MAX_BYTES = 64 * 1024**4

Step = Literal[
    "freezing",
    "frozen",
    "snapshot",
    "flipped",
    "holding",
    "held",
    "copy_failed",
    "copied",
    "released",
    "done",
    "rolled_back",
    "cleaned",
]
#: Steps after which the move is over; a new one may start after a rollback.
FINISHED: frozenset[str] = MOVE_FINISHED
#: Steps a rollback undoes by unfreezing the v1 machine (the row is still `vm`).
BEFORE_FLIP: frozenset[str] = frozenset({"freezing", "frozen", "snapshot"})
#: Steps a rollback undoes by turning the box back into the v1 machine.
AFTER_FLIP: frozenset[str] = frozenset(
    {"flipped", "holding", "held", "copy_failed", "copied", "released", "done"}
)
#: Steps during which Core holds the box stopped (`stop_reason` `migration`).
HELD: frozenset[str] = frozenset({"holding", "held", "copy_failed", "copied"})


class MigrationRefused(Exception):
    """The move can't take this step. `code` is fixed, for the caller to word."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class CopyReport:
    """What the copy job reports for the box it copied into: the box, the
    workspaces it copied (tenant ids, as the manifest named them), counts, the
    volume it read from (made from the snapshot) and how long it took. No file
    names. Any checksum mismatch refuses the report."""

    machine_id: str
    workspaces: tuple[str, ...]
    files: int
    bytes: int
    symlinks_skipped: int
    refused: int
    checksum_mismatches: int
    source_volume_id: str
    seconds: int


@dataclass(frozen=True)
class WorkspacePlan:
    workspace: str | None  # keyed
    still_member: bool
    agents: list[tuple[str, str]]  # (agent id, name): they move only if still a member
    providers: list[str]  # names of the AI logins given on the v1 controller


@dataclass
class Plan:
    """What a run would do, and what stands in its way. Read only."""

    person: str | None  # keyed
    box: str | None  # keyed
    step: str | None
    refusals: list[str] = field(default_factory=list)
    workspaces: list[WorkspacePlan] = field(default_factory=list)
    disk_total_bytes: int | None = None
    disk_used_bytes: int | None = None
    #: When the v1 machine last reported; its figures may be stale (rule 3).
    reported_at: datetime | None = None
    boxes_made: int | None = None
    box_ceiling: int | None = None
    next: str = ""


@dataclass(frozen=True)
class Outcome:
    executed: bool
    step_before: str | None
    step_after: str | None
    note: str


@dataclass(frozen=True)
class Manifest:
    """What the copy job copies, from Core's own record: the box and its
    namespace, the snapshot to copy from, and each still-member workspace's
    agents, by id. Only while the box is held for the copy."""

    machine_id: str
    person: str | None  # keyed
    namespace: str | None  # the box's, `agents-user-<keyed id>`
    snapshot_id: str | None
    workspaces: list[tuple[str, list[str]]]  # (tenant id, agent ids)


class HostedMigrations:
    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        config: SwitchConfig,
        *,
        revoke: RevokeController,
        box_allowed: Callable[[CloudMachine], Awaitable[bool]],
        key: KeyedIdKey | None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._factory = factory
        self._config = config
        self._revoke = revoke
        self._box_allowed = box_allowed
        self._key = key
        self._now = now
        self._store = CloudMachineStore()

    # ── reading ──────────────────────────────────────────────────────────

    async def plan(self, owner_id: str) -> Plan:
        """The dry run: the person's machine, workspaces, agents, providers,
        disk, the box ceiling and what a run would do next."""
        with no_tenant():
            async with self._factory() as session:
                record = await session.get(HostedMigration, owner_id)
                machine = await self._machine_of(session, owner_id, record)
                plan = Plan(
                    person=self._keyed(KeyedIdKind.USER, owner_id),
                    box=self._keyed(KeyedIdKind.BOX, machine.id) if machine else None,
                    step=record.step if record else None,
                    box_ceiling=self._config.hosted_box_ceiling,
                    boxes_made=await boxes_made(session),
                )
                if machine is not None:
                    disk = (machine.heartbeat or {}).get("disk") or {}
                    plan.disk_total_bytes = _int_or_none(disk.get("total_bytes"))
                    available = _int_or_none(disk.get("available_bytes"))
                    if plan.disk_total_bytes is not None and available is not None:
                        plan.disk_used_bytes = plan.disk_total_bytes - available
                    plan.reported_at = machine.heartbeat_at
        if machine is not None:
            plan.workspaces = await self._workspaces(machine.id, owner_id)
        plan.refusals = await self._refusals(owner_id, record, machine, plan)
        plan.next = _next(record, plan.refusals)
        return plan

    async def copy_manifest(self, owner_id: str) -> Manifest:
        """The agents the copy job copies, named from Core's record only."""
        with no_tenant():
            async with self._factory() as session:
                record = await session.get(HostedMigration, owner_id)
                if record is None or record.step not in ("held", "copy_failed"):
                    raise MigrationRefused(
                        "not_held", "The move isn't at the copy step."
                    )
                machine = await session.get(CloudMachine, record.machine_id)
                _require_box_of(machine, owner_id, record)
                machine_id = record.machine_id
                snapshot_id = record.snapshot_id
        workspaces = []
        for plan_tenant, agent_ids in await self._agents_by_workspace(
            machine_id, owner_id
        ):
            workspaces.append((plan_tenant, agent_ids))
        person = self._keyed(KeyedIdKind.USER, owner_id)
        return Manifest(
            machine_id=machine_id,
            person=person,
            namespace=None if person is None else f"{NAMESPACE_PREFIX}{person}",
            snapshot_id=snapshot_id,
            workspaces=workspaces,
        )

    # ── the move ─────────────────────────────────────────────────────────

    async def run(
        self,
        owner_id: str,
        *,
        operator_id: str,
        execute: bool = False,
        snapshot_id: str | None = None,
        copied: CopyReport | None = None,
        copy_failed: bool = False,
    ) -> Outcome:
        """Take the next step of the person's move, if it can be taken now.
        A dry run unless `execute`. `copy_failed` records that the copy job
        failed: the box stays held, and the copy can be run again."""
        _require_v2()
        if execute:
            self._require_key()
        plan = await self.plan(owner_id)
        if plan.refusals:
            raise MigrationRefused(plan.refusals[0], f"Refused: {plan.refusals[0]}.")
        if not execute:
            return Outcome(False, plan.step, plan.step, plan.next)
        now = self._now()
        with no_tenant():
            async with self._factory() as session:
                await self._lock(session, owner_id)
                record = await session.get(
                    HostedMigration, owner_id, with_for_update=True
                )
                if record is not None and record.step in ("done", "cleaned"):
                    await session.rollback()
                    return Outcome(True, record.step, record.step, "Nothing to do.")
                if record is None or record.step == "rolled_back":
                    return await self._freeze(
                        session, owner_id, record, operator_id, now
                    )
                machine = await self._store.locked(session, record.machine_id)
                if machine is None or machine.owner_id != owner_id:
                    raise MigrationRefused(
                        "no_machine", "The person's machine is gone."
                    )
                before = record.step
                if (copied is not None or copy_failed) and record.step not in (
                    "held",
                    "copy_failed",
                ):
                    # A copy report only while the box is held for it.
                    raise MigrationRefused(
                        "not_held", "The move isn't at the copy step."
                    )
                if record.step == "freezing":
                    if not _frozen(machine):
                        await session.rollback()
                        return Outcome(
                            True, before, before, "Waiting for the v1 machine to stop."
                        )
                    record.step = "frozen"
                elif record.step == "frozen":
                    if snapshot_id is None or not SNAPSHOT_ID.match(snapshot_id):
                        raise MigrationRefused(
                            "snapshot_needed", "Give the snapshot id of the v1 disk."
                        )
                    record.snapshot_id = snapshot_id
                    record.step = "snapshot"
                elif record.step == "snapshot":
                    if await boxes_made(session) >= self._config.hosted_box_ceiling:
                        raise MigrationRefused(
                            "box_ceiling", "The box ceiling is reached."
                        )
                    try:
                        await self._store.flip_to_box(
                            session, self._factory, machine, owner_id, self._revoke, now
                        )
                    except CloudMachineConflict as error:
                        raise MigrationRefused("not_frozen", str(error)) from None
                    record.step = "flipped"
                elif record.step == "flipped":
                    # The box has started once, so its disk exists: hold it
                    # stopped for the copy.
                    if machine.state != "ready":
                        await session.rollback()
                        return Outcome(
                            True, before, before, "Waiting for the box's first start."
                        )
                    self._store.stop(machine, "migration", now)
                    record.step = "holding"
                elif record.step == "holding":
                    if not _box_stopped(machine):
                        await session.rollback()
                        return Outcome(
                            True, before, before, "Waiting for the box to stop."
                        )
                    record.step = "held"
                elif record.step in ("held", "copy_failed"):
                    if copy_failed:
                        record.step = "copy_failed"
                    else:
                        expected = {
                            tenant
                            for tenant, _agents in await self._agents_by_workspace(
                                machine.id, owner_id
                            )
                        }
                        _check_copy(copied, record, machine, owner_id, expected)
                        assert copied is not None
                        record.files_copied = copied.files
                        record.bytes_copied = copied.bytes
                        record.symlinks_skipped = copied.symlinks_skipped
                        record.copy_refused = copied.refused
                        record.copy_seconds = copied.seconds
                        record.copy_source_volume_id = copied.source_volume_id
                        record.step = "copied"
                elif record.step == "copied":
                    try:
                        await self._store.release_hold(
                            session, self._factory, machine, owner_id, self._revoke, now
                        )
                    except CloudMachineConflict as error:
                        raise MigrationRefused("not_held", str(error)) from None
                    record.step = "released"
                elif record.step == "released":
                    if not await self._enrolled(machine.id, owner_id):
                        await session.rollback()
                        return Outcome(
                            True,
                            before,
                            before,
                            "Waiting for the box's controllers to enrol.",
                        )
                    record.step = "done"
                    record.done_at = now
                record.updated_at = now
                await self._audit(
                    session,
                    operator_id,
                    owner_id,
                    machine.id,
                    ServerAuditAction.HOSTED_MIGRATION_DONE
                    if record.step == "done"
                    else ServerAuditAction.HOSTED_MIGRATION_STEP,
                    record,
                )
                after = record.step
                await session.commit()
        return Outcome(True, before, after, f"Now {after}.")

    async def rollback(
        self, owner_id: str, *, operator_id: str, execute: bool = False
    ) -> Outcome:
        """Undo the move before its clean-up: unfreeze the v1 machine, or turn
        the box back into it on its own disk. Files written on the box are not
        copied back."""
        _require_v2()
        if execute:
            self._require_key()
        now = self._now()
        with no_tenant():
            async with self._factory() as session:
                if execute:
                    await self._lock(session, owner_id)
                record = await session.get(
                    HostedMigration, owner_id, with_for_update=execute
                )
                if record is None or record.step in ("rolled_back", "cleaned"):
                    raise MigrationRefused(
                        "nothing_to_undo", "There's no move to undo."
                    )
                machine = await self._store.locked(session, record.machine_id)
                if machine is None or machine.owner_id != owner_id:
                    raise MigrationRefused(
                        "no_machine", "The person's machine is gone."
                    )
                if record.step in AFTER_FLIP and record.v1_data_volume_id is None:
                    raise MigrationRefused("no_v1_disk", "The v1 disk wasn't recorded.")
                before = record.step
                if not execute:
                    await session.rollback()
                    return Outcome(False, before, "rolled_back", _undo_note(before))
                if before in BEFORE_FLIP:
                    if machine.backend != "vm" or machine.stop_reason != "migration":
                        raise MigrationRefused(
                            "not_frozen", "The machine isn't frozen for the move."
                        )
                    machine.stop_reason = None
                    self._store.start(machine, now)
                else:
                    assert record.v1_data_volume_id is not None
                    if not _box_stopped(machine):
                        # First the box stops, held stopped for the move, so
                        # nothing runs on it while its controller is revoked.
                        if machine.stop_reason in ("paused", "turned_off"):
                            raise MigrationRefused(
                                "blocked", "The person is paused or turned off."
                            )
                        if admin_stopped(machine):
                            raise MigrationRefused(
                                "admin_stopped",
                                "An administrator holds the machine stopped.",
                            )
                        self._store.stop(machine, "migration", now)
                        record.updated_at = now
                        await session.commit()
                        return Outcome(
                            True,
                            before,
                            before,
                            "Stopping the box first; run the rollback again once "
                            "it has stopped.",
                        )
                    try:
                        await self._store.flip_back(
                            session,
                            self._factory,
                            machine,
                            owner_id,
                            self._revoke,
                            instance_id=record.v1_instance_id,
                            data_volume_id=record.v1_data_volume_id,
                            instance_type=record.v1_instance_type,
                            now=now,
                        )
                    except CloudMachineConflict as error:
                        raise MigrationRefused("not_a_box", str(error)) from None
                record.step = "rolled_back"
                record.updated_at = now
                await self._audit(
                    session,
                    operator_id,
                    owner_id,
                    machine.id,
                    ServerAuditAction.HOSTED_MIGRATION_ROLLED_BACK,
                    record,
                    extra={"from": before},
                )
                await session.commit()
        return Outcome(True, before, "rolled_back", _undo_note(before))

    async def clean_up(
        self, owner_id: str, *, operator_id: str, execute: bool = False
    ) -> tuple[Outcome, dict[str, str | None]]:
        """After the rollback window: record that the v1 VM, disk and snapshot
        may go, and say which. Destroying them is outside Core."""
        _require_v2()
        if execute:
            self._require_key()
        now = self._now()
        with no_tenant():
            async with self._factory() as session:
                if execute:
                    await self._lock(session, owner_id)
                record = await session.get(
                    HostedMigration, owner_id, with_for_update=execute
                )
                if record is None or record.step != "done" or record.done_at is None:
                    raise MigrationRefused(
                        "not_done", "Only a finished move is cleaned up."
                    )
                if now < record.done_at + ROLLBACK_WINDOW:
                    raise MigrationRefused(
                        "window_open", "The rollback window hasn't passed yet."
                    )
                v1 = {
                    "instance_id": record.v1_instance_id,
                    "data_volume_id": record.v1_data_volume_id,
                    "snapshot_id": record.snapshot_id,
                }
                if not execute:
                    await session.rollback()
                    return Outcome(
                        False, "done", "cleaned", "Would record the clean-up."
                    ), v1
                record.step = "cleaned"
                record.updated_at = now
                await self._audit(
                    session,
                    operator_id,
                    owner_id,
                    record.machine_id,
                    ServerAuditAction.HOSTED_MIGRATION_CLEANED,
                    record,
                )
                await session.commit()
        return Outcome(True, "done", "cleaned", "Recorded."), v1

    # ── the steps' parts ─────────────────────────────────────────────────

    async def _freeze(
        self,
        session: AsyncSession,
        owner_id: str,
        record: HostedMigration | None,
        operator_id: str,
        now: datetime,
    ) -> Outcome:
        machine = await self._store.live_for_owner(session, owner_id)
        if machine is not None:
            machine = await self._store.locked(session, machine.id)
        if machine is None or machine.backend != "vm" or machine.state == "deleted":
            raise MigrationRefused("no_v1_machine", "The person has no v1 machine.")
        if machine.stop_reason in ("paused", "turned_off"):
            raise MigrationRefused("blocked", "The person is paused or turned off.")
        if admin_stopped(machine):
            raise MigrationRefused(
                "admin_stopped", "An administrator holds the machine stopped."
            )
        if machine.data_volume_id is None:
            raise MigrationRefused("no_v1_disk", "The v1 machine has no disk yet.")
        before = record.step if record else None
        if record is None:
            record = HostedMigration(owner_id=owner_id, started_at=now)
            session.add(record)
        record.machine_id = machine.id
        record.step = "freezing"
        record.v1_instance_id = machine.instance_id
        record.v1_data_volume_id = machine.data_volume_id
        record.v1_instance_type = machine.instance_type
        record.snapshot_id = None
        record.files_copied = None
        record.bytes_copied = None
        record.symlinks_skipped = None
        record.started_at = now
        record.done_at = None
        record.updated_at = now
        self._store.stop(machine, "migration", now)
        if _frozen(machine):
            record.step = "frozen"
        await self._audit(
            session,
            operator_id,
            owner_id,
            machine.id,
            ServerAuditAction.HOSTED_MIGRATION_STARTED,
            record,
        )
        await session.commit()
        return Outcome(True, before, record.step, f"Now {record.step}.")

    async def _refusals(
        self,
        owner_id: str,
        record: HostedMigration | None,
        machine: CloudMachine | None,
        plan: Plan,
    ) -> list[str]:
        refusals: list[str] = []
        if not process_hosted_v2():
            return ["v2_off"]
        if record is not None and record.step in ("done", "cleaned"):
            return refusals
        if machine is None:
            return ["no_machine"]
        starting = record is None or record.step == "rolled_back"
        if starting:
            if machine.backend != "vm":
                refusals.append("not_v1")
            if machine.stop_reason in ("paused", "turned_off"):
                refusals.append("blocked")
            if admin_stopped(machine):
                refusals.append("admin_stopped")
            if machine.data_volume_id is None:
                refusals.append("no_v1_disk")
        if starting or (record is not None and record.step == "snapshot"):
            if not await self._box_allowed(machine):
                refusals.append("box_not_allowed")
            if (plan.boxes_made or 0) >= self._config.hosted_box_ceiling:
                refusals.append("box_ceiling")
        if (
            record is not None
            and record.step in BEFORE_FLIP | HELD
            and machine.stop_reason not in ("migration",)
        ):
            # Something replaced the hold (an operator's pause or an
            # administrator's stop): stop here.
            refusals.append("freeze_replaced")
        return refusals

    async def _machine_of(
        self, session: AsyncSession, owner_id: str, record: HostedMigration | None
    ) -> CloudMachine | None:
        if record is not None and record.step not in ("rolled_back",):
            machine = await session.get(CloudMachine, record.machine_id)
            return (
                machine
                if machine is not None and machine.owner_id == owner_id
                else None
            )
        return await self._store.live_for_owner(session, owner_id)

    async def _workspaces(self, machine_id: str, owner_id: str) -> list[WorkspacePlan]:
        found = []
        for tenant_id in await tenants_of_cloud_machine(self._factory, machine_id):
            async with tenant_session(self._factory, tenant_id) as scoped:
                row = await workspace_on(scoped, machine_id)
                if row is None:
                    continue
                member = (
                    await scoped.get(TenantMember, (tenant_id, owner_id)) is not None
                )
                agents: list[tuple[str, str]] = []
                providers: list[str] = []
                placed_on = _agents_on(row)
                if placed_on is not None:
                    agents = [
                        (agent_id, name)
                        for agent_id, name in await scoped.execute(
                            select(AgentDefinition.agent_id, Agent.name)
                            .join(
                                Agent,
                                (Agent.tenant_id == AgentDefinition.tenant_id)
                                & (Agent.id == AgentDefinition.agent_id),
                            )
                            .where(
                                AgentDefinition.tenant_id == tenant_id,
                                AgentDefinition.controller_id == placed_on,
                            )
                            .order_by(AgentDefinition.agent_id)
                        )
                    ]
                    providers = sorted(
                        await scoped.scalars(
                            select(SealedProviderLogin.provider).where(
                                SealedProviderLogin.tenant_id == tenant_id,
                                SealedProviderLogin.controller_id == placed_on,
                            )
                        )
                    )
                found.append(
                    WorkspacePlan(
                        workspace=self._keyed(KeyedIdKind.WORKSPACE, tenant_id),
                        still_member=member,
                        agents=agents,
                        providers=providers,
                    )
                )
        return found

    async def _agents_by_workspace(
        self, machine_id: str, owner_id: str
    ) -> list[tuple[str, list[str]]]:
        """Each workspace still on the machine (only where the person is a
        member, after the flip) and the person's agents placed on its
        controller, by id."""
        found = []
        for tenant_id in await tenants_of_cloud_machine(self._factory, machine_id):
            async with tenant_session(self._factory, tenant_id) as scoped:
                row = await workspace_on(scoped, machine_id)
                placed_on = None if row is None else _agents_on(row)
                if placed_on is None:
                    continue
                agent_ids = list(
                    await scoped.scalars(
                        select(AgentDefinition.agent_id)
                        .where(
                            AgentDefinition.tenant_id == tenant_id,
                            AgentDefinition.controller_id == placed_on,
                            AgentDefinition.owner_id == owner_id,
                        )
                        .order_by(AgentDefinition.agent_id)
                    )
                )
                found.append((tenant_id, agent_ids))
        return found

    async def _enrolled(self, machine_id: str, owner_id: str) -> bool:
        """Every workspace on the box has a live controller that has reported,
        and none of the person's agents there is left on a revoked controller:
        they're on the new one. Read from Core's own state."""
        tenants = await tenants_of_cloud_machine(self._factory, machine_id)
        if not tenants:
            return False
        for tenant_id in tenants:
            async with tenant_session(self._factory, tenant_id) as scoped:
                row = await workspace_on(scoped, machine_id)
                if row is None or row.controller_id is None:
                    return False
                controller = await scoped.get(AgentController, row.controller_id)
                if (
                    controller is None
                    or controller.revoked_at is not None
                    or controller.status is None
                ):
                    return False
                left_behind = await scoped.scalar(
                    select(AgentDefinition.agent_id)
                    .join(
                        AgentController,
                        (AgentController.tenant_id == AgentDefinition.tenant_id)
                        & (AgentController.id == AgentDefinition.controller_id),
                    )
                    .where(
                        AgentDefinition.tenant_id == tenant_id,
                        AgentDefinition.owner_id == owner_id,
                        AgentController.revoked_at.is_not(None),
                    )
                    .limit(1)
                )
                if left_behind is not None:
                    return False
        return True

    async def _lock(self, session: AsyncSession, owner_id: str) -> None:
        held = await session.scalar(
            text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"hosted-migration:{owner_id}"},
        )
        if not held:
            raise MigrationRefused("busy", "Another run for this person is going on.")

    async def _audit(
        self,
        session: AsyncSession,
        operator_id: str,
        owner_id: str,
        machine_id: str,
        action: ServerAuditAction,
        record: HostedMigration,
        extra: dict[str, Any] | None = None,
    ) -> None:
        details: dict[str, Any] = {
            "step": record.step,
            "box": self._keyed(KeyedIdKind.BOX, machine_id),
        }
        if record.step == "copied":
            details.update(
                files=record.files_copied,
                bytes=record.bytes_copied,
                symlinks_skipped=record.symlinks_skipped,
                refused=record.copy_refused,
            )
        details.update(extra or {})
        await record_server_audit_event(
            session,
            actor_user_id=operator_id,
            action=action,
            target_type="user",
            target_id=self._keyed(KeyedIdKind.USER, owner_id),
            details=details,
        )

    def _require_key(self) -> None:
        """A change is audited under the person's and box's keyed ids, so
        without the key the record would say nothing about who was moved."""
        if self._key is None:
            raise MigrationRefused(
                "no_keyed_id_key",
                "No keyed-id key is set (VISIBILITY_KEYED_ID_KEY_PATH), so the "
                "move couldn't be audited. Set it and run again.",
            )

    def _keyed(self, kind: KeyedIdKind, raw: str) -> str | None:
        return None if self._key is None else self._key.keyed_id(kind, raw)


def _require_v2() -> None:
    if not process_hosted_v2():
        raise MigrationRefused("v2_off", "Hosted agents v2 is off on this server.")


def _frozen(machine: CloudMachine) -> bool:
    return (
        machine.backend == "vm"
        and machine.desired_state == "stopped"
        and machine.state == "stopped"
        and machine.stop_reason == "migration"
    )


def _agents_on(row: Any) -> str | None:
    """The controller the owner's agents are placed on in this workspace: the
    v1 one while the move holds them, else the current one."""
    held: str | None = row.moving_from_controller_id
    return held if held is not None else row.controller_id


def _box_stopped(machine: CloudMachine) -> bool:
    return (
        machine.backend == "box"
        and machine.desired_state == "stopped"
        and machine.state == "stopped"
        and machine.stop_reason == "migration"
    )


def _require_box_of(
    machine: CloudMachine | None, owner_id: str, record: HostedMigration
) -> None:
    if (
        machine is None
        or machine.id != record.machine_id
        or machine.owner_id != owner_id
        or machine.backend != "box"
    ):
        raise MigrationRefused("target_mismatch", "The box isn't this person's.")


def _check_copy(
    copied: CopyReport | None,
    record: HostedMigration,
    machine: CloudMachine,
    owner_id: str,
    workspaces: set[str],
) -> None:
    """The copy went into this person's own box, the one the move recorded,
    for exactly the workspaces the manifest named, and its counts
    are plausible."""
    if copied is None:
        raise MigrationRefused("copy_needed", "Give the copy job's report.")
    if copied.machine_id != record.machine_id:
        raise MigrationRefused("target_mismatch", "The copy went to another box.")
    _require_box_of(machine, owner_id, record)
    if not _box_stopped(machine):
        # Only into a box held stopped: never files under a running agent.
        raise MigrationRefused("not_held", "The box isn't held stopped for the copy.")
    if (
        not isinstance(copied.workspaces, tuple)
        or not all(isinstance(tenant, str) for tenant in copied.workspaces)
        or len(set(copied.workspaces)) != len(copied.workspaces)
        or set(copied.workspaces) != workspaces
    ):
        # Not a workspace the person has left, nor one the box doesn't serve.
        raise MigrationRefused(
            "target_mismatch", "The copy's workspaces aren't the manifest's."
        )
    for value, ceiling in (
        (copied.files, MAX_FILES),
        (copied.bytes, MAX_BYTES),
        (copied.symlinks_skipped, MAX_FILES),
        (copied.refused, MAX_FILES),
        (copied.checksum_mismatches, MAX_FILES),
        (copied.seconds, MAX_COPY_SECONDS),
    ):
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not 0 <= value <= ceiling
        ):
            raise MigrationRefused(
                "bad_report", "The copy report's counts aren't valid."
            )
    if copied.checksum_mismatches != 0:
        raise MigrationRefused(
            "checksum_mismatch", "Files didn't match their checksums: not verified."
        )
    if (
        not isinstance(copied.source_volume_id, str)
        or not VOLUME_ID.match(copied.source_volume_id)
        or copied.source_volume_id == record.v1_data_volume_id
    ):
        # A volume made from the snapshot, never the v1 disk itself.
        raise MigrationRefused("bad_report", "The copy's source volume isn't valid.")


def _next(record: HostedMigration | None, refusals: list[str]) -> str:
    if refusals:
        return "Nothing: " + ", ".join(refusals) + "."
    step = None if record is None else record.step
    return {
        None: "Freeze: stop the v1 machine for the move.",
        "rolled_back": "Freeze again: stop the v1 machine for a new move.",
        "freezing": "Wait for the v1 machine to stop, then mark it frozen.",
        "frozen": "Record the v1 disk's snapshot id.",
        "snapshot": "Turn the machine into a box; the v1 controllers are revoked.",
        "flipped": "Wait for the box's first start, then hold it stopped.",
        "holding": "Wait for the box to stop.",
        "held": "Run the copy job, then record its report.",
        "copy_failed": "Run the copy job again, then record its report.",
        "copied": "Release the box: it starts, enrols, and the agents move to it.",
        "released": "Wait for the box's controllers to enrol, then finish.",
        "done": "Nothing: the move is done. Clean up after the rollback window.",
        "cleaned": "Nothing: the move is done and cleaned up.",
    }.get(step, "Nothing.")


def _undo_note(step: str) -> str:
    if step in BEFORE_FLIP:
        return "Unfreeze the v1 machine and start it."
    return (
        "Stop the box, then turn it back into the v1 machine, on its own disk, "
        "and start it."
    )


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None

"""Moving a person from their v1 machine to a v2 box,
against Postgres. The v1 controller, the box and the copy job are outside
Core: here their reports are written to the row as they would write them, and
the copy job's report is handed in as the operator would hand it in. One test
runs the real enrolment path for the agents' move."""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.cloud_machine_admin import release_machine, stop_machine
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    AgentController,
    AgentDefinition,
    CloudMachine,
    HostedMigration,
    MachineWorkspace,
    ServerAuditEvent,
    TenantMember,
    User,
)
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_MIGRATING,
    MOVE_HOLD_STEPS,
    CloudMachineConflict,
    CloudMachineStore,
    lock_claims,
    workspace_on,
)
from switch_core.gateway.cloud_controllers import (
    revoke_machine_controller,
    set_cloud_enrollment,
    wake_controller_machine,
)
from switch_core.tenant_context import no_tenant, tenant_scope
from switch_core.visibility.hosted_migration import (
    BEFORE_FLIP,
    HELD,
    CopyReport,
    HostedMigrations,
    MigrationRefused,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from switch_core.visibility.operator_actions import ActionRefused, OperatorActions
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _enroll,
    _hosted_app,
    _prepare,
)
from tests.switch_core.hosted_machine_helpers import (
    add_tenant,
    link_controller,
    place_managed_agent,
    seed_machine,
)
from tests.switch_core.management.harness import (
    TENANT_ZERO_ID,
    Harness,
    add_member,
    build_harness,
)

pytestmark = pytest.mark.usefixtures("hosted_v2_on")

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")
VOLUME = "vol-0123456789abcdef0"
INSTANCE = "i-0123456789abcdef0"
SNAPSHOT = "snap-0123456789abcdef0"
# The rest of a copy report: the volume made from the snapshot, never the v1
# disk, and no mismatches.
COPY: dict[str, Any] = {
    "refused": 0,
    "checksum_mismatches": 0,
    "source_volume_id": "vol-0fedcba9876543210",
    "seconds": 42,
}


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


class FakeRevoke:
    """Core's controller revoke, faked: it marks the controller revoked and
    records which, in which workspace."""

    def __init__(self) -> None:
        self.revoked: list[tuple[str, str]] = []

    async def __call__(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> None:
        self.revoked.append((tenant_id, controller_id))
        controller = await session.get(AgentController, controller_id)
        if controller is not None and controller.revoked_at is None:
            controller.revoked_at = datetime.now(UTC)


class RealRevoke:
    """Core's own revoke, recording which controllers it was asked for."""

    def __init__(self) -> None:
        self.revoked: list[tuple[str, str]] = []

    async def __call__(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> None:
        self.revoked.append((tenant_id, controller_id))
        await revoke_machine_controller(session, tenant_id, controller_id)


class World:
    def __init__(
        self,
        factory: async_sessionmaker[AsyncSession],
        *,
        ceiling: int = 50,
        revoke: FakeRevoke | RealRevoke | None = None,
    ) -> None:
        self.factory = factory
        self.revoke = revoke or FakeRevoke()
        self.clock = Clock()
        self.allowed = True
        self.migrations = HostedMigrations(
            factory,
            SimpleNamespace(hosted_box_ceiling=ceiling),  # type: ignore[arg-type]
            revoke=self.revoke,
            box_allowed=self._allowed,
            key=KEY,
            now=self.clock,
        )

    async def _allowed(self, _machine: CloudMachine) -> bool:
        return self.allowed

    def revoked(self) -> list[str]:
        return [controller for _tenant, controller in self.revoke.revoked]

    async def v1_machine(
        self, owner: User, agent: str = "reviewer"
    ) -> tuple[str, str, str]:
        """A running v1 machine with an enrolled controller and one agent:
        (machine id, controller id, agent id)."""
        async with self.factory() as session:
            machine = await seed_machine(
                session,
                owner_id=owner.id,
                state="ready",
                desired_state="running",
                stop_reason=None,
                revision=3,
            )
            machine.backend = "vm"
            machine.instance_id = INSTANCE
            machine.data_volume_id = VOLUME
            machine.instance_type = "m6i.large"
            machine.heartbeat = {"disk": {"total_bytes": 100, "available_bytes": 40}}
            controller = await link_controller(session, machine)
            definition = await place_managed_agent(
                session, owner_id=owner.id, controller_id=controller.id, name=agent
            )
            await session.commit()
            return machine.id, controller.id, definition.agent_id

    async def machine(self, machine_id: str) -> CloudMachine:
        with no_tenant():
            async with self.factory() as session:
                found = await session.get(CloudMachine, machine_id)
                assert found is not None
                return found

    async def workspace(self, machine_id: str) -> MachineWorkspace:
        async with self.factory() as session:
            found = await workspace_on(session, machine_id)
            assert found is not None
            return found

    async def record(self, owner: User) -> HostedMigration:
        with no_tenant():
            async with self.factory() as session:
                found = await session.get(HostedMigration, owner.id)
                assert found is not None
                return found

    async def reports(self, machine_id: str, state: str) -> None:
        """What the v1 controller's or the box's observation writes."""
        with no_tenant():
            async with self.factory() as session:
                machine = await session.get(CloudMachine, machine_id)
                assert machine is not None
                machine.state = state
                await session.commit()

    async def box_enrols(self, machine_id: str, owner: User) -> str:
        """A box controller enrols and reports, as the enrolment does it: it
        replaces the workspace's controller, and moves the agents from the one
        it replaces unless the move is holding them there (the real path:
        `test_the_box_takes_no_agents_until_the_release`)."""
        async with self.factory() as session:
            workspace = await workspace_on(session, machine_id)
            assert workspace is not None
            controller = AgentController(
                owner_id=owner.id, name="Switch box", kind="daemon"
            )
            session.add(controller)
            await session.flush()
            controller.status = {"agents": []}
            replaced = workspace.controller_id
            if replaced is not None and replaced != workspace.moving_from_controller_id:
                await session.execute(
                    update(AgentDefinition)
                    .where(
                        AgentDefinition.tenant_id == workspace.tenant_id,
                        AgentDefinition.controller_id == replaced,
                    )
                    .values(controller_id=controller.id)
                )
            workspace.controller_id = controller.id
            await session.commit()
            return controller.id

    async def step(self, owner: User, operator: str, **extra: Any) -> str | None:
        outcome = await self.migrations.run(
            owner.id, operator_id=operator, execute=True, **extra
        )
        return outcome.step_after

    async def to_flipped(self, owner: User, machine_id: str, operator: str) -> None:
        await self.step(owner, operator)
        await self.reports(machine_id, "stopped")
        await self.step(owner, operator)
        await self.step(owner, operator, snapshot_id=SNAPSHOT)
        assert await self.step(owner, operator) == "flipped"

    async def to_held(self, owner: User, machine_id: str, operator: str) -> str:
        """Through the box's first start to held; the first-start controller's id."""
        await self.to_flipped(owner, machine_id, operator)
        first = await self.box_enrols(machine_id, owner)
        await self.reports(machine_id, "ready")
        assert await self.step(owner, operator) == "holding"
        await self.reports(machine_id, "stopped")
        assert await self.step(owner, operator) == "held"
        return first

    async def to_done(self, owner: User, machine_id: str, operator: str) -> str:
        await self.to_held(owner, machine_id, operator)
        copied = CopyReport(
            machine_id, (TENANT_ZERO_ID,), files=1, bytes=1, symlinks_skipped=0, **COPY
        )
        assert await self.step(owner, operator, copied=copied) == "copied"
        assert await self.step(owner, operator) == "released"
        await self.reports(machine_id, "ready")
        second = await self.box_enrols(machine_id, owner)
        assert await self.step(owner, operator) == "done"
        return second


async def _audit(factory: async_sessionmaker[AsyncSession]) -> list[ServerAuditEvent]:
    with no_tenant():
        async with factory() as session:
            return list(
                await session.scalars(
                    select(ServerAuditEvent)
                    .where(ServerAuditEvent.action.like("hosted.migration_%"))
                    .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
                )
            )


@pytest.fixture(autouse=True)
def _no_enrollment_left_installed() -> Iterator[None]:
    set_cloud_enrollment(None)
    yield
    set_cloud_enrollment(None)


@pytest.fixture
async def people(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, User]:
    return {
        "ada": await add_member(session_factory, "ada"),
        "op": await add_member(session_factory, "op"),
    }


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def test_the_dry_run_says_what_it_would_do_and_changes_nothing(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada = people["ada"]
    machine_id, _controller, agent_id = await world.v1_machine(ada)

    plan = await world.migrations.plan(ada.id)
    outcome = await world.migrations.run(ada.id, operator_id=people["op"].id)

    assert plan.refusals == []
    assert plan.person == KEY.keyed_id(KeyedIdKind.USER, ada.id)
    assert plan.box == KEY.keyed_id(KeyedIdKind.BOX, machine_id)
    [workspace] = plan.workspaces
    assert workspace.still_member and workspace.agents == [(agent_id, "reviewer")]
    assert (plan.disk_total_bytes, plan.disk_used_bytes) == (100, 60)
    assert plan.next.startswith("Freeze")
    assert not outcome.executed
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("running", None)
    async with session_factory() as session:
        assert await session.get(HostedMigration, ada.id) is None
    assert await _audit(session_factory) == []


async def test_a_move_runs_step_by_step_and_keeps_what_a_rollback_needs(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, v1_controller, agent_id = await world.v1_machine(ada)

    # 1. Freeze: an owner-style stop that only the move clears.
    first = await world.migrations.run(ada.id, operator_id=op, execute=True)
    assert (first.step_before, first.step_after) == (None, "freezing")
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "migration")
    record = await world.record(ada)
    assert (record.v1_instance_id, record.v1_data_volume_id) == (INSTANCE, VOLUME)
    assert record.v1_instance_type == "m6i.large"
    waiting = await world.migrations.run(ada.id, operator_id=op, execute=True)
    assert waiting.step_after == "freezing" and "Waiting" in waiting.note
    await world.reports(machine_id, "stopped")
    assert await world.step(ada, op) == "frozen"

    # 2. The snapshot id, checked.
    with pytest.raises(MigrationRefused) as refused:
        await world.step(ada, op, snapshot_id="snap-$(rm -rf)")
    assert refused.value.code == "snapshot_needed"
    assert await world.step(ada, op, snapshot_id=SNAPSHOT) == "snapshot"
    assert (await world.record(ada)).snapshot_id == SNAPSHOT

    # 3. The flip: the same row, now a box, nothing of the v1 controller left,
    # and the agents held on it.
    assert await world.step(ada, op) == "flipped"
    machine = await world.machine(machine_id)
    assert machine.backend == "box"
    assert (machine.state, machine.desired_state, machine.stop_reason) == (
        "queued",
        "running",
        None,
    )
    assert machine.instance_id is None and machine.data_volume_id is None
    assert world.revoked() == [v1_controller]
    workspace = await world.workspace(machine_id)
    assert workspace.controller_id == v1_controller
    assert workspace.moving_from_controller_id == v1_controller
    assert workspace.enrollment_code_encrypted is None
    with no_tenant():
        async with session_factory() as session:
            revived = list(
                await session.scalars(
                    select(ServerAuditEvent).where(
                        ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REVIVED
                    )
                )
            )
    # The provisioner's cue to make a box for a machine that ran before.
    assert [e.details for e in revived] == [
        {"by": "migration", "machine_id": machine_id}
    ]
    # No copy before the box is held.
    with pytest.raises(MigrationRefused):
        await world.step(
            ada,
            op,
            copied=CopyReport(
                machine_id,
                (TENANT_ZERO_ID,),
                files=1,
                bytes=1,
                symlinks_skipped=0,
                **COPY,
            ),
        )

    # 4. The box's first start makes its disk; then Core holds it stopped.
    waiting = await world.migrations.run(ada.id, operator_id=op, execute=True)
    assert "first start" in waiting.note
    first_start = await world.box_enrols(machine_id, ada)
    await world.reports(machine_id, "ready")
    assert await world.step(ada, op) == "holding"
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "migration")
    waiting = await world.migrations.run(ada.id, operator_id=op, execute=True)
    assert waiting.step_after == "holding" and "stop" in waiting.note
    await world.reports(machine_id, "stopped")
    assert await world.step(ada, op) == "held"

    # 5. The copy, for this box only, while it's held.
    manifest = await world.migrations.copy_manifest(ada.id)
    assert manifest.machine_id == machine_id
    assert manifest.snapshot_id == SNAPSHOT
    assert manifest.namespace == "agents-user-" + KEY.keyed_id(KeyedIdKind.USER, ada.id)
    assert manifest.workspaces == [(TENANT_ZERO_ID, [agent_id])]
    with pytest.raises(MigrationRefused) as refused:
        await world.step(
            ada,
            op,
            copied=CopyReport(
                "another-machine",
                (TENANT_ZERO_ID,),
                files=3,
                bytes=10,
                symlinks_skipped=0,
                **COPY,
            ),
        )
    assert refused.value.code == "target_mismatch"
    copied = CopyReport(
        machine_id, (TENANT_ZERO_ID,), files=3, bytes=10, symlinks_skipped=1, **COPY
    )
    assert await world.step(ada, op, copied=copied) == "copied"

    # 6. The release: the first-start controller goes, the v1 one comes back
    # for the next enrolment to move the agents from, and the box starts.
    assert await world.step(ada, op) == "released"
    assert world.revoked() == [v1_controller, first_start]
    workspace = await world.workspace(machine_id)
    assert workspace.controller_id == v1_controller
    assert workspace.moving_from_controller_id is None
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("running", None)

    # 7. Done once the box's controller has enrolled again and reported.
    waiting = await world.migrations.run(ada.id, operator_id=op, execute=True)
    assert waiting.step_after == "released"
    await world.box_enrols(machine_id, ada)
    assert await world.step(ada, op) == "done"
    record = await world.record(ada)
    assert record.done_at == world.clock.now
    assert (record.v1_instance_id, record.v1_data_volume_id) == (INSTANCE, VOLUME)

    entries = await _audit(session_factory)
    assert [(e.details or {})["step"] for e in entries] == [
        "freezing",
        "frozen",
        "snapshot",
        "flipped",
        "holding",
        "held",
        "copied",
        "released",
        "done",
    ]
    assert entries[0].action == ServerAuditAction.HOSTED_MIGRATION_STARTED
    assert entries[-1].action == ServerAuditAction.HOSTED_MIGRATION_DONE
    assert {e.actor_user_id for e in entries} == {op}  # the operator, every step
    assert {e.target_id for e in entries} == {KEY.keyed_id(KeyedIdKind.USER, ada.id)}
    assert entries[6].details == {
        "step": "copied",
        "box": KEY.keyed_id(KeyedIdKind.BOX, machine_id),
        "files": 3,
        "bytes": 10,
        "symlinks_skipped": 1,
        "refused": 0,
    }
    for entry in entries:  # keyed ids and counts only
        details = repr(entry.details)
        assert ada.email not in details and "reviewer" not in details
        assert machine_id not in details and VOLUME not in details


async def test_nothing_starts_or_retains_a_machine_frozen_for_the_move(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """The design's first two rules: the freeze ends at `stopped`, and Core's
    clean-up leaves a moving row alone."""
    world = World(session_factory)
    ada = people["ada"]
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await world.step(ada, people["op"].id)
    await world.reports(machine_id, "stopped")
    store = CloudMachineStore()
    now = datetime.now(UTC)
    with no_tenant():
        async with session_factory() as session:
            machine = await store.locked(session, machine_id)
            assert machine is not None
            with pytest.raises(CloudMachineConflict, match="being moved"):
                store.start(machine, now)
            store.stop(machine, "owner", now)
            store.stop(machine, "idle", now)
            assert machine.stop_reason == "migration"
            assert not await store.retain_if_empty(
                machine, [], retention_days=7, now=now
            )
            assert machine.desired_state == "stopped"
            await session.rollback()
    assert MACHINE_MIGRATING.startswith("Your hosted agents are being moved")


async def test_nothing_starts_a_box_held_for_the_copy(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """The hold: between the box's first start and the verified
    copy, no route starts it: the person's ensure and start, a message, or
    an operator's restart."""
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    first_start = await world.to_held(ada, machine_id, op)

    # The person's ensure (a claim) is refused.
    async with session_factory() as session:
        await lock_claims(session)
        with pytest.raises(CloudMachineConflict, match="being moved"):
            await CloudMachineStore().claim(
                session,
                session_factory,
                owner_id=ada.id,
                capacity=5,
                now=datetime.now(UTC),
            )
        await session.rollback()
    # The person's start, and every other action on the machine, is refused.
    machine = await world.machine(machine_id)
    async with _hosted_app(session_factory, ada) as hosted:
        for action in ("start", "stop", "retry"):
            answer = await hosted.post(
                f"/hosted-machines/{machine_id}/lifecycle",
                json={"action": action, "revision": machine.revision},
            )
            assert answer.status_code == 409, answer.text
            assert answer.json()["detail"] == MACHINE_MIGRATING
    # A message to the box's controller doesn't wake it.
    async with session_factory() as session:
        await wake_controller_machine(
            session, first_start, datetime.now(UTC), "message"
        )
        await session.commit()
    # An operator's restart is refused: the box isn't running.
    box = KEY.keyed_id(KeyedIdKind.BOX, machine_id)
    with pytest.raises(ActionRefused) as refused:
        await OperatorActions(session_factory=session_factory, key=KEY).request_restart(
            actor_id=op, box_keyed_id=box, reason="checking the hold"
        )
    assert refused.value.status == 409

    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "migration")


async def test_a_failed_copy_leaves_the_box_held_to_run_again(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await world.to_held(ada, machine_id, op)

    assert await world.step(ada, op, copy_failed=True) == "copy_failed"
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "migration")
    assert (await world.migrations.copy_manifest(ada.id)).machine_id == machine_id
    copied = CopyReport(
        machine_id, (TENANT_ZERO_ID,), files=1, bytes=1, symlinks_skipped=0, **COPY
    )
    assert await world.step(ada, op, copied=copied) == "copied"


async def test_a_rollback_before_the_flip_just_unfreezes_the_v1_machine(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await world.step(ada, op)

    dry = await world.migrations.rollback(ada.id, operator_id=op)
    assert not dry.executed
    assert (await world.machine(machine_id)).stop_reason == "migration"
    undone = await world.migrations.rollback(ada.id, operator_id=op, execute=True)

    assert undone.step_after == "rolled_back"
    machine = await world.machine(machine_id)
    assert (machine.backend, machine.desired_state, machine.stop_reason) == (
        "vm",
        "running",
        None,
    )
    assert world.revoked() == []
    assert (await world.migrations.plan(ada.id)).next.startswith("Freeze again")


async def test_a_rollback_while_the_box_is_held_gives_the_v1_disk_and_agents_back(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, v1_controller, _agent = await world.v1_machine(ada)
    first_start = await world.to_held(ada, machine_id, op)

    # Already stopped: one call turns it back.
    undone = await world.migrations.rollback(ada.id, operator_id=op, execute=True)

    assert undone.step_after == "rolled_back"
    machine = await world.machine(machine_id)
    assert machine.backend == "vm" and machine.stop_reason is None
    assert (machine.state, machine.desired_state) == ("queued", "running")
    assert (machine.instance_id, machine.data_volume_id, machine.instance_type) == (
        INSTANCE,
        VOLUME,
        "m6i.large",
    )
    assert world.revoked() == [v1_controller, first_start]
    # The agents never left the v1 controller: it's back, for the v1
    # machine's fresh enrolment to move them from. It stays revoked, and no
    # code is kept: the v1 machine enrols again with a fresh one.
    workspace = await world.workspace(machine_id)
    assert workspace.controller_id == v1_controller
    assert workspace.moving_from_controller_id is None
    assert workspace.enrollment_code_encrypted is None
    async with session_factory() as session:
        v1 = await session.get(AgentController, v1_controller)
        assert v1 is not None and v1.revoked_at is not None
    [entry] = [
        e
        for e in await _audit(session_factory)
        if e.action == ServerAuditAction.HOSTED_MIGRATION_ROLLED_BACK
    ]
    assert (entry.details or {})["from"] == "held" and entry.actor_user_id == op


async def test_a_rollback_after_the_release_stops_the_box_first(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _v1_controller, _agent = await world.v1_machine(ada)
    box_controller = await world.to_done(ada, machine_id, op)

    stopping = await world.migrations.rollback(ada.id, operator_id=op, execute=True)
    assert stopping.step_after == "done" and "Stopping the box" in stopping.note
    machine = await world.machine(machine_id)
    assert (machine.backend, machine.desired_state, machine.stop_reason) == (
        "box",
        "stopped",
        "migration",
    )
    assert box_controller not in world.revoked()
    await world.reports(machine_id, "stopped")
    undone = await world.migrations.rollback(ada.id, operator_id=op, execute=True)

    assert undone.step_after == "rolled_back"
    machine = await world.machine(machine_id)
    assert machine.backend == "vm" and machine.data_volume_id == VOLUME
    assert box_controller in world.revoked()
    # The agents are on the box's controller: the v1 machine's enrolment
    # moves them from it.
    assert (await world.workspace(machine_id)).controller_id == box_controller


async def test_a_box_of_another_person_is_refused(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """the flip and the copy act only on the person's own row."""
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    bob = await add_member(session_factory, "bob")
    machine_id, _controller, _agent = await world.v1_machine(ada)
    bob_machine, _c, _a = await world.v1_machine(bob, "bobs-agent")
    await world.to_held(ada, machine_id, op)

    with pytest.raises(MigrationRefused) as refused:
        await world.step(
            ada,
            op,
            copied=CopyReport(
                bob_machine,
                (TENANT_ZERO_ID,),
                files=1,
                bytes=1,
                symlinks_skipped=0,
                **COPY,
            ),
        )
    assert refused.value.code == "target_mismatch"
    store = CloudMachineStore()
    with no_tenant():
        async with session_factory() as session:
            machine = await store.locked(session, bob_machine)
            assert machine is not None
            machine.state, machine.desired_state = "stopped", "stopped"
            machine.stop_reason = "migration"
            with pytest.raises(CloudMachineConflict):
                await store.flip_to_box(
                    session,
                    session_factory,
                    machine,
                    ada.id,
                    world.revoke,
                    datetime.now(UTC),
                )
            await session.rollback()


async def test_a_bad_copy_report_is_refused(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await world.to_held(ada, machine_id, op)
    good = CopyReport(
        machine_id, (TENANT_ZERO_ID,), files=1, bytes=1, symlinks_skipped=0, **COPY
    )
    for report in (
        None,
        dataclasses.replace(good, checksum_mismatches=1),
        dataclasses.replace(good, source_volume_id=VOLUME),  # the v1 disk itself
        dataclasses.replace(good, source_volume_id="vol-$(id)"),
        dataclasses.replace(good, seconds=-1),
        CopyReport(machine_id, (), files=1, bytes=1, symlinks_skipped=0, **COPY),
        CopyReport(
            machine_id,
            (TENANT_ZERO_ID, "another-workspace"),
            files=1,
            bytes=1,
            symlinks_skipped=0,
            **COPY,
        ),
        CopyReport(
            machine_id, (TENANT_ZERO_ID,), files=-1, bytes=1, symlinks_skipped=0, **COPY
        ),
        CopyReport(
            machine_id,
            (TENANT_ZERO_ID,),
            files=True,
            bytes=1,
            symlinks_skipped=0,
            **COPY,
        ),
        CopyReport(
            machine_id,
            (TENANT_ZERO_ID,),
            files=1,
            bytes=10**20,
            symlinks_skipped=0,
            **COPY,
        ),
    ):
        with pytest.raises(MigrationRefused):
            await world.step(ada, op, copied=report)
    assert (await world.record(ada)).step == "held"


async def test_one_run_at_a_time_per_person(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada = people["ada"]
    await world.v1_machine(ada)
    with no_tenant():
        async with session_factory() as holder:
            await holder.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": f"hosted-migration:{ada.id}"},
            )
            with pytest.raises(MigrationRefused) as refused:
                await world.step(ada, people["op"].id)
            await holder.rollback()
    assert refused.value.code == "busy"


async def test_refused_when_the_box_ceiling_is_reached_or_the_person_is_not_allowed(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    ada = people["ada"]
    full = World(session_factory, ceiling=1)
    await full.v1_machine(ada)
    # One box already made, as the provisioner's result records it.
    other = await add_member(session_factory, "zoe")
    async with session_factory() as seeded:
        box = await seed_machine(
            seeded,
            owner_id=other.id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        await seeded.commit()
    with no_tenant():
        async with session_factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.HOSTED_BOX_PROVISION,
                target_type="box",
                target_id="k1-box",
                details={"phase": "result", "result": "done", "machine_id": box.id},
            )
            await session.commit()
    assert "box_ceiling" in (await full.migrations.plan(ada.id)).refusals
    with pytest.raises(MigrationRefused) as refused:
        await full.step(ada, people["op"].id)
    assert refused.value.code == "box_ceiling"

    barred = World(session_factory)
    barred.allowed = False
    assert "box_not_allowed" in (await barred.migrations.plan(ada.id)).refusals


async def test_a_pause_mid_move_stops_it(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await world.step(ada, op)
    store = CloudMachineStore()
    with no_tenant():
        async with session_factory() as session:
            machine = await store.locked(session, machine_id)
            assert machine is not None
            store.stop(machine, "paused", datetime.now(UTC))  # an operator's pause wins
            await session.commit()
    assert "freeze_replaced" in (await world.migrations.plan(ada.id)).refusals
    with pytest.raises(MigrationRefused):
        await world.step(ada, op)


async def test_an_administrator_s_stop_mid_move_stops_it(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """An administrator's stop replaces the move's freeze, as a pause does, and
    the move then refuses to carry on."""
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await world.step(ada, op)
    store = CloudMachineStore()
    with no_tenant():
        async with session_factory() as session:
            machine = await store.locked(session, machine_id)
            assert machine is not None
            store.admin_stop(machine, datetime.now(UTC))
            assert machine.stop_reason == "admin"
            await session.commit()
    assert "freeze_replaced" in (await world.migrations.plan(ada.id)).refusals
    with pytest.raises(MigrationRefused):
        await world.step(ada, op)


async def test_an_administrator_s_release_mid_move_gives_the_hold_back(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """Released while the move holds the machine, it is held for the move
    again, not left for its owner to start, and the move carries on."""
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    await world.step(ada, op)
    await world.reports(machine_id, "stopped")
    assert await world.step(ada, op) == "frozen"
    await stop_machine(session_factory, machine_id, "looking at it")
    assert "freeze_replaced" in (await world.migrations.plan(ada.id)).refusals

    await release_machine(session_factory, machine_id)
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "migration")
    assert (await world.migrations.plan(ada.id)).refusals == []
    assert await world.step(ada, op, snapshot_id=SNAPSHOT) == "snapshot"


async def test_the_hold_steps_are_the_moves_own():
    """The store's list of steps at which a move holds the machine is the
    move's: before the flip, and held for the copy."""
    assert MOVE_HOLD_STEPS == BEFORE_FLIP | HELD


async def test_a_machine_an_administrator_stopped_is_not_moved(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    store = CloudMachineStore()
    with no_tenant():
        async with session_factory() as session:
            machine = await store.locked(session, machine_id)
            assert machine is not None
            store.admin_stop(machine, datetime.now(UTC))
            await session.commit()
    assert "admin_stopped" in (await world.migrations.plan(ada.id)).refusals
    with pytest.raises(MigrationRefused) as refused:
        await world.step(ada, op)
    assert refused.value.code == "admin_stopped"
    with no_tenant():
        async with session_factory() as session:
            machine = await store.get(session, machine_id)
            assert machine is not None and machine.stop_reason == "admin"


async def test_a_person_mid_move_takes_no_new_workspace(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """Joining another workspace mid-move would add one the move didn't plan
    for. Refused while the machine is frozen, and while the box runs unheld
    for its first start (`flipped`), when its stop reason says nothing."""
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    async with session_factory() as session:
        await add_tenant(session, "t-joining")
        await session.commit()

    async def claim_elsewhere() -> None:
        with tenant_scope("t-joining"):
            async with session_factory() as session:
                await lock_claims(session)
                try:
                    await CloudMachineStore().claim(
                        session,
                        session_factory,
                        owner_id=ada.id,
                        capacity=10,
                        now=datetime.now(UTC),
                    )
                finally:
                    await session.rollback()

    await world.step(ada, op)
    with pytest.raises(CloudMachineConflict) as refused:
        await claim_elsewhere()
    assert str(refused.value) == MACHINE_MIGRATING

    await world.reports(machine_id, "stopped")
    await world.step(ada, op)
    await world.step(ada, op, snapshot_id=SNAPSHOT)
    assert await world.step(ada, op) == "flipped"
    assert (await world.machine(machine_id)).stop_reason is None
    with pytest.raises(CloudMachineConflict) as refused:
        await claim_elsewhere()
    assert str(refused.value) == MACHINE_MIGRATING


async def test_without_the_keyed_id_key_nothing_is_executed(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """Every change is audited under keyed ids: without the key, a dry run
    still says what would happen, but nothing runs."""
    world = World(session_factory)
    world.migrations._key = None
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    dry = await world.migrations.run(ada.id, operator_id=op)
    assert not dry.executed
    for attempt in (
        world.migrations.run(ada.id, operator_id=op, execute=True),
        world.migrations.rollback(ada.id, operator_id=op, execute=True),
        world.migrations.clean_up(ada.id, operator_id=op, execute=True),
    ):
        with pytest.raises(MigrationRefused) as refused:
            await attempt
        assert refused.value.code == "no_keyed_id_key"
    machine = await world.machine(machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("running", None)
    with no_tenant():
        async with session_factory() as session:
            assert await session.get(HostedMigration, ada.id) is None


async def test_a_moved_box_s_first_ready_counts_as_new(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """The box is a new box, as a revived one is: the v1 machine's first ready
    doesn't carry over, so its first ready is timed as a new machine's."""
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    with no_tenant():
        async with session_factory() as session:
            await session.execute(
                update(CloudMachine)
                .where(CloudMachine.id == machine_id)
                .values(first_ready_at=datetime.now(UTC) - timedelta(days=30))
            )
            await session.commit()
    await world.to_flipped(ada, machine_id, op)
    machine = await world.machine(machine_id)
    assert (machine.backend, machine.first_ready_at) == ("box", None)


async def test_the_clean_up_waits_for_the_rollback_window(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    with pytest.raises(MigrationRefused):
        await world.migrations.clean_up(ada.id, operator_id=op, execute=True)
    await world.to_done(ada, machine_id, op)

    world.clock.now += timedelta(days=6)
    with pytest.raises(MigrationRefused) as refused:
        await world.migrations.clean_up(ada.id, operator_id=op, execute=True)
    assert refused.value.code == "window_open"
    world.clock.now += timedelta(days=1)
    outcome, v1 = await world.migrations.clean_up(ada.id, operator_id=op, execute=True)

    assert outcome.step_after == "cleaned"
    assert v1 == {
        "instance_id": INSTANCE,
        "data_volume_id": VOLUME,
        "snapshot_id": SNAPSHOT,
    }
    with pytest.raises(MigrationRefused):
        await world.migrations.rollback(ada.id, operator_id=op, execute=True)


async def test_with_v2_off_nothing_runs(
    session_factory: async_sessionmaker[AsyncSession],
    people: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from switch_core import hosted_v2

    world = World(session_factory)
    ada = people["ada"]
    await world.v1_machine(ada)
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    assert (await world.migrations.plan(ada.id)).refusals == ["v2_off"]
    with pytest.raises(MigrationRefused) as refused:
        await world.step(ada, people["op"].id)
    assert refused.value.code == "v2_off"


async def test_a_workspace_the_person_left_does_not_move(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, _agent = await world.v1_machine(ada)
    async with session_factory() as session:
        member = await session.get(TenantMember, (TENANT_ZERO_ID, ada.id))
        assert member is not None
        await session.delete(member)
        await session.commit()
    [workspace] = (await world.migrations.plan(ada.id)).workspaces
    assert not workspace.still_member
    await world.to_flipped(ada, machine_id, op)
    async with session_factory() as session:
        assert (
            await session.scalar(
                select(MachineWorkspace).where(
                    MachineWorkspace.machine_id == machine_id
                )
            )
            is None
        )


async def test_the_box_takes_no_agents_until_the_release(
    harness: Harness, people: dict[str, Any]
) -> None:
    """The real enrolment path: the box enrolling at its first start takes
    none of the agents; after the release, its next enrolment moves them,
    ids kept."""
    factory = harness.session_factory
    ada, op = people["ada"], people["op"].id
    world = World(factory, revoke=RealRevoke())
    machine_id, v1_controller, agent_id = await world.v1_machine(ada)
    await world.to_flipped(ada, machine_id, op)

    async def placed_on() -> str | None:
        async with factory() as session:
            found: str | None = await session.scalar(
                select(AgentDefinition.controller_id).where(
                    AgentDefinition.agent_id == agent_id
                )
            )
            return found

    # The first start: the box enrols with the code prepare hands it.
    async with _hosted_app(factory, ada) as hosted:
        [entry] = (await _prepare(hosted, machine_id))["controllers"]
    async with harness.client() as client:
        first = await _enroll(client, entry["enrollment_code"])
    assert await placed_on() == v1_controller  # not moved
    workspace = await world.workspace(machine_id)
    assert workspace.controller_id == str(first["controller_id"])
    assert workspace.moving_from_controller_id == v1_controller

    await world.reports(machine_id, "ready")
    assert await world.step(ada, op) == "holding"
    await world.reports(machine_id, "stopped")
    assert await world.step(ada, op) == "held"
    copied = CopyReport(
        machine_id, (TENANT_ZERO_ID,), files=1, bytes=1, symlinks_skipped=0, **COPY
    )
    assert await world.step(ada, op, copied=copied) == "copied"
    assert await world.step(ada, op) == "released"
    # Released, but the box hasn't started and enrolled again: nothing moved.
    assert await placed_on() == v1_controller

    # The box starts again and enrols afresh: now the agents move to it.
    async with _hosted_app(factory, ada) as hosted:
        [fresh] = (await _prepare(hosted, machine_id))["controllers"]
    assert fresh["enrollment_code"] != entry["enrollment_code"]
    async with harness.client() as client:
        # The first-start controller's credential is refused: it's revoked.
        stale = await client.post(
            f"/v1/management/controllers/{first['controller_id']}/token",
            json={"credential": first["credential"]},
        )
        second = await _enroll(client, fresh["enrollment_code"])
    assert stale.status_code in (401, 403), stale.text
    assert await placed_on() == str(second["controller_id"])
    async with factory() as session:
        old = await session.get(AgentController, str(first["controller_id"]))
        assert old is not None and old.revoked_at is not None

    # Done only once the new controller has reported, read from Core's state.
    assert await world.step(ada, op) == "released"
    async with factory() as session:
        new = await session.get(AgentController, str(second["controller_id"]))
        assert new is not None
        new.status = {"agents": []}
        await session.commit()
    assert await world.step(ada, op) == "done"


async def test_the_person_never_sees_the_box_ready_before_the_release(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    """During the first start the box's controller may enrol, but the
    person's machine reads as still starting, with their agents, until the
    release; while held, it reads as stopped by the owner (Console's schema)."""
    from switch_core.gateway.hosted_machines import machine_summary

    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, _controller, agent_id = await world.v1_machine(ada)
    await world.to_flipped(ada, machine_id, op)
    first_start = await world.box_enrols(machine_id, ada)
    await world.reports(machine_id, "ready")

    async def summary() -> dict[str, Any]:
        async with session_factory() as session:
            workspace = await workspace_on(session, machine_id)
            machine = await session.get(CloudMachine, machine_id)
            assert workspace is not None and machine is not None
            # As if the box's controller had reported in this workspace.
            machine.heartbeat = {
                "controllers": {
                    workspace.id: {
                        "at": datetime.now(UTC).isoformat(),
                        "sessions_running": 0,
                    }
                }
            }
            return await machine_summary(session, machine, workspace)

    first = await summary()
    assert first["state"] == "provisioning"
    assert first["agents"] == [agent_id]
    assert first["controller_id"] == first_start
    await world.step(ada, op)  # holding
    await world.reports(machine_id, "stopped")
    held = await summary()
    assert (held["state"], held["stop_reason"]) == ("stopped", "owner")
    assert held["agents"] == [agent_id]


async def test_no_login_is_given_to_the_machine_during_the_move(
    harness: Harness, people: dict[str, Any]
) -> None:
    """the person's own "give login" is refused while the move is
    open, so nothing is sealed to a box before its files and agents are
    there; once the move ends, it's accepted as usual."""
    import base64
    import os

    from switch_core.management.sealed_logins import key_id
    from tests.switch_core.management.harness import cookies_for, enroll_console

    factory = harness.session_factory
    ada, op = people["ada"], people["op"].id
    world = World(factory)
    machine_id, _v1, _agent = await world.v1_machine(ada)
    key = base64.b64encode(os.urandom(32)).decode()
    sealed = {
        "alg": "X25519-HKDF-SHA256-A256GCM",
        "key_id": key_id(key),
        "ephemeral_key": base64.b64encode(os.urandom(32)).decode(),
        "nonce": base64.b64encode(os.urandom(12)).decode(),
        "ciphertext": base64.b64encode(os.urandom(80)).decode(),
    }
    async with harness.client() as client:
        machine_controller = await enroll_console(harness, client, ada)
        await client.patch(
            f"/v1/management/controllers/{machine_controller.controller_id}",
            json={"public_key": {"alg": "X25519", "key": key}},
            headers=machine_controller.headers,
        )
        # The machine's controller in this workspace is that one.
        async with factory() as session:
            workspace = await workspace_on(session, machine_id)
            assert workspace is not None
            workspace.controller_id = machine_controller.controller_id
            await session.commit()
        path = (
            f"/gateway/management/controllers/{machine_controller.controller_id}"
            "/provider-logins/claude"
        )

        await world.step(ada, op)  # the move starts: the freeze
        during = [
            await client.put(path, json={"sealed": sealed}, cookies=cookies_for(ada))
        ]
        # Still refused once released, until the move is done (agents moved).
        await _set_step(factory, ada, "released")
        during.append(
            await client.put(path, json={"sealed": sealed}, cookies=cookies_for(ada))
        )
        await _set_step(factory, ada, "done")
        given = await client.put(
            path, json={"sealed": sealed}, cookies=cookies_for(ada)
        )

    for refused in during:
        assert refused.status_code == 409, refused.text
        assert refused.json()["error"]["code"] == "migration_in_progress"
        assert refused.json()["error"]["message"] == "migration_in_progress"
        assert ada.id not in refused.text and machine_id not in refused.text
    assert given.status_code == 200, given.text


async def _set_step(
    factory: async_sessionmaker[AsyncSession], owner: User, step: str
) -> None:
    with no_tenant():
        async with factory() as session:
            record = await session.get(HostedMigration, owner.id)
            assert record is not None
            record.step = step
            await session.commit()


async def test_release_refuses_before_the_copy_is_verified_or_unless_the_box_is_held(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, v1_controller, _agent = await world.v1_machine(ada)
    await world.to_held(ada, machine_id, op)
    # Every step up to here kept the agents held on the v1 controller.
    assert (
        await world.workspace(machine_id)
    ).moving_from_controller_id == v1_controller
    # Held, but no verified copy: nothing is released.
    with pytest.raises(MigrationRefused) as refused:
        await world.step(ada, op)
    assert refused.value.code == "copy_needed"
    copied = CopyReport(
        machine_id, (TENANT_ZERO_ID,), files=1, bytes=1, symlinks_skipped=0, **COPY
    )
    assert await world.step(ada, op, copied=copied) == "copied"
    # Verified, but the box isn't held stopped any more: refused.
    with no_tenant():
        async with session_factory() as session:
            machine = await session.get(CloudMachine, machine_id)
            assert machine is not None
            machine.state = "ready"
            await session.commit()
    with pytest.raises(MigrationRefused) as refused:
        await world.step(ada, op)
    assert refused.value.code == "not_held"
    assert (
        await world.workspace(machine_id)
    ).moving_from_controller_id == v1_controller
    assert (await world.record(ada)).step == "copied"


async def test_a_release_whose_box_never_enrols_stays_released_and_rolls_back(
    session_factory: async_sessionmaker[AsyncSession], people: dict[str, Any]
) -> None:
    world = World(session_factory)
    ada, op = people["ada"], people["op"].id
    machine_id, v1_controller, agent_id = await world.v1_machine(ada)
    await world.to_held(ada, machine_id, op)
    copied = CopyReport(
        machine_id, (TENANT_ZERO_ID,), files=1, bytes=1, symlinks_skipped=0, **COPY
    )
    await world.step(ada, op, copied=copied)
    assert await world.step(ada, op) == "released"
    await world.reports(machine_id, "ready")

    # The box never enrols: the move stays released, however often it's run.
    for _ in range(3):
        assert await world.step(ada, op) == "released"

    stopping = await world.migrations.rollback(ada.id, operator_id=op, execute=True)
    assert "Stopping the box" in stopping.note
    await world.reports(machine_id, "stopped")
    undone = await world.migrations.rollback(ada.id, operator_id=op, execute=True)
    assert undone.step_after == "rolled_back"
    machine = await world.machine(machine_id)
    assert machine.backend == "vm" and machine.data_volume_id == VOLUME
    # The agents never left the v1 controller, which is back for the v1
    # machine's enrolment to move them from.
    assert (await world.workspace(machine_id)).controller_id == v1_controller
    async with session_factory() as session:
        placed = await session.scalar(
            select(AgentDefinition.controller_id).where(
                AgentDefinition.agent_id == agent_id
            )
        )
    assert placed == v1_controller

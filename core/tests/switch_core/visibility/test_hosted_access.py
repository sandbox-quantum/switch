"""An operator's pause and a workspace admin's per-person switch,
on real Postgres through the runtime role.

The revoke is Core's existing controller revocation, faked here so the tests
see which controllers it was asked to revoke and in which workspace.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from switch_core.db.audit import AuditAction, ServerAuditAction
from switch_core.db.models import (
    AgentController,
    AuditEvent,
    CloudMachine,
    ServerAuditEvent,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_PAUSED,
    CloudMachineConflict,
    CloudMachineStore,
    claim_conflict,
)
from switch_core.tenant_context import tenant_scope
from switch_core.visibility.hosted_access import (
    HostedAccess,
    block_reason,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from switch_core.visibility.reason_codes import StopReason
from tests.conftest import RLSHarness
from tests.switch_core.hosted_machine_helpers import (
    add_workspace,
    link_controller,
    seed_machine,
)

pytestmark = pytest.mark.no_ambient_tenant

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")


class FakeRevoker:
    def __init__(self) -> None:
        self.revoked: list[tuple[str, str]] = []
        self.announced: list[str] = []
        self.reasons: list[str | None] = []

    async def revoke_controllers(
        self, session, tenant_id, controller_ids, revoked_by=None
    ) -> None:
        self.revoked += [(tenant_id, c) for c in controller_ids]
        self.reasons.append(revoked_by)

    def announce_revoked(self, controller_ids) -> None:
        self.announced += controller_ids


async def _no_sleep(_seconds: float) -> None:
    return None


def _access(rls_harness: RLSHarness, revoker: FakeRevoker) -> HostedAccess:
    ticks = iter(range(10_000))
    return HostedAccess(
        session_factory=rls_harness.restricted,
        revoker=revoker,
        key=KEY,
        sleep=_no_sleep,
        monotonic=lambda: float(next(ticks)),
        revoke_wait_s=3.0,
        stop_wait_s=3.0,
    )


async def _world(rls_harness: RLSHarness, workspaces: int = 1):
    """A user who is a member of `workspaces` workspaces, and an operator."""
    suffix = uuid.uuid4().hex[:8]
    user_id, operator_id = f"user-{suffix}", f"operator-{suffix}"
    tenants = [f"tenant-{i}-{suffix}" for i in range(workspaces)]
    async with rls_harness.owner() as session:
        for uid in (user_id, operator_id):
            session.add(
                User(id=uid, name=uid, email=f"{uid}@example.test", role="user")
            )
        for tenant_id in tenants:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.flush()
        for tenant_id in tenants:
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=user_id, role="member")
            )
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=operator_id, role="admin")
            )
        await session.commit()
    return user_id, operator_id, tenants


async def _box(
    rls_harness: RLSHarness, user_id: str, tenants: list[str], *, state="ready"
):
    """The user's box, serving each workspace with a cloud controller."""
    with tenant_scope(tenants[0]):
        async with rls_harness.owner() as session:
            machine = await seed_machine(
                session,
                owner_id=user_id,
                state=state,
                desired_state="running",
                stop_reason=None,
                revision=1,
            )
            controllers = [(tenants[0], (await link_controller(session, machine)).id)]
            await session.commit()
    for tenant_id in tenants[1:]:
        with tenant_scope(tenant_id):
            async with rls_harness.owner() as session:
                machine_row = await session.get(CloudMachine, machine.id)
                await add_workspace(session, machine_row, created_at=datetime.now(UTC))
                controllers.append(
                    (tenant_id, (await link_controller(session, machine_row)).id)
                )
                await session.commit()
    return machine.id, controllers


async def _machine(rls_harness: RLSHarness, machine_id: str) -> CloudMachine | None:
    async with rls_harness.owner() as session:
        return await session.get(CloudMachine, machine_id)


async def _set_state(rls_harness: RLSHarness, machine_id: str, state: str) -> None:
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        machine.state = state
        await session.commit()


async def _server_entries(rls_harness: RLSHarness) -> list[ServerAuditEvent]:
    async with rls_harness.owner() as session:
        return list(
            (
                await session.execute(
                    select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
                )
            )
            .scalars()
            .all()
        )


# ── Pause ────────────────────────────────────────────────────────────────────


async def test_pause_audits_first_marks_the_box_revokes_every_controller_and_records_the_steps(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness, workspaces=2)
    machine_id, controllers = await _box(rls_harness, user_id, tenants)
    revoker = FakeRevoker()
    access = _access(rls_harness, revoker)

    request = await access.pause(
        actor_id=operator_id, user_id=user_id, reason="Misuse, ticket 7"
    )

    machine = await _machine(rls_harness, machine_id)
    assert machine.desired_state == "stopped" and machine.stop_reason == "paused"
    # Every workspace's controller on the box, then announced.
    assert sorted(revoker.revoked) == sorted(controllers)
    assert sorted(revoker.announced) == sorted(c for _, c in controllers)
    # The scaler stops the box; then the steps and the result follow.
    await _set_state(rls_harness, machine_id, "stopped")
    for task in list(access.pending):
        await task
    entries = await _server_entries(rls_harness)
    mine = [
        e
        for e in entries
        if e.id == request.event_id
        or (e.details or {}).get("linked_to") == request.event_id
    ]
    phases = [
        (e.details["phase"], e.details.get("step") or e.details.get("result"))
        for e in mine
    ]
    assert phases[0] == ("requested", None)
    assert ("progress", "revoked") in phases
    assert ("progress", "scaled") in phases
    assert phases[-1] == ("result", "done")
    assert mine[0].action == ServerAuditAction.HOSTED_USER_PAUSED
    assert user_id not in repr([e.details for e in mine])


async def test_a_box_that_never_stops_is_recorded_failed_never_done(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    await _box(rls_harness, user_id, tenants)
    access = _access(rls_harness, FakeRevoker())
    request = await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    for task in list(access.pending):
        await task
    last = [
        e
        for e in await _server_entries(rls_harness)
        if (e.details or {}).get("linked_to") == request.event_id
    ][-1]
    assert last.details["phase"] == "result"
    assert last.details["result"] == "failed" and last.details["step"] == "scale"


async def test_the_pause_holds_start_claim_and_retain_all_refuse(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, tenants)
    await _access(rls_harness, FakeRevoker()).pause(
        actor_id=operator_id, user_id=user_id, reason="Misuse"
    )
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        with pytest.raises(CloudMachineConflict, match="paused"):
            CloudMachineStore().start(machine, datetime.now(UTC))
        assert claim_conflict(machine, datetime.now(UTC)) == MACHINE_PAUSED
        assert not await CloudMachineStore().retain_if_empty(
            machine, [], retention_days=7, now=datetime.now(UTC)
        )
        assert machine.desired_state == "stopped" and machine.stop_reason == "paused"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_user_with_no_box_is_paused_on_the_user_and_can_claim_nothing(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    for task in list(access.pending):
        await task
    async with rls_harness.owner() as session:
        assert await CloudMachineStore().live_for_owner(session, user_id) is None
        user = await session.get(User, user_id)
        assert user.hosted_paused_at is not None
    assert (
        await block_reason(rls_harness.restricted, user_id, None)
        is StopReason.PAUSED_BY_SWITCH
    )
    # A claim, from any workspace, is refused and creates no row.
    with tenant_scope(x):
        async with rls_harness.owner() as session:
            with pytest.raises(CloudMachineConflict, match="paused"):
                await CloudMachineStore().claim(
                    session,
                    rls_harness.owner,
                    owner_id=user_id,
                    capacity=10,
                    now=datetime.now(UTC),
                )
            await session.rollback()
    async with rls_harness.owner() as session:
        assert await CloudMachineStore().live_for_owner(session, user_id) is None

    await access.resume(actor_id=operator_id, user_id=user_id, reason="Cleared")
    assert await block_reason(rls_harness.restricted, user_id, None) is None


async def test_a_sign_in_writing_the_users_metadata_cant_clear_a_pause(
    rls_harness: RLSHarness,
) -> None:
    """A race: the sign-in reads the user row, the pause lands, then
    the sign-in writes its metadata back. The pause has its own column, and
    the ORM writes only the columns it changed."""
    user_id, operator_id, _ = await _world(rls_harness)
    async with rls_harness.owner() as signing_in:
        user = await signing_in.get(User, user_id)
        assert user.hosted_paused_at is None
        await _access(rls_harness, FakeRevoker()).pause(
            actor_id=operator_id, user_id=user_id, reason="Misuse"
        )
        user.metadata_ = {**(user.metadata_ or {}), "last_workspace": "t"}
        await signing_in.commit()
    assert (
        await block_reason(rls_harness.restricted, user_id, None)
        is StopReason.PAUSED_BY_SWITCH
    )


async def test_a_paused_box_keeps_paused_through_any_other_stop(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, tenants)
    await _access(rls_harness, FakeRevoker()).pause(
        actor_id=operator_id, user_id=user_id, reason="Misuse"
    )
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        for reason in ("owner", "idle", "turned_off"):
            CloudMachineStore().stop(machine, reason, datetime.now(UTC))
            assert machine.stop_reason == "paused"


async def test_a_turned_off_box_keeps_its_label_through_the_owners_or_idle_stop(
    rls_harness: RLSHarness,
) -> None:
    user_id, _, tenants = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, tenants)
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        store = CloudMachineStore()
        store.stop(machine, "turned_off", datetime.now(UTC))
        for reason in ("owner", "idle"):
            store.stop(machine, reason, datetime.now(UTC))
            assert machine.stop_reason == "turned_off"
        store.stop(machine, "paused", datetime.now(UTC))  # a pause wins
        assert machine.stop_reason == "paused"


async def test_every_workspace_the_user_is_in_gets_its_copy(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x, y] = await _world(rls_harness, workspaces=2)
    access = _access(rls_harness, FakeRevoker())
    request = await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    assert sorted(raw for raw, _, _ in request.workspace_copies) == sorted([x, y])
    for tenant_id in (x, y):
        with tenant_scope(tenant_id):
            async with rls_harness.restricted() as session:
                copies = (
                    (
                        await session.execute(
                            select(AuditEvent).where(
                                AuditEvent.action == AuditAction.HOSTED_OPERATOR_ACTION
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
        assert request.event_id in [c.details["server_event_id"] for c in copies]


async def test_pausing_someone_who_doesnt_exist_writes_nothing(
    rls_harness: RLSHarness,
) -> None:
    _, operator_id, _ = await _world(rls_harness)
    before = len(await _server_entries(rls_harness))
    with pytest.raises(LookupError):
        await _access(rls_harness, FakeRevoker()).pause(
            actor_id=operator_id, user_id="no-such-user", reason="Misuse"
        )
    assert len(await _server_entries(rls_harness)) == before


class FailingRevoker(FakeRevoker):
    async def revoke_controllers(
        self, session, tenant_id, controller_ids, revoked_by=None
    ) -> None:
        raise RuntimeError("the stream is gone")


async def test_a_failed_revoke_is_recorded_failed_at_that_step_and_the_mark_holds(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    await _box(rls_harness, user_id, tenants)
    access = _access(rls_harness, FailingRevoker())
    with pytest.raises(RuntimeError):
        await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    [request] = [
        e
        for e in await _server_entries(rls_harness)
        if e.action == ServerAuditAction.HOSTED_USER_PAUSED
        and e.details["phase"] == "requested"
        and e.target_id == KEY.keyed_id(KeyedIdKind.USER, user_id)
    ]
    [result] = [
        e
        for e in await _server_entries(rls_harness)
        if (e.details or {}).get("linked_to") == request.id
    ]
    assert (result.details["result"], result.details["step"]) == ("failed", "revoke")
    assert (
        await block_reason(rls_harness.restricted, user_id, None)
        is StopReason.PAUSED_BY_SWITCH
    )


async def test_the_start_up_sweep_ends_an_unfinished_pause_as_failed(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    await _box(rls_harness, user_id, tenants)
    access = _access(rls_harness, FakeRevoker())
    request = await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    for task in list(access.pending):
        task.cancel()  # Core stopped before the result

    async def linked() -> list[ServerAuditEvent]:
        return [
            e
            for e in await _server_entries(rls_harness)
            if (e.details or {}).get("linked_to") == request.event_id
        ]

    # Not yet old enough: an action still running elsewhere is left alone.
    await access.sweep_unfinished()
    assert all(e.details["phase"] != "result" for e in await linked())
    later = HostedAccess(
        session_factory=rls_harness.restricted,
        revoker=FakeRevoker(),
        key=KEY,
        now=lambda: datetime.now(UTC) + timedelta(hours=1),
    )
    await later.sweep_unfinished()
    results = [e for e in await linked() if e.details["phase"] == "result"]
    assert len(results) == 1
    assert results[0].details["result"] == "failed"
    assert results[0].details["swept"] is True
    # Once ended, a second sweep leaves it alone.
    await later.sweep_unfinished()
    assert len([e for e in await linked() if e.details["phase"] == "result"]) == 1
    # The workspace's admins see the failure too, linked to their copy.
    [x] = tenants
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            copies = (
                (
                    await session.execute(
                        select(AuditEvent).where(
                            AuditEvent.action == AuditAction.HOSTED_OPERATOR_ACTION
                        )
                    )
                )
                .scalars()
                .all()
            )
    [copy] = [c for c in copies if c.details.get("server_event_id") == request.event_id]
    results = [c for c in copies if c.details.get("linked_to") == copy.id]
    assert [r.details["result"] for r in results] == ["failed"]


async def test_resume_leaves_the_box_asleep_so_the_next_message_wakes_it(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, tenants)
    access = _access(rls_harness, FakeRevoker())
    await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    await access.resume(actor_id=operator_id, user_id=user_id, reason="Cleared")
    machine = await _machine(rls_harness, machine_id)
    # Asleep, not the owner's stop: the next message wakes it.
    assert machine.desired_state == "stopped" and machine.stop_reason == "idle"


# ── The per-person switch ────────────────────────────────────────────────────


async def test_turning_off_audits_with_the_mark_and_revokes_only_that_workspace(
    rls_harness: RLSHarness,
) -> None:
    user_id, admin_id, [x, y] = await _world(rls_harness, workspaces=2)
    machine_id, controllers = await _box(rls_harness, user_id, [x, y])
    revoker = FakeRevoker()
    access = _access(rls_harness, revoker)

    await access.set_member(
        actor_id=admin_id,
        tenant_id=x,
        user_id=user_id,
        enabled=False,
        reason="Left the team",
    )
    # Only X's controller; Y keeps working.
    assert revoker.revoked == [c for c in controllers if c[0] == x]
    assert (
        await block_reason(rls_harness.restricted, user_id, x)
        is StopReason.TURNED_OFF_BY_ADMIN
    )
    assert await block_reason(rls_harness.restricted, user_id, y) is None
    for task in list(access.pending):
        await task
    # The revoke was confirmed (no live stream), and the box serves Y: it keeps running.
    machine = await _machine(rls_harness, machine_id)
    assert machine.desired_state == "running"
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            entries = (
                (
                    await session.execute(
                        select(AuditEvent).order_by(AuditEvent.occurred_at)
                    )
                )
                .scalars()
                .all()
            )
    offs = [e for e in entries if e.action == AuditAction.HOSTED_PERSON_TURNED_OFF]
    assert len(offs) == 2  # the change, then its outcome linked to it
    assert offs[1].details["linked_to"] == offs[0].id


async def test_turning_off_the_only_workspace_stops_the_box(
    rls_harness: RLSHarness,
) -> None:
    user_id, admin_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    await access.set_member(
        actor_id=admin_id,
        tenant_id=x,
        user_id=user_id,
        enabled=False,
        reason="Left the team",
    )
    for task in list(access.pending):
        await task
    machine = await _machine(rls_harness, machine_id)
    assert machine.desired_state == "stopped" and machine.stop_reason == "turned_off"


async def test_pause_wins_over_turning_on(rls_harness: RLSHarness) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    await access.set_member(
        actor_id=operator_id,
        tenant_id=x,
        user_id=user_id,
        enabled=False,
        reason="Left the team",
    )
    await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    await access.set_member(
        actor_id=operator_id,
        tenant_id=x,
        user_id=user_id,
        enabled=True,
        reason="Back on the team",
    )
    assert (
        await block_reason(rls_harness.restricted, user_id, x)
        is StopReason.PAUSED_BY_SWITCH
    )


async def test_everyone_is_enabled_by_default_so_todays_access_carries_over(
    rls_harness: RLSHarness,
) -> None:
    user_id, _, [x] = await _world(rls_harness)
    assert await block_reason(rls_harness.restricted, user_id, x) is None
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            member = await session.get(TenantMember, (x, user_id))
    assert member.hosted_enabled is True


async def test_turning_off_someone_who_isnt_a_member_is_refused(
    rls_harness: RLSHarness,
) -> None:
    _, admin_id, [x] = await _world(rls_harness)
    with pytest.raises(LookupError):
        await _access(rls_harness, FakeRevoker()).set_member(
            actor_id=admin_id,
            tenant_id=x,
            user_id="not-a-member",
            enabled=False,
            reason="Left the team",
        )


# ── Refusals on the paths that could start, wake or reconnect a box ─────────


@pytest.mark.usefixtures("hosted_v2_on")
async def test_controller_work_is_refused_for_a_blocked_owner(
    rls_harness: RLSHarness,
) -> None:
    from switch_core.management import reason_codes
    from switch_core.management.errors import ManagementError
    from switch_core.management.service import _refuse_if_blocked

    user_id, operator_id, [x] = await _world(rls_harness)
    await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            await _refuse_if_blocked(session, user_id, x)  # nothing blocks yet
    await access.set_member(
        actor_id=operator_id,
        tenant_id=x,
        user_id=user_id,
        enabled=False,
        reason="Left the team",
    )
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            with pytest.raises(ManagementError) as off:
                await _refuse_if_blocked(session, user_id, x)
    assert off.value.code == reason_codes.HOSTED_TURNED_OFF
    await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            with pytest.raises(ManagementError) as paused:
                await _refuse_if_blocked(session, user_id, x)
    assert paused.value.code == reason_codes.HOSTED_PAUSED


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_message_never_wakes_a_box_for_a_turned_off_workspace(
    rls_harness: RLSHarness,
) -> None:
    from switch_core.gateway.cloud_controllers import wake_controller_machine

    user_id, _operator, [x] = await _world(rls_harness)
    machine_id, [(_x, controller_id)] = await _box(rls_harness, user_id, [x])
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        machine.desired_state, machine.stop_reason = "stopped", "idle"  # asleep
        await session.commit()
    # Turned off in X: the revoke is faked, so the controller row stays for the lookup.
    with tenant_scope(x):
        async with rls_harness.owner() as session:
            member = await session.get(TenantMember, (x, user_id))
            member.hosted_enabled = False
            await session.commit()
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            await wake_controller_machine(
                session, controller_id, datetime.now(UTC), "message"
            )
            await session.commit()
    machine = await _machine(rls_harness, machine_id)
    assert machine.desired_state == "stopped" and machine.stop_reason == "idle"


# ── The operators' alert for a pause still failing (A8) ──────


class Alerts:
    """Records pause alerts as (user, raised), and turn-off alerts in `off`."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, bool]] = []
        self.off: list[tuple[str, str | None, bool]] = []

    async def __call__(
        self, action: str, user_keyed_id: str, workspace: str | None, raised: bool
    ) -> None:
        if action == "pause":
            self.calls.append((user_keyed_id, raised))
        else:
            self.off.append((user_keyed_id, workspace, raised))


async def test_a_pause_that_never_finishes_raises_the_alert_and_resume_clears_it(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    await _box(rls_harness, user_id, tenants)  # never reports stopped
    alerts = Alerts()
    access = _access(rls_harness, FakeRevoker())
    access.alert = alerts
    await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    for task in list(access.pending):
        await task
    keyed = KEY.keyed_id(KeyedIdKind.USER, user_id)
    assert alerts.calls == [(keyed, True)]
    await access.resume(actor_id=operator_id, user_id=user_id, reason="Cleared")
    assert alerts.calls[-1] == (keyed, False)


async def test_a_pause_that_finishes_raises_nothing(rls_harness: RLSHarness) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, tenants)
    alerts = Alerts()
    access = _access(rls_harness, FakeRevoker())
    access.alert = alerts
    await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    await _set_state(rls_harness, machine_id, "stopped")
    for task in list(access.pending):
        await task
    assert all(raised is False for _, raised in alerts.calls)


async def test_a_failed_revoke_raises_the_alert_later_unless_resumed_first(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    await _box(rls_harness, user_id, tenants)
    keyed = KEY.keyed_id(KeyedIdKind.USER, user_id)

    alerts = Alerts()
    access = _access(rls_harness, FailingRevoker())
    access.alert = alerts
    with pytest.raises(RuntimeError):
        await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    for task in list(access.pending):
        await task
    assert alerts.calls == [(keyed, True)]

    # Resumed before the wait is over: the stale alert is dropped.
    gate = asyncio.Event()

    async def held_sleep(_seconds: float) -> None:
        await gate.wait()

    alerts = Alerts()
    access = _access(rls_harness, FailingRevoker())
    access.alert, access.sleep = alerts, held_sleep
    with pytest.raises(RuntimeError):
        await access.pause(actor_id=operator_id, user_id=user_id, reason="Again")
    await access.resume(actor_id=operator_id, user_id=user_id, reason="Cleared")
    gate.set()
    for task in list(access.pending):
        await task
    assert alerts.calls == [(keyed, False)]


async def test_a_broken_alert_never_changes_the_action(rls_harness: RLSHarness) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, tenants)

    async def broken(*_args: object) -> None:
        raise RuntimeError("alerts are down")

    access = _access(rls_harness, FakeRevoker())
    access.alert = broken
    request = await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    await _set_state(rls_harness, machine_id, "stopped")
    for task in list(access.pending):
        await task
    last = [
        e
        for e in await _server_entries(rls_harness)
        if (e.details or {}).get("linked_to") == request.event_id
    ][-1]
    assert (last.details["phase"], last.details["result"]) == ("result", "done")


# ── Clean-up never removes or restarts a paused box ──


@pytest.mark.parametrize("state", ["stopped", "error", "ready"])
async def test_the_clean_up_sweep_leaves_a_paused_box_as_it_is(
    rls_harness: RLSHarness, state: str
) -> None:
    from switch_core.db.stores.hosted_machine_store import workspaces_on
    from switch_core.gateway.hosted_controller import _sweep

    user_id, operator_id, tenants = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, tenants)
    await _access(rls_harness, FakeRevoker()).pause(
        actor_id=operator_id, user_id=user_id, reason="Misuse"
    )
    await _set_state(rls_harness, machine_id, state)
    later = datetime.now(UTC) + timedelta(days=30)  # past any idle or disk expiry
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        workspaces = await workspaces_on(rls_harness.owner, machine_id)
        await _sweep(
            session, machine, workspaces, idle_minutes=1, retention_days=7, now=later
        )
        await session.commit()
    machine = await _machine(rls_harness, machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "paused")
    assert machine.retain_until is None


async def test_a_message_never_wakes_a_paused_box(rls_harness: RLSHarness) -> None:
    from switch_core.gateway.cloud_controllers import wake_controller_machine

    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, [(_x, controller_id)] = await _box(rls_harness, user_id, [x])
    await _access(rls_harness, FakeRevoker()).pause(
        actor_id=operator_id, user_id=user_id, reason="Misuse"
    )
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            await wake_controller_machine(
                session, controller_id, datetime.now(UTC), "message"
            )
            await session.commit()
    machine = await _machine(rls_harness, machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "paused")


async def _mark_revoked(
    rls_harness: RLSHarness, tenant_id: str, controller_id: str, revoked_by: str | None
) -> datetime:
    """What the real revoke leaves on the controller's row: the fake revoker only
    records the call and its reason."""
    at = datetime.now(UTC) - timedelta(minutes=1)
    with tenant_scope(tenant_id):
        async with rls_harness.owner() as session:
            controller = await session.get(AgentController, controller_id)
            controller.revoked_at = at
            controller.revoked_by = revoked_by
            await session.commit()
    return at


async def _controller(rls_harness: RLSHarness, tenant_id: str, controller_id: str):
    with tenant_scope(tenant_id):
        async with rls_harness.owner() as session:
            return await session.get(AgentController, controller_id)


async def _wake_lifted(rls_harness: RLSHarness, tenant_id: str, controller_id: str):
    from switch_core.gateway.cloud_controllers import wake_lifted_machine

    with tenant_scope(tenant_id):
        async with rls_harness.restricted() as session:
            woken = await wake_lifted_machine(session, controller_id, datetime.now(UTC))
            await session.commit()
            return woken


async def _block(
    access: HostedAccess, lift: str, operator_id, user_id, tenant_id
) -> None:
    if lift == "pause":
        await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    else:
        await access.set_member(
            actor_id=operator_id,
            tenant_id=tenant_id,
            user_id=user_id,
            enabled=False,
            reason="Left",
        )


async def _lift(
    access: HostedAccess, lift: str, operator_id, user_id, tenant_id
) -> None:
    if lift == "pause":
        await access.resume(actor_id=operator_id, user_id=user_id, reason="Cleared")
    else:
        await access.set_member(
            actor_id=operator_id,
            tenant_id=tenant_id,
            user_id=user_id,
            enabled=True,
            reason="Back",
        )


@pytest.mark.parametrize("lift", ["pause", "turn_off"])
@pytest.mark.usefixtures("hosted_v2_on")
async def test_after_a_lift_a_message_for_the_blocks_revoked_controller_wakes_the_box(
    rls_harness: RLSHarness, lift: str
) -> None:
    """The pause (or turn-off) revoked the box's controller, marked as its own.
    After the resume (or turn-on), a message for its agents, still placed on that
    controller, wakes the box with a new revision, so the scaler asks `prepare` for a
    fresh one-time code and the box enrols a new controller. The revoked row is left
    exactly as it was."""
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, [(_x, controller_id)] = await _box(rls_harness, user_id, [x])
    revoker = FakeRevoker()
    access = _access(rls_harness, revoker)
    await _block(access, lift, operator_id, user_id, x)
    await _set_state(rls_harness, machine_id, "stopped")
    for task in list(access.pending):
        await task
    assert revoker.reasons == [lift]  # the block asks for its own mark
    revoked_at = await _mark_revoked(rls_harness, x, controller_id, lift)
    await _lift(access, lift, operator_id, user_id, x)
    before = (await _machine(rls_harness, machine_id)).revision

    assert await _wake_lifted(rls_harness, x, controller_id) is not None

    machine = await _machine(rls_harness, machine_id)
    assert machine.desired_state == "running" and machine.stop_reason is None
    assert machine.revision > before  # a new revision: prepared again, a fresh code
    controller = await _controller(rls_harness, x, controller_id)
    assert (controller.revoked_at, controller.revoked_by) == (revoked_at, lift)


async def test_a_message_during_the_pause_still_doesnt_wake_the_box(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, [(_x, controller_id)] = await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
    await _mark_revoked(rls_harness, x, controller_id, "pause")
    revision = (await _machine(rls_harness, machine_id)).revision

    await _wake_lifted(rls_harness, x, controller_id)

    machine = await _machine(rls_harness, machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "paused")
    assert machine.revision == revision


@pytest.mark.parametrize("pause_first", [True, False])
async def test_a_revoke_that_wasnt_a_hosted_block_never_wakes_the_box(
    rls_harness: RLSHarness, pause_first: bool
) -> None:
    """Only a lifted pause or turn-off counts. A controller revoked any other
    way (no mark), or whose pause revoke a later revoke overrode (the mark cleared),
    stays down on a message, even with the owner free to use hosted agents."""
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, [(_x, controller_id)] = await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    if pause_first:
        await access.pause(actor_id=operator_id, user_id=user_id, reason="Misuse")
        await _set_state(rls_harness, machine_id, "stopped")
        for task in list(access.pending):
            await task
        await _mark_revoked(rls_harness, x, controller_id, "pause")
        # Then the owner removes it, which clears the mark (ManagementService._revoke).
        await _mark_revoked(rls_harness, x, controller_id, None)
        await access.resume(actor_id=operator_id, user_id=user_id, reason="Cleared")
    else:
        await _mark_revoked(rls_harness, x, controller_id, None)
        async with rls_harness.owner() as session:
            machine = await session.get(CloudMachine, machine_id)
            CloudMachineStore().stop(machine, "idle", datetime.now(UTC))
            await session.commit()
    asleep = await _machine(rls_harness, machine_id)

    assert await _wake_lifted(rls_harness, x, controller_id) is None

    machine = await _machine(rls_harness, machine_id)
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        asleep.desired_state,
        asleep.stop_reason,
        asleep.revision,
    )
    assert asleep.desired_state == "stopped"


async def test_turning_on_again_lets_the_next_message_wake_the_box(
    rls_harness: RLSHarness,
) -> None:
    user_id, admin_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=False, reason="Left"
    )
    for task in list(access.pending):
        await task
    assert (await _machine(rls_harness, machine_id)).stop_reason == "turned_off"
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=True, reason="Back"
    )
    machine = await _machine(rls_harness, machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "idle")


async def test_turning_on_a_paused_person_leaves_the_pause(
    rls_harness: RLSHarness,
) -> None:
    user_id, admin_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    await access.pause(actor_id=admin_id, user_id=user_id, reason="Misuse")
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=True, reason="Back"
    )
    assert (await _machine(rls_harness, machine_id)).stop_reason == "paused"


async def test_the_clean_up_sweep_leaves_a_turned_off_box_as_it_is(
    rls_harness: RLSHarness,
) -> None:
    from switch_core.db.stores.hosted_machine_store import workspaces_on
    from switch_core.gateway.hosted_controller import _sweep

    user_id, admin_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    access = _access(rls_harness, FakeRevoker())
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=False, reason="Left"
    )
    for task in list(access.pending):
        await task
    later = datetime.now(UTC) + timedelta(days=30)
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        workspaces = await workspaces_on(rls_harness.owner, machine_id)
        await _sweep(
            session, machine, workspaces, idle_minutes=1, retention_days=7, now=later
        )
        await session.commit()
    machine = await _machine(rls_harness, machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "turned_off")
    assert machine.retain_until is None


async def test_the_admins_reason_stays_in_the_workspace_never_the_operators_copy(
    rls_harness: RLSHarness,
) -> None:
    """An admin's reason may hold a name, and operators see ids only."""
    user_id, admin_id, [x] = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await access.set_member(
        actor_id=admin_id,
        tenant_id=x,
        user_id=user_id,
        enabled=False,
        reason="Ada asked for this",
    )
    for task in list(access.pending):
        await task
    copies = [
        e
        for e in await _server_entries(rls_harness)
        if e.action == ServerAuditAction.HOSTED_ADMIN_CHANGE
        and e.target_id == KEY.keyed_id(KeyedIdKind.USER, user_id)
    ]
    assert copies
    for copy in copies:
        assert "reason" not in copy.details
        assert "Ada" not in repr(copy.details)
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            [change] = (
                (
                    await session.execute(
                        select(AuditEvent).where(
                            AuditEvent.action == AuditAction.HOSTED_PERSON_TURNED_OFF,
                            AuditEvent.details["linked_to"].astext.is_(None),
                        )
                    )
                )
                .scalars()
                .all()
            )
    assert change.details["reason"] == "Ada asked for this"


async def test_a_turn_off_whose_box_never_stops_raises_the_alert_and_turn_on_clears_it(
    rls_harness: RLSHarness,
) -> None:
    user_id, admin_id, [x] = await _world(rls_harness)
    await _box(rls_harness, user_id, [x])  # the only workspace; never reports stopped
    alerts = Alerts()
    access = _access(rls_harness, FakeRevoker())
    access.alert = alerts
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=False, reason="Left"
    )
    for task in list(access.pending):
        await task
    user = KEY.keyed_id(KeyedIdKind.USER, user_id)
    workspace = KEY.keyed_id(KeyedIdKind.WORKSPACE, x)
    assert alerts.off == [(user, workspace, True)]
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            outcome = (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.action == AuditAction.HOSTED_PERSON_TURNED_OFF,
                        AuditEvent.details["linked_to"].astext.is_not(None),
                    )
                )
            ).scalar_one()
    assert outcome.details["result"] == "failed"
    assert outcome.details["failed_at"] == "scale"
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=True, reason="Back"
    )
    assert alerts.off[-1] == (user, workspace, False)


async def test_a_turn_off_on_a_shared_box_with_a_confirmed_revoke_raises_nothing(
    rls_harness: RLSHarness,
) -> None:
    user_id, admin_id, [x, y] = await _world(rls_harness, workspaces=2)
    await _box(rls_harness, user_id, [x, y])
    alerts = Alerts()
    access = _access(rls_harness, FakeRevoker())
    access.alert = alerts
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=False, reason="Left"
    )
    for task in list(access.pending):
        await task
    assert all(raised is False for _, _, raised in alerts.off)


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_pause_survives_its_box_row_going(rls_harness: RLSHarness) -> None:
    """The mark is on the user: removing the box row (as the disk clean-up
    would) leaves the user paused, and a fresh claim is refused."""
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    await _access(rls_harness, FakeRevoker()).pause(
        actor_id=operator_id, user_id=user_id, reason="Misuse"
    )
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        machine.state, machine.desired_state = "deleted", "deleted"
        await session.commit()
    assert (
        await block_reason(rls_harness.restricted, user_id, x)
        is StopReason.PAUSED_BY_SWITCH
    )
    with tenant_scope(x):
        async with rls_harness.owner() as session:
            with pytest.raises(CloudMachineConflict, match="paused"):
                await CloudMachineStore().claim(
                    session,
                    rls_harness.owner,
                    owner_id=user_id,
                    capacity=10,
                    now=datetime.now(UTC),
                )
            await session.rollback()


async def test_paused_since_reads_many_owners_at_once(rls_harness: RLSHarness) -> None:
    from switch_core.visibility.hosted_access import paused_since

    user_id, operator_id, _ = await _world(rls_harness)
    await _access(rls_harness, FakeRevoker()).pause(
        actor_id=operator_id, user_id=user_id, reason="Misuse"
    )
    async with rls_harness.owner() as session:
        found = await paused_since(session, [user_id, operator_id])
    assert set(found) == {user_id}  # the operator isn't paused
    assert found[user_id] is not None


# ── Operators name a user by keyed id ───────────────


async def test_a_keyed_id_is_resolved_by_recomputing_and_pauses_that_user(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    keyed = KEY.keyed_id(KeyedIdKind.USER, user_id)
    assert await access.resolve_user(keyed) == user_id
    await access.by_keyed_id(
        action="pause", actor_id=operator_id, user_keyed_id=keyed, reason="Misuse"
    )
    assert (
        await block_reason(rls_harness.restricted, user_id, None)
        is StopReason.PAUSED_BY_SWITCH
    )
    await access.by_keyed_id(
        action="resume", actor_id=operator_id, user_keyed_id=keyed, reason="Cleared"
    )
    assert await block_reason(rls_harness.restricted, user_id, None) is None


async def test_an_unknown_keyed_id_is_a_404_audited_as_failed_not_found(
    rls_harness: RLSHarness,
) -> None:
    _, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    nobody = KEY.keyed_id(KeyedIdKind.USER, "no-such-user")
    with pytest.raises(LookupError):
        await access.by_keyed_id(
            action="pause", actor_id=operator_id, user_keyed_id=nobody, reason="Misuse"
        )
    mine = [e for e in await _server_entries(rls_harness) if e.target_id == nobody]
    assert [e.details["phase"] for e in mine] == ["requested", "result"]
    assert (mine[1].details["result"], mine[1].details["step"]) == (
        "failed",
        "not_found",
    )


async def test_a_raw_id_or_a_workspace_keyed_id_never_resolves_to_a_user(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    before = len(await _server_entries(rls_harness))
    for wrong in (user_id, KEY.keyed_id(KeyedIdKind.WORKSPACE, x), "k1-zz"):
        assert await access.resolve_user(wrong) is None
        with pytest.raises(LookupError):
            await access.by_keyed_id(
                action="pause", actor_id=operator_id, user_keyed_id=wrong, reason="r"
            )
    # A raw or malformed id writes nothing (it isn't an id the log takes); the
    # well-formed workspace id is audited as not found, like any unknown id.
    assert len(await _server_entries(rls_harness)) == before + 2
    assert await block_reason(rls_harness.restricted, user_id, None) is None


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_message_in_another_workspace_wakes_a_box_turned_off_elsewhere(
    rls_harness: RLSHarness,
) -> None:
    """A shared box stopped by a partial turn-off in X serves Y again on Y's
    next message; X stays blocked."""
    from switch_core.gateway.cloud_controllers import wake_controller_machine

    user_id, admin_id, [x, y] = await _world(rls_harness, workspaces=2)
    machine_id, controllers = await _box(rls_harness, user_id, [x, y])
    controller_in = dict(controllers)
    with tenant_scope(x):
        async with rls_harness.owner() as session:
            member = await session.get(TenantMember, (x, user_id))
            member.hosted_enabled = False
            await session.commit()
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        CloudMachineStore().stop(machine, "turned_off", datetime.now(UTC))
        await session.commit()
    # X's message: no wake.
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            await wake_controller_machine(
                session, controller_in[x], datetime.now(UTC), "message"
            )
            await session.commit()
    assert (await _machine(rls_harness, machine_id)).desired_state == "stopped"
    # Y's message: the box starts for Y.
    with tenant_scope(y):
        async with rls_harness.restricted() as session:
            await wake_controller_machine(
                session, controller_in[y], datetime.now(UTC), "message"
            )
            await session.commit()
    machine = await _machine(rls_harness, machine_id)
    assert machine.desired_state == "running" and machine.stop_reason is None
    assert (
        await block_reason(rls_harness.restricted, user_id, x)
        is StopReason.TURNED_OFF_BY_ADMIN
    )


class _OpenStreams(FakeRevoker):
    """A revoke whose streams never close, so the turn-off is `partial`."""


async def test_a_partial_turn_off_on_a_shared_box_is_a_one_off_stop_not_a_mark(
    rls_harness: RLSHarness,
) -> None:
    user_id, admin_id, [x, y] = await _world(rls_harness, workspaces=2)
    machine_id, controllers = await _box(rls_harness, user_id, [x, y])
    for tenant_id, controller_id in controllers:
        with tenant_scope(tenant_id):
            async with rls_harness.owner() as session:
                row = await session.get(AgentController, controller_id)
                row.connected_at, row.disconnected_at = datetime.now(UTC), None
                await session.commit()
    access = _access(rls_harness, _OpenStreams())
    await access.set_member(
        actor_id=admin_id, tenant_id=x, user_id=user_id, enabled=False, reason="Left"
    )
    for task in list(access.pending):
        await task
    machine = await _machine(rls_harness, machine_id)
    # Stopped at once, but asleep (`idle`), not labelled: Y's next message wakes it.
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "idle")
    assert (
        await block_reason(rls_harness.restricted, user_id, x)
        is StopReason.TURNED_OFF_BY_ADMIN
    )

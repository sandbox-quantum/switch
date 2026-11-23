"""A suspended owner's hosted agents v2 box: stopped at once, never woken,
started, claimed or given a controller while the suspension lasts, and asleep
again (so the next message wakes it) once it's lifted. Against Postgres, with
real agent management."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.suspension import Suspender, suspend_user, unsuspend_user
from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import CloudMachine, ServerAuditEvent
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_SUSPENDED,
    CloudMachineConflict,
    CloudMachineStore,
    lock_claims,
)
from switch_core.gateway.cloud_controllers import wake_controller_machine
from switch_core.visibility.hosted_access import block_reason
from switch_core.visibility.reason_codes import StopReason
from tests.switch_core.gateway.test_cloud_controller_machines import (
    HEADERS,
    _enroll,
    _hosted_app,
    _machine,
    _prepare,
)
from tests.switch_core.gateway.test_machine_revival import _claim
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    build_harness,
    report_status,
)

OPERATOR = Suspender(user_id=None, role="operator")


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _box(harness: Harness, owner, hosted, client) -> SimpleNamespace:
    """A box machine whose controller enrolled and has a token."""
    machine = await _claim(harness.session_factory, owner, backend="box")
    [entry] = (await _prepare(hosted, machine.id))["controllers"]
    enrolled = await _enroll(client, entry["enrollment_code"])
    token = await client.post(
        f"/v1/management/controllers/{enrolled['controller_id']}/token",
        json={"credential": enrolled["credential"]},
    )
    assert token.status_code == 200, token.text
    controller = SimpleNamespace(
        controller_id=enrolled["controller_id"],
        credential=enrolled["credential"],
        access_token=token.json()["access_token"],
        owner=owner,
        harness=harness,
        headers=bearer(token.json()["access_token"]),
    )
    return SimpleNamespace(
        machine_id=machine.id, controller=controller, hosted=hosted, client=client
    )


async def _ready(box: SimpleNamespace) -> None:
    """The scaler's `running`, then the controller's report: ready."""
    machine = await _machine(box.controller.harness.session_factory, box.machine_id)
    answer = await box.hosted.post(
        f"/hosted-controller/machines/{box.machine_id}/observation",
        headers=HEADERS,
        json={"state": "running", "revision": machine.revision},
    )
    assert answer.status_code == 200, answer.text
    reported = await report_status(box.client, box.controller, 1)  # type: ignore[arg-type]
    assert reported.status_code == 200, reported.text


async def _state(harness: Harness, box: SimpleNamespace) -> CloudMachine:
    return await _machine(harness.session_factory, box.machine_id)


async def _suspend(harness: Harness, user_id: str) -> None:
    await suspend_user(
        harness.session_factory, user_id=user_id, by=OPERATOR, reason="testing"
    )


async def _lift(harness: Harness, user_id: str) -> None:
    await unsuspend_user(harness.session_factory, user_id=user_id, by=OPERATOR)


async def _wake(harness: Harness, controller_id: str) -> None:
    async with harness.session_factory() as session:
        await wake_controller_machine(
            session, controller_id, datetime.now(UTC), "message"
        )
        await session.commit()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_suspending_the_owner_stops_a_running_box_at_once(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _ready(box)
        before = await _state(harness, box)
        assert (before.state, before.desired_state) == ("ready", "running")
        await _suspend(harness, owner.id)
        after = await _state(harness, box)
    assert (after.desired_state, after.stop_reason) == ("stopped", "suspended")
    assert after.revision == before.revision + 1  # the scaler stops it now
    async with harness.session_factory() as session:
        audited = await session.scalar(
            select(ServerAuditEvent).where(
                ServerAuditEvent.action == ServerAuditAction.USER_SUSPENDED
            )
        )
    assert audited is not None and audited.details["box_stopped"] is True


@pytest.mark.usefixtures("hosted_v2_on")
async def test_while_suspended_nothing_starts_wakes_or_enrols_the_box(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _ready(box)
        await _suspend(harness, owner.id)
        stopped = await _state(harness, box)

        # A message to one of its agents: no wake.
        await _wake(harness, box.controller.controller_id)
        assert (await _state(harness, box)).desired_state == "stopped"
        # The owner's (or anyone's) start: refused.
        async with harness.session_factory() as session:
            machine = await CloudMachineStore().locked(session, box.machine_id)
            assert machine is not None
            with pytest.raises(CloudMachineConflict, match="suspended"):
                CloudMachineStore().start(machine, datetime.now(UTC))
            await session.rollback()
        # A claim: refused.
        async with harness.session_factory() as session:
            await lock_claims(session)
            with pytest.raises(CloudMachineConflict) as refused:
                await CloudMachineStore().claim(
                    session,
                    harness.session_factory,
                    owner_id=owner.id,
                    capacity=5,
                    now=datetime.now(UTC),
                )
            assert str(refused.value) == MACHINE_SUSPENDED
            await session.rollback()
        # The box asking to boot: no controller, no code.
        prepared = await hosted.post(
            f"/hosted-controller/machines/{box.machine_id}/prepare",
            headers=HEADERS,
        )
        assert prepared.status_code == 409
        # Every gate sees it blocked.
        assert (
            await block_reason(harness.session_factory, owner.id, None)
            is StopReason.PAUSED_BY_SWITCH
        )
        final = await _state(harness, box)
    assert (final.desired_state, final.stop_reason, final.revision) == (
        "stopped",
        "suspended",
        stopped.revision,
    )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_another_stop_never_replaces_the_suspension(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "ada")
    machine = await _claim(harness.session_factory, owner, backend="box")
    await _suspend(harness, owner.id)
    async with harness.session_factory() as session:
        row = await CloudMachineStore().locked(session, machine.id)
        assert row is not None
        for reason in ("idle", "owner", "paused", "turned_off"):
            CloudMachineStore().stop(row, reason, datetime.now(UTC))  # type: ignore[arg-type]
            assert row.stop_reason == "suspended"
        await session.rollback()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_lifting_it_leaves_the_box_asleep_and_a_message_wakes_it(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _ready(box)
        await _suspend(harness, owner.id)
        await _lift(harness, owner.id)
        asleep = await _state(harness, box)
        assert (asleep.desired_state, asleep.stop_reason) == ("stopped", "idle")
        await _wake(harness, box.controller.controller_id)
        woken = await _state(harness, box)
    assert woken.desired_state == "running"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_suspending_twice_or_with_no_box_is_harmless(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "ada")
    await _suspend(harness, owner.id)  # no box at all
    other = await add_member(harness.session_factory, "bea")
    machine = await _claim(harness.session_factory, other, backend="box")
    await _suspend(harness, other.id)
    async with harness.session_factory() as session:
        first = await CloudMachineStore().get(session, machine.id)
        assert first is not None
        revision = first.revision
    await _suspend(harness, other.id)  # a re-run
    async with harness.session_factory() as session:
        again = await CloudMachineStore().get(session, machine.id)
    assert again is not None
    assert (again.stop_reason, again.revision) == ("suspended", revision)


async def test_a_v1_machine_is_left_to_the_suspensions_own_refusals(
    harness: Harness,
) -> None:
    """A v1 machine's controller is already refused and disconnected by the
    suspension; its machine row isn't touched, exactly as before."""
    owner = await add_member(harness.session_factory, "ada")
    machine = await _claim(harness.session_factory, owner)  # a `vm`
    async with harness.session_factory() as session:
        before = await CloudMachineStore().get(session, machine.id)
        assert before is not None
        snapshot = (before.desired_state, before.stop_reason, before.revision)
    await _suspend(harness, owner.id)
    async with harness.session_factory() as session:
        after = await CloudMachineStore().get(session, machine.id)
    assert after is not None
    assert (after.desired_state, after.stop_reason, after.revision) == snapshot

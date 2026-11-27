"""`switch.hosted.start_seconds`: a v2 box start, timed from the person's first
request that needs it, in stages that add up to `total`, tagged by case and
stage only. Against Postgres, with real agent management, except the pure
stage arithmetic and the catalogue checks."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import box_cluster
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.stores.hosted_machine_store import CloudMachineStore
from switch_core.gateway.cloud_controllers import (
    FIRST_CLICK_KEY,
    START_KEY,
    note_start_click,
    start_segments,
)
from switch_core.observability.catalogue import HOSTED_START_SECONDS
from switch_core.observability.hosted import (
    START_CASES,
    START_STAGES,
    record_start_stage,
)
from switch_core.observability.metrics import MetricsRegistry
from tests.switch_core.gateway.test_box_ready_both_orders import (
    _box,
    _report,
    _running,
    _state,
)
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _hosted_app,
    hosted_metrics,  # noqa: F401  (fixture)
)
from tests.switch_core.management.harness import Harness, add_member, build_harness

T0 = datetime(2026, 11, 19, 12, 0, tzinfo=UTC)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _stages(registry: MetricsRegistry) -> dict[tuple[str, str], tuple[int, float]]:
    """(case, stage) to (count, seconds) of every start reading collected."""
    found: dict[tuple[str, str], tuple[int, float]] = {}
    for payload in registry.collect():
        if payload.name != HOSTED_START_SECONDS.name:
            continue
        for point in payload.histograms:
            attributes = dict(point.attributes)
            assert set(attributes) == {"case", "stage"}  # nothing else, ever
            found[(attributes["case"], attributes["stage"])] = (
                point.count,
                point.total,
            )
    return found


# ── the arithmetic, and the words ──


def test_stages_add_up_to_the_clock_to_the_last_stage() -> None:
    marks = [
        ("box_requested", T0 - timedelta(minutes=5)),  # asked for at sign-up
        ("box_claimed", T0 + timedelta(seconds=3)),
        ("box_provisioned", None),  # not recorded: folded into the next
        ("box_running", T0 + timedelta(seconds=10)),
        ("controller_reported", T0 + timedelta(seconds=8)),  # before running
        ("ready", T0 + timedelta(seconds=12)),
    ]
    segments = start_segments(T0, marks)
    assert segments == [
        ("box_requested", 0.0),
        ("box_claimed", 3.0),
        ("box_running", 7.0),
        ("controller_reported", 0.0),
        ("ready", 2.0),
    ]
    assert sum(seconds for _, seconds in segments) == 12.0


def test_only_the_fixed_words_are_recorded(hosted_metrics: MetricsRegistry) -> None:  # noqa: F811
    assert HOSTED_START_SECONDS.attributes == frozenset({"case", "stage"})
    record_start_stage("first_start", "total", 5.0)
    record_start_stage("someone@example.test", "total", 5.0)
    record_start_stage("wake", "machine-1234", 5.0)
    record_start_stage("wake", "total", -1.0)
    found = _stages(hosted_metrics)
    assert found == {("first_start", "total"): (1, 5.0)}
    assert set(START_CASES) == {"first_start", "wake"}
    assert "total" in START_STAGES and "since_box_request" in START_STAGES


# ── on the database ──


async def _provisioned(harness: Harness, machine_id: str, *, asked: datetime) -> None:
    """The operator's request, claim and result for the box, as the
    provisioner records them, at known times."""
    async with harness.session_factory() as session:
        request = await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id="k1-box",
            details={"phase": "requested", "by": "core", "machine_id": machine_id},
        )
        request.occurred_at = asked
        for step, after in (
            ({"phase": "progress", "step": "claimed"}, 2),
            ({"phase": "result", "result": "done"}, 5),
        ):
            row = await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.HOSTED_BOX_PROVISION,
                target_type="box",
                target_id="k1-box",
                details={**step, "linked_to": request.id, "machine_id": machine_id},
            )
            row.occurred_at = asked + timedelta(seconds=after)
        await session.commit()


async def _click(harness: Harness, machine_id: str, at: datetime) -> None:
    async with harness.session_factory() as session:
        machine = await CloudMachineStore().locked(session, machine_id)
        assert machine is not None
        note_start_click(machine, at)
        await session.commit()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_first_start_is_timed_from_the_click_in_stages_that_add_up(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        clicked = datetime.now(UTC) - timedelta(seconds=30)
        await _click(harness, box.machine_id, clicked)
        # Asked for at sign-up, well before the click.
        await _provisioned(
            harness, box.machine_id, asked=clicked - timedelta(minutes=10)
        )
        await _report(box, 1)
        await _running(box)
        assert (await _state(harness, box)).state == "ready"
    found = _stages(hosted_metrics)
    total_count, total = found[("first_start", "total")]
    assert total_count == 1 and 25 <= total <= 120
    parts = [
        found[("first_start", stage)][1]
        for stage in START_STAGES
        if ("first_start", stage) in found
        and stage not in ("total", "since_box_request")
    ]
    assert abs(sum(parts) - total) < 0.01  # the stages add up to the total
    assert found[("first_start", "box_requested")][1] == 0.0  # asked for earlier
    assert found[("first_start", "since_box_request")][1] >= 600
    assert not [key for key in found if key[0] == "wake"]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_wake_is_timed_without_provision_stages(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        await _running(box)
        assert (await _state(harness, box)).state == "ready"
        hosted_metrics.collect()  # the first start's readings, set aside
        async with harness.session_factory() as session:
            machine = await CloudMachineStore().locked(session, box.machine_id)
            assert machine is not None
            CloudMachineStore().stop(machine, "idle", datetime.now(UTC))
            await session.commit()
        woken = await hosted.post(
            f"/hosted-machines/{box.machine_id}/lifecycle",
            json={"action": "start", "revision": (await _state(harness, box)).revision},
        )
        assert woken.status_code == 200, woken.text
        machine = await _state(harness, box)
        assert machine.heartbeat is not None
        assert machine.heartbeat[START_KEY]["case"] == "wake"
        await _report(box, 2)
        await _running(box)
        assert (await _state(harness, box)).state == "ready"
    found = _stages(hosted_metrics)
    assert found[("wake", "total")][0] == 1
    assert not [
        key for key in found if key[1].startswith("box_") and key[1] != "box_running"
    ]
    parts = [
        found[("wake", stage)][1]
        for stage in ("box_running", "controller_reported", "ready")
        if ("wake", stage) in found
    ]
    assert abs(sum(parts) - found[("wake", "total")][1]) < 0.01


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_first_click_on_a_box_already_ready_is_a_first_start_of_nothing(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        await _running(box)
        hosted_metrics.collect()
        await _click(harness, box.machine_id, datetime.now(UTC))
        await _click(harness, box.machine_id, datetime.now(UTC))  # the next visit
        machine = await _state(harness, box)
    assert _stages(hosted_metrics) == {("first_start", "total"): (1, 0.0)}
    assert machine.heartbeat is not None and FIRST_CLICK_KEY in machine.heartbeat


async def test_with_v2_off_no_clock_is_kept(harness: Harness, monkeypatch) -> None:
    monkeypatch.setattr(box_cluster, "_process_on", False)
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client, backend="vm")
        await _click(harness, box.machine_id, datetime.now(UTC))
        machine = await _state(harness, box)
    assert START_KEY not in (machine.heartbeat or {})
    assert FIRST_CLICK_KEY not in (machine.heartbeat or {})

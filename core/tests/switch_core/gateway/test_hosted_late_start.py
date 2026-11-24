"""A v2 box start given up on (the box scaler's `machine_needs_attention`, or
Core's `machine_connect_timeout`) whose box comes up anyway: within the grace
period it's the person's start after all; after it, Core stops the box. A box
in error never keeps its proxy login. Against Postgres, with real agent
management."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import CloudMachine
from switch_core.db.stores.hosted_machine_store import CloudMachineStore
from switch_core.gateway.cloud_controllers import LATE_GRACE
from switch_core.gateway.hosted_controller import machine_item, sweep_hosted_machines
from tests.switch_core.gateway.test_box_ready_both_orders import (
    HEADERS,
    Box,
    _box,
    _report,
    _running,
    _state,
)
from tests.switch_core.gateway.test_cloud_controller_machines import _hosted_app
from tests.switch_core.management.harness import Harness, add_member, build_harness

pytestmark = pytest.mark.usefixtures("hosted_v2_on")


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _gave_up(box: Box, harness: Harness, code: str, ago: timedelta) -> None:
    """The start given up on `ago`: the scaler's error report, or Core's own
    timeout, as the row records either."""
    async with harness.session_factory() as session:
        machine = await CloudMachineStore().locked(session, box.machine_id)
        assert machine is not None
        machine.state = "error"
        machine.error_code = code
        machine.error = "given up"
        machine.updated_at = datetime.now(UTC) - ago
        await session.commit()


async def _scaler_gives_up(box: Box, harness: Harness) -> None:
    machine = await _state(harness, box)
    answer = await box.hosted.post(
        f"/hosted-controller/machines/{box.machine_id}/observation",
        headers=HEADERS,
        json={
            "state": "error",
            "revision": machine.revision,
            "error_code": "machine_needs_attention",
        },
    )
    assert answer.status_code == 200, answer.text


async def _sweep(harness: Harness, box: Box) -> None:
    app = box.hosted._transport.app  # type: ignore[attr-defined]
    from switch_core.gateway.dependencies import get_config

    config = app.dependency_overrides[get_config]()
    async with harness.session_factory() as session:
        await sweep_hosted_machines(
            session,
            harness.session_factory,
            config,
            app.state.hosted_controller_settings,
            datetime.now(UTC),
        )
        await session.commit()


@pytest.mark.parametrize("order", ["running_first", "report_first"])
async def test_a_box_up_within_the_grace_period_is_ready_after_all(
    harness: Harness, order: str
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _scaler_gives_up(box, harness)
        given_up = await _state(harness, box)
        assert (given_up.state, given_up.error_code) == (
            "error",
            "machine_needs_attention",
        )
        if order == "running_first":
            await _running(box)
            assert (await _state(harness, box)).state == "provisioning"
            await _report(box, 1)
        else:
            await _report(box, 1)
            assert (await _state(harness, box)).state == "provisioning"
            await _running(box)
        ready = await _state(harness, box)
    assert (ready.state, ready.error_code, ready.desired_state) == (
        "ready",
        None,
        "running",
    )
    assert ready.revision == given_up.revision


@pytest.mark.parametrize("code", ["machine_needs_attention", "machine_connect_timeout"])
async def test_after_the_grace_period_the_box_is_stopped_and_retry_restarts_it(
    harness: Harness, code: str
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _gave_up(box, harness, code, LATE_GRACE + timedelta(minutes=1))
        before = await _state(harness, box)
        # Too late to be taken as its start.
        await _running(box)
        assert (await _state(harness, box)).state == "error"

        await _sweep(harness, box)
        stopped = await _state(harness, box)
        assert (stopped.state, stopped.desired_state, stopped.error_code) == (
            "error",
            "stopped",
            code,
        )
        assert stopped.revision == before.revision + 1  # the scaler stops it
        assert stopped.stop_reason is None
        await _sweep(harness, box)  # once only
        assert (await _state(harness, box)).revision == stopped.revision

        retried = await hosted.post(
            f"/hosted-machines/{box.machine_id}/lifecycle",
            json={"action": "retry", "revision": stopped.revision},
        )
        assert retried.status_code == 200, retried.text
        again = await _state(harness, box)
    assert (again.state, again.desired_state) == ("queued", "running")


async def test_within_the_grace_period_the_sweep_leaves_it_running(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _gave_up(box, harness, "machine_needs_attention", timedelta(minutes=5))
        await _sweep(harness, box)
        machine = await _state(harness, box)
    assert (machine.state, machine.desired_state) == ("error", "running")


@pytest.mark.parametrize(
    ("code", "desired"),
    [
        ("box_not_made", "stopped"),
        ("box_missing", "running"),
        ("machine_needs_attention", "retained"),
        ("machine_needs_attention", "deleted"),
    ],
)
async def test_other_errors_and_other_wishes_are_left_alone(
    harness: Harness, code: str, desired: str
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _gave_up(box, harness, code, timedelta(minutes=1))
        async with harness.session_factory() as session:
            machine = await CloudMachineStore().locked(session, box.machine_id)
            assert machine is not None
            machine.desired_state = desired
            await session.commit()
        before = await _state(harness, box)
        await _report(box, 1)
        after = await _state(harness, box)
    assert (after.state, after.error_code, after.desired_state, after.revision) == (
        "error",
        code,
        desired,
        before.revision,
    )


def _machine(**values: object) -> CloudMachine:
    base: dict[str, object] = {
        "id": "m-1",
        "state": "ready",
        "desired_state": "running",
        "revision": 1,
        "data_volume_id": None,
        "retain_until": None,
        "backend": "box",
        "error_code": None,
        "updated_at": datetime.now(UTC) - timedelta(hours=1),
    }
    return CloudMachine(**{**base, **values})


@pytest.mark.parametrize(
    ("state", "desired", "egress"),
    [
        ("ready", "running", True),
        ("provisioning", "running", True),
        ("stopped", "stopped", True),
        ("error", "running", False),
        ("error", "stopped", False),
        ("ready", "deleted", False),
    ],
)
def test_a_box_in_error_or_being_deleted_keeps_no_login(
    state: str, desired: str, egress: bool
) -> None:
    item = machine_item(_machine(state=state, desired_state=desired))
    assert item["egress"] is egress


def test_a_given_up_box_keeps_its_login_through_the_grace_period() -> None:
    """A box waiting in its starter needs its login to come up and be taken
    back; once past the grace (or stopped by the sweep) it has none."""
    fresh = _machine(
        state="error",
        error_code="machine_needs_attention",
        updated_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    assert machine_item(fresh)["egress"] is True
    late = _machine(state="error", error_code="machine_needs_attention")
    assert machine_item(late)["egress"] is False
    stopped = _machine(
        state="error",
        desired_state="stopped",
        error_code="machine_needs_attention",
        updated_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    assert machine_item(stopped)["egress"] is False


def test_a_v1_machine_carries_no_egress_word() -> None:
    assert "egress" not in machine_item(_machine(backend="vm", state="error"))

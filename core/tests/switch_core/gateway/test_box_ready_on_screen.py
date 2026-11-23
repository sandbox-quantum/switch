"""F1 on screen: a v2 box made ready by its controller's report and then the
scaler's `running` is ready in the owner's summary at once, not only at the
controller's next report. A report counts for its own workspace when it was
made at the machine's current revision, by that workspace's own live,
unrevoked controller (`cloud_controllers.workspace_reported`). v1 unchanged."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_v2
from switch_core.gateway.cloud_controllers import workspace_reported
from tests.switch_core.gateway.test_box_ready_both_orders import (
    _box,
    _report,
    _running,
    _state,
)
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _hosted_app,
    _new_revision,
)
from tests.switch_core.management.harness import Harness, add_member, build_harness

T0 = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _machine(**values: object) -> SimpleNamespace:
    """A box seen running at T0, whose workspace `w` reported 5 s earlier,
    at revision 3, by controller `c`."""
    base: dict[str, object] = {
        "backend": "box",
        "revision": 3,
        "running_observed_at": T0,
        "heartbeat": {
            "controllers": {
                "w": {
                    "at": (T0 - timedelta(seconds=5)).isoformat(),
                    "revision": 3,
                    "controller_id": "c",
                }
            }
        },
    }
    return SimpleNamespace(**{**base, **values})


def _controller(**values: object) -> SimpleNamespace:
    return SimpleNamespace(
        **{"id": "c", "revoked_at": None, "api_key_id": "k", **values}
    )


# ── the rule ──


@pytest.mark.usefixtures("hosted_v2_on")
def test_a_report_at_this_revision_by_the_live_controller_counts() -> None:
    assert workspace_reported(_machine(), "w", _controller())  # type: ignore[arg-type]


@pytest.mark.usefixtures("hosted_v2_on")
def test_a_report_from_before_a_revision_bump_doesnt_count() -> None:
    assert not workspace_reported(_machine(revision=4), "w", _controller())  # type: ignore[arg-type]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    "controller",
    [
        None,
        _controller(id="another"),
        _controller(revoked_at=T0),
        _controller(api_key_id=None),
    ],
    ids=["none", "another_controller", "revoked", "no_key"],
)
def test_only_the_workspaces_own_live_controller_counts(
    controller: SimpleNamespace | None,
) -> None:
    assert not workspace_reported(_machine(), "w", controller)  # type: ignore[arg-type]


@pytest.mark.usefixtures("hosted_v2_on")
def test_a_report_counts_for_its_own_workspace_only() -> None:
    assert not workspace_reported(_machine(), "other", _controller())  # type: ignore[arg-type]


@pytest.mark.usefixtures("hosted_v2_on")
def test_a_v1_machine_is_unchanged() -> None:
    vm = _machine(backend="vm")
    assert not workspace_reported(vm, "w", _controller())  # type: ignore[arg-type]
    later = _machine(
        backend="vm",
        heartbeat={
            "controllers": {"w": {"at": (T0 + timedelta(seconds=1)).isoformat()}}
        },
    )
    assert workspace_reported(later, "w", _controller())  # type: ignore[arg-type]


def test_with_v2_off_only_a_later_report_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    assert not workspace_reported(_machine(), "w", _controller())  # type: ignore[arg-type]


# ── through the owner's route ──


@pytest.mark.usefixtures("hosted_v2_on")
async def test_report_first_then_running_is_ready_on_screen_at_once(
    harness: Harness,
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
        listed = await hosted.get("/hosted-machines")
        assert listed.status_code == 200, listed.text
        (machine,) = listed.json()["machines"]
    assert machine["state"] == "ready"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_report_before_a_revision_bump_isnt_ready_on_screen(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        await _new_revision(harness.session_factory, box.machine_id)
        await _running(box)
        listed = await hosted.get("/hosted-machines")
        (machine,) = listed.json()["machines"]
    assert machine["state"] != "ready"

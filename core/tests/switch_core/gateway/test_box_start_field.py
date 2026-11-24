"""`start` in the owner's machine summary: a v2 box still starting, as
`{kind, since, waiting_for_room}`, else null; absent with v2 off. `since` is the start-timing clock
already keeps (`note_start_click`), at the current revision. Against
Postgres, with real agent management, apart from the pure cases."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_v2
from switch_core.db.stores.hosted_machine_store import CloudMachineStore
from switch_core.gateway.cloud_controllers import (
    ROOM_KEY,
    START_KEY,
    note_waiting_for_room,
    start_summary,
)
from switch_core.gateway.hosted_controller import Observation
from tests.switch_core.gateway.test_box_missing import _app as _hosted_app
from tests.switch_core.gateway.test_box_missing import keyed_id_key  # noqa: F401
from tests.switch_core.gateway.test_box_ready_both_orders import (
    HEADERS,
    Box,
    _box,
    _report,
    _running,
    _state,
)
from tests.switch_core.management.harness import Harness, add_member, build_harness

T0 = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _machine(**values: object) -> SimpleNamespace:
    base: dict[str, object] = {
        "backend": "box",
        "desired_state": "running",
        "revision": 3,
        "first_ready_at": None,
        "heartbeat": {
            START_KEY: {
                "revision": 3,
                "case": "first_start",
                "clicked_at": T0.isoformat(),
            }
        },
    }
    return SimpleNamespace(**{**base, **values})


# ── the rule ──


def test_a_box_still_starting_says_since_when_and_which_kind() -> None:
    assert start_summary(_machine(), "queued") == {
        "kind": "first",
        "since": T0.isoformat(),
        "waiting_for_room": False,
    }
    woken = _machine(first_ready_at=T0 - timedelta(days=1))
    assert start_summary(woken, "provisioning") == {
        "kind": "wake",
        "since": T0.isoformat(),
        "waiting_for_room": False,
    }


@pytest.mark.parametrize("state", ["ready", "error", "stopped", "retained"])
def test_a_box_not_starting_says_nothing(state: str) -> None:
    assert start_summary(_machine(), state) is None


def test_a_box_not_wanted_running_or_a_v1_machine_says_nothing() -> None:
    assert start_summary(_machine(desired_state="stopped"), "provisioning") is None
    assert start_summary(_machine(backend="vm"), "provisioning") is None


def test_a_clock_from_another_revision_or_none_gives_no_since() -> None:
    stale = _machine(revision=4)  # the marker is revision 3's
    nothing = {"kind": "first", "since": None, "waiting_for_room": False}
    assert start_summary(stale, "queued") == nothing
    assert start_summary(_machine(heartbeat=None), "queued") == nothing
    garbled = _machine(
        heartbeat={START_KEY: {"revision": 3, "clicked_at": "not a time"}}
    )
    assert start_summary(garbled, "queued") == nothing


def test_waiting_for_room_holds_at_its_own_revision_until_cleared() -> None:
    machine = _machine()
    note_waiting_for_room(machine, True, T0)  # type: ignore[arg-type]
    assert start_summary(machine, "provisioning")["waiting_for_room"] is True  # type: ignore[index]
    note_waiting_for_room(machine, True, T0 + timedelta(minutes=1))  # type: ignore[arg-type]
    assert machine.heartbeat[ROOM_KEY]["since"] == T0.isoformat()  # kept
    machine.revision = 4  # a new start: an old word doesn't carry over
    assert start_summary(machine, "provisioning")["waiting_for_room"] is False  # type: ignore[index]
    machine.revision = 3
    note_waiting_for_room(machine, False, T0)  # type: ignore[arg-type]
    assert ROOM_KEY not in machine.heartbeat
    assert start_summary(machine, "provisioning")["waiting_for_room"] is False  # type: ignore[index]
    vm = _machine(backend="vm")
    note_waiting_for_room(vm, True, T0)  # type: ignore[arg-type]
    assert ROOM_KEY not in vm.heartbeat


# ── through the owner's route ──


async def _summary(hosted: httpx.AsyncClient) -> dict:
    listed = await hosted.get("/hosted-machines")
    assert listed.status_code == 200, listed.text
    (machine,) = listed.json()["machines"]
    return dict(machine)


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_summary_shows_a_first_start_then_null_once_ready(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness, owner) as hosted,
        harness.client() as client,
    ):
        before = datetime.now(UTC)
        ensured = await hosted.post("/hosted-machines/ensure")
        assert ensured.status_code == 200, ensured.text
        summary = await _summary(hosted)
        start = summary["start"]
        assert start is not None, summary
        assert start["kind"] == "first"
        assert datetime.fromisoformat(start["since"]) >= before - timedelta(seconds=1)

        box = await _box_of(harness, owner, hosted, client)
        await _report(box, 1)
        await _running(box)
        assert (await _state(harness, box)).state == "ready"
        after = await _summary(hosted)
        # Ready for this workspace too, at once: its controller reported
        # first, at this revision.
        assert after["state"] == "ready"
        assert after["start"] is None


async def _box_of(harness: Harness, owner, hosted, client) -> Box:
    """The owner's box, its controller enrolled (as `_box` makes one)."""
    return await _box(harness, owner, hosted, client)


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_wake_and_a_retry_each_show_their_own_start(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        await _running(box)
        async with harness.session_factory() as session:
            machine = await CloudMachineStore().locked(session, box.machine_id)
            assert machine is not None
            CloudMachineStore().stop(machine, "idle", datetime.now(UTC))
            await session.commit()
        assert (await _summary(hosted))["start"] is None  # asleep

        woke_at = datetime.now(UTC)
        woken = await hosted.post(
            f"/hosted-machines/{box.machine_id}/lifecycle",
            json={"action": "start", "revision": (await _state(harness, box)).revision},
        )
        assert woken.status_code == 200, woken.text
        start = woken.json()["machine"]["start"]
        assert start["kind"] == "wake"
        assert datetime.fromisoformat(start["since"]) >= woke_at - timedelta(seconds=1)

        async with harness.session_factory() as session:
            machine = await CloudMachineStore().locked(session, box.machine_id)
            assert machine is not None
            machine.state = "error"
            machine.error_code = "machine_connect_timeout"
            await session.commit()
        assert (await _summary(hosted))["start"] is None  # in error
        retried_at = datetime.now(UTC)
        retried = await hosted.post(
            f"/hosted-machines/{box.machine_id}/lifecycle",
            json={"action": "retry", "revision": (await _state(harness, box)).revision},
        )
        assert retried.status_code == 200, retried.text
        start = retried.json()["machine"]["start"]
        assert start["kind"] == "wake"
        assert datetime.fromisoformat(start["since"]) >= retried_at - timedelta(
            seconds=1
        )


async def test_with_v2_off_the_summary_has_no_start(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    owner = await add_member(harness.session_factory, "ada")
    async with _hosted_app(harness, owner) as hosted:
        ensured = await hosted.post("/hosted-machines/ensure")
        assert ensured.status_code == 200, ensured.text
        assert "start" not in await _summary(hosted)


async def _observe(box: Box, harness: Harness, **body: object) -> httpx.Response:
    machine = await _state(harness, box)
    return await box.hosted.post(
        f"/hosted-controller/machines/{box.machine_id}/observation",
        headers=HEADERS,
        json={"revision": machine.revision, **body},
    )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_scalers_waiting_for_room_shows_in_start_and_keeps_it_provisioning(
    harness: Harness,
) -> None:
    """A field, not a state: the box stays provisioning, `start` says it's
    waiting for room, and the next observation without it clears it."""
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        waiting = await _observe(
            box, harness, state="provisioning", waiting_for_room=True
        )
        assert waiting.status_code == 200, waiting.text
        summary = await _summary(hosted)
        assert summary["state"] == "provisioning"
        assert summary["start"]["waiting_for_room"] is True
        placed = await _observe(box, harness, state="provisioning")
        assert placed.status_code == 200, placed.text
        assert (await _summary(hosted))["start"]["waiting_for_room"] is False


def test_with_v2_off_the_field_is_refused_as_upstream_would(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The v1/v2 switch: with v2 off an observation naming it is checked by
    upstream's model alone, which refuses the unknown field (the box scaler
    then stops sending it)."""
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    with pytest.raises(ValidationError, match="waiting_for_room"):
        Observation.model_validate(
            {"state": "provisioning", "revision": 1, "waiting_for_room": True}
        )

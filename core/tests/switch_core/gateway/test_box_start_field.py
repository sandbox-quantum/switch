"""`start` in the owner's machine summary: a v2 box still starting, as
`{kind, since}`, else null; absent with v2 off. `since` is the start-timing clock
already keeps (`note_start_click`), at the current revision. Against
Postgres, with real agent management, apart from the pure cases."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_v2
from switch_core.db.stores.hosted_machine_store import CloudMachineStore
from switch_core.gateway.cloud_controllers import START_KEY, start_summary
from tests.switch_core.gateway.test_box_missing import _app as _hosted_app
from tests.switch_core.gateway.test_box_missing import keyed_id_key  # noqa: F401
from tests.switch_core.gateway.test_box_ready_both_orders import (
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
    }
    woken = _machine(first_ready_at=T0 - timedelta(days=1))
    assert start_summary(woken, "provisioning") == {
        "kind": "wake",
        "since": T0.isoformat(),
    }


@pytest.mark.parametrize("state", ["ready", "error", "stopped", "retained"])
def test_a_box_not_starting_says_nothing(state: str) -> None:
    assert start_summary(_machine(), state) is None


def test_a_box_not_wanted_running_or_a_v1_machine_says_nothing() -> None:
    assert start_summary(_machine(desired_state="stopped"), "provisioning") is None
    assert start_summary(_machine(backend="vm"), "provisioning") is None


def test_a_clock_from_another_revision_or_none_gives_no_since() -> None:
    stale = _machine(revision=4)  # the marker is revision 3's
    assert start_summary(stale, "queued") == {"kind": "first", "since": None}
    assert start_summary(_machine(heartbeat=None), "queued") == {
        "kind": "first",
        "since": None,
    }
    garbled = _machine(
        heartbeat={START_KEY: {"revision": 3, "clicked_at": "not a time"}}
    )
    assert start_summary(garbled, "queued") == {"kind": "first", "since": None}


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

"""One agent's shared-cloud card state, from its status entry, its box and its reason, as
Console's `/shared-cloud/agents` contract has it."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from switch_core.db.models import CloudMachine
from switch_core.visibility.reason_codes import StopReason
from switch_core.visibility.shared_cloud_agents import (
    overview_bucket,
    shared_cloud_agent,
)
from switch_core.visibility.stop_reasons import AgentStopReason

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
READY = CloudMachine(id="m", state="ready", desired_state="running")


def state(entry=None, box=READY, reason=None, desired="running"):  # type: ignore[no-untyped-def]
    return shared_cloud_agent(
        "a1", desired, entry, box, reason, "2026-10-29T11:00:00+00:00"
    )


def running(**over):  # type: ignore[no-untyped-def]
    return {"agent_id": "a1", "process": "running", "session": "active", **over}


def test_busy_tells_working_from_idle():
    assert state(running(busy=True))["state"] == "working"
    assert state(running(busy=False))["state"] == "idle"
    assert state(running())["state"] == "idle"  # an older host that doesn't say
    assert state(running(busy="yes"))["state"] == "idle"  # only a real true counts


def test_a_parked_or_waking_session_reads_resting_or_back_in_a_moment():
    assert state(running(session="parked"))["state"] == "resting"
    assert state(running(session="waking"))["state"] == "waking"


@pytest.mark.parametrize(
    ("code", "flags"),
    [
        (StopReason.PAUSED_BY_SWITCH, {"paused": True}),
        (StopReason.TURNED_OFF_BY_ADMIN, {"turned_off": True}),
        (StopReason.MEMORY_GUARD, {"memory_stopped": True}),
        (StopReason.LOGIN_NEEDED, {}),
        (StopReason.CANT_REACH, {}),
        (StopReason.DAILY_CAP_REACHED, {"reset_at": "2026-10-30T00:00:00+00:00"}),
    ],
)
def test_the_reasons_that_change_the_card_make_it_unavailable(code, flags):
    reason = AgentStopReason(code, NOW, datetime(2026, 10, 30, tzinfo=UTC))
    shown = state(running(busy=True), reason=reason)
    assert shown["state"] == "unavailable" and shown["stop_reason"] == code.value
    for key, value in flags.items():
        assert shown[key] == value


@pytest.mark.parametrize(
    "code",
    [StopReason.WAITING_TOO_LONG, StopReason.BOX_RESTARTED, StopReason.BOX_MOVED],
)
def test_passing_reasons_keep_the_cards_usual_state(code):
    shown = state(running(busy=True), reason=AgentStopReason(code, NOW))
    assert shown["state"] == "working" and "stop_reason" not in shown


def test_a_host_that_gave_up_needs_a_restart_and_other_failures_a_look():
    assert state(running(process="failed", reason="internal"))["needs_restart"] is True
    assert state(running(process="failed", reason="credential"))["needs_check"] is True


def test_the_boxs_own_state():
    asleep = CloudMachine(
        id="m", state="stopped", desired_state="stopped", stop_reason="idle"
    )
    starting = CloudMachine(id="m", state="provisioning", desired_state="running")
    failed = CloudMachine(id="m", state="error", desired_state="running")
    assert state(running(), box=asleep) == {
        "agent_id": "a1",
        "last_reply_at": "2026-10-29T11:00:00+00:00",
        "state": "resting",
        "box_stopped": True,
    }
    assert state(running(), box=starting)["box_starting"] is True
    assert state(running(), box=failed)["needs_check"] is True


def test_a_full_box_reads_waiting_for_room():
    shown = state(running(waiting_for_room={"count": 2, "oldest_since": None}))
    assert shown["state"] == "waking" and shown["waiting_for_room"] is True


def test_an_agent_its_owner_stopped_is_left_out():
    assert state(running(), desired="stopped") is None


def test_only_fixed_fields_ever_leave():
    shown = state(
        running(busy=True, detail="a planted marker phrase", reason="out_of_memory")
    )
    assert "planted marker" not in str(shown)
    assert set(shown) <= {
        "agent_id", "state", "last_reply_at", "needs_restart", "needs_check", "memory_stopped",
        "waiting_for_room", "box_stopped", "box_starting", "paused", "turned_off", "stop_reason",
        "reset_at",
    }  # fmt: skip


# The operators' overview counts through the same mapping (one mapping, shared), with
# every case the overview's `agent_bucket` had.
@pytest.mark.parametrize(
    ("entry", "box", "bucket"),
    [
        (running(busy=True), ("ready", "running", None), "working"),
        (running(busy=False), ("ready", "running", None), "idle"),
        (running(busy="yes"), ("ready", "running", None), "idle"),
        (running(session="parked", busy=True), ("ready", "running", None), "resting"),
        (running(session="waking"), ("ready", "running", None), "idle"),
        (running(), ("stopped", "stopped", "idle"), "resting"),
        (running(), ("stopped", "stopped", "owner"), "resting"),
        (
            running(process="crashed", reason="x"),
            ("ready", "running", None),
            "unavailable",
        ),
        (
            running(process="failed", reason="x"),
            ("stopped", "stopped", "idle"),
            "unavailable",
        ),
        ({}, ("ready", "running", None), "idle"),
        (running(session="parked"), ("stopped", "stopped", "paused"), "unavailable"),
        (
            running(session="parked"),
            ("stopped", "stopped", "turned_off"),
            "unavailable",
        ),
        (
            running(process="stopped", reason="out_of_memory"),
            ("ready", "running", None),
            "unavailable",
        ),
        (running(), ("provisioning", "running", None), "idle"),
    ],
)
def test_overview_buckets_come_from_the_card(entry, box, bucket):
    machine = CloudMachine(
        id="m", state=box[0], desired_state=box[1], stop_reason=box[2]
    )
    assert overview_bucket(state(entry, box=machine)) == bucket


def test_a_paused_owners_agents_count_as_unavailable_whatever_the_box_says():
    paused = AgentStopReason(StopReason.PAUSED_BY_SWITCH, None)
    asleep = CloudMachine(
        id="m", state="stopped", desired_state="stopped", stop_reason="idle"
    )
    assert overview_bucket(state(running(busy=True), reason=paused)) == "unavailable"
    assert overview_bucket(state({}, box=asleep, reason=paused)) == "unavailable"


def test_an_agent_its_owner_stopped_counts_as_resting():
    assert overview_bucket(state(running(), desired="stopped")) == "resting"


def test_a_box_stopped_by_a_mark_shows_the_marks_flag_without_a_reason():
    paused = CloudMachine(
        id="m", state="stopped", desired_state="stopped", stop_reason="paused"
    )
    off = CloudMachine(
        id="m", state="stopped", desired_state="stopped", stop_reason="turned_off"
    )
    assert state(running(), box=paused)["paused"] is True
    assert state(running(), box=off)["turned_off"] is True

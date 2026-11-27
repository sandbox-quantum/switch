"""Why it stopped: each reason can be forced on its own, the order decides between them, and only fixed words
ever reach the user."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from switch_core.config import SwitchConfig
from switch_core.visibility.reason_codes import StopReason
from switch_core.visibility.stop_reasons import (
    BOX_POSTS,
    ROOM_LINES,
    WORDS,
    AgentStopReason,
    ReasonInputs,
    heading,
    room_line,
    room_line_due,
    stop_reason,
)

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
AGO = NOW - timedelta(minutes=5)
RESETS = datetime(2026, 10, 30, 0, 0, tzinfo=UTC)

ALONE = {
    StopReason.PAUSED_BY_SWITCH: {"paused_since": AGO},
    StopReason.TURNED_OFF_BY_ADMIN: {"turned_off": True},
    StopReason.CANT_REACH: {"controller_offline_since": AGO},
    StopReason.LOGIN_NEEDED: {"login_needed_since": AGO},
    StopReason.DAILY_CAP_REACHED: {"capped_since": AGO, "cap_resets_at": RESETS},
    StopReason.BUDGET_REACHED: {
        "budget_reached": True,
        "budget_resets_at": RESETS,
    },
    StopReason.MEMORY_GUARD: {"memory_stopped_since": AGO},
    StopReason.WAITING_TOO_LONG: {"let_go_at": AGO},
    StopReason.BOX_MOVED: {"moved_at": AGO},
    StopReason.BOX_RESTARTED: {"restart_notice_at": AGO},
}
ORDER = list(ALONE)  # the design's order, first wins


def test_every_code_is_covered_and_has_its_words():
    assert set(ALONE) == set(StopReason) == set(WORDS)


@pytest.mark.parametrize("code", ORDER)
def test_each_reason_can_be_forced_on_its_own(code):
    reason = stop_reason(ReasonInputs(now=NOW, **ALONE[code]))
    assert reason is not None and reason.code == code
    # A budget and a turn-off carry no start time.
    no_time = (StopReason.BUDGET_REACHED, StopReason.TURNED_OFF_BY_ADMIN)
    assert reason.since == (None if code in no_time else AGO)
    if code in (StopReason.DAILY_CAP_REACHED, StopReason.BUDGET_REACHED):
        assert reason.reset_at == RESETS
    else:
        assert reason.reset_at is None


def test_nothing_present_means_no_reason():
    assert stop_reason(ReasonInputs(now=NOW)) is None


@pytest.mark.parametrize("higher", range(len(ORDER)))
def test_the_first_in_the_order_wins_over_everything_after_it(higher):
    fields = {}
    for code in ORDER[higher:]:
        fields.update(ALONE[code])
    assert stop_reason(ReasonInputs(now=NOW, **fields)).code == ORDER[higher]


def test_a_short_drop_off_is_a_blip_not_a_reason():
    assert (
        stop_reason(
            ReasonInputs(now=NOW, controller_offline_since=NOW - timedelta(seconds=59))
        )
        is None
    )
    assert stop_reason(
        ReasonInputs(now=NOW, controller_offline_since=NOW - timedelta(seconds=60))
    ).code == (StopReason.CANT_REACH)


@pytest.mark.parametrize("field", ["let_go_at", "moved_at", "restart_notice_at"])
def test_passing_reasons_clear_once_the_agent_works_again(field):
    assert (
        stop_reason(
            ReasonInputs(
                now=NOW, **{field: AGO}, last_worked_at=AGO + timedelta(seconds=1)
            )
        )
        is None
    )
    assert (
        stop_reason(
            ReasonInputs(
                now=NOW, **{field: AGO}, last_worked_at=AGO - timedelta(seconds=1)
            )
        )
        is not None
    )


def test_restarted_stops_showing_after_30_minutes_even_without_work():
    assert (
        stop_reason(
            ReasonInputs(now=NOW, restart_notice_at=NOW - timedelta(minutes=29))
        )
        is not None
    )
    assert (
        stop_reason(
            ReasonInputs(now=NOW, restart_notice_at=NOW - timedelta(minutes=30))
        )
        is None
    )


def test_lasting_reasons_do_not_clear_on_old_work():
    reason = stop_reason(
        ReasonInputs(now=NOW, memory_stopped_since=AGO, last_worked_at=NOW)
    )
    assert reason == AgentStopReason(StopReason.MEMORY_GUARD, AGO)


# ---- the words ----


def test_the_status_heading_follows_the_wait_limit_setting():
    assert (
        heading(StopReason.WAITING_TOO_LONG)
        == "Still waiting for room after 10 minutes"
    )
    assert (
        heading(StopReason.WAITING_TOO_LONG, 15)
        == "Still waiting for room after 15 minutes"
    )
    assert heading(StopReason.PAUSED_BY_SWITCH, 15) == "Paused by Switch"


def test_restart_is_offered_only_where_it_helps():
    assert {c for c, w in WORDS.items() if w.restart_helps} == {
        StopReason.MEMORY_GUARD,
        StopReason.CANT_REACH,
    }


def test_core_posts_no_line_for_the_codes_the_box_or_budgets_post():
    for code in [*BOX_POSTS, StopReason.BUDGET_REACHED]:
        assert room_line(code, "ada") is None
    assert set(ROOM_LINES) | BOX_POSTS | {StopReason.BUDGET_REACHED} == set(StopReason)


def test_room_lines_are_filled_with_only_the_owner_and_a_utc_time():
    line = room_line(StopReason.DAILY_CAP_REACHED, "ada", RESETS)
    assert line == (
        "My owner (@ada) has reached today's AI limit, so I can't start on this. It resets at 00:00 UTC. "
        "Send it again after that."
    )
    # the gateway counts per UTC day, so the reset is always 00:00 UTC
    assert "It resets at 00:00 UTC." in room_line(StopReason.DAILY_CAP_REACHED, "ada")
    no_handle = room_line(StopReason.DAILY_CAP_REACHED, None, RESETS)
    assert no_handle.startswith("My owner has reached")
    paused = room_line(StopReason.PAUSED_BY_SWITCH, "ada")
    assert "paused hosted agents for my owner (@ada)," in paused
    for code in ROOM_LINES:
        for handle in ("ada", None):
            text = room_line(code, handle, RESETS)
            assert "{" not in text and "}" not in text
            assert "my owner (my owner" not in text.lower()


def test_room_lines_are_limited_per_agent():
    assert room_line_due(StopReason.CANT_REACH, None, NOW)
    assert not room_line_due(StopReason.CANT_REACH, NOW - timedelta(minutes=9), NOW)
    assert room_line_due(StopReason.CANT_REACH, NOW - timedelta(minutes=10), NOW)
    assert not room_line_due(
        StopReason.PAUSED_BY_SWITCH, NOW - timedelta(minutes=59), NOW
    )  # hourly, per the copy


# ---- the setting ----


def test_the_wait_limit_setting_defaults_to_10_minutes_and_is_bounded():
    field = SwitchConfig.model_fields["hosted_wait_limit_minutes"]
    assert field.default == 10
    bounds = {
        k: getattr(m, k) for m in field.metadata for k in ("ge", "le") if hasattr(m, k)
    }
    assert bounds == {"ge": 1, "le": 60}

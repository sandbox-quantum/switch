"""Awake minutes from status reports: the count, and who gets it."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from switch_core.visibility.awake_usage import (
    MAX_MINUTES_PER_REPORT,
    awake_agents,
    minutes_crossed,
)

T0 = datetime(2026, 10, 29, 12, 0, 30, tzinfo=UTC)


@pytest.mark.parametrize(
    ("later", "minutes"),
    [
        (timedelta(seconds=20), 0),  # 12:00:30 → 12:00:50, no boundary
        (timedelta(seconds=30), 1),  # → 12:01:00
        (timedelta(seconds=60), 1),  # → 12:01:30
        (timedelta(seconds=150), 3),  # → 12:03:00
        (timedelta(hours=2), MAX_MINUTES_PER_REPORT),  # a gap counts at most 5
        (timedelta(seconds=-10), 0),  # a clock step back counts nothing
    ],
)
def test_minute_boundaries_crossed(later: timedelta, minutes: int) -> None:
    assert minutes_crossed(T0, T0 + later) == minutes


def test_the_first_report_is_a_baseline() -> None:
    assert minutes_crossed(None, T0) == 0


def test_reports_every_20_seconds_add_up_exactly() -> None:
    """Over ten minutes of reports 20 s apart, ten minutes are counted."""
    total, previous = 0, T0
    for step in range(1, 31):
        now = T0 + timedelta(seconds=20 * step)
        total += minutes_crossed(previous, now)
        previous = now
    assert total == 10


def test_only_awake_bound_agents_count_once_each() -> None:
    bound = {"a1": "c1", "a2": "c2", "a3": "c3"}
    agents = [
        {"agent_id": "a1", "session": "active"},
        {"agent_id": "a1", "session": "active"},  # listed twice, counted once
        {"agent_id": "a2", "session": "waking"},
        {"agent_id": "a3", "session": "parked"},  # asleep
        {"agent_id": "x9", "session": "active"},  # not this controller's
        {"agent_id": "a3"},  # no session
        {"session": "active"},  # no id
    ]
    assert awake_agents(agents, bound) == ["c1", "c2"]


def test_reports_within_one_minute_add_at_most_one() -> None:
    """Several reports inside the same minute add nothing, and crossing into
    the next minute adds exactly one, however many reports."""
    start = datetime(2026, 10, 29, 12, 0, 0, tzinfo=UTC)
    stamps = [start + timedelta(seconds=s) for s in (0, 10, 20, 30, 40, 50, 59)]
    assert (
        sum(minutes_crossed(a, b) for a, b in zip(stamps, stamps[1:], strict=False))
        == 0
    )
    stamps += [start + timedelta(seconds=s) for s in (60, 61, 75, 119)]
    assert (
        sum(minutes_crossed(a, b) for a, b in zip(stamps, stamps[1:], strict=False))
        == 1
    )

"""Hosted AI calls from status reports: the day's rise, never negative,
clamped, and filed under the controller, never an agent (display only)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from switch_core.visibility.awake_usage import MAX_CALLS_PER_REPORT, calls_rise

T0 = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)


def rise(
    previous: int | None,
    current: int | None,
    *,
    later=timedelta(seconds=20),
    cap=None,
    first=False,
) -> int:  # type: ignore[no-untyped-def]
    return calls_rise(
        previous_seen_at=None if first else T0,
        seen_at=T0 + later,
        previous=previous,
        current=current,
        daily_cap=cap,
    )


def test_the_rise_since_the_last_report() -> None:
    assert rise(10, 14) == 4
    assert rise(14, 14) == 0


def test_the_first_report_is_a_baseline() -> None:
    assert rise(None, 30, first=True) == 0


def test_a_fall_counts_from_zero_never_negative() -> None:
    """A controller restart resets its count."""
    assert rise(40, 3) == 3


def test_a_new_utc_day_counts_from_zero() -> None:
    assert rise(190, 5, later=timedelta(hours=12, minutes=1)) == 5


def test_no_count_reported_counts_nothing() -> None:
    assert rise(10, None) == 0
    # A previous report without the field: the whole current count is today's.
    assert rise(None, 7) == 7


@pytest.mark.parametrize(
    ("cap", "claimed", "counted"),
    [
        (200, 5_000, 200),
        (None, 50_000, MAX_CALLS_PER_REPORT),
        (0, 50_000, MAX_CALLS_PER_REPORT),
    ],
)
def test_a_claimed_rise_is_clamped(cap: int | None, claimed: int, counted: int) -> None:
    """The box reports this figure, so one report can't add more than the
    day's cap, or a fixed bound without one."""
    assert rise(0, claimed, cap=cap) == counted

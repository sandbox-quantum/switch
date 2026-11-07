from datetime import UTC, datetime

import pytest

from switch_core.scheduling.timing import ScheduleTimingError, next_cron_run


def test_weekday_in_india() -> None:
    assert next_cron_run(
        "0 9 * * 1-5", "Asia/Kolkata", datetime(2026, 11, 6, 4, tzinfo=UTC)
    ) == datetime(2026, 11, 9, 3, 30, tzinfo=UTC)


def test_spring_gap_is_skipped() -> None:
    assert next_cron_run(
        "30 2 * * *", "America/New_York", datetime(2026, 3, 8, 5, tzinfo=UTC)
    ) == datetime(2026, 3, 9, 6, 30, tzinfo=UTC)


def test_fall_repeat_runs_only_first_time() -> None:
    first = next_cron_run(
        "30 1 * * *", "America/New_York", datetime(2026, 11, 1, 4, tzinfo=UTC)
    )
    assert first == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
    assert next_cron_run("30 1 * * *", "America/New_York", first) == datetime(
        2026, 11, 2, 6, 30, tzinfo=UTC
    )


@pytest.mark.parametrize(
    "rule,zone",
    [
        ("* * * * * *", "UTC"),
        ("0 0 31 2 *", "UTC"),
        ("bad", "UTC"),
        ("0 9 * * *", "missing/zone"),
    ],
)
def test_invalid_timing_is_rejected(rule: str, zone: str) -> None:
    with pytest.raises(ScheduleTimingError):
        next_cron_run(rule, zone, datetime(2026, 1, 1, tzinfo=UTC))


def test_naive_time_is_rejected() -> None:
    with pytest.raises(ScheduleTimingError, match="offset"):
        next_cron_run("0 9 * * *", "UTC", datetime(2026, 1, 1))

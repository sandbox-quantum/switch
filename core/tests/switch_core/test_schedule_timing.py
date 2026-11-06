from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from switch_core.schedule_timing import next_cron_run, parse_cron, parse_timezone


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


class TestParseCron:
    def test_fields_lists_ranges_and_steps(self) -> None:
        spec = parse_cron("0,30 9-11 */10 jan,mar mon-fri")

        assert spec.minutes == (0, 30)
        assert spec.hours == (9, 10, 11)
        assert spec.days == frozenset({1, 11, 21, 31})
        assert spec.months == frozenset({1, 3})
        assert spec.weekdays == frozenset({1, 2, 3, 4, 5})

    def test_step_on_a_range_and_on_a_bare_start(self) -> None:
        assert parse_cron("0-30/10 * * * *").minutes == (0, 10, 20, 30)
        assert parse_cron("5/20 * * * *").minutes == (5, 25, 45)

    def test_sunday_is_zero_or_seven(self) -> None:
        assert parse_cron("0 0 * * 7").weekdays == frozenset({0})
        assert parse_cron("0 0 * * sun").weekdays == frozenset({0})
        assert parse_cron("0 0 * * 5-7").weekdays == frozenset({5, 6, 0})

    @pytest.mark.parametrize(
        "expression",
        [
            "",
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "* * * * 8",
            "5-1 * * * *",
            "*/0 * * * *",
            "*/x * * * *",
            "a * * * *",
            "1,,2 * * * *",
        ],
    )
    def test_rejects_malformed_expressions(self, expression: str) -> None:
        with pytest.raises(ValueError):
            parse_cron(expression)


class TestParseTimezone:
    def test_known_name(self) -> None:
        assert parse_timezone("Europe/Berlin") == ZoneInfo("Europe/Berlin")

    @pytest.mark.parametrize("name", ["Mars/Olympus", "", "../etc/passwd"])
    def test_unknown_name_is_a_value_error(self, name: str) -> None:
        with pytest.raises(ValueError):
            parse_timezone(name)


class TestNextCronRun:
    def test_is_strictly_after(self) -> None:
        after = utc(2026, 11, 2, 9, 0)

        assert next_cron_run("0 9 * * *", "UTC", after) == utc(2026, 11, 3, 9, 0)
        assert next_cron_run("0 9 * * *", "UTC", utc(2026, 11, 2, 8, 59, 59)) == after

    def test_weekdays_skip_the_weekend(self) -> None:
        friday = utc(2026, 11, 6, 10, 0)

        assert next_cron_run("0 9 * * 1-5", "UTC", friday) == utc(2026, 11, 9, 9, 0)

    def test_read_in_the_schedules_timezone(self) -> None:
        # 09:00 in Berlin is 08:00 UTC in winter and 07:00 UTC in summer.
        assert next_cron_run(
            "0 9 * * *", "Europe/Berlin", utc(2026, 1, 15, 0, 0)
        ) == utc(2026, 1, 15, 8, 0)
        assert next_cron_run(
            "0 9 * * *", "Europe/Berlin", utc(2026, 7, 15, 0, 0)
        ) == utc(2026, 7, 15, 7, 0)

    def test_day_of_month_and_weekday_match_either_when_both_restricted(self) -> None:
        # 13 November 2026 is a Friday; 9 November is the Monday before it.
        after = utc(2026, 11, 8, 0, 0)

        assert next_cron_run("0 0 13 * 1", "UTC", after) == utc(2026, 11, 9, 0, 0)
        assert next_cron_run("0 0 13 * 1", "UTC", utc(2026, 11, 9, 0, 0)) == utc(
            2026, 11, 13, 0, 0
        )

    def test_a_star_day_field_leaves_the_weekday_binding(self) -> None:
        assert next_cron_run("0 0 * * 1", "UTC", utc(2026, 11, 8, 0, 0)) == utc(
            2026, 11, 9, 0, 0
        )

    def test_leap_day(self) -> None:
        assert next_cron_run("0 0 29 2 *", "UTC", utc(2026, 3, 1, 0, 0)) == utc(
            2028, 2, 29, 0, 0
        )

    def test_a_date_that_never_comes_is_refused(self) -> None:
        with pytest.raises(ValueError, match="never matches"):
            next_cron_run("0 0 31 2 *", "UTC", utc(2026, 1, 1, 0, 0))

    def test_every_minute_steps_one_minute(self) -> None:
        assert next_cron_run("* * * * *", "UTC", utc(2026, 11, 6, 10, 0, 30)) == utc(
            2026, 11, 6, 10, 1
        )

    def test_spring_forward_runs_a_skipped_time_after_the_gap(self) -> None:
        # New York, 8 March 2026: 02:00 jumps to 03:00, so 02:30 does not exist.
        after = utc(2026, 3, 7, 12, 0)

        run = next_cron_run("30 2 * * *", "America/New_York", after)

        assert run == utc(2026, 3, 8, 7, 30)
        assert run.astimezone(ZoneInfo("America/New_York")).hour == 3

    def test_the_day_after_a_spring_forward_is_back_on_the_clock_time(self) -> None:
        run = next_cron_run("30 2 * * *", "America/New_York", utc(2026, 3, 8, 8, 0))

        assert run == utc(2026, 3, 9, 6, 30)

    def test_fall_back_runs_a_repeated_time_once(self) -> None:
        # New York, 1 November 2026: 01:30 happens twice (05:30 and 06:30 UTC).
        first = next_cron_run("30 1 * * *", "America/New_York", utc(2026, 11, 1, 0, 0))
        after_first = next_cron_run("30 1 * * *", "America/New_York", first)

        assert first == utc(2026, 11, 1, 5, 30)
        assert after_first == utc(2026, 11, 2, 6, 30)

    def test_after_in_the_repeated_hour_never_goes_backwards(self) -> None:
        second_pass = utc(2026, 11, 1, 6, 15)

        run = next_cron_run("45 1 * * *", "America/New_York", second_pass)

        assert run > second_pass
        assert run == utc(2026, 11, 2, 6, 45)

    def test_hourly_across_the_spring_gap_does_not_repeat_an_instant(self) -> None:
        zone = "America/New_York"
        moment = utc(2026, 3, 8, 5, 0)
        seen = []
        for _ in range(4):
            moment = next_cron_run("30 * * * *", zone, moment)
            seen.append(moment)

        assert seen == sorted(set(seen))

from datetime import UTC, datetime

import pytest

from switch_core.scheduler.cron_util import (
    compute_next_run,
    validate_cron_expression,
    validate_timezone,
)


def test_validate_cron_expression():
    assert validate_cron_expression("0 9 * * *") is True
    assert validate_cron_expression("*/5 * * * *") is True
    assert validate_cron_expression("0 0 1 1 *") is True
    assert validate_cron_expression("invalid_cron") is False
    assert validate_cron_expression("60 * * * *") is False
    assert validate_cron_expression("") is False


def test_validate_timezone():
    assert validate_timezone("UTC") is True
    assert validate_timezone("America/New_York") is True
    assert validate_timezone("Asia/Kolkata") is True
    assert validate_timezone("Europe/London") is True
    assert validate_timezone("Mars/Olympus_Mons") is False
    assert validate_timezone("") is False


def test_compute_next_run_standard():
    base = datetime(2026, 11, 4, 8, 30, tzinfo=UTC)
    # Every day at 9:00 UTC
    next_run = compute_next_run("0 9 * * *", "UTC", base_time=base)
    assert next_run == datetime(2026, 11, 4, 9, 0, tzinfo=UTC)

    # Next day at 9:00 UTC
    base_after = datetime(2026, 11, 4, 9, 30, tzinfo=UTC)
    next_run_after = compute_next_run("0 9 * * *", "UTC", base_time=base_after)
    assert next_run_after == datetime(2026, 11, 5, 9, 0, tzinfo=UTC)


def test_compute_next_run_with_timezone():
    # 9:00 AM New York time
    # In November, America/New_York is EST (UTC-5)
    base = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)  # 7:00 AM EST
    next_run = compute_next_run("0 9 * * *", "America/New_York", base_time=base)
    # 9:00 AM EST is 14:00 UTC
    assert next_run == datetime(2026, 11, 4, 14, 0, tzinfo=UTC)


def test_compute_next_run_invalid_inputs():
    with pytest.raises(ValueError, match="Invalid cron expression"):
        compute_next_run("bad-cron", "UTC")

    with pytest.raises(ValueError, match="Invalid timezone"):
        compute_next_run("0 9 * * *", "NonExistent/Timezone")

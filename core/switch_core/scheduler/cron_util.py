from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter


def validate_timezone(tz_name: str) -> bool:
    """Check if the given timezone name is a valid IANA timezone."""
    try:
        ZoneInfo(tz_name)
        return True
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return False


def validate_cron_expression(cron_expr: str) -> bool:
    """Check if the given string is a valid cron expression."""
    try:
        return bool(croniter.is_valid(cron_expr))
    except (ValueError, KeyError, TypeError):
        return False


def compute_next_run(
    cron_expr: str,
    tz_name: str = "UTC",
    base_time: datetime | None = None,
) -> datetime:
    """Compute the next occurrence for a cron expression in the specified timezone.

    Returns an aware UTC datetime suitable for storage in Postgres.
    """
    if not validate_cron_expression(cron_expr):
        raise ValueError(f"Invalid cron expression: '{cron_expr}'")

    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as e:
        raise ValueError(f"Invalid timezone: '{tz_name}'") from e

    if base_time is None:
        base_time = datetime.now(UTC)
    elif base_time.tzinfo is None:
        base_time = base_time.replace(tzinfo=UTC)

    # Convert base time to the target timezone so croniter evaluates local wall clock
    local_base = base_time.astimezone(tz)
    it = croniter(cron_expr, local_base)
    next_local = it.get_next(datetime)

    # Ensure result is converted to UTC
    return next_local.astimezone(UTC)

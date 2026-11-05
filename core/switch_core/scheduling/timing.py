"""Five-field wall-clock cron: skip gaps and use the first repeated minute."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import CroniterBadCronError, CroniterBadDateError, croniter


class ScheduleTimingError(ValueError):
    pass


def next_cron_run(rule: str, timezone: str, after: datetime) -> datetime:
    if after.tzinfo is None or after.utcoffset() is None:
        raise ScheduleTimingError("A schedule time must include a UTC offset")
    if len(rule.split()) != 5:
        raise ScheduleTimingError("Use a five-field cron rule")
    try:
        zone = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ScheduleTimingError("Choose a valid IANA timezone") from exc
    try:
        # Enumerate naive wall times deliberately: library defaults around DST
        # vary. Round-trip each candidate to reject nonexistent local minutes.
        iterator = croniter(
            rule,
            after.astimezone(zone).replace(tzinfo=None),
            max_years_between_matches=8,
        )
        for _ in range(512):
            wall: datetime = iterator.get_next(datetime)
            instant = wall.replace(tzinfo=zone, fold=0).astimezone(UTC)
            if instant.astimezone(zone).replace(tzinfo=None) != wall:
                continue
            if instant > after.astimezone(UTC):
                return instant
    except (CroniterBadCronError, CroniterBadDateError, ValueError) as exc:
        raise ScheduleTimingError("The cron rule has no usable next run") from exc
    raise ScheduleTimingError("The cron rule has no usable next run")

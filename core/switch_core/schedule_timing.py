"""When a room schedule next runs.

A five-field cron expression (minute, hour, day of month, month, day of week)
read as wall-clock time in an IANA timezone, evaluated with the standard
library alone. Each field takes `*`, a number, a range (`1-5`), a list
(`1,15`), a step (`*/10`, `0-30/5`) or any mix of those; months and weekdays
may be written as three-letter names, and weekday `7` is Sunday.

As in Vixie cron, when both day of month and day of week are restricted a day
matches if either does.

Daylight saving: a wall-clock time that does not exist (the hour skipped when
the clocks go forward) runs at the same moment the clock shows after the skip,
and one that happens twice (when the clocks go back) runs once, the first
time. A later offset change never moves a run that was already computed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_MONTH_NAMES = (
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
)
_WEEKDAY_NAMES = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")

# Far enough to find 29 February, which comes round at most eight years apart.
_SEARCH_DAYS = 366 * 8


@dataclass(frozen=True)
class CronSpec:
    """A parsed cron expression. `weekdays` counts Sunday as 0."""

    minutes: tuple[int, ...]
    hours: tuple[int, ...]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]
    days_unrestricted: bool
    weekdays_unrestricted: bool

    def matches_day(self, day: date) -> bool:
        if day.month not in self.months:
            return False
        day_ok = day.day in self.days
        weekday_ok = (day.weekday() + 1) % 7 in self.weekdays
        if self.days_unrestricted or self.weekdays_unrestricted:
            return day_ok and weekday_ok
        return day_ok or weekday_ok


def parse_timezone(name: str) -> ZoneInfo:
    """The IANA timezone called `name`, or ValueError saying it is unknown."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError) as e:
        raise ValueError(
            f"Unknown timezone {name!r}: use an IANA name such as UTC or Europe/Berlin"
        ) from e


def _parse_value(
    token: str, low: int, high: int, names: tuple[str, ...], first_name: int, field: str
) -> int:
    lowered = token.lower()
    if lowered in names:
        value = names.index(lowered) + first_name
    elif token.isdigit():
        value = int(token)
    else:
        raise ValueError(f"Cron {field} field: {token!r} is not a number or name")
    if not low <= value <= high:
        raise ValueError(f"Cron {field} field: {value} is outside {low}-{high}")
    return value


def _parse_field(
    text: str,
    low: int,
    high: int,
    field: str,
    names: tuple[str, ...] = (),
    first_name: int = 0,
) -> frozenset[int]:
    values: set[int] = set()
    for part in text.split(","):
        base, slash, step_text = part.partition("/")
        step = 1
        if slash:
            if not step_text.isdigit() or int(step_text) < 1:
                raise ValueError(f"Cron {field} field: bad step in {part!r}")
            step = int(step_text)
        if base == "*":
            start, end = low, high
        elif "-" in base:
            start_text, _, end_text = base.partition("-")
            start = _parse_value(start_text, low, high, names, first_name, field)
            end = _parse_value(end_text, low, high, names, first_name, field)
            if start > end:
                raise ValueError(f"Cron {field} field: range {base!r} runs backwards")
        else:
            start = _parse_value(base, low, high, names, first_name, field)
            end = high if slash else start
        values.update(range(start, end + 1, step))
    return frozenset(values)


def parse_cron(expression: str) -> CronSpec:
    """Parse a five-field cron expression, or raise ValueError saying what is wrong."""
    fields = expression.split()
    if len(fields) != 5:
        raise ValueError(
            "A cron expression has five fields: minute hour day-of-month month day-of-week"
        )
    minute, hour, day, month, weekday = fields
    weekdays = _parse_field(weekday, 0, 7, "day-of-week", _WEEKDAY_NAMES, 0)
    return CronSpec(
        minutes=tuple(sorted(_parse_field(minute, 0, 59, "minute"))),
        hours=tuple(sorted(_parse_field(hour, 0, 23, "hour"))),
        days=_parse_field(day, 1, 31, "day-of-month"),
        months=_parse_field(month, 1, 12, "month", _MONTH_NAMES, 1),
        weekdays=frozenset(value % 7 for value in weekdays),
        days_unrestricted=day.startswith("*"),
        weekdays_unrestricted=weekday.startswith("*"),
    )


def next_cron_run(expression: str, timezone: str, after: datetime) -> datetime:
    """The first moment strictly after `after` that `expression` matches in
    `timezone`, in UTC. ValueError when the expression is malformed or never
    matches (`0 0 31 2 *`)."""
    spec = parse_cron(expression)
    zone = parse_timezone(timezone)
    local_start = after.astimezone(zone).replace(
        tzinfo=None, second=0, microsecond=0
    ) + timedelta(minutes=1)
    day = local_start.date()
    for _ in range(_SEARCH_DAYS):
        if spec.matches_day(day):
            for hour in spec.hours:
                for minute in spec.minutes:
                    candidate = datetime.combine(day, time(hour, minute))
                    if candidate < local_start:
                        continue
                    instant = candidate.replace(tzinfo=zone).astimezone(UTC)
                    if instant > after:
                        return instant
        day += timedelta(days=1)
    raise ValueError(f"Cron expression {expression!r} never matches a date")

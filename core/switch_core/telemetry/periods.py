"""The calendar periods usage is counted over, for `usage_period`.

The snapshot's `*_7d` counts are trailing windows sent every day, so a chart
that adds them up over a week counts each room up to seven times. A finished
period is counted once: one event per deployment per UTC day, ISO week and
calendar month, each carrying distinct counts for exactly that period, so the
sum across deployments at the matching interval is the real figure.

Each is dated to the middle of its period rather than to when it was sent. A
laptop that was off sends the periods it missed when it next runs, days late,
and an event dated "now" would land in the wrong bucket; the middle is inside
the same day, week and month in any timezone a chart is drawn in, where the
start would fall on the previous day west of UTC.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from switch_core.telemetry.snapshot import as_utc

# How far back a pass reports periods that ended while nothing was sending.
# Bounds the queries a server back from a long time off runs at once, and how
# old what it reports can be. Long enough to cover the month before for a
# laptop that was off for most of the month after.
BACKFILL = timedelta(days=35)

_DAY = timedelta(days=1)
_WEEK = timedelta(days=7)


@dataclass(frozen=True)
class Period:
    kind: str
    start: datetime
    end: datetime

    @property
    def midpoint(self) -> datetime:
        return self.start + (self.end - self.start) / 2


def _day_start(moment: datetime) -> datetime:
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)


def _month_after(start: datetime) -> datetime:
    return start.replace(
        year=start.year + start.month // 12, month=start.month % 12 + 1
    )


def _periods_of(kind: str, first_start: datetime, before: datetime) -> list[Period]:
    """Every period of `kind` from the one starting at `first_start` to the
    last that ends by `before`."""
    periods: list[Period] = []
    start = first_start
    while True:
        end = (
            _month_after(start)
            if kind == "month"
            else start + (_DAY if kind == "day" else _WEEK)
        )
        if end > before:
            return periods
        periods.append(Period(kind=kind, start=start, end=end))
        start = end


def periods_ending_between(since: datetime, now: datetime) -> list[Period]:
    """Every day, week and month that ended after `since` and by `now`, and
    within `BACKFILL` of `now`, oldest first within each kind.

    Successive passes hand in successive windows (the snapshot watermark), so
    each period's end falls in exactly one of them and it is reported once.
    """
    now = as_utc(now)
    floor = max(as_utc(since), now - BACKFILL)
    # Start early enough that the first period ending after `floor` is in the
    # walk; those ending at or before it are dropped below.
    first_day = _day_start(floor)
    first_week = first_day - timedelta(days=first_day.weekday())
    first_month = first_day.replace(day=1)
    walked = (
        _periods_of("day", first_day, now)
        + _periods_of("week", first_week, now)
        + _periods_of("month", first_month, now)
    )
    return [period for period in walked if period.end > floor]

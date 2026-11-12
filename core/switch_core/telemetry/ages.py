"""How old a row is, for the events that report it.

Every deletion event carries the lifespan of what was deleted — deleted after
an hour and after a year mean opposite things — and all of them use this one
helper, so they agree on what to report when the timestamp cannot be read.

That is None, and the property is left off the event (the catalogue declares
it `optional`). Not ``0.0``, which a real row can have and which would count a
lookup failure as a burst of churn, and not a sentinel such as ``-1``, which
every sum and average on the far end would include unless each chart filtered
it out. An absent property is skipped by every aggregation.

None of this is reachable today: every ``created_at`` in the schema is
``nullable=False`` with a server default, and the session factory sets
``expire_on_commit=False``, so a loaded row always hands back a real
``datetime``. The guard is for the day one of those stops being true.
"""

from __future__ import annotations

from datetime import UTC, datetime

_SECONDS_PER_DAY = 86400.0
_SECONDS_PER_HOUR = 3600.0


def _elapsed_seconds(created_at: object) -> float | None:
    """Seconds since a timestamp column, or None when it is not one.

    Takes ``object`` because the timestamp columns on the models are annotated
    ``Mapped[str]`` while carrying real ``datetime``s — so the honest signature
    is "whatever the column hands back", checked here rather than trusted.

    Clamped at zero. The clock is the wall clock, because these span process
    restarts and there is no monotonic reading from before the row existed; a
    clock stepped backwards would otherwise produce a negative number.
    """
    if not isinstance(created_at, datetime):
        return None
    moment = created_at if created_at.tzinfo else created_at.replace(tzinfo=UTC)
    return max((datetime.now(UTC) - moment).total_seconds(), 0.0)


def age_days(created_at: object) -> float | None:
    """How old a row is, in days. None when it cannot be told."""
    elapsed = _elapsed_seconds(created_at)
    return None if elapsed is None else elapsed / _SECONDS_PER_DAY


def age_hours(created_at: object) -> float | None:
    """How old a row is, in hours. None when it cannot be told.

    Hours rather than days where the interesting range is "immediately" to "a
    couple of days": a figure that reads 0.1 for most of it says less than one
    that reads 2.4.
    """
    elapsed = _elapsed_seconds(created_at)
    return None if elapsed is None else elapsed / _SECONDS_PER_HOUR


def seconds_since(created_at: object) -> float | None:
    """Seconds since a timestamp column. None when it is not one."""
    return _elapsed_seconds(created_at)

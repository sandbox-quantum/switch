"""How old a row is, for the events that report it.

Every deletion event carries the lifespan of what was deleted — deleted after
an hour and after a year mean opposite things — and all of them use this one
helper, so they agree on what to report when the timestamp cannot be read.

That value is ``-1``, not ``0.0``. ``0.0`` is a real value a real row can
have, so it makes "we could not tell" indistinguishable from "created a moment
ago" — and the second is the far more common reading, which is how a lookup
failure gets counted as a burst of churn. ``-1`` is a number no age can take, so a reader
that does not know about it still cannot mistake it for data.

None of this is reachable today: every ``created_at`` in the schema is
``nullable=False`` with a server default, and the session factory sets
``expire_on_commit=False``, so a loaded row always hands back a real
``datetime``. The guard is for the day one of those stops being true.
"""

from __future__ import annotations

from datetime import UTC, datetime

# Not an age any row can have, so it cannot be read as one.
UNKNOWN_AGE = -1.0

_SECONDS_PER_DAY = 86400.0
_SECONDS_PER_HOUR = 3600.0


def _elapsed_seconds(created_at: object) -> float | None:
    """Seconds since a timestamp column, or None when it is not one.

    Takes ``object`` because the timestamp columns on the models are annotated
    ``Mapped[str]`` while carrying real ``datetime``s — so the honest signature
    is "whatever the column hands back", checked here rather than trusted.

    Clamped at zero. The clock is the wall clock, because these span process
    restarts and there is no monotonic reading from before the row existed; a
    clock stepped backwards would otherwise produce a negative number, which is
    the one value that means something else here.
    """
    if not isinstance(created_at, datetime):
        return None
    moment = created_at if created_at.tzinfo else created_at.replace(tzinfo=UTC)
    return max((datetime.now(UTC) - moment).total_seconds(), 0.0)


def age_days(created_at: object) -> float:
    """How old a row is, in days. :data:`UNKNOWN_AGE` when it cannot be told."""
    elapsed = _elapsed_seconds(created_at)
    return UNKNOWN_AGE if elapsed is None else elapsed / _SECONDS_PER_DAY


def age_hours(created_at: object) -> float:
    """How old a row is, in hours. :data:`UNKNOWN_AGE` when it cannot be told.

    Hours rather than days where the interesting range is "immediately" to "a
    couple of days": a figure that reads 0.1 for most of it says less than one
    that reads 2.4.
    """
    elapsed = _elapsed_seconds(created_at)
    return UNKNOWN_AGE if elapsed is None else elapsed / _SECONDS_PER_HOUR


def seconds_since(created_at: object) -> float:
    """Seconds since a timestamp column. :data:`UNKNOWN_AGE` when it is not one."""
    elapsed = _elapsed_seconds(created_at)
    return UNKNOWN_AGE if elapsed is None else elapsed

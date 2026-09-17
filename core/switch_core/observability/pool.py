"""Connection-pool readings, for the pools that have them.

Pool exhaustion is the failure this exists for: every request waits, the health
check times out, and from the outside it looks exactly like a slow database.
The difference between the two is here.

``AsyncEngine.pool`` is typed as the base ``Pool``, which declares none of these
— they belong to ``QueuePool``, the one the application engine actually uses.
The unpooled engine behind the notification listener is a ``NullPool`` and
genuinely has nothing to report. So this asks rather than assumes, and a pool
that cannot answer produces no reading at all instead of a zero, which would
otherwise draw a flat line that looks like an idle pool rather than an absent
one.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine


@dataclass(frozen=True)
class PoolStats:
    in_use: int
    size: int
    overflow: int


def pool_stats(engine: AsyncEngine) -> PoolStats | None:
    pool = engine.pool
    try:
        return PoolStats(
            in_use=pool.checkedout(),  # type: ignore[attr-defined]
            size=pool.size(),  # type: ignore[attr-defined]
            overflow=_overflow_beyond_nominal(pool.overflow()),  # type: ignore[attr-defined]
        )
    except AttributeError:
        return None


def _overflow_beyond_nominal(raw: int) -> int:
    """SQLAlchemy's overflow counter, as the number it is usually read as.

    ``QueuePool.overflow()`` counts from ``-pool_size`` rather than from zero:
    it is the pool's internal "how many connections have I created, relative to
    my nominal size" and reaches 0 only once the pool is full. An idle pool of
    thirty reports **-30**.

    Reported raw, the panel labelled "connections open beyond the pool's
    nominal size" draws a deep negative line on a perfectly healthy server —
    the most alarming thing on the dashboard being its normal state. Clamped,
    it means what its name says: zero until the pool is exhausted, then the
    count of overflow connections. Saturation is not lost, because `in_use`
    against `size` already shows the pool filling.
    """
    return max(0, raw)

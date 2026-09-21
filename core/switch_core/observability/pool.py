"""Connection-pool readings, for the pools that have them.

Exhaustion is the failure this exists for: every request waits, the health
check times out, and from outside it looks exactly like a slow database.

``AsyncEngine.pool`` is typed as the base ``Pool``, which declares none of
these, and the unpooled engine behind the listener genuinely has nothing to
report — so this asks rather than assumes. A pool that cannot answer produces
no reading rather than a zero, which would draw an idle pool instead of an
absent one.
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

    ``QueuePool.overflow()`` counts from ``-pool_size`` and reaches zero only
    once the pool is full, so an idle pool of thirty reports **-30** — a deep
    negative line on a panel labelled "connections beyond the nominal size".
    Clamped it means what its name says; saturation still shows as `in_use`
    approaching `size`.
    """
    return max(0, raw)

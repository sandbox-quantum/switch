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
            overflow=pool.overflow(),  # type: ignore[attr-defined]
        )
    except AttributeError:
        return None

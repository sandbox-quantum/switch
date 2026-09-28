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

import threading
from dataclasses import dataclass

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine


class PoolInUseWatermark:
    """The most connections checked out at once since the last reading.

    Read point-in-time on the export interval, ``in_use`` misses the failure it
    exists to show: a reconnect burst fills the pool and drains it inside a few
    hundred milliseconds — between two one-minute samples — so the panel stays
    flat through an exhaustion. Fed from the pool's ``checkout`` event, which
    fires on every rise, the peak is caught however brief it was. Reading it
    resets it, so each interval reports its own worst case rather than the worst
    ever seen — the same shape as :class:`~switch_core.observability.runtime.EventLoopLag`.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._peak = 0

    def record(self, in_use: int) -> None:
        with self._lock:
            self._peak = max(self._peak, in_use)

    def take(self, current: int) -> int:
        # Reset to what is checked out right now, not to zero: the next
        # interval's floor is the pool as it actually stands, and a pool that
        # sits at thirty between bursts should not read as empty for the minute
        # after each collection.
        with self._lock:
            peak = max(self._peak, current)
            self._peak = current
            return peak


def install_pool_watermark(engine: AsyncEngine) -> PoolInUseWatermark:
    """Track the pool's high-water checkout count off its ``checkout`` event.

    Registered on the engine rather than sampled, so a spike that lives and dies
    between two exporter reads is still seen. Harmless on a pool that never
    fires the event: the watermark stays at whatever ``take`` last set it to,
    and :func:`pool_stats` still returns ``None`` for a pool that cannot count.
    """
    watermark = PoolInUseWatermark()

    @event.listens_for(engine.sync_engine, "checkout")
    def _record_checkout(*_: object) -> None:
        checkedout = getattr(engine.pool, "checkedout", None)
        if checkedout is not None:
            watermark.record(checkedout())

    return watermark


@dataclass(frozen=True)
class PoolStats:
    in_use: int
    size: int
    overflow: int


def pool_stats(engine: AsyncEngine, watermark: PoolInUseWatermark) -> PoolStats | None:
    pool = engine.pool
    try:
        current = pool.checkedout()  # type: ignore[attr-defined]
        return PoolStats(
            in_use=watermark.take(current),
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

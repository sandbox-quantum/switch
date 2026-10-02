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

import logging
import os
import sys
import threading
import time
from dataclasses import dataclass
from types import FrameType
from typing import Any

import greenlet
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.pool import AsyncAdaptedQueuePool, ConnectionPoolEntry

from switch_core.observability.catalogue import (
    DB_POOL_HOLD_DURATION,
    DB_POOL_WAIT_DURATION,
)
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)


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


# ── Who holds a connection, and for how long ─────────────────────────────────

# A hold this long is code that awaited something else with a connection in
# hand: the slowest query on this schema is a few hundred milliseconds.
LONG_HOLD_SECONDS = 1.0
# One warning per caller per window, so a storm of long holds is a line per
# culprit rather than one per request.
_LONG_HOLD_LOG_INTERVAL_SECONDS = 60.0
# Frames shown with a long-hold warning, innermost first.
_LONG_HOLD_STACK_DEPTH = 6

_PACKAGE_MARKER = f"{os.sep}switch_core{os.sep}"
# Frames that are the plumbing every borrow passes through, not the borrower.
_PLUMBING = (
    f"{_PACKAGE_MARKER}observability{os.sep}",
    f"{_PACKAGE_MARKER}db{os.sep}engine.py",
    f"{_PACKAGE_MARKER}db{os.sep}session_scope.py",
    f"{_PACKAGE_MARKER}db{os.sep}tenant_session.py",
)
_HOLD_KEY = "_switch_hold"
UNKNOWN_CALLER = "unknown"


@dataclass(frozen=True)
class _Hold:
    started: float
    caller: str
    stack: tuple[str, ...]


def _frames_of_borrower() -> list[FrameType]:
    """The call stack of the code borrowing a connection, innermost first.

    A checkout on the async engine runs inside SQLAlchemy's greenlet, whose
    own stack starts at the greenlet and knows nothing of the coroutine that
    awaited it. That coroutine is suspended in the parent greenlet, so the
    walk continues from the parent's frame when the local one runs out.
    """
    frames: list[FrameType] = []
    frame: FrameType | None = sys._getframe(1)
    while frame is not None:
        frames.append(frame)
        frame = frame.f_back
    current = greenlet.getcurrent()
    parent = current.parent
    if parent is not None and parent.gr_frame is not None:
        frame = parent.gr_frame
        while frame is not None:
            frames.append(frame)
            frame = frame.f_back
    return frames


def _ours(frame: FrameType) -> bool:
    filename = frame.f_code.co_filename
    return _PACKAGE_MARKER in filename and not any(p in filename for p in _PLUMBING)


def _module(frame: FrameType) -> str:
    filename = frame.f_code.co_filename
    tail = filename.rsplit(_PACKAGE_MARKER, 1)[-1]
    return "switch_core." + tail.removesuffix(".py").replace(os.sep, ".")


def describe_borrower() -> tuple[str, tuple[str, ...]]:
    """`module:function` of the innermost switch_core frame, and a short stack.

    The label is bounded by the code rather than the traffic, so it can be a
    metric attribute. Asked on every checkout: walking a few dozen frames is
    microseconds against a round trip of a hundred or more.
    """
    ours = [f for f in _frames_of_borrower() if _ours(f)]
    if not ours:
        return UNKNOWN_CALLER, ()
    caller = f"{_module(ours[0])}:{ours[0].f_code.co_name}"
    stack = tuple(
        f"{_module(f)}:{f.f_code.co_name}:{f.f_lineno}"
        for f in ours[:_LONG_HOLD_STACK_DEPTH]
    )
    return caller, stack


class _LongHoldLog:
    """Rate-limits the long-hold warning per caller."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last: dict[str, float] = {}
        self._suppressed: dict[str, int] = {}

    def report(self, hold: _Hold, held_seconds: float) -> None:
        now = time.monotonic()
        with self._lock:
            last = self._last.get(hold.caller)
            if last is not None and now - last < _LONG_HOLD_LOG_INTERVAL_SECONDS:
                self._suppressed[hold.caller] = self._suppressed.get(hold.caller, 0) + 1
                return
            self._last[hold.caller] = now
            suppressed = self._suppressed.pop(hold.caller, 0)
        logger.warning(
            "A database connection was held for %.2f s by %s (%d more long holds "
            "by it in the last %d s). Stack: %s",
            held_seconds,
            hold.caller,
            suppressed,
            int(_LONG_HOLD_LOG_INTERVAL_SECONDS),
            " < ".join(hold.stack) or "unknown",
        )


def install_hold_timer(engine: AsyncEngine) -> None:
    """Time every checkout to its checkin, by the code that borrowed it.

    The checkout event fires in the borrower's call, which is the only moment
    its stack is there to read; the checkin fires wherever the connection
    happens to be returned, so the borrower is stored on the connection
    record in between.
    """
    long_holds = _LongHoldLog()

    @event.listens_for(engine.sync_engine, "checkout")
    def _on_checkout(_dbapi: object, record: Any, _proxy: object) -> None:
        caller, stack = describe_borrower()
        record.info[_HOLD_KEY] = _Hold(time.perf_counter(), caller, stack)

    @event.listens_for(engine.sync_engine, "checkin")
    def _on_checkin(_dbapi: object, record: Any) -> None:
        hold = record.info.pop(_HOLD_KEY, None) if record is not None else None
        if hold is None:
            return
        held = time.perf_counter() - hold.started
        metrics().observe(DB_POOL_HOLD_DURATION, {"caller": hold.caller}, held * 1000.0)
        if held >= LONG_HOLD_SECONDS:
            long_holds.report(hold, held)


class WaitTimedQueuePool(AsyncAdaptedQueuePool):
    """The default async pool, timing how long each request waits for a
    connection.

    A subclass rather than an event because the pool has no event for the
    request, only for the handover. Passed in by `main.py` as the engine's
    `poolclass`, so the database layer stays unaware of any of this; a pool
    rebuilt by `dispose()` keeps the class, and with it the timing.
    """

    def _do_get(self) -> ConnectionPoolEntry:
        started = time.perf_counter()
        entry = super()._do_get()
        metrics().observe(
            DB_POOL_WAIT_DURATION, {}, (time.perf_counter() - started) * 1000.0
        )
        return entry

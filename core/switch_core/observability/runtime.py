"""What the process can tell you about itself.

This is the part an infrastructure agent would normally report, and Switch has
none deployed. Most of it is cheap to read from inside the process anyway, and
two of the numbers here are ones no external agent could produce: event-loop
lag, and the count of descriptors this process in particular is holding.

Nothing here reaches outside the process — no ``psutil``, no subprocess, no new
dependency. On Linux that is ``/proc/self``, which is what production runs on;
off Linux the readings that have no source are simply absent, because a
fabricated memory figure on a developer's laptop is worse than a missing one.
"""

from __future__ import annotations

import gc
import logging
import os
import resource
import sys
import threading
from collections.abc import Iterator

from switch_core.observability.catalogue import (
    RUNTIME_CPU_SECONDS,
    RUNTIME_EVENT_LOOP_LAG,
    RUNTIME_GC_COLLECTIONS,
    RUNTIME_MEMORY_RSS,
    RUNTIME_OPEN_FDS,
)
from switch_core.observability.metrics import GaugeReading, MetricsRegistry, metrics

logger = logging.getLogger(__name__)

_PROC_STATM = "/proc/self/statm"
_PROC_FD = "/proc/self/fd"


class EventLoopLag:
    """The worst oversleep seen since the last reading.

    The server is single-threaded and cooperative: one synchronous call that
    blocks stalls every room, every bridge and every heartbeat at once, and
    from the outside that looks like an unrelated timeout somewhere else. This
    is the number that names the real cause.

    The maximum rather than the latest, because a stall is rare and brief by
    nature — sampling the current value on a one-minute interval would miss
    almost all of them. Reading it resets it, so each interval reports its own
    worst case rather than the worst case ever seen.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._worst_ms = 0.0

    def record(self, lag_seconds: float) -> None:
        # A task woken early (or on time) contributes nothing; only lateness is
        # lag, and a negative reading would otherwise drag the maximum down.
        lag_ms = max(0.0, lag_seconds * 1000.0)
        with self._lock:
            self._worst_ms = max(self._worst_ms, lag_ms)

    def take(self) -> float:
        with self._lock:
            worst = self._worst_ms
            self._worst_ms = 0.0
            return worst


def _resident_bytes() -> int | None:
    """Current resident set size, or None where it cannot be read.

    ``/proc/self/statm`` reports pages, and its second field is the resident
    count. Deliberately not ``getrusage``, whose ``ru_maxrss`` is the *peak*
    and never falls — a process that briefly spiked would report that spike
    forever, which reads on a graph as a leak that is not there.
    """
    try:
        with open(_PROC_STATM) as handle:
            fields = handle.read().split()
    except OSError:
        return None
    if len(fields) < 2:
        return None
    try:
        pages = int(fields[1])
    except ValueError:
        return None
    return pages * os.sysconf("SC_PAGE_SIZE")


def _open_descriptors() -> int | None:
    try:
        return len(os.listdir(_PROC_FD))
    except OSError:
        return None


class RuntimeMetrics:
    """Samples the process and feeds the registry.

    CPU time and collection counts are cumulative at the source, so they are
    differenced against the previous reading and recorded as the interval's
    delta through a pre-collect hook. The rest are read at collection time.
    """

    def __init__(self, lag: EventLoopLag) -> None:
        self._lag = lag
        usage = resource.getrusage(resource.RUSAGE_SELF)
        self._last_user = usage.ru_utime
        self._last_system = usage.ru_stime
        self._last_collections = self._collection_counts()

    def install(self, registry: MetricsRegistry) -> None:
        registry.register_pre_collect(self._record_cumulative)
        registry.register_observer(self._readings)

    @staticmethod
    def _collection_counts() -> list[int]:
        return [generation["collections"] for generation in gc.get_stats()]

    def _record_cumulative(self) -> None:
        registry = metrics()

        usage = resource.getrusage(resource.RUSAGE_SELF)
        for mode, previous, current in (
            ("user", self._last_user, usage.ru_utime),
            ("system", self._last_system, usage.ru_stime),
        ):
            delta = current - previous
            if delta > 0:
                registry.increment(RUNTIME_CPU_SECONDS, {"mode": mode}, delta)
        self._last_user = usage.ru_utime
        self._last_system = usage.ru_stime

        counts = self._collection_counts()
        for generation, current in enumerate(counts):
            previous = (
                self._last_collections[generation]
                if generation < len(self._last_collections)
                else 0
            )
            delta = current - previous
            if delta > 0:
                registry.increment(
                    RUNTIME_GC_COLLECTIONS, {"generation": str(generation)}, delta
                )
        self._last_collections = counts

    def _readings(self) -> Iterator[GaugeReading]:
        resident = _resident_bytes()
        if resident is not None:
            yield GaugeReading(RUNTIME_MEMORY_RSS, float(resident), {})

        descriptors = _open_descriptors()
        if descriptors is not None:
            yield GaugeReading(RUNTIME_OPEN_FDS, float(descriptors), {})

        yield GaugeReading(RUNTIME_EVENT_LOOP_LAG, self._lag.take(), {})


def log_unreadable_sources() -> None:
    """Say once, at startup, which process readings this platform will not give.

    A missing panel on a dashboard is otherwise indistinguishable from a
    healthy process that happens to be reporting nothing.
    """
    missing = []
    if _resident_bytes() is None:
        missing.append("memory")
    if _open_descriptors() is None:
        missing.append("open file descriptors")
    if missing:
        logger.warning(
            "Process %s cannot be read on this platform (%s), so those metrics "
            "will be absent. Expected off Linux; on a deployment it means "
            "/proc is not mounted.",
            " and ".join(missing),
            sys.platform,
        )

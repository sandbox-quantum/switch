"""In-process metric aggregation, flushed to OTLP one interval at a time.

**Why this is a module-level registry and not an injected service.** The house
rule is that services are injected, and it holds for anything a request path
depends on. Instrumentation is the exception, for the same reason logging is
one: the points worth measuring are deep — a transport delivery loop, a bridge
dispatch chokepoint, a pool event handler — and threading a registry through
every constructor between here and there would change the shape of code that
has nothing to do with observability, which is how instrumentation ends up not
being added at all. :func:`install` is called once at startup, exactly like
``configure_logging``, and :func:`metrics` returns whatever is installed.

Nothing is installed by default, so an uninstrumented process — every test, and
every deployment that has not configured an endpoint — gets a registry that
records nothing and allocates nothing.

Aggregation is **delta**: each collection returns what happened since the last
one and resets. A restart therefore loses at most one interval instead of
resetting a cumulative series to zero, which downstream reads as a counter
rollback.

Recording is guarded by a lock because not every caller is on the event loop —
the Mattermost adapter dispatches inbound events from an OS thread via
``run_coroutine_threadsafe``, and a dict mutated from two threads mid-resize is
the kind of bug that appears once a month in production and never in a test.
"""

from __future__ import annotations

import bisect
import logging
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass

from switch_core.observability.catalogue import (
    CATALOGUE,
    MAX_SERIES_PER_METRIC,
    MetricSpec,
)
from switch_core.observability.otlp import (
    DEFAULT_LATENCY_BOUNDS_MS,
    AttributeValue,
    HistogramPoint,
    MetricPayload,
    NumberPoint,
)

logger = logging.getLogger(__name__)

# The attribute map, frozen into something hashable so it can key a series.
SeriesKey = tuple[tuple[str, AttributeValue], ...]


@dataclass(frozen=True)
class GaugeReading:
    """One gauge value, produced at collection time by an observer."""

    spec: MetricSpec
    value: float
    attributes: Mapping[str, AttributeValue]


# An observer is asked for its readings on every collection, rather than
# pushing them when they change. A pushed gauge keeps reporting its last value
# after whatever was setting it has stopped — so a crashed bridge would go on
# reporting the count it had when it died. A pulled one reports what is true
# now, or is absent.
GaugeObserver = Callable[[], Iterable[GaugeReading]]

# Run just before a collection, to record anything that must be sampled on the
# collection's own schedule. See `MetricsRegistry.register_pre_collect`.
PreCollectHook = Callable[[], None]


def _series_key(attributes: Mapping[str, AttributeValue]) -> SeriesKey:
    return tuple(sorted(attributes.items()))


def _validate(spec: MetricSpec, attributes: Mapping[str, AttributeValue]) -> None:
    """The catalogue is a contract; a call site that breaks it is a bug.

    Raised rather than logged. A wrong attribute set is not a runtime condition
    to degrade through — it is a typo or a copied call site, and it should fail
    in the test that covers that code rather than quietly produce a series
    nobody can group by.
    """
    if spec.name not in CATALOGUE:
        raise ValueError(
            f"{spec.name!r} is not in the metric catalogue. Declare it in "
            "switch_core.observability.catalogue before recording it."
        )
    keys = set(attributes)
    if keys != set(spec.attributes):
        missing = sorted(set(spec.attributes) - keys)
        unknown = sorted(keys - set(spec.attributes))
        raise ValueError(
            f"{spec.name!r} takes attributes {sorted(spec.attributes)}; "
            f"missing {missing}, unexpected {unknown}."
        )


class _Histogram:
    """Counts per bucket for one series, reset each collection."""

    __slots__ = ("bounds", "buckets", "count", "total")

    def __init__(self, bounds: Sequence[float]) -> None:
        self.bounds = bounds
        # One more bucket than bounds: the last holds everything above the
        # highest bound, which is where a pathological latency shows up.
        self.buckets = [0] * (len(bounds) + 1)
        self.count = 0
        self.total = 0.0

    def record(self, value: float) -> None:
        self.buckets[bisect.bisect_left(self.bounds, value)] += 1
        self.count += 1
        self.total += value


class MetricsRegistry:
    """Accumulates one interval's measurements."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sums: dict[str, dict[SeriesKey, float]] = {}
        self._histograms: dict[str, dict[SeriesKey, _Histogram]] = {}
        self._observers: list[GaugeObserver] = []
        self._pre_collect: list[PreCollectHook] = []
        # Metrics that have already been reported as over the series ceiling,
        # so the warning is emitted once per interval rather than per call.
        self._over_capacity: set[str] = set()

    @property
    def enabled(self) -> bool:
        return True

    def increment(
        self,
        spec: MetricSpec,
        attributes: Mapping[str, AttributeValue],
        amount: float = 1.0,
    ) -> None:
        _validate(spec, attributes)
        key = _series_key(attributes)
        with self._lock:
            series = self._sums.setdefault(spec.name, {})
            if key not in series and not self._admits(spec.name, series):
                return
            series[key] = series.get(key, 0.0) + amount

    def observe(
        self,
        spec: MetricSpec,
        attributes: Mapping[str, AttributeValue],
        value: float,
    ) -> None:
        """Record one measurement into a histogram."""
        _validate(spec, attributes)
        key = _series_key(attributes)
        with self._lock:
            series = self._histograms.setdefault(spec.name, {})
            if key not in series and not self._admits(spec.name, series):
                return
            histogram = series.get(key)
            if histogram is None:
                histogram = _Histogram(DEFAULT_LATENCY_BOUNDS_MS)
                series[key] = histogram
            histogram.record(value)

    def register_observer(self, observer: GaugeObserver) -> None:
        """Add a source of gauge readings, polled on every collection."""
        with self._lock:
            self._observers.append(observer)

    def register_pre_collect(self, hook: PreCollectHook) -> None:
        """Add a callback run immediately before each collection.

        For the counters whose source is itself cumulative — process CPU time,
        garbage collections — where the delta this interval is only knowable by
        differencing against the last reading. Such a source has to be sampled
        on the collection's own schedule or the delta it reports covers a
        different window than the interval it is attributed to.
        """
        with self._lock:
            self._pre_collect.append(hook)

    def _admits(self, name: str, series: Mapping[SeriesKey, object]) -> bool:
        """Whether a new series may be added, complaining once if not.

        Called with the lock held. Refusing loses the measurement, which is bad
        — but accepting an unbounded attribute value is worse, and the warning
        names the metric so the offending call site is one grep away.
        """
        if len(series) < MAX_SERIES_PER_METRIC:
            return True
        if name not in self._over_capacity:
            self._over_capacity.add(name)
            logger.warning(
                "Metric %s has reached %d distinct attribute combinations and is "
                "dropping new ones. A call site is passing an unbounded value; "
                "check what it puts in the attributes declared for it in "
                "switch_core.observability.catalogue.",
                name,
                MAX_SERIES_PER_METRIC,
            )
        return False

    def collect(self) -> list[MetricPayload]:
        """Take everything recorded since the last call, and reset.

        Gauges are read here rather than stored, so an observer that raises
        takes out its own readings and not the interval's. It is logged at
        error: a gauge that has stopped reporting is a broken dashboard panel,
        not a broken server.
        """
        # Outside the lock: a hook records through the public methods, which
        # take it themselves.
        with self._lock:
            hooks = list(self._pre_collect)
        for hook in hooks:
            try:
                hook()
            except Exception:
                logger.exception(
                    "A metrics pre-collect hook raised; the counters it feeds "
                    "are missing from this interval."
                )

        with self._lock:
            sums = self._sums
            histograms = self._histograms
            observers = list(self._observers)
            self._sums = {}
            self._histograms = {}
            self._over_capacity = set()

        payloads: list[MetricPayload] = []

        for name, series in sums.items():
            spec = CATALOGUE[name]
            payloads.append(
                MetricPayload(
                    name=spec.name,
                    unit=spec.unit,
                    description=spec.description,
                    kind="sum",
                    numbers=[
                        NumberPoint(attributes=dict(key), value=value)
                        for key, value in series.items()
                    ],
                    histograms=(),
                )
            )

        for name, buckets in histograms.items():
            spec = CATALOGUE[name]
            payloads.append(
                MetricPayload(
                    name=spec.name,
                    unit=spec.unit,
                    description=spec.description,
                    kind="histogram",
                    numbers=(),
                    histograms=[
                        HistogramPoint(
                            attributes=dict(key),
                            count=histogram.count,
                            total=histogram.total,
                            bucket_counts=list(histogram.buckets),
                            bounds=list(histogram.bounds),
                        )
                        for key, histogram in buckets.items()
                    ],
                )
            )

        payloads.extend(_collect_gauges(observers))
        return payloads


def _collect_gauges(observers: Sequence[GaugeObserver]) -> list[MetricPayload]:
    grouped: dict[str, list[NumberPoint]] = {}
    seen: set[tuple[str, SeriesKey]] = set()
    for observer in observers:
        try:
            readings = list(observer())
        except Exception:
            logger.exception(
                "A metrics gauge observer raised; its readings are missing from "
                "this interval."
            )
            continue
        for reading in readings:
            _validate(reading.spec, reading.attributes)
            key = (reading.spec.name, _series_key(reading.attributes))
            if key in seen:
                # Two observers claiming the same series puts two data points
                # with identical attributes in one payload, which a receiver
                # either rejects or silently picks one of. Sums and histograms
                # already complain when a series goes wrong; this is the same
                # guard for the one kind that had none.
                logger.error(
                    "Two gauge observers both reported %s with the same "
                    "attributes; keeping the first. One of them should not be "
                    "registered.",
                    reading.spec.name,
                )
                continue
            seen.add(key)
            grouped.setdefault(reading.spec.name, []).append(
                NumberPoint(attributes=dict(reading.attributes), value=reading.value)
            )

    return [
        MetricPayload(
            name=CATALOGUE[name].name,
            unit=CATALOGUE[name].unit,
            description=CATALOGUE[name].description,
            kind="gauge",
            numbers=points,
            histograms=(),
        )
        for name, points in grouped.items()
    ]


class NullMetricsRegistry(MetricsRegistry):
    """What an unconfigured process gets: every call a no-op.

    A subclass rather than a separate protocol so that ``metrics()`` has one
    return type and no call site needs a ``None`` check — the thing the house
    rule about optional parameters is getting at.
    """

    @property
    def enabled(self) -> bool:
        return False

    def increment(
        self,
        spec: MetricSpec,
        attributes: Mapping[str, AttributeValue],
        amount: float = 1.0,
    ) -> None:
        return

    def observe(
        self,
        spec: MetricSpec,
        attributes: Mapping[str, AttributeValue],
        value: float,
    ) -> None:
        return

    def register_observer(self, observer: GaugeObserver) -> None:
        return

    def register_pre_collect(self, hook: PreCollectHook) -> None:
        return

    def collect(self) -> list[MetricPayload]:
        return []


_registry: MetricsRegistry = NullMetricsRegistry()


def metrics() -> MetricsRegistry:
    """The installed registry, or the no-op one when nothing was installed."""
    return _registry


def install(registry: MetricsRegistry) -> None:
    """Make `registry` the process's metrics sink. Called once, at startup."""
    global _registry
    _registry = registry


def uninstall() -> None:
    """Restore the no-op registry. For tests, and for a clean shutdown."""
    global _registry
    _registry = NullMetricsRegistry()

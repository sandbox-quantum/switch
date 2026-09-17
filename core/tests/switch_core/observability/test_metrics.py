import logging

import pytest

from switch_core.observability.catalogue import (
    HTTP_REQUEST_DURATION,
    HTTP_REQUESTS,
    MAX_SERIES_PER_METRIC,
    MetricSpec,
)
from switch_core.observability.metrics import (
    GaugeReading,
    MetricsRegistry,
    NullMetricsRegistry,
    install,
    metrics,
    uninstall,
)

AGENTS = MetricSpec(
    name="switch.agents.connected",
    kind="gauge",
    unit="{agent}",
    description="Agents connected.",
)

REQUEST_ATTRS = {"route": "/health", "method": "GET", "status_class": "2xx"}


@pytest.fixture
def registry() -> MetricsRegistry:
    return MetricsRegistry()


def _by_name(payloads) -> dict[str, object]:
    return {payload.name: payload for payload in payloads}


def test_counter_accumulates_then_resets(registry: MetricsRegistry):
    registry.increment(HTTP_REQUESTS, REQUEST_ATTRS)
    registry.increment(HTTP_REQUESTS, REQUEST_ATTRS)

    first = _by_name(registry.collect())[HTTP_REQUESTS.name]
    assert first.numbers[0].value == 2.0
    assert first.kind == "sum"

    # Delta: the next interval starts at nothing, so a restart loses one
    # interval instead of reading downstream as a counter rollback.
    assert registry.collect() == []


def test_counters_are_kept_apart_by_attributes(registry: MetricsRegistry):
    registry.increment(HTTP_REQUESTS, REQUEST_ATTRS)
    registry.increment(HTTP_REQUESTS, {**REQUEST_ATTRS, "status_class": "5xx"})

    points = _by_name(registry.collect())[HTTP_REQUESTS.name].numbers
    classes = {point.attributes["status_class"]: point.value for point in points}
    assert classes == {"2xx": 1.0, "5xx": 1.0}


def test_unknown_attribute_is_a_bug_and_raises(registry: MetricsRegistry):
    with pytest.raises(ValueError, match="unexpected \\['room_id'\\]"):
        registry.increment(HTTP_REQUESTS, {**REQUEST_ATTRS, "room_id": "r1"})


def test_missing_attribute_is_a_bug_and_raises(registry: MetricsRegistry):
    with pytest.raises(ValueError, match="missing \\['status_class'\\]"):
        registry.increment(HTTP_REQUESTS, {"route": "/health", "method": "GET"})


def test_histogram_buckets_by_upper_bound(registry: MetricsRegistry):
    for value in (1.0, 7.0, 7.5, 999_999.0):
        registry.observe(HTTP_REQUEST_DURATION, {"route": "/x", "method": "GET"}, value)

    point = _by_name(registry.collect())[HTTP_REQUEST_DURATION.name].histograms[0]
    assert point.count == 4
    assert point.total == pytest.approx(1_000_014.5)
    # Bounds start (5, 10, ...): 1.0 falls in the first bucket, 7.0 and 7.5 in
    # the second, and the outlier in the overflow bucket at the end.
    assert point.bucket_counts[0] == 1
    assert point.bucket_counts[1] == 2
    assert point.bucket_counts[-1] == 1
    assert sum(point.bucket_counts) == point.count


def test_histogram_resets_between_intervals(registry: MetricsRegistry):
    registry.observe(HTTP_REQUEST_DURATION, {"route": "/x", "method": "GET"}, 1.0)
    registry.collect()
    assert registry.collect() == []


def test_gauges_are_pulled_at_collection_not_pushed(registry: MetricsRegistry):
    current = [1.0]
    registry.register_observer(lambda: [GaugeReading(AGENTS, current[0], {})])

    assert _by_name(registry.collect())[AGENTS.name].numbers[0].value == 1.0
    current[0] = 4.0
    # Pulled, so the second interval reports what is true then — a pushed gauge
    # would still be reporting 1.0 until something set it again.
    assert _by_name(registry.collect())[AGENTS.name].numbers[0].value == 4.0


def test_a_broken_observer_loses_only_its_own_readings(
    registry: MetricsRegistry, caplog
):
    def broken():
        raise RuntimeError("no")

    registry.register_observer(broken)
    registry.register_observer(lambda: [GaugeReading(AGENTS, 2.0, {})])

    with caplog.at_level(logging.ERROR):
        payloads = _by_name(registry.collect())

    assert payloads[AGENTS.name].numbers[0].value == 2.0
    assert "gauge observer raised" in caplog.text


def test_pre_collect_hooks_run_before_the_drain(registry: MetricsRegistry):
    registry.register_pre_collect(
        lambda: registry.increment(HTTP_REQUESTS, REQUEST_ATTRS, 5.0)
    )
    # The hook's counter must appear in the interval it was recorded for, not
    # the one after it.
    assert _by_name(registry.collect())[HTTP_REQUESTS.name].numbers[0].value == 5.0


def test_a_broken_pre_collect_hook_does_not_lose_the_interval(
    registry: MetricsRegistry, caplog
):
    def broken():
        raise RuntimeError("no")

    registry.register_pre_collect(broken)
    registry.increment(HTTP_REQUESTS, REQUEST_ATTRS)

    with caplog.at_level(logging.ERROR):
        payloads = _by_name(registry.collect())

    assert payloads[HTTP_REQUESTS.name].numbers[0].value == 1.0
    assert "pre-collect hook raised" in caplog.text


def test_series_ceiling_drops_and_complains_once(registry: MetricsRegistry, caplog):
    with caplog.at_level(logging.WARNING):
        for index in range(MAX_SERIES_PER_METRIC + 10):
            registry.increment(
                HTTP_REQUESTS, {**REQUEST_ATTRS, "route": f"/room/{index}"}
            )

    points = _by_name(registry.collect())[HTTP_REQUESTS.name].numbers
    assert len(points) == MAX_SERIES_PER_METRIC
    # Loud, but once — a warning per dropped call would bury the log it is
    # trying to draw attention to.
    assert caplog.text.count("distinct attribute combinations") == 1


def test_an_existing_series_still_records_at_the_ceiling(registry: MetricsRegistry):
    for index in range(MAX_SERIES_PER_METRIC):
        registry.increment(HTTP_REQUESTS, {**REQUEST_ATTRS, "route": f"/r/{index}"})
    registry.increment(HTTP_REQUESTS, {**REQUEST_ATTRS, "route": "/r/0"})

    points = _by_name(registry.collect())[HTTP_REQUESTS.name].numbers
    first = next(p for p in points if p.attributes["route"] == "/r/0")
    assert first.value == 2.0


def test_nothing_is_installed_by_default():
    assert metrics().enabled is False
    # The no-op has to accept every call the real one does, or an uninstrumented
    # process crashes where an instrumented one works.
    metrics().increment(HTTP_REQUESTS, REQUEST_ATTRS)
    metrics().observe(HTTP_REQUEST_DURATION, {"route": "/x", "method": "GET"}, 1.0)
    metrics().register_observer(lambda: [])
    metrics().register_pre_collect(lambda: None)
    assert metrics().collect() == []


def test_install_and_uninstall_swap_the_sink():
    registry = MetricsRegistry()
    install(registry)
    try:
        assert metrics() is registry
        assert metrics().enabled is True
    finally:
        uninstall()

    assert isinstance(metrics(), NullMetricsRegistry)


def test_histogram_boundaries_are_upper_bound_inclusive(registry: MetricsRegistry):
    """OpenTelemetry's bucket i is `(bounds[i-1], bounds[i]]`.

    The exact bound is the case worth pinning: `bisect_left` puts it in the
    lower bucket and `bisect_right` would put it in the higher one, and every
    value that is not a boundary looks identical either way.
    """
    for value in (5.0, 10.0, 10.0001):
        registry.observe(HTTP_REQUEST_DURATION, {"route": "/x", "method": "GET"}, value)

    point = _by_name(registry.collect())[HTTP_REQUEST_DURATION.name].histograms[0]
    # Bounds start (5, 10, 25, …): 5.0 belongs to the first bucket, 10.0 to the
    # second, and anything above 10 to the third.
    assert point.bucket_counts[0] == 1
    assert point.bucket_counts[1] == 1
    assert point.bucket_counts[2] == 1


def test_two_observers_claiming_one_series_is_reported(
    registry: MetricsRegistry, caplog
):
    """Duplicate points with identical attributes are rejected by a receiver.

    Sums and histograms already complain when a series goes wrong; before this
    the one metric kind with no guard was the one collected from several
    independent sources.
    """
    registry.register_observer(lambda: [GaugeReading(AGENTS, 1.0, {})])
    registry.register_observer(lambda: [GaugeReading(AGENTS, 2.0, {})])

    with caplog.at_level(logging.ERROR):
        points = _by_name(registry.collect())[AGENTS.name].numbers

    assert len(points) == 1
    assert points[0].value == 1.0
    assert "Two gauge observers" in caplog.text


def test_the_same_metric_from_two_observers_is_fine_when_attributes_differ(
    registry: MetricsRegistry,
):
    health = MetricSpec(
        name="switch.health.check",
        kind="gauge",
        unit="{status}",
        description="",
        attributes=frozenset({"check"}),
    )
    registry.register_observer(lambda: [GaugeReading(health, 1.0, {"check": "a"})])
    registry.register_observer(lambda: [GaugeReading(health, 0.0, {"check": "b"})])

    points = _by_name(registry.collect())[health.name].numbers
    assert {p.attributes["check"]: p.value for p in points} == {"a": 1.0, "b": 0.0}

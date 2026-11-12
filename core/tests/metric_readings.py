"""Reading what code under test recorded into the metrics registry.

`recording_metrics()` installs a fresh registry for the block and yields it;
`Readings(registry)` takes one collection and answers questions about it by
metric name and attributes, so a test asserts on what an operator's collector
would receive rather than on the registry's internals.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager

from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.otlp import AttributeValue, MetricPayload


@contextmanager
def recording_metrics() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    try:
        yield registry
    finally:
        uninstall()


def _matches(
    attributes: Mapping[str, AttributeValue], wanted: Mapping[str, AttributeValue]
) -> bool:
    return all(attributes.get(key) == value for key, value in wanted.items())


class Readings:
    """One collection from `registry`, taken when this is made."""

    def __init__(self, registry: MetricsRegistry) -> None:
        self.payloads: dict[str, MetricPayload] = {
            payload.name: payload for payload in registry.collect()
        }

    def total(self, name: str, **attributes: AttributeValue) -> float:
        """The sum of a counter's or gauge's points whose attributes include
        `attributes`; 0 when there are none."""
        payload = self.payloads.get(name)
        if payload is None:
            return 0.0
        return sum(
            point.value
            for point in payload.numbers
            if _matches(point.attributes, attributes)
        )

    def count(self, name: str, **attributes: AttributeValue) -> int:
        """How many measurements a histogram took in matching series."""
        payload = self.payloads.get(name)
        if payload is None:
            return 0
        return sum(
            point.count
            for point in payload.histograms
            if _matches(point.attributes, attributes)
        )

    def attribute_values(self) -> set[str]:
        """Every attribute value of every point, as text."""
        values: set[str] = set()
        for payload in self.payloads.values():
            for number in payload.numbers:
                values.update(str(value) for value in number.attributes.values())
            for histogram in payload.histograms:
                values.update(str(value) for value in histogram.attributes.values())
        return values

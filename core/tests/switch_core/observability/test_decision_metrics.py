"""The decision-routing metrics are declared with bounded, identifier-free
attributes, and the registry refuses anything else."""

from __future__ import annotations

import pytest

from switch_core.observability.catalogue import (
    CATALOGUE,
    DECISION_BACKEND_ERRORS,
    DECISION_CONFIDENCE,
    DECISION_DURATION,
    DECISION_FAILURES,
    DECISION_LATENCY_BOUNDS_MS,
    DECISION_MODEL_TIME,
    DECISION_NOTICES,
    DECISION_PENDING,
    DECISION_PENDING_OLDEST_AGE,
    DECISION_REQUESTS,
    DECISION_SETTLED,
    DECISION_WAIT,
)
from switch_core.observability.metrics import MetricsRegistry

EXPECTED = {
    DECISION_REQUESTS: ("sum", {"backend", "outcome"}),
    DECISION_FAILURES: ("sum", {"backend", "reason"}),
    DECISION_BACKEND_ERRORS: ("sum", {"backend", "kind"}),
    DECISION_DURATION: ("histogram", {"backend"}),
    DECISION_MODEL_TIME: ("histogram", {"backend"}),
    DECISION_CONFIDENCE: ("histogram", {"backend"}),
    DECISION_SETTLED: ("sum", {"outcome"}),
    DECISION_WAIT: ("histogram", {"outcome"}),
    DECISION_PENDING: ("gauge", set()),
    DECISION_PENDING_OLDEST_AGE: ("gauge", set()),
    DECISION_NOTICES: ("sum", set()),
}

# What would make a series one tenant's, or unbounded.
IDENTIFYING = {"room_id", "agent", "agent_id", "tenant_id", "message_key", "machine"}


@pytest.mark.parametrize("spec", list(EXPECTED), ids=lambda spec: spec.name)
def test_each_decision_metric_is_declared_with_its_attributes(spec) -> None:
    kind, attributes = EXPECTED[spec]

    assert CATALOGUE[spec.name] is spec
    assert spec.kind == kind
    assert set(spec.attributes) == attributes
    assert not set(spec.attributes) & IDENTIFYING


def test_every_decision_metric_is_covered_here() -> None:
    declared = {name for name in CATALOGUE if name.startswith("switch.decision.")}

    assert declared == {spec.name for spec in EXPECTED}


def test_latencies_resolve_around_the_one_second_target() -> None:
    for spec in (DECISION_DURATION, DECISION_MODEL_TIME, DECISION_WAIT):
        assert spec.bounds == DECISION_LATENCY_BOUNDS_MS
    below_two_seconds = [b for b in DECISION_LATENCY_BOUNDS_MS if b <= 2000]
    assert len(below_two_seconds) >= 8
    assert DECISION_LATENCY_BOUNDS_MS[-1] >= 120_000


def test_a_room_id_is_refused() -> None:
    registry = MetricsRegistry()

    with pytest.raises(ValueError, match="unexpected \\['room_id'\\]"):
        registry.increment(
            DECISION_REQUESTS,
            {"backend": "server_default", "outcome": "agent", "room_id": "r-1"},
        )

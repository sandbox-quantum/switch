"""The run's arguments and plan for a message-rate sweep (`--rates`). No requests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from run import broken, parse_args, plan, rate_phase  # noqa: E402


def _args(*extra: str):
    return parse_args(["--namespace", "switch-dev-abel", "--steps", "300", *extra])


def test_each_rate_gets_a_steady_window_of_its_own():
    a = _args("--scenarios", "idle", "--rates", "10,15,20", "--rate-duration", "90")
    _, schedules = plan(a)
    assert list(schedules) == [
        "idle@300",
        "steady10@300",
        "steady15@300",
        "steady20@300",
    ]
    assert schedules["idle@300"] == []
    for r in (10, 15, 20):
        sent = len(schedules[rate_phase(r, 300)])
        # Poisson arrivals: about rate x duration messages.
        assert 0.8 * r * 90 < sent < 1.2 * r * 90


def test_without_rates_the_plan_is_unchanged():
    a = _args("--scenarios", "idle,steady")
    _, schedules = plan(a)
    assert list(schedules) == ["idle@300", "steady@300"]


def test_rates_must_go_up():
    with pytest.raises(SystemExit):
        _args("--rates", "20,10")
    with pytest.raises(SystemExit):
        _args("--rates", "0,10")


def test_a_rate_name_reads_as_rate_at_agents():
    assert rate_phase(15, 300) == "steady15@300"
    assert rate_phase(7.5, 300) == "steady7.5@300"


@pytest.mark.parametrize(
    ("summary", "why"),
    [
        ({"deliveries_missing": 0, "delivery_ms_p99": 900.0, "errors": 0}, None),
        (
            {"deliveries_missing": 2, "delivery_ms_p99": 900.0, "errors": 0},
            "2 deliveries missing",
        ),
        (
            {"deliveries_missing": 0, "delivery_ms_p99": 21179.1, "errors": 0},
            "p99 21.2 s",
        ),
        (
            {"deliveries_missing": 0, "delivery_ms_p99": 900.0, "errors": 21},
            "21 errors",
        ),
        ({"deliveries_missing": 0, "delivery_ms_p99": None, "errors": 0}, None),
    ],
)
def test_a_window_is_broken_when_deliveries_are_lost_slow_or_failing(summary, why):
    assert broken(summary) == why

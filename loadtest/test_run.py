"""The run's arguments and plan for a message-rate sweep (`--rates`). No requests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from kube import Refused  # noqa: E402
from run import (  # noqa: E402
    broken,
    kept_record,
    parse_args,
    plan,
    rate_phase,
    resolve_urls,
    take_over,
)
from seed import SeededAgent  # noqa: E402


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


def test_keeping_or_reusing_needs_controllers():
    for flag in (["--keep"], ["--reuse", "20261102t104605w1"]):
        with pytest.raises(SystemExit):
            parse_args(["--namespace", "switch-dev-abel", "--steps", "10", *flag])
    a = parse_args(
        [
            "--namespace",
            "switch-dev-abel",
            "--steps",
            "10",
            "--controllers",
            "2",
            "--keep",
        ]
    )
    assert a.keep


def _kept(a, membership, n=10):
    seeded = [SeededAgent(i, f"agent-{i}", f"load-r1-a{i:04d}", "") for i in range(n)]
    return kept_record("r1", "r1", seeded, ["room-0", "room-1"], membership, a)


def test_a_kept_run_records_ids_and_no_credential():
    a = parse_args(
        [
            "--namespace",
            "switch-dev-abel",
            "--steps",
            "10",
            "--controllers",
            "2",
            "--keep",
        ]
    )
    membership, _ = plan(a)
    record = _kept(a, membership)

    assert record["names_from"] == "r1"
    assert set(record["agents"][0]) == {"index", "id", "name"}
    assert "credential" not in str(record) and "key" not in record


def test_a_later_run_takes_the_agents_over_only_with_the_same_rooms():
    a = parse_args(
        [
            "--namespace",
            "switch-dev-abel",
            "--steps",
            "10",
            "--controllers",
            "2",
            "--keep",
        ]
    )
    membership, _ = plan(a)
    record = _kept(a, membership)

    taken = take_over(record, membership, 10)
    assert [s.id for s in taken] == [f"agent-{i}" for i in range(10)]

    other = parse_args(
        [
            "--namespace",
            "switch-dev-abel",
            "--steps",
            "10",
            "--controllers",
            "2",
            "--seed",
            "2",
        ]
    )
    with pytest.raises(RuntimeError, match="rooms differ"):
        take_over(record, plan(other)[0], 10)
    with pytest.raises(RuntimeError, match="kept 10 agents"):
        take_over(record, membership, 12)


class _Release:
    """The release's own URLs and its Ingresses' hostnames, as `Kube` reads them."""

    def public_urls(self) -> tuple[str, str]:
        return "https://dev.example.com", "https://dev.example.com"

    def ingress_hosts(self) -> set[str]:
        return {"dev-gateway.tail.ts.net", "dev-api.tail.ts.net"}


def test_urls_default_to_the_release_and_may_be_its_ingresses() -> None:
    a = parse_args(["--namespace", "switch-dev"])
    resolve_urls(a, _Release())  # type: ignore[arg-type]
    assert (a.gateway_url, a.api_url) == ("https://dev.example.com",) * 2

    a = parse_args(
        [
            "--namespace",
            "switch-dev",
            "--gateway-url",
            "https://dev-gateway.tail.ts.net/",
            "--api-url",
            "https://dev-api.tail.ts.net",
        ]
    )
    resolve_urls(a, _Release())  # type: ignore[arg-type]
    assert a.gateway_url == "https://dev-gateway.tail.ts.net"
    assert a.api_url == "https://dev-api.tail.ts.net"


def test_urls_of_another_environment_are_refused() -> None:
    a = parse_args(
        ["--namespace", "switch-dev", "--api-url", "https://staging-api.tail.ts.net"]
    )
    with pytest.raises(Refused, match="--api-url"):
        resolve_urls(a, _Release())  # type: ignore[arg-type]

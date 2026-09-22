import asyncio

import pytest

from switch_core.observability.catalogue import HEALTH_CHECK
from switch_core.observability.health import (
    CheckOutcome,
    HealthCheck,
    HealthMonitor,
    bridges_check,
    connectors_check,
    message_listener_check,
)
from switch_core.observability.metrics import MetricsRegistry


def _check(name: str, healthy: bool, gates: bool) -> HealthCheck:
    async def probe() -> CheckOutcome:
        return CheckOutcome(name=name, healthy=healthy, detail="" if healthy else "no")

    return HealthCheck(name=name, gates_readiness=gates, probe=probe)


@pytest.mark.asyncio
async def test_all_healthy_is_ready():
    monitor = HealthMonitor([_check("database", True, True)], interval_seconds=1.0)
    report = await monitor.refresh()

    assert report.ready is True
    assert report.as_response()["status"] == "ready"


@pytest.mark.asyncio
async def test_a_failing_gating_check_fails_readiness():
    monitor = HealthMonitor([_check("database", False, True)], interval_seconds=1.0)
    report = await monitor.refresh()

    assert report.ready is False
    assert report.as_response()["checks"]["database"]["detail"] == "no"


@pytest.mark.asyncio
async def test_a_failing_non_gating_check_is_reported_but_stays_ready():
    """switch-core is a single replica: failing readiness is a total outage.

    A dead Slack adapter must not take the whole server off the air.
    """
    monitor = HealthMonitor(
        [_check("database", True, True), _check("bridges", False, False)],
        interval_seconds=1.0,
    )
    report = await monitor.refresh()

    assert report.ready is True
    assert report.as_response()["checks"]["bridges"]["healthy"] is False


@pytest.mark.asyncio
async def test_a_check_that_raises_counts_as_failed():
    async def explode() -> CheckOutcome:
        raise RuntimeError("boom")

    monitor = HealthMonitor(
        [HealthCheck(name="database", gates_readiness=True, probe=explode)],
        interval_seconds=1.0,
    )
    report = await monitor.refresh()

    # Reporting healthy because we could not find out is the exact inversion of
    # what a health check is for.
    assert report.ready is False
    assert "RuntimeError" in report.as_response()["checks"]["database"]["detail"]


@pytest.mark.asyncio
async def test_healthy_checks_carry_no_detail():
    monitor = HealthMonitor([_check("database", True, True)], interval_seconds=1.0)
    await monitor.refresh()

    assert monitor.current().as_response()["checks"]["database"] == {"healthy": True}


def test_before_the_first_check_the_server_is_not_ready():
    monitor = HealthMonitor([_check("database", True, True)], interval_seconds=1.0)
    report = monitor.current()

    assert report.ready is False
    assert "No health check has completed" in str(report.as_response())


@pytest.mark.asyncio
async def test_a_stale_answer_is_not_a_good_answer(monkeypatch):
    """A refresher that has stopped means the server cannot vouch for itself."""
    monitor = HealthMonitor([_check("database", True, True)], interval_seconds=1.0)
    await monitor.refresh()
    assert monitor.current().ready is True

    clock = [monitor.current().taken_at + 100.0]
    monkeypatch.setattr(
        "switch_core.observability.health.time.monotonic", lambda: clock[0]
    )

    report = monitor.current()
    assert report.ready is False
    assert "health_monitor" in report.as_response()["checks"]


@pytest.mark.asyncio
async def test_the_stale_report_still_shows_what_was_last_known(monkeypatch):
    monitor = HealthMonitor(
        [_check("database", True, True), _check("bridges", False, False)],
        interval_seconds=1.0,
    )
    await monitor.refresh()
    clock = [monitor.current().taken_at + 100.0]
    monkeypatch.setattr(
        "switch_core.observability.health.time.monotonic", lambda: clock[0]
    )

    checks = monitor.current().as_response()["checks"]
    assert set(checks) == {"health_monitor", "database", "bridges"}


@pytest.mark.asyncio
async def test_message_listener_check_follows_the_connection():
    connected = [True]
    check = message_listener_check(lambda: connected[0])

    assert (await check.probe()).healthy is True
    connected[0] = False
    outcome = await check.probe()
    assert outcome.healthy is False
    assert "LISTEN" in outcome.detail
    # Reconnects itself with backoff, so restarting the pod would not help.
    assert check.gates_readiness is False


@pytest.mark.asyncio
async def test_bridges_check_counts_the_missing_ones():
    check = bridges_check(running=lambda: 1, configured=lambda: 3)
    outcome = await check.probe()

    assert outcome.healthy is False
    assert "2 of 3" in outcome.detail
    assert check.gates_readiness is False


@pytest.mark.asyncio
async def test_bridges_check_is_healthy_when_none_are_configured():
    check = bridges_check(running=lambda: 0, configured=lambda: 0)
    assert (await check.probe()).healthy is True


@pytest.mark.asyncio
async def test_checks_become_a_gauge_per_dependency():
    monitor = HealthMonitor(
        [_check("database", True, True), _check("bridges", False, False)],
        interval_seconds=1.0,
    )
    await monitor.refresh()

    registry = MetricsRegistry()
    monitor.install(registry)
    payload = next(p for p in registry.collect() if p.name == HEALTH_CHECK.name)

    values = {point.attributes["check"]: point.value for point in payload.numbers}
    # One series per dependency, so an alert says which one broke.
    assert values == {"database": 1.0, "bridges": 0.0}


@pytest.mark.asyncio
async def test_run_forever_keeps_going_after_a_broken_refresh(monkeypatch):
    calls = [0]

    async def flaky() -> CheckOutcome:
        calls[0] += 1
        if calls[0] == 1:
            raise RuntimeError("first one fails")
        return CheckOutcome(name="database", healthy=True, detail="")

    monitor = HealthMonitor(
        [HealthCheck(name="database", gates_readiness=True, probe=flaky)],
        interval_seconds=0.01,
    )
    task = asyncio.create_task(monitor.run_forever())
    try:
        await asyncio.sleep(0.1)
    finally:
        task.cancel()

    assert calls[0] > 1
    assert monitor.current().ready is True


@pytest.mark.asyncio
async def test_connectors_check_counts_the_missing_ones():
    """They start fire-and-forget, so a failure is otherwise one boot-log line."""
    check = connectors_check(running=lambda: 1, configured=lambda: 3)
    outcome = await check.probe()

    assert outcome.healthy is False
    assert "2 of 3" in outcome.detail
    # The rest of Switch serves fine without one, and emptying the Service
    # would not bring it back.
    assert check.gates_readiness is False


@pytest.mark.asyncio
async def test_connectors_check_is_healthy_when_none_are_configured():
    check = connectors_check(running=lambda: 0, configured=lambda: 0)
    assert (await check.probe()).healthy is True

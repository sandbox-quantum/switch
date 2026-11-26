"""What the retention and erasure sweeps report about themselves: how long
since each job last completed a pass with no failure, and how many failed."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.retention import erasure as erasure_module
from switch_core.retention import service as retention_service
from switch_core.retention.health import SweepHealth


class _Clock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _ages(health: SweepHealth) -> dict[str, float]:
    return {str(r.attributes["job"]): r.value for r in health.readings()}


def _failures(registry: MetricsRegistry) -> dict[str, float]:
    for payload in registry.collect():
        if payload.name == "switch.retention.failures":
            return {
                str(point.attributes["job"]): point.value for point in payload.numbers
            }
    return {}


def test_a_process_not_running_the_sweeps_reports_no_age() -> None:
    assert _ages(SweepHealth(_Clock(0.0))) == {}


def test_the_age_runs_from_the_start_until_a_pass_succeeds(
    registry: MetricsRegistry,
) -> None:
    clock = _Clock(100.0)
    health = SweepHealth(clock)
    health.start(("messages", "erasure"))

    clock.now = 160.0
    assert _ages(health) == {"messages": 60.0, "erasure": 60.0}

    health.record("messages", failed=False)
    health.record("erasure", failed=True)
    clock.now = 190.0
    assert _ages(health) == {"messages": 30.0, "erasure": 90.0}
    assert _failures(registry) == {"erasure": 1.0}


def test_a_failure_leaves_the_last_success_where_it_was(
    registry: MetricsRegistry,
) -> None:
    clock = _Clock(0.0)
    health = SweepHealth(clock)
    health.start(("media",))
    clock.now = 10.0
    health.record("media", failed=False)
    clock.now = 20.0
    health.record("media", failed=True)
    health.record("media", failed=True)

    clock.now = 25.0
    assert _ages(health) == {"media": 15.0}
    assert _failures(registry) == {"media": 2.0}


def test_a_stopped_loop_reports_nothing_and_starts_afresh() -> None:
    clock = _Clock(0.0)
    health = SweepHealth(clock)
    health.start(("erasure",))
    health.record("erasure", failed=False)
    health.stop(("erasure",))
    assert _ages(health) == {}

    clock.now = 50.0
    health.start(("erasure",))
    clock.now = 55.0
    assert _ages(health) == {"erasure": 5.0}


async def test_the_retention_loop_reports_while_it_runs(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    passes = asyncio.Event()

    async def one_pass(*args: object) -> None:
        passes.set()

    monkeypatch.setattr(retention_service, "retain_once", one_pass)
    health = SweepHealth(_Clock(0.0))
    task = asyncio.create_task(
        retention_service.retention_loop(session_factory, health)
    )
    try:
        await asyncio.wait_for(passes.wait(), 5)
        assert set(_ages(health)) == {
            "messages",
            "media",
            "leftovers",
            "audit_history",
        }
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert _ages(health) == {}


async def test_the_erasure_loop_records_a_pass_that_could_not_list_tenants(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    registry: MetricsRegistry,
) -> None:
    listed = asyncio.Event()

    async def broken(*args: object) -> list[str]:
        listed.set()
        raise RuntimeError("the database is away")

    monkeypatch.setattr(erasure_module, "all_tenant_ids", broken)
    monkeypatch.setattr(erasure_module, "ERASURE_INTERVAL_SECONDS", 60.0)
    health = SweepHealth(_Clock(0.0))
    task = asyncio.create_task(
        erasure_module.erasure_loop(session_factory, object(), health)  # type: ignore[arg-type]
    )
    try:
        await asyncio.wait_for(listed.wait(), 5)
        await asyncio.sleep(0)
        assert _failures(registry) == {"erasure": 1.0}
        assert set(_ages(health)) == {"erasure"}
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

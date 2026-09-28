"""Fixtures for the baseline benchmark harness.

The database stack is the integration suite's, imported rather than copied: a
second PostgresContainer would double the boot cost and give the benchmark a
different schema path from the one the integration tests prove.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from tests.benchmarks.server import (
    BenchCore,
    BenchServer,
    bench_server,
    restartable_bench_server,
)
from tests.benchmarks.trace import TraceCollector
from tests.integration.conftest import (  # noqa: F401
    SessionEnv,
    session_env,
    switch_stack,
)


@pytest.fixture
def collector() -> TraceCollector:
    return TraceCollector()


@pytest_asyncio.fixture(loop_scope="session")
async def bench(
    session_env: SessionEnv,  # noqa: F811
    collector: TraceCollector,
) -> AsyncIterator[BenchServer]:
    async with bench_server(session_env, collector) as server:
        yield server


@pytest_asyncio.fixture(loop_scope="session")
async def core(
    session_env: SessionEnv,  # noqa: F811
    collector: TraceCollector,
) -> AsyncIterator[BenchCore]:
    """The same server, for a scenario that has to restart it mid-run."""
    async with restartable_bench_server(session_env, collector) as running:
        yield running

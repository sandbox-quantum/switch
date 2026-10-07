"""The database's own view of this server, against a real Postgres.

The sampler exists for the moment the pool is exhausted, so the test that
matters most holds the application pool's only connection and samples anyway.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.observability.db_server import DbServerSampler
from switch_core.observability.metrics import MetricsRegistry, install, uninstall


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _unpooled(url: str) -> AsyncEngine:
    return create_async_engine(url, poolclass=NullPool)


def _restricted_url(rls_harness) -> str:
    return rls_harness.restricted_engine.url.render_as_string(hide_password=False)


def _states(sampler: DbServerSampler) -> dict[str, float]:
    return {r.attributes["state"]: r.value for r in sampler.readings()}  # type: ignore[misc]


async def test_it_samples_while_the_app_pool_is_exhausted(postgres_url: str) -> None:
    app_engine = create_async_engine(postgres_url, pool_size=1, max_overflow=0)
    sampler = DbServerSampler(lambda: _unpooled(postgres_url))
    try:
        async with app_engine.connect() as held:
            # The pool's only connection, checked out and left in a transaction.
            await held.execute(text("SELECT 1"))

            sample = await sampler.sample_once()

            assert app_engine.pool.checkedout() == 1  # type: ignore[attr-defined]
            assert sample is not None
            assert sum(sample.connections.values()) >= 1
            assert sample.connections["idle_in_transaction"] >= 1
            assert sample.transactions >= 0
            states = _states(sampler)
            assert set(states) == {"active", "idle_in_transaction", "idle", "other"}
            assert states["idle_in_transaction"] >= 1
    finally:
        await sampler.aclose()
        await app_engine.dispose()


async def test_it_does_not_count_its_own_session(rls_harness) -> None:
    sampler = DbServerSampler(lambda: _unpooled(_restricted_url(rls_harness)))
    try:
        sample = await sampler.sample_once()
    finally:
        await sampler.aclose()

    # A role with no session but the sampler's own.
    assert sample is not None
    assert sum(sample.connections.values()) == 0


async def test_transactions_are_recorded_as_the_rise_between_samples(
    postgres_url: str, registry: MetricsRegistry
) -> None:
    sampler = DbServerSampler(lambda: _unpooled(postgres_url))
    other = _unpooled(postgres_url)
    try:
        await sampler.sample_once()
        # The first sample is only a baseline.
        assert not [
            p for p in registry.collect() if p.name == "switch.db.server.transactions"
        ]

        async with other.begin() as conn:
            await conn.execute(text("SELECT 1"))
        await sampler.sample_once()

        payload = next(
            p for p in registry.collect() if p.name == "switch.db.server.transactions"
        )
        assert payload.numbers[0].value >= 1
    finally:
        await sampler.aclose()
        await other.dispose()


async def test_a_restricted_role_sees_only_its_own_sessions(rls_harness) -> None:
    """The runtime role is not a superuser, and the numbers must still be true."""
    sampler = DbServerSampler(lambda: _unpooled(_restricted_url(rls_harness)))
    try:
        async with rls_harness.owner_engine.connect() as owner:
            await owner.execute(text("SELECT 1"))
            before = await sampler.sample_once()

        async with rls_harness.restricted_engine.connect() as held:
            await held.execute(text("SELECT 1"))
            during = await sampler.sample_once()
    finally:
        await sampler.aclose()

    assert before is not None and during is not None
    # The owner's open transaction is not this role's.
    assert before.connections["idle_in_transaction"] == 0
    assert during.connections["idle_in_transaction"] == 1


async def test_an_unreachable_database_reports_nothing_and_keeps_trying(
    postgres_url: str,
) -> None:
    unreachable = make_url(postgres_url).set(host="127.0.0.1", port=1)
    sampler = DbServerSampler(
        lambda: _unpooled(unreachable.render_as_string(hide_password=False))
    )
    try:
        assert await sampler.sample_once() is None
        assert list(sampler.readings()) == []
        assert not sampler.disabled
    finally:
        await sampler.aclose()


async def test_a_sampler_that_switches_itself_off_stops_reporting(
    postgres_url: str, registry: MetricsRegistry
) -> None:
    """The last good reading must not stay on the dashboard after it stops."""
    from sqlalchemy.exc import ProgrammingError

    sampler = DbServerSampler(lambda: _unpooled(postgres_url))
    try:
        assert await sampler.sample_once() is not None
        assert list(sampler.readings())

        async def unreadable() -> None:
            raise ProgrammingError("SELECT ...", {}, Exception("permission denied"))

        sampler._read = unreadable  # type: ignore[method-assign]
        assert await sampler.sample_once() is None
        assert sampler.disabled
        assert list(sampler.readings()) == []
    finally:
        await sampler.aclose()

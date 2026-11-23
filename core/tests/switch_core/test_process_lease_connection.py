"""A process's lease is renewed on a connection of its own, so a pool the rest
of the process has filled cannot make it lapse (`db/engine.create_lease_engine`).
Real Postgres, a real pool, and sessions that hold every connection of it
until the test lets them go."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable

import pytest
from sqlalchemy import make_url, text
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from switch_core.db.engine import create_lease_engine, create_session_factory
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.process_identity import new_process_id
from switch_core.process_lease import ProcessLease
from tests.conftest import TEST_KEYRING
from tests.switch_core.observability.test_bootstrap import _config

POOL = 3


@pytest.fixture
async def shared(
    postgres_schema: str,
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncEngine]:
    """The process's shared pool, small and quick to give up, as the rest of
    the process sees it. `session_factory` empties the database first."""
    engine = create_async_engine(
        postgres_schema, pool_size=POOL, max_overflow=0, pool_timeout=0.5
    )
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def lease_engine(
    postgres_schema: str, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[AsyncEngine]:
    """The lease's engine, built as `main` builds it, against the test's
    database."""
    url = make_url(postgres_schema)
    config = _config(
        monkeypatch,
        DB_HOST=str(url.host),
        DB_PORT=str(url.port),
        DB_USER=str(url.username),
        DB_PASSWORD=str(url.password),
        DB_NAME=str(url.database),
    )
    engine = create_lease_engine(config)
    try:
        yield engine
    finally:
        await engine.dispose()


def _lease(shared: AsyncEngine, renewals: AsyncEngine | None = None) -> ProcessLease:
    return ProcessLease(
        process_id=new_process_id("test-pod"),
        session_factory=create_session_factory(shared),
        processes=SwitchCoreProcessStore(),
        key_ids=[key.id for key in TEST_KEYRING.keys],
        renewal_session_factory=(
            create_session_factory(renewals) if renewals is not None else None
        ),
    )


async def _with_pool_full(
    engine: AsyncEngine, then: Callable[[], Awaitable[None]]
) -> None:
    """Run `then` while every connection of `engine`'s pool is held, as
    requests and streams that each wait on something hold theirs."""
    release = asyncio.Event()
    holding = 0
    all_held = asyncio.Event()

    async def hold() -> None:
        nonlocal holding
        async with AsyncSession(engine) as session:
            await session.execute(text("SELECT 1"))
            holding += 1
            if holding == POOL:
                all_held.set()
            await release.wait()

    holders = [asyncio.create_task(hold()) for _ in range(POOL)]
    try:
        await asyncio.wait_for(all_held.wait(), timeout=5)
        assert engine.pool.checkedout() == POOL  # type: ignore[attr-defined]
        await then()
    finally:
        release.set()
        await asyncio.gather(*holders)


async def test_the_lease_renews_while_the_pool_is_full(
    shared: AsyncEngine, lease_engine: AsyncEngine
) -> None:
    lease = _lease(shared, lease_engine)
    await lease.renew()
    first = lease.held_until()
    assert first is not None

    async def renew_twice_and_stop() -> None:
        # Sooner than the shared pool would give up on a borrower.
        await asyncio.wait_for(lease.renew(), timeout=0.4)
        await asyncio.wait_for(lease.renew(), timeout=0.4)
        held_until = lease.held_until()
        assert held_until is not None and held_until > first
        assert lease.surely_held()
        # Releasing the lease as the process drains goes through too.
        await asyncio.wait_for(lease.stop(), timeout=0.4)

    await _with_pool_full(shared, renew_twice_and_stop)

    leases = await lease.read_all()
    assert lease.process_id in leases.leases
    assert not leases.holds(lease.process_id)  # stopped, as asked


async def test_on_the_shared_pool_a_full_pool_fails_the_renewal(
    shared: AsyncEngine,
) -> None:
    """What the lease's own connection prevents: renewed through the shared
    pool, the renewal waits out the pool timeout behind everyone else and
    fails, and enough of those in a row let the lease lapse."""
    lease = _lease(shared)
    await lease.renew()

    async def renewal_fails() -> None:
        with pytest.raises(PoolTimeoutError):
            await lease.renew()

    await _with_pool_full(shared, renewal_fails)


async def _stall_the_next_prune(
    lease: ProcessLease, engine: AsyncEngine
) -> tuple[AsyncSession, Callable[[], Awaitable[None]]]:
    """Leave a lease long dead, and hold its row locked in a session of
    `engine`: the next renewal's prune waits on that lock, as it would behind
    a slow transaction, until `wait_for_stall` sees it and the caller closes
    the session."""
    dead = _lease(engine)
    await dead.renew()
    holder = AsyncSession(engine)
    await holder.execute(
        text(
            "UPDATE switch_core_processes SET beat_at = now() - interval '2 hours'"
            " WHERE id = :id"
        ),
        {"id": dead.process_id},
    )
    await holder.commit()
    await holder.execute(
        text("SELECT 1 FROM switch_core_processes WHERE id = :id FOR UPDATE"),
        {"id": dead.process_id},
    )

    async def wait_for_stall() -> None:
        async def stalled() -> bool:
            async with AsyncSession(engine) as session:
                waiting = await session.scalar(
                    text(
                        "SELECT count(*) FROM pg_stat_activity"
                        " WHERE wait_event_type = 'Lock'"
                        " AND query LIKE 'DELETE FROM switch_core_processes%'"
                    )
                )
                return bool(waiting)

        while not await stalled():
            await asyncio.sleep(0.05)

    return holder, wait_for_stall


async def test_a_stalled_renewal_does_not_hold_up_the_release(
    shared: AsyncEngine, lease_engine: AsyncEngine
) -> None:
    """The lease has one connection. A renewal stalled on it would make the
    release wait behind it and give up, leaving `stopped_at` unwritten: the
    release ends the renewal first."""
    lease = _lease(shared, lease_engine)
    await lease.renew()
    holder, wait_for_stall = await _stall_the_next_prune(lease, shared)
    renewing = asyncio.create_task(lease.run())
    try:
        # The loop renews at once only once a renewal is due.
        lease._renewed_at = None
        await asyncio.wait_for(wait_for_stall(), timeout=10)
        await asyncio.wait_for(lease.stop(), timeout=2)
    finally:
        await holder.close()
        renewing.cancel()
        await asyncio.wait({renewing})

    assert renewing.done()
    assert not lease.surely_held()
    leases = await lease.read_all()
    assert not leases.holds(lease.process_id)


async def test_a_renewal_that_lands_after_the_release_does_not_claim_it_back(
    shared: AsyncEngine,
) -> None:
    """A renewal outside the loop (the first one, from `Ownership.start`) can
    still be in flight when the release runs, and finishes after it."""
    lease = _lease(shared)
    await lease.renew()
    holder, wait_for_stall = await _stall_the_next_prune(lease, shared)
    renewal = asyncio.create_task(lease.renew())
    try:
        await asyncio.wait_for(wait_for_stall(), timeout=10)
        # The release's write waits on the renewal's row lock, so it lands
        # after the renewal commits.
        stopping = asyncio.create_task(lease.stop())
        await asyncio.sleep(0.1)
    finally:
        await holder.close()
    await asyncio.wait_for(renewal, timeout=5)
    await asyncio.wait_for(stopping, timeout=5)

    assert not lease.surely_held()
    leases = await lease.read_all()
    assert not leases.holds(lease.process_id)

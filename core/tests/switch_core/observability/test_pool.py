"""Pool readings, and the counter that does not start at zero."""

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool, QueuePool

from switch_core.observability.pool import _overflow_beyond_nominal, pool_stats


def test_overflow_is_zero_on_an_idle_pool():
    """SQLAlchemy counts overflow from `-pool_size`, not from zero.

    Reported raw, a healthy idle pool of thirty draws -30 on a panel labelled
    "connections open beyond the pool's nominal size".
    """
    engine = create_engine(
        "sqlite://", poolclass=QueuePool, pool_size=30, max_overflow=10
    )
    assert engine.pool.overflow() == -30
    assert _overflow_beyond_nominal(engine.pool.overflow()) == 0


def test_overflow_counts_only_connections_beyond_the_nominal_size():
    assert _overflow_beyond_nominal(-30) == 0
    assert _overflow_beyond_nominal(0) == 0
    assert _overflow_beyond_nominal(4) == 4


def test_a_queue_pool_reports_its_numbers():
    # A URL, not a connection: creating an engine opens nothing, and these
    # numbers are the pool's own bookkeeping rather than the server's.
    # No poolclass: an async engine defaults to AsyncAdaptedQueuePool, which
    # is what production uses and what these accessors come from.
    engine = create_async_engine(
        "postgresql+asyncpg://u:p@localhost/db", pool_size=5, max_overflow=2
    )
    stats = pool_stats(engine)

    assert stats is not None
    assert stats.size == 5
    assert stats.in_use == 0
    assert stats.overflow == 0


def test_a_pool_with_nothing_to_report_reports_nothing():
    """A zero would draw an idle pool; absence draws nothing, which is true."""
    engine = create_async_engine(
        "postgresql+asyncpg://u:p@localhost/db", poolclass=NullPool
    )
    assert pool_stats(engine) is None

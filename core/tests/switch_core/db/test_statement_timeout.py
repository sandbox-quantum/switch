"""A statement timeout bound for some work reaches every transaction begun
under it, in the tenant's round trip, and ends with the transaction
(`db/statement_timeout.py`, `db/tenant_session.py`). Real Postgres."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.statement_timeout import statement_timeout, timed_out
from tests.switch_core.statement_counts import StatementCounts


async def _limit_seen(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        return (await session.execute(text("SHOW statement_timeout"))).scalar_one()


async def test_a_transaction_begun_under_a_limit_carries_it_and_none_after(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    with statement_timeout("1500ms"):
        limited = await _limit_seen(session_factory)
    # The next session may well borrow the same pooled connection.
    after = await _limit_seen(session_factory)

    assert (limited, after) == ("1500ms", "0")


@pytest.mark.no_ambient_tenant
async def test_a_session_with_no_tenant_still_gets_the_limit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    with statement_timeout("2s"):
        assert await _limit_seen(session_factory) == "2s"


async def test_the_limit_costs_no_round_trip_of_its_own(
    session_factory: async_sessionmaker[AsyncSession],
    statement_counts: StatementCounts,
) -> None:
    with statement_counts.scope("plain") as plain:
        await _limit_seen(session_factory)
    with statement_counts.scope("limited") as limited, statement_timeout("3s"):
        await _limit_seen(session_factory)

    assert limited.count == plain.count


async def test_a_statement_past_the_limit_is_cancelled_and_told_apart(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    with statement_timeout("50ms"), pytest.raises(DBAPIError) as stopped:
        async with session_factory() as session:
            await session.execute(text("SELECT pg_sleep(1)"))

    assert timed_out(stopped.value)
    assert not timed_out(ValueError("canceling statement due to statement timeout"))

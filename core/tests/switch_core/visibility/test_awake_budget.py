"""Awake minutes reach `BudgetGuard`: written per agent under
its client id, they trip an awake-time budget like any other metric."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.budgets import BudgetExceeded, BudgetGuard, enforce_awake_budgets
from switch_core.db.models import TENANT_ZERO_ID, TenantUsage, UsageMetric
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.visibility.awake_usage import record_awake_minutes
from tests.switch_core.db.stores.test_budget_store import _agent

T0 = datetime(2026, 10, 29, 12, 0, 30, tzinfo=UTC)


async def test_awake_minutes_are_counted_per_agent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        awake = await _agent(session, "awake")
        asleep = await _agent(session, "asleep")
        written = await record_awake_minutes(
            session,
            tenant_id=TENANT_ZERO_ID,
            previous_seen_at=T0,
            seen_at=T0 + timedelta(seconds=90),
            agents=[
                {"agent_id": awake.id, "session": "active"},
                {"agent_id": asleep.id, "session": "parked"},
            ],
            bound={awake.id: awake.client_id, asleep.id: asleep.client_id},
        )
        await session.commit()
    assert written == 2
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(TenantUsage.client_id, TenantUsage.amount).where(
                    TenantUsage.metric == UsageMetric.AWAKE_MINUTES
                )
            )
        ).all()
    assert rows == [(awake.client_id, 2)]


async def test_a_report_with_no_boundary_writes_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session, "quick")
        written = await record_awake_minutes(
            session,
            tenant_id=TENANT_ZERO_ID,
            previous_seen_at=T0,
            seen_at=T0 + timedelta(seconds=10),
            agents=[{"agent_id": agent.id, "session": "active"}],
            bound={agent.id: agent.client_id},
        )
        await session.commit()
        assert written == 0
        assert (await session.execute(select(TenantUsage))).scalars().all() == []


@pytest.fixture
def awake_budgets_on() -> Iterator[None]:
    enforce_awake_budgets(True)
    yield
    enforce_awake_budgets(False)


async def test_awake_minutes_trip_an_awake_time_budget(
    session_factory: async_sessionmaker[AsyncSession], awake_budgets_on: None
) -> None:
    store = BudgetStore()
    guard = BudgetGuard(store)
    async with session_factory() as session:
        agent = await _agent(session, "budgeted")
        await store.create(
            session,
            tenant_id=TENANT_ZERO_ID,
            agent_id=agent.id,
            metric=UsageMetric.AWAKE_MINUTES,
            model="",
            amount_limit=5,
            period_hours=24,
        )
        await session.commit()
        await guard.require_within(
            session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id, room_id="room-1"
        )
        previous = T0
        for step in range(1, 4):  # three reports, 2 minutes apart: 6 minutes
            now = T0 + timedelta(minutes=2 * step)
            await record_awake_minutes(
                session,
                tenant_id=TENANT_ZERO_ID,
                previous_seen_at=previous,
                seen_at=now,
                agents=[{"agent_id": agent.id, "session": "active"}],
                bound={agent.id: agent.client_id},
            )
            previous = now
        await session.commit()
        with pytest.raises(BudgetExceeded, match="awake minutes"):
            await guard.require_within(
                session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id, room_id="room-1"
            )


async def test_core_never_enforces_an_old_hosted_ai_calls_budget(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A `hosted_ai_calls` budget and the usage older boxes reported under it
    are still stored and read, but nothing counts that metric any more, and
    `BudgetGuard` never enforces it, however used up it reads."""
    store = BudgetStore()
    guard = BudgetGuard(store)
    async with session_factory() as session:
        agent = await _agent(session, "capped")
        await store.create(
            session,
            tenant_id=TENANT_ZERO_ID,
            agent_id=agent.id,
            metric=UsageMetric.HOSTED_AI_CALLS,
            model="",
            amount_limit=2,
            period_hours=24,
        )
        await UsageStore().record(
            session,
            tenant_id=TENANT_ZERO_ID,
            metric=UsageMetric.HOSTED_AI_CALLS,
            client_id=agent.client_id,
            model="",
            amount=9,
        )
        await session.commit()
        [standing] = await store.standings(
            session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id
        )
        assert standing.exhausted
        await guard.require_within(
            session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id, room_id="room-1"
        )


async def test_awake_budgets_are_ignored_while_the_flag_is_off(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Off by default: an exhausted awake-time budget stops nothing until every
    hosted box is split and `hosted_awake_budgets` is turned on."""
    store = BudgetStore()
    guard = BudgetGuard(store)
    async with session_factory() as session:
        agent = await _agent(session, "awake-off")
        await store.create(
            session,
            tenant_id=TENANT_ZERO_ID,
            agent_id=agent.id,
            metric=UsageMetric.AWAKE_MINUTES,
            model="",
            amount_limit=1,
            period_hours=24,
        )
        await record_awake_minutes(
            session,
            tenant_id=TENANT_ZERO_ID,
            previous_seen_at=T0,
            seen_at=T0 + timedelta(minutes=3),
            agents=[{"agent_id": agent.id, "session": "active"}],
            bound={agent.id: agent.client_id},
        )
        await session.commit()
        [standing] = await store.standings(
            session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id
        )
        assert standing.exhausted
        await guard.require_within(
            session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id, room_id="room-1"
        )

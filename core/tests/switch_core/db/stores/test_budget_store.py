"""Budgets and what has been spent against them, against a real database.

The period arithmetic and the spend sum are SQL, so none of this is mocked.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.budgets import BudgetExceeded, BudgetGuard
from switch_core.db.models import (
    MAX_BUDGET_AMOUNT,
    MAX_BUDGET_PERIOD_HOURS,
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    TenantUsage,
    UsageMetric,
    User,
)
from switch_core.db.stores.budget_store import BudgetNotFound, BudgetStore


async def _agent(session: AsyncSession, name: str) -> Agent:
    owner = User(
        id=f"owner-{name}", name=name, email=f"{name}@example.test", role="user"
    )
    session.add(owner)
    await session.flush()
    client = Client(matrix_user_id=f"@{name}:test", display_name=name, type="agent")
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{name}",
        encrypted_key="",
        label="unused fixture",
        type="agent",
    )
    session.add_all([client, key])
    await session.flush()
    agent = Agent(
        name=name,
        description="test agent",
        agent_type="session_addressable",
        connector_type="codex",
        integration_profile={},
        client_id=client.id,
        api_key_id=key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


def _hour(offset: int) -> datetime:
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    return now + timedelta(hours=offset)


def _spent(client_id: str, amount: int, *, metric="turns", model="", hour=0):
    return TenantUsage(
        metric=metric,
        bucket_start=_hour(hour),
        client_id=client_id,
        model=model,
        amount=amount,
    )


async def _budget(
    session: AsyncSession,
    *,
    agent_id: str | None,
    metric: UsageMetric = UsageMetric.TURNS,
    model: str = "",
    amount_limit: int = 10,
    period_hours: int = 1,
):
    return await BudgetStore().create(
        session,
        tenant_id=TENANT_ZERO_ID,
        agent_id=agent_id,
        metric=metric,
        model=model,
        amount_limit=amount_limit,
        period_hours=period_hours,
    )


async def _standings(session: AsyncSession, agent_id: str | None):
    return await BudgetStore().standings(
        session, tenant_id=TENANT_ZERO_ID, agent_id=agent_id
    )


class TestSpend:
    async def test_an_agent_budget_counts_only_that_agent_this_period(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            mine = await _agent(session, "mine")
            other = await _agent(session, "other")
            await _budget(session, agent_id=mine.id)
            session.add_all(
                [
                    _spent(mine.client_id, 3),
                    _spent(mine.client_id, 100, hour=-1),
                    _spent(other.client_id, 50),
                ]
            )
            await session.commit()

        async with session_factory() as session:
            [standing] = await _standings(session, None)

        assert standing.agent_name == "mine"
        assert standing.spent == 3
        assert standing.resets_at == _hour(1)
        assert not standing.exhausted

    async def test_a_daily_budget_turns_over_at_midnight_utc(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await _budget(session, agent_id=None, period_hours=24)
            await session.commit()

        async with session_factory() as session:
            [standing] = await _standings(session, None)

        midnight = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
        assert standing.resets_at == midnight + timedelta(days=1)

    async def test_a_tenant_wide_budget_counts_every_agent_and_no_one_else(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            one = await _agent(session, "one")
            two = await _agent(session, "two")
            await _budget(session, agent_id=None, metric=UsageMetric.MESSAGES)
            session.add_all(
                [
                    _spent("a-person", 40, metric="messages"),
                    _spent("a-bridge", 40, metric="messages"),
                    _spent(one.client_id, 4, metric="messages"),
                    _spent(two.client_id, 6, metric="messages"),
                ]
            )
            await session.commit()

        async with session_factory() as session:
            [standing] = await _standings(session, None)

        assert standing.agent_id is None
        assert standing.spent == 10
        assert standing.exhausted

    async def test_a_model_budget_counts_only_that_model(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session, "modelled")
            await _budget(
                session,
                agent_id=agent.id,
                metric=UsageMetric.OUTPUT_TOKENS,
                model="big",
                amount_limit=1000,
            )
            session.add_all(
                [
                    _spent(agent.client_id, 300, metric="output_tokens", model="big"),
                    _spent(agent.client_id, 900, metric="output_tokens", model="small"),
                ]
            )
            await session.commit()

        async with session_factory() as session:
            [standing] = await _standings(session, None)

        assert standing.spent == 300

    async def test_an_agent_is_covered_by_its_own_and_tenant_wide_budgets(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            mine = await _agent(session, "covered")
            other = await _agent(session, "elsewhere")
            await _budget(session, agent_id=None)
            await _budget(session, agent_id=mine.id)
            await _budget(session, agent_id=other.id)
            await session.commit()

        async with session_factory() as session:
            covering = await _standings(session, mine.id)

        assert [s.agent_id for s in covering] == [None, mine.id]


class TestChanges:
    async def test_a_second_budget_on_the_same_thing_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await _budget(session, agent_id=None)
            with pytest.raises(IntegrityError, match="uq_usage_budgets_tenant_wide"):
                await _budget(session, agent_id=None, amount_limit=99)

    @pytest.mark.parametrize(
        ("amount_limit", "period_hours", "constraint"),
        [
            (MAX_BUDGET_AMOUNT + 1, 24, "ck_usage_budgets_amount_limit"),
            (10, MAX_BUDGET_PERIOD_HOURS + 1, "ck_usage_budgets_period_hours"),
        ],
    )
    async def test_a_budget_past_the_bounds_is_refused(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        amount_limit: int,
        period_hours: int,
        constraint: str,
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(IntegrityError, match=constraint):
                await _budget(
                    session,
                    agent_id=None,
                    amount_limit=amount_limit,
                    period_hours=period_hours,
                )

    async def test_the_longest_budget_reads_its_standing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session, "yearly")
            session.add(_spent(agent.client_id, 4))
            await _budget(
                session,
                agent_id=agent.id,
                amount_limit=MAX_BUDGET_AMOUNT,
                period_hours=MAX_BUDGET_PERIOD_HOURS,
            )
            [standing] = await _standings(session, agent.id)

        assert standing.spent == 4
        assert standing.resets_at > datetime.now(UTC)

    async def test_update_and_delete_name_a_budget_that_exists(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BudgetStore()
        async with session_factory() as session:
            budget = await _budget(session, agent_id=None)
            await store.update(
                session,
                tenant_id=TENANT_ZERO_ID,
                budget_id=budget.id,
                amount_limit=5,
                period_hours=48,
            )
            [standing] = await _standings(session, None)
            assert (standing.amount_limit, standing.period_hours) == (5, 48)

            await store.delete(session, tenant_id=TENANT_ZERO_ID, budget_id=budget.id)
            assert await _standings(session, None) == []
            with pytest.raises(BudgetNotFound):
                await store.delete(
                    session, tenant_id=TENANT_ZERO_ID, budget_id=budget.id
                )

    async def test_deleting_an_agent_deletes_its_budgets(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session, "deleted")
            await _budget(session, agent_id=agent.id)
            await session.commit()
            await session.delete(agent)
            await session.commit()

        async with session_factory() as session:
            assert await _standings(session, None) == []


class TestGuard:
    async def test_an_agent_within_its_budgets_passes(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session, "within")
            await _budget(session, agent_id=agent.id)
            session.add(_spent(agent.client_id, 9))
            await session.flush()

            await BudgetGuard(BudgetStore()).require_within(
                session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id
            )

    async def test_the_budget_that_stops_the_agent_longest_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            agent = await _agent(session, "stopped")
            await _budget(session, agent_id=agent.id, period_hours=1)
            await _budget(
                session,
                agent_id=None,
                metric=UsageMetric.MESSAGES,
                amount_limit=2,
                period_hours=24,
            )
            session.add_all(
                [
                    _spent(agent.client_id, 10),
                    _spent(agent.client_id, 2, metric="messages"),
                ]
            )
            await session.flush()

            with pytest.raises(BudgetExceeded) as stopped:
                await BudgetGuard(BudgetStore()).require_within(
                    session, tenant_id=TENANT_ZERO_ID, agent_id=agent.id
                )

        assert stopped.value.standing.metric == "messages"
        assert str(stopped.value).startswith(
            "This workspace has reached its budget of 2 messages per 24h."
        )

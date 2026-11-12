from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    ColumnElement,
    Select,
    and_,
    bindparam,
    cast,
    delete,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from switch_core.db.models import (
    Agent,
    AgentController,
    TenantUsage,
    UsageBudget,
    UsageMetric,
)


@dataclass(frozen=True)
class BudgetStanding:
    """A budget and what has been spent against it in the current period.

    `agent_id` and `agent_name` are null for a budget covering every agent.
    """

    id: str
    agent_id: str | None
    agent_name: str | None
    metric: str
    model: str
    amount_limit: int
    period_hours: int
    spent: int
    resets_at: datetime

    @property
    def exhausted(self) -> bool:
        return self.spent >= self.amount_limit


class BudgetNotFound(LookupError):
    pass


def _period_start() -> ColumnElement[datetime]:
    """The start of the budget's current period, on the database's clock.

    Periods are counted from the Unix epoch in whole hours, which puts a daily
    boundary at midnight UTC and lines every period up with the hourly usage
    buckets it sums.
    """
    seconds = cast(UsageBudget.period_hours, BigInteger) * 3600
    return func.to_timestamp(
        func.floor(func.extract("epoch", func.now()) / seconds) * seconds
    )


def _standings(*, covering_agent: bool) -> Select[Any]:
    """The statement `BudgetStore.standings` runs: every budget of the tenant
    named by the `tenant_id` parameter, or with `covering_agent` only the
    budgets covering the agent named by `agent_id`.

    Built once, at import: it is run for every message an agent posts and
    every row decided for an agent, and building it, a correlated subquery
    and a dozen comparisons, cost more than running it."""
    period_start = _period_start()
    agent_clients = aliased(Agent)
    spent = (
        select(func.coalesce(func.sum(TenantUsage.amount), 0))
        .where(
            TenantUsage.tenant_id == UsageBudget.tenant_id,
            TenantUsage.metric == UsageBudget.metric,
            TenantUsage.bucket_start >= period_start,
            or_(UsageBudget.model == "", TenantUsage.model == UsageBudget.model),
            or_(
                and_(
                    UsageBudget.agent_id.is_(None),
                    TenantUsage.client_id.in_(
                        select(agent_clients.client_id).where(
                            agent_clients.tenant_id == UsageBudget.tenant_id
                        )
                    ),
                ),
                TenantUsage.client_id == Agent.client_id,
            ),
        )
        .correlate(UsageBudget, Agent)
        .scalar_subquery()
    )
    statement = (
        select(
            UsageBudget,
            Agent.name,
            spent,
            period_start + func.make_interval(0, 0, 0, 0, UsageBudget.period_hours),
        )
        .outerjoin(
            Agent,
            and_(
                Agent.tenant_id == UsageBudget.tenant_id,
                Agent.id == UsageBudget.agent_id,
            ),
        )
        .where(UsageBudget.tenant_id == bindparam("tenant_id"))
        .order_by(
            UsageBudget.agent_id.nulls_first(),
            UsageBudget.metric,
            UsageBudget.model,
        )
    )
    if covering_agent:
        statement = statement.where(
            or_(
                UsageBudget.agent_id.is_(None),
                UsageBudget.agent_id == bindparam("agent_id"),
            )
        )
    return statement


_EVERY_BUDGET = _standings(covering_agent=False)
_BUDGETS_COVERING_AGENT = _standings(covering_agent=True)


class BudgetStore:
    async def standings(
        self, session: AsyncSession, *, tenant_id: str, agent_id: str | None
    ) -> list[BudgetStanding]:
        """The tenant's budgets with their current spend.

        With `agent_id`, only the budgets covering that agent: its own and the
        tenant-wide ones. Without, every budget the tenant has.

        A tenant-wide budget sums what the tenant's agents spent, not what its
        people and bridges did, since it is agents that a budget stops.

        Names the tenant explicitly as well as relying on the bound session,
        for the reason `UsageStore.totals` gives.
        """
        if agent_id is None:
            rows = await session.execute(_EVERY_BUDGET, {"tenant_id": tenant_id})
        else:
            rows = await session.execute(
                _BUDGETS_COVERING_AGENT, {"tenant_id": tenant_id, "agent_id": agent_id}
            )
        return [
            BudgetStanding(
                id=budget.id,
                agent_id=budget.agent_id,
                agent_name=agent_name,
                metric=budget.metric,
                model=budget.model,
                amount_limit=budget.amount_limit,
                period_hours=budget.period_hours,
                spent=int(amount),
                resets_at=resets_at,
            )
            for budget, agent_name, amount, resets_at in rows
        ]

    async def create(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str | None,
        metric: UsageMetric,
        model: str,
        amount_limit: int,
        period_hours: int,
    ) -> UsageBudget:
        """Add a budget. A second budget on the same agent (or tenant-wide),
        metric and model fails on the unique index; the caller decides what
        that means to its user."""
        budget = UsageBudget(
            tenant_id=tenant_id,
            agent_id=agent_id,
            metric=metric.value,
            model=model,
            amount_limit=amount_limit,
            period_hours=period_hours,
        )
        session.add(budget)
        await session.flush()
        return budget

    async def update(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        budget_id: str,
        amount_limit: int,
        period_hours: int,
    ) -> UsageBudget:
        budget = await session.scalar(
            select(UsageBudget).where(
                UsageBudget.tenant_id == tenant_id, UsageBudget.id == budget_id
            )
        )
        if budget is None:
            raise BudgetNotFound(budget_id)
        budget.amount_limit = amount_limit
        budget.period_hours = period_hours
        await session.flush()
        return budget

    async def delete(
        self, session: AsyncSession, *, tenant_id: str, budget_id: str
    ) -> None:
        result = await session.execute(
            delete(UsageBudget).where(
                UsageBudget.tenant_id == tenant_id, UsageBudget.id == budget_id
            )
        )
        if result.rowcount == 0:  # type: ignore[attr-defined]
            raise BudgetNotFound(budget_id)


async def hosted_daily_cap(session: AsyncSession, tenant_id: str) -> int | None:
    """The workspace's hosted daily AI cap, or None with none
    set. The gateway enforces it; Core only hands it to the controllers."""
    limit = await session.scalar(
        select(UsageBudget.amount_limit).where(
            UsageBudget.tenant_id == tenant_id,
            UsageBudget.metric == UsageMetric.HOSTED_AI_CALLS.value,
            UsageBudget.agent_id.is_(None),
        )
    )
    return None if limit is None else int(limit)


async def bump_hosted_controllers(
    session: AsyncSession, tenant_id: str
) -> dict[str, int]:
    """Bump the assignment revision of this workspace's hosted controllers only,
    in the caller's transaction, so each refetches its assignment and reads the
    new daily cap. Returns controller id to new revision, for the nudge after
    commit. Other workspaces' controllers and people's own computers are left
    alone."""
    rows = await session.execute(
        update(AgentController)
        .where(
            AgentController.tenant_id == tenant_id,
            AgentController.kind == "ec2",
            AgentController.revoked_at.is_(None),
        )
        .values(assignment_revision=AgentController.assignment_revision + 1)
        .returning(AgentController.id, AgentController.assignment_revision)
        .execution_options(synchronize_session=False)
    )
    return {controller_id: int(revision) for controller_id, revision in rows.all()}

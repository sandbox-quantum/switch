"""The one check every path an agent spends through makes before it spends.

An agent that has reached a budget covering it is stopped until the period
turns over: addressed room messages are answered with a refusal instead of
delivered (so no session is started or prompted for them), and its own posts
are refused. People are never stopped — a budget caps what agents spend.

What a person types into a session from Switch Console goes straight to the
session's host and never passes through Switch, so it is not stopped here.

Usage is counted after the fact (a turn's tokens arrive when it ends), so the
check stops the next piece of work, not the one in flight, and a budget can be
overshot by whatever was already running when it was reached.
"""

from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import GATEWAY_ENFORCED_METRICS, UsageMetric
from switch_core.db.stores.budget_store import BudgetStanding
from switch_core.security_events import SecuritySignal, log_security_event

# Whether awake-time budgets are enforced: the `hosted_awake_budgets` flag,
# fixed for the life of the process (flags can't change while it runs), and
# set once at start (`enforce_awake_budgets`). Off by default, so a guard built
# before start-up, or in a test, never enforces one.
_awake_budgets = {"enforced": False}


def enforce_awake_budgets(enabled: bool) -> None:
    """Set from the `hosted_awake_budgets` flag when the server starts."""
    _awake_budgets["enforced"] = enabled


def _enforced_here(metric: str) -> bool:
    if metric in GATEWAY_ENFORCED_METRICS:
        return False
    if metric == UsageMetric.AWAKE_MINUTES:
        return _awake_budgets["enforced"]
    return True


class BudgetStandings(Protocol):
    """Where the guard reads budgets from: `BudgetStore`, or the router's
    reads for one row, which ask for a tenant's budgets once and answer every
    agent in the room from them."""

    async def standings(
        self, session: AsyncSession, *, tenant_id: str, agent_id: str | None
    ) -> list[BudgetStanding]: ...


def _describe(standing: BudgetStanding) -> str:
    whose = (
        f"Agent {standing.agent_name}"
        if standing.agent_name is not None
        else "This workspace"
    )
    metric = standing.metric.replace("_", " ")
    model = f" on {standing.model}" if standing.model else ""
    resets = standing.resets_at.strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"{whose} has reached its budget of {standing.amount_limit:,} {metric}"
        f"{model} per {standing.period_hours}h. It resets at {resets}."
    )


class BudgetExceeded(Exception):
    """An agent has reached a budget covering it. The message is written for
    the people in the room, since they are who see it."""

    def __init__(self, standing: BudgetStanding) -> None:
        super().__init__(_describe(standing))
        self.standing = standing


class BudgetGuard:
    def __init__(self, store: BudgetStandings) -> None:
        self._store = store
        # (tenant, agent, budget, period end) already reported as a security
        # event by this guard: an exhausted agent is refused on every message
        # until the period turns over, and one event per period is the signal.
        self._reported: set[tuple[str, str, str, datetime]] = set()

    async def require_within(
        self, session: AsyncSession, *, tenant_id: str, agent_id: str, room_id: str
    ) -> bool:
        """Raise `BudgetExceeded` if the agent has reached any budget covering
        it. When several have, the one that resets last is reported, because
        that is how long the agent is actually stopped for. Returns whether
        any budget covers the agent."""
        standings = await self._store.standings(
            session, tenant_id=tenant_id, agent_id=agent_id
        )
        exhausted = [
            standing
            for standing in standings
            # The hosted daily cap is the gateway's to enforce, never Core's
            # from a count the box reports; awake time only once every box is
            # split.
            if standing.exhausted and _enforced_here(standing.metric)
        ]
        if exhausted:
            reported = max(exhausted, key=lambda s: s.resets_at)
            self._report(tenant_id, agent_id, room_id, reported)
            raise BudgetExceeded(reported)
        return bool(standings)

    def _report(
        self, tenant_id: str, agent_id: str, room_id: str, standing: BudgetStanding
    ) -> None:
        now = datetime.now(UTC)
        self._reported = {key for key in self._reported if key[3] > now}
        key = (tenant_id, agent_id, standing.id, standing.resets_at)
        if key in self._reported:
            return
        self._reported.add(key)
        log_security_event(
            SecuritySignal.BUDGET_EXCEEDED,
            tenant_id=tenant_id,
            actor_user_id=None,
            target_type="budget",
            target_id=standing.id,
            agent_id=agent_id,
            room_id=room_id,
            details={
                "budget_agent_id": standing.agent_id,
                "metric": standing.metric,
                "model": standing.model,
                "amount_limit": standing.amount_limit,
                "spent": standing.spent,
                "period_hours": standing.period_hours,
                "resets_at": standing.resets_at.isoformat(),
            },
        )

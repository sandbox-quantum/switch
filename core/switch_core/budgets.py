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

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.stores.budget_store import BudgetStanding, BudgetStore


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
    def __init__(self, store: BudgetStore) -> None:
        self._store = store

    async def require_within(
        self, session: AsyncSession, *, tenant_id: str, agent_id: str
    ) -> None:
        """Raise `BudgetExceeded` if the agent has reached any budget covering
        it. When several have, the one that resets last is reported, because
        that is how long the agent is actually stopped for."""
        exhausted = [
            standing
            for standing in await self._store.standings(
                session, tenant_id=tenant_id, agent_id=agent_id
            )
            if standing.exhausted
        ]
        if exhausted:
            raise BudgetExceeded(max(exhausted, key=lambda s: s.resets_at))

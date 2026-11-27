"""Hosted usage from status reports: awake minutes per agent.

On each status report Core accepts from a hosted box, every agent the report
shows awake (`session` active or waking) is counted the minute boundaries
crossed since that controller's previous accepted report, capped at 5. Over
time that's exact, it needs no remainder kept anywhere, and a gap in reports
can't add more than 5 minutes.

It's written to `tenant_usage` under the agent's own `client_id`, in the same
transaction as the report, so `BudgetGuard` sums it for an awake-time budget
like any other metric, and a report that isn't stored (a
retry, an older `seq`) counts nothing.

Only agents bound to the reporting controller are counted, so one box can't
add time to anybody else's agent. The report never claims minutes: Core works
them out from its own clock between two accepted reports.

**Trust:** which agents are awake comes from the controller's own
report. On a split box the agents run as another user and can't touch it. On
an unsplit box they share the controller's user and could under-report, so an
awake-time budget there is best effort until the box is split (v12.2's roll
splits every hosted box).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import UsageMetric
from switch_core.db.stores.usage_store import UsageStore

MAX_MINUTES_PER_REPORT = 5
AWAKE_SESSIONS = frozenset({"active", "waking"})


def minutes_crossed(previous: datetime | None, now: datetime) -> int:
    """Whole-minute boundaries between two reports, capped. The first report
    from a controller is only a baseline."""
    if previous is None or now <= previous:
        return 0
    crossed = int(now.timestamp() // 60) - int(previous.timestamp() // 60)
    return max(0, min(crossed, MAX_MINUTES_PER_REPORT))


def awake_agents(
    agents: Iterable[Mapping[str, Any]], bound: Mapping[str, str]
) -> list[str]:
    """The client ids of the bound agents the report shows awake, once each."""
    seen: dict[str, None] = {}
    for entry in agents:
        agent_id = entry.get("agent_id")
        if not isinstance(agent_id, str) or entry.get("session") not in AWAKE_SESSIONS:
            continue
        client_id = bound.get(agent_id)
        if client_id:
            seen[client_id] = None
    return list(seen)


async def record_awake_minutes(
    session: AsyncSession,
    *,
    tenant_id: str,
    previous_seen_at: datetime | None,
    seen_at: datetime,
    agents: Iterable[Mapping[str, Any]],
    bound: Mapping[str, str],
    usage: UsageStore | None = None,
) -> int:
    """Count this report's awake minutes. Returns the minutes counted per
    agent (0 when nothing was written)."""
    minutes = minutes_crossed(previous_seen_at, seen_at)
    if minutes == 0:
        return 0
    store = usage or UsageStore()
    for client_id in awake_agents(agents, bound):
        await store.record(
            session,
            tenant_id=tenant_id,
            metric=UsageMetric.AWAKE_MINUTES,
            client_id=client_id,
            model="",
            amount=minutes,
        )
    return minutes

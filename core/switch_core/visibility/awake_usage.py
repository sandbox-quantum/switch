"""Hosted usage from status reports: awake minutes per agent,
and the box's AI calls (display only).

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
from datetime import UTC, datetime
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


# ── Hosted AI calls (display only) ──────────────────────────────────────────

# The most one report may add when the box reports no daily cap. A box reports
# every ~20 s, so this is far above any honest rise.
MAX_CALLS_PER_REPORT = 1_000


def _count(machine: Mapping[str, Any] | None, key: str) -> int | None:
    value = (machine or {}).get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def calls_rise(
    *,
    previous_seen_at: datetime | None,
    seen_at: datetime,
    previous: int | None,
    current: int | None,
    daily_cap: int | None,
) -> int:
    """The calls to count for this report: the rise in the box's count for
    today, counted from 0 on a new UTC day or when the count falls (a
    controller restart), and clamped to the day's cap, or to a fixed bound
    where the box reports none. The box reports this figure, so Core only
    shows it, never enforces it."""
    if current is None or previous_seen_at is None:
        return 0
    same_day = previous_seen_at.astimezone(UTC).date() == seen_at.astimezone(UTC).date()
    if previous is None or not same_day or current < previous:
        rise = current
    else:
        rise = current - previous
    bound = (
        daily_cap if daily_cap is not None and daily_cap > 0 else MAX_CALLS_PER_REPORT
    )
    return max(0, min(rise, bound))


def _agent_counts(
    agents: Iterable[Mapping[str, Any]] | None, bound: Mapping[str, str]
) -> dict[str, int]:
    """Client id → `ai_calls_today`, for the bound agents that report one."""
    counts: dict[str, int] = {}
    for entry in agents or []:
        agent_id = entry.get("agent_id")
        client_id = bound.get(agent_id) if isinstance(agent_id, str) else None
        value = _count(entry, "ai_calls_today")
        if client_id and value is not None:
            counts[client_id] = value
    return counts


async def record_hosted_ai_calls(
    session: AsyncSession,
    *,
    tenant_id: str,
    previous_seen_at: datetime | None,
    seen_at: datetime,
    previous_status: Mapping[str, Any] | None,
    status: Mapping[str, Any] | None,
    bound: Mapping[str, str],
    usage: UsageStore | None = None,
) -> int:
    """Count this report's AI calls, per agent, under each agent's own
    `client_id`, from `agents[].ai_calls_today`. Returns the calls counted.

    Only the per-agent count is used. A box can serve several workspaces, and
    its box-wide `gateway_calls_today` covers all of them, so filing that under
    any one workspace would count the same calls in each. A report
    without per-agent counts adds nothing.
    """
    store = usage or UsageStore()
    daily_cap = _count((status or {}).get("machine"), "gateway_daily_cap")
    current = _agent_counts((status or {}).get("agents"), bound)
    previous = _agent_counts((previous_status or {}).get("agents"), bound)
    total = 0
    for client_id, count in current.items():
        rise = calls_rise(
            previous_seen_at=previous_seen_at,
            seen_at=seen_at,
            previous=previous.get(client_id),
            current=count,
            daily_cap=daily_cap,
        )
        if rise:
            await store.record(
                session,
                tenant_id=tenant_id,
                metric=UsageMetric.HOSTED_AI_CALLS,
                client_id=client_id,
                model="",
                amount=rise,
            )
            total += rise
    return total

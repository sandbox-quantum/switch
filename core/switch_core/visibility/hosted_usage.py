"""The workspace admin's Usage tab: each person's awake
hours and AI calls this month, from `tenant_usage`.

Core's existing `/tenants/{id}/usage` answers per agent (client), and a person
is the agents' owner, so this read sums the two hosted metrics per owner for
the bound workspace. Counts only: no agent names, messages or content, and the
workspace's own members only, by name, as the People tab shows them.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    AgentController,
    TenantMember,
    TenantUsage,
    UsageMetric,
    User,
)
from switch_core.gateway.dependencies import get_session
from switch_core.tenant_context import current_tenant_id
from switch_core.visibility.guards import require_workspace_admin

router = APIRouter()

HOSTED_METRICS = (UsageMetric.AWAKE_MINUTES.value, UsageMetric.HOSTED_AI_CALLS.value)


_MAX_CALLS = 1_000_000_000


def cap_in_force(status: dict | None) -> tuple[int | None, str | None]:
    """The daily cap a controller reported applying, and its source; None for
    anything missing or out of bounds (display only)."""
    machine = (status or {}).get("machine")
    if not isinstance(machine, dict):
        return None, None
    cap = machine.get("gateway_daily_cap")
    source = machine.get("gateway_cap_source")
    if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= _MAX_CALLS:
        return None, None
    return cap, source if source in ("local", "workspace") else None


def month_start(now: datetime) -> datetime:
    """The first moment of this month in UTC: usage resets with the month."""
    return now.astimezone(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def awake_hours(minutes: int) -> float:
    """Awake minutes as hours, to one decimal, as the tab shows them."""
    return round(minutes / 60, 1)


class PersonUsage(BaseModel):
    user_id: str
    name: str
    awake_hours: float
    ai_calls: int
    # The daily AI cap their box's gateway applies now, and which number set it:
    # display only, from the controller's last report.
    cap_in_force: int | None = None
    cap_source: Literal["local", "workspace"] | None = None


class HostedUsageView(BaseModel):
    since: str
    people: list[PersonUsage]


@router.get("/tenants/{tenant_id}/hosted-usage")
async def workspace_hosted_usage(
    tenant_id: str,
    _admin: Annotated[User, Depends(require_workspace_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    response: Response,
) -> HostedUsageView:
    """Awake hours and AI calls this month for each person in this workspace
    with hosted usage. This workspace's admins only, counts only."""
    if current_tenant_id() != tenant_id:
        raise HTTPException(403, "Not authorized for this tenant")
    response.headers["Cache-Control"] = "no-store"
    since = month_start(datetime.now(UTC))
    rows = await session.execute(
        select(User.id, User.name, TenantUsage.metric, func.sum(TenantUsage.amount))
        .join(
            Agent,
            and_(
                Agent.client_id == TenantUsage.client_id,
                Agent.tenant_id == TenantUsage.tenant_id,
            ),
        )
        .join(User, User.id == Agent.owner_id)
        # Only this workspace's own members are named (a former member's
        # usage still counts against the workspace, but isn't listed here).
        .join(
            TenantMember,
            and_(
                TenantMember.user_id == User.id,
                TenantMember.tenant_id == TenantUsage.tenant_id,
            ),
        )
        .where(
            TenantUsage.tenant_id == tenant_id,
            TenantUsage.metric.in_(HOSTED_METRICS),
            TenantUsage.bucket_start >= since,
        )
        .group_by(User.id, User.name, TenantUsage.metric)
    )
    people: dict[str, dict] = {}

    def person_for(user_id: str, name: str) -> dict:
        return people.setdefault(
            user_id,
            {
                "user_id": user_id,
                "name": name,
                "awake": 0,
                "calls": 0,
                "cap": None,
                "source": None,
            },
        )

    for user_id, name, metric, amount in rows.all():
        person = person_for(user_id, name)
        if metric == UsageMetric.AWAKE_MINUTES.value:
            person["awake"] += int(amount or 0)
        else:
            person["calls"] += int(amount or 0)
    # Each member's hosted box in this workspace: the cap its gateway applies.
    controllers = await session.execute(
        select(User.id, User.name, AgentController.status)
        .join(User, User.id == AgentController.owner_id)
        .join(
            TenantMember,
            and_(
                TenantMember.user_id == User.id,
                TenantMember.tenant_id == AgentController.tenant_id,
            ),
        )
        .where(
            AgentController.tenant_id == tenant_id,
            AgentController.kind == "ec2",
            AgentController.revoked_at.is_(None),
        )
        .order_by(AgentController.last_seen_at.desc().nulls_last())
    )
    seen: set[str] = set()
    for user_id, name, status in controllers.all():
        if user_id in seen:
            continue
        seen.add(user_id)
        person = person_for(user_id, name)
        person["cap"], person["source"] = cap_in_force(status)
    return HostedUsageView(
        since=since.isoformat(),
        people=[
            PersonUsage(
                user_id=p["user_id"],
                name=p["name"],
                awake_hours=awake_hours(p["awake"]),
                ai_calls=p["calls"],
                cap_in_force=p["cap"],
                cap_source=p["source"],
            )
            for p in sorted(people.values(), key=lambda p: (p["name"], p["user_id"]))
        ],
    )

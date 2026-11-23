"""Store for session freshness policies.

A freshness policy defines a maximum context age (in hours) for an agent session.
Can be set workspace-wide (agent_id=None) or overridden per-agent.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, SessionFreshnessPolicy


@dataclass(frozen=True)
class FreshnessPolicyResolved:
    id: str
    tenant_id: str
    agent_id: str | None
    agent_name: str | None
    max_age_hours: int
    action: str
    created_at: datetime


class FreshnessPolicyNotFound(LookupError):
    pass


class FreshnessPolicyStore:
    async def list_policies(
        self, session: AsyncSession, tenant_id: str
    ) -> list[FreshnessPolicyResolved]:
        query = (
            select(SessionFreshnessPolicy, Agent.name)
            .outerjoin(
                Agent,
                (Agent.tenant_id == SessionFreshnessPolicy.tenant_id)
                & (Agent.id == SessionFreshnessPolicy.agent_id),
            )
            .where(SessionFreshnessPolicy.tenant_id == tenant_id)
            .order_by(
                SessionFreshnessPolicy.agent_id.nulls_first(),
                SessionFreshnessPolicy.created_at,
            )
        )
        rows = (await session.execute(query)).all()
        return [
            FreshnessPolicyResolved(
                id=p.id,
                tenant_id=p.tenant_id,
                agent_id=p.agent_id,
                agent_name=agent_name,
                max_age_hours=p.max_age_hours,
                action=p.action,
                created_at=p.created_at,
            )
            for p, agent_name in rows
        ]

    async def get(
        self, session: AsyncSession, tenant_id: str, policy_id: str
    ) -> FreshnessPolicyResolved | None:
        query = (
            select(SessionFreshnessPolicy, Agent.name)
            .outerjoin(
                Agent,
                (Agent.tenant_id == SessionFreshnessPolicy.tenant_id)
                & (Agent.id == SessionFreshnessPolicy.agent_id),
            )
            .where(
                SessionFreshnessPolicy.tenant_id == tenant_id,
                SessionFreshnessPolicy.id == policy_id,
            )
        )
        row = (await session.execute(query)).first()
        if row is None:
            return None
        p, agent_name = row
        return FreshnessPolicyResolved(
            id=p.id,
            tenant_id=p.tenant_id,
            agent_id=p.agent_id,
            agent_name=agent_name,
            max_age_hours=p.max_age_hours,
            action=p.action,
            created_at=p.created_at,
        )

    async def resolve_for_agent(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> FreshnessPolicyResolved | None:
        """Find active policy for `agent_id`: agent override if set, else workspace default."""
        policies = await self.list_policies(session, tenant_id)
        for p in policies:
            if p.agent_id == agent_id:
                return p
        for p in policies:
            if p.agent_id is None:
                return p
        return None

    async def create_or_update(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str | None,
        max_age_hours: int,
        action: str = "reset",
    ) -> SessionFreshnessPolicy:
        existing = await session.scalar(
            select(SessionFreshnessPolicy).where(
                SessionFreshnessPolicy.tenant_id == tenant_id,
                SessionFreshnessPolicy.agent_id == agent_id
                if agent_id is not None
                else SessionFreshnessPolicy.agent_id.is_(None),
            )
        )
        if existing is not None:
            existing.max_age_hours = max_age_hours
            existing.action = action
            await session.flush()
            return existing

        policy = SessionFreshnessPolicy(
            tenant_id=tenant_id,
            agent_id=agent_id,
            max_age_hours=max_age_hours,
            action=action,
        )
        session.add(policy)
        await session.flush()
        return policy

    async def delete(
        self, session: AsyncSession, *, tenant_id: str, policy_id: str
    ) -> None:
        result = await session.execute(
            delete(SessionFreshnessPolicy).where(
                SessionFreshnessPolicy.tenant_id == tenant_id,
                SessionFreshnessPolicy.id == policy_id,
            )
        )
        if result.rowcount == 0:  # type: ignore[attr-defined]
            raise FreshnessPolicyNotFound(policy_id)

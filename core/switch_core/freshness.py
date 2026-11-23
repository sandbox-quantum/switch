"""Enforces freshness policies on agent sessions before work begins.

A session older than max_age_hours is evaluated when addressed while idle:
- 'reset': context is cleared and session reconnected before turn starts,
  with an announcement in room.
- 'refuse': turn is refused and a room note explains why.

Never evaluated mid-turn (acting only on idle sessions).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.freshness_policy_store import (
    FreshnessPolicyResolved,
    FreshnessPolicyStore,
)


class FreshnessExceeded(Exception):
    """An agent's session has exceeded the freshness policy limit."""

    def __init__(
        self,
        agent_name: str,
        max_age_hours: int,
        action: str,
        age_hours: float,
    ) -> None:
        self.agent_name = agent_name
        self.max_age_hours = max_age_hours
        self.action = action
        self.age_hours = age_hours
        if action == "reset":
            msg = (
                f"Session context for @{agent_name} exceeded freshness limit "
                f"({age_hours:.1f}h old, limit {max_age_hours}h). "
                f"Resetting context before starting this turn."
            )
        else:
            msg = (
                f"@{agent_name} session is {age_hours:.1f}h old, exceeding freshness "
                f"limit of {max_age_hours}h. Work stopped by freshness policy. "
                f"Use `!reset @{agent_name}` to start a new session."
            )
        super().__init__(msg)


class FreshnessPolicyLookup(Protocol):
    async def resolve_for_agent(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> FreshnessPolicyResolved | None: ...


class FreshnessGuard:
    def __init__(
        self,
        policy_store: FreshnessPolicyLookup | None = None,
        session_store: AgentSessionStore | None = None,
    ) -> None:
        self._policy_store = policy_store or FreshnessPolicyStore()
        self._session_store = session_store or AgentSessionStore()

    async def check_freshness(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str,
        agent_name: str,
        room_id: str,
        is_idle: bool = True,
    ) -> FreshnessPolicyResolved | None:
        """Check if the session for (agent_id, room_id) violates freshness policy.

        Returns policy if exceeded, else None.
        Never fires when `is_idle` is False (acting only on idle sessions).
        """
        if not is_idle:
            return None

        policy = await self._policy_store.resolve_for_agent(session, tenant_id, agent_id)
        if policy is None:
            return None

        sessions = await self._session_store.get_sessions_for_agent(session, agent_id)
        room_session = next((s for s in sessions if s.room_id == room_id), None)
        if room_session is None or room_session.created_at is None:
            return None

        created_at = room_session.created_at
        if isinstance(created_at, str):
            try:
                created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except ValueError:
                return None
        else:
            created_dt = created_at

        now = datetime.now(UTC)
        if created_dt.tzinfo is None:
            created_dt = created_dt.replace(tzinfo=UTC)

        age = now - created_dt
        age_hours = age.total_seconds() / 3600.0
        if age_hours >= policy.max_age_hours:
            raise FreshnessExceeded(
                agent_name=agent_name,
                max_age_hours=policy.max_age_hours,
                action=policy.action,
                age_hours=age_hours,
            )
        return None

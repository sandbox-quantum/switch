from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic import ValidationError

from switch_core.db.stores.freshness_policy_store import (
    FreshnessPolicyResolved,
)
from switch_core.freshness import FreshnessExceeded, FreshnessGuard
from switch_core.gateway.schemas import (
    FreshnessPolicyCreateRequest,
)


def test_freshness_schemas_validation():
    req = FreshnessPolicyCreateRequest(max_age_hours=24, action="reset")
    assert req.max_age_hours == 24
    assert req.action == "reset"
    assert req.agent_id is None

    agent_req = FreshnessPolicyCreateRequest(
        agent_id="agent-123", max_age_hours=48, action="refuse"
    )
    assert agent_req.agent_id == "agent-123"
    assert agent_req.max_age_hours == 48
    assert agent_req.action == "refuse"

    # Validation errors on non-positive max_age_hours
    with pytest.raises(ValidationError):
        FreshnessPolicyCreateRequest(max_age_hours=0)

    with pytest.raises(ValidationError):
        FreshnessPolicyCreateRequest(max_age_hours=-5)


class FakePolicyStore:
    def __init__(self, policies: list[FreshnessPolicyResolved]) -> None:
        self.policies = policies

    async def resolve_for_agent(
        self, session: Any, tenant_id: str, agent_id: str
    ) -> FreshnessPolicyResolved | None:
        for p in self.policies:
            if p.agent_id == agent_id:
                return p
        for p in self.policies:
            if p.agent_id is None:
                return p
        return None


class FakeSession:
    def __init__(self, room_id: str, created_at: datetime) -> None:
        self.room_id = room_id
        self.created_at = created_at


class FakeSessionStore:
    def __init__(self, sessions: list[FakeSession]) -> None:
        self.sessions = sessions

    async def get_sessions_for_agent(
        self, session: Any, agent_id: str
    ) -> list[FakeSession]:
        return self.sessions


@pytest.mark.asyncio
async def test_freshness_guard_idle_check():
    # If not idle (mid-turn), guard never fires
    guard = FreshnessGuard(policy_store=FakePolicyStore([]), session_store=FakeSessionStore([]))
    res = await guard.check_freshness(
        None,  # type: ignore[arg-type]
        tenant_id="t1",
        agent_id="a1",
        agent_name="Agent",
        room_id="r1",
        is_idle=False,
    )
    assert res is None


@pytest.mark.asyncio
async def test_freshness_guard_fresh_session():
    now = datetime.now(UTC)
    policy = FreshnessPolicyResolved(
        id="p1",
        tenant_id="t1",
        agent_id=None,
        agent_name=None,
        max_age_hours=24,
        action="reset",
        created_at=now,
    )
    # Session is only 2 hours old
    session_row = FakeSession(room_id="r1", created_at=now - timedelta(hours=2))
    guard = FreshnessGuard(
        policy_store=FakePolicyStore([policy]),  # type: ignore[arg-type]
        session_store=FakeSessionStore([session_row]),  # type: ignore[arg-type]
    )

    res = await guard.check_freshness(
        None,  # type: ignore[arg-type]
        tenant_id="t1",
        agent_id="a1",
        agent_name="Agent",
        room_id="r1",
        is_idle=True,
    )
    assert res is None


@pytest.mark.asyncio
async def test_freshness_guard_exceeded_reset_action():
    now = datetime.now(UTC)
    policy = FreshnessPolicyResolved(
        id="p1",
        tenant_id="t1",
        agent_id=None,
        agent_name=None,
        max_age_hours=12,
        action="reset",
        created_at=now,
    )
    # Session is 25 hours old (> 12h)
    session_row = FakeSession(room_id="r1", created_at=now - timedelta(hours=25))
    guard = FreshnessGuard(
        policy_store=FakePolicyStore([policy]),  # type: ignore[arg-type]
        session_store=FakeSessionStore([session_row]),  # type: ignore[arg-type]
    )

    with pytest.raises(FreshnessExceeded) as exc_info:
        await guard.check_freshness(
            None,  # type: ignore[arg-type]
            tenant_id="t1",
            agent_id="a1",
            agent_name="Helper",
            room_id="r1",
            is_idle=True,
        )

    assert exc_info.value.action == "reset"
    assert exc_info.value.max_age_hours == 12
    assert "Resetting context before starting this turn" in str(exc_info.value)


@pytest.mark.asyncio
async def test_freshness_guard_exceeded_refuse_action():
    now = datetime.now(UTC)
    policy = FreshnessPolicyResolved(
        id="p1",
        tenant_id="t1",
        agent_id="a1",
        agent_name="Helper",
        max_age_hours=6,
        action="refuse",
        created_at=now,
    )
    # Session is 10 hours old (> 6h)
    session_row = FakeSession(room_id="r1", created_at=now - timedelta(hours=10))
    guard = FreshnessGuard(
        policy_store=FakePolicyStore([policy]),  # type: ignore[arg-type]
        session_store=FakeSessionStore([session_row]),  # type: ignore[arg-type]
    )

    with pytest.raises(FreshnessExceeded) as exc_info:
        await guard.check_freshness(
            None,  # type: ignore[arg-type]
            tenant_id="t1",
            agent_id="a1",
            agent_name="Helper",
            room_id="r1",
            is_idle=True,
        )

    assert exc_info.value.action == "refuse"
    assert "Work stopped by freshness policy" in str(exc_info.value)
    assert "!reset @Helper" in str(exc_info.value)


@pytest.mark.asyncio
async def test_freshness_policy_resolution_agent_override():
    now = datetime.now(UTC)
    workspace_policy = FreshnessPolicyResolved(
        id="p-ws",
        tenant_id="t1",
        agent_id=None,
        agent_name=None,
        max_age_hours=48,
        action="reset",
        created_at=now,
    )
    agent_override = FreshnessPolicyResolved(
        id="p-agent",
        tenant_id="t1",
        agent_id="a1",
        agent_name="SpecialAgent",
        max_age_hours=12,
        action="refuse",
        created_at=now,
    )

    store = FakePolicyStore([workspace_policy, agent_override])

    # Agent a1 gets override (12h)
    resolved_a1 = await store.resolve_for_agent(None, "t1", "a1")
    assert resolved_a1 is not None
    assert resolved_a1.id == "p-agent"
    assert resolved_a1.max_age_hours == 12

    # Agent a2 gets fallback (48h)
    resolved_a2 = await store.resolve_for_agent(None, "t1", "a2")
    assert resolved_a2 is not None
    assert resolved_a2.id == "p-ws"
    assert resolved_a2.max_age_hours == 48

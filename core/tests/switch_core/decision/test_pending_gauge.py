"""The waiting queue's gauges: sampled by the sweep across the workspaces with
a message waiting, and quiet once the sample goes stale."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, PendingDecision, Room, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.pending_decision_store import PendingDecisionStore
from switch_core.db.tenant_lookup import tenants_with_pending_decisions
from switch_core.decision.pending_gauge import PendingDecisionGauge
from switch_core.observability.catalogue import (
    DECISION_PENDING,
    DECISION_PENDING_OLDEST_AGE,
)

TENANT_B = "pending-gauge-tenant-b"


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def _waiting(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, count: int
) -> None:
    async with tenant_session(session_factory, tenant_id) as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="d",
        )
        session.add(room)
        await session.flush()
        for seq in range(1, count + 1):
            await PendingDecisionStore().add(
                session,
                tenant_id=tenant_id,
                room_id=room.id,
                room_seq=seq,
                message_key=f"$m{seq}-{uuid.uuid4().hex[:6]}",
            )
        await session.commit()


def _values(gauge: PendingDecisionGauge) -> dict[str, float]:
    return {reading.spec.name: reading.value for reading in gauge.readings()}


async def test_the_queue_is_summed_across_workspaces_with_the_oldest_age(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
        await session.commit()
    await _waiting(session_factory, TENANT_ZERO_ID, 2)
    await _waiting(session_factory, TENANT_B, 1)
    async with session_factory() as session:
        await session.execute(
            update(PendingDecision)
            .where(PendingDecision.tenant_id == TENANT_B)
            .values(created_at=func.now() - timedelta(seconds=90))
        )
        await session.commit()
    gauge = PendingDecisionGauge(sweep_seconds=5.0)

    await gauge.sample(
        session_factory, await tenants_with_pending_decisions(session_factory)
    )

    values = _values(gauge)
    assert values[DECISION_PENDING.name] == 3
    assert 89 <= values[DECISION_PENDING_OLDEST_AGE.name] <= 95


async def test_an_empty_queue_reads_zero(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gauge = PendingDecisionGauge(sweep_seconds=5.0)

    await gauge.sample(session_factory, [])

    assert _values(gauge) == {
        DECISION_PENDING.name: 0.0,
        DECISION_PENDING_OLDEST_AGE.name: 0.0,
    }


async def test_nothing_is_reported_before_the_first_sample_or_once_stale(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    clock = _Clock()
    gauge = PendingDecisionGauge(sweep_seconds=5.0, clock=clock)
    assert _values(gauge) == {}

    await gauge.sample(session_factory, [])
    clock.now += 20
    assert DECISION_PENDING.name in _values(gauge)

    clock.now += 1
    assert _values(gauge) == {}

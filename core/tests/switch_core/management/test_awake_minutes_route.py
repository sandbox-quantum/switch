"""Awake minutes come only from hosted boxes: a person's own computer
(a Console or daemon controller) reporting awake agents counts nothing, and
its reports are stored as before."""

from __future__ import annotations

import copy

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TenantUsage, UsageMetric
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    enroll_console,
    fixture,
    place_agent,
    report_status_only,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def test_own_computers_count_no_awake_minutes(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="helper")
        entry = copy.deepcopy(fixture("status_request.json")["agents"][0])
        entry.update({"agent_id": agent_id, "session": "active"})
        entry.pop("reason", None)
        for seq in (2, 3, 4):
            harness.clock.advance(minutes=2)
            response = await report_status_only(client, controller, seq, agents=[entry])
            assert response.status_code == 200, response.text
    async with harness.session_factory() as session:
        rows = (
            (
                await session.execute(
                    select(TenantUsage).where(
                        TenantUsage.metric == UsageMetric.AWAKE_MINUTES
                    )
                )
            )
            .scalars()
            .all()
        )
    assert rows == []

"""The daily AI cap is gone: a workspace's budget row from before it went still
reads, and no controller is handed it. Against Postgres."""

from __future__ import annotations

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    UsageBudget,
    UsageMetric,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.budget_store import BudgetStore
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    enroll_console,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _controller(harness: Harness, name: str, *, ec2: bool) -> EnrolledController:
    owner = await add_member(harness.session_factory, name)
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
    if ec2:
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            await session.execute(
                update(AgentController)
                .where(AgentController.id == controller.controller_id)
                .values(kind="ec2")
            )
            await session.commit()
        harness.controller_auth_cache.clear()
    return controller


async def _set_daily_cap(harness: Harness, limit: int) -> None:
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        session.add(
            UsageBudget(
                tenant_id=TENANT_ZERO_ID,
                agent_id=None,
                metric=UsageMetric.HOSTED_AI_CALLS.value,
                model="",
                amount_limit=limit,
                period_hours=24,
            )
        )
        await session.commit()


async def _assignment(harness: Harness, controller: EnrolledController) -> dict:
    async with harness.client() as client:
        answer = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )
    assert answer.status_code == 200, answer.text
    return answer.json()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_no_assignment_carries_a_daily_cap_even_with_an_old_budget_stored(
    harness: Harness,
) -> None:
    """A workspace that set a daily AI cap before it was removed still has its
    budget row. It is still read (the budgets list shows it), but no controller
    is handed it: a box on an older image then has no workspace cap, only its
    own operator setting, if it carries one."""
    from tests.switch_core.management.test_hosted_block_refusals import _on_machine

    cloud = await _controller(harness, "ada", ec2=True)
    await _on_machine(harness, cloud, "box")
    own_computer = await _controller(harness, "bob", ec2=False)
    await _set_daily_cap(harness, 300)
    assert "gateway_daily_cap" not in await _assignment(harness, cloud)
    assert "gateway_daily_cap" not in await _assignment(harness, own_computer)
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        standings = await BudgetStore().standings(
            session, tenant_id=TENANT_ZERO_ID, agent_id=None
        )
    assert [(s.metric, s.amount_limit) for s in standings] == [
        (UsageMetric.HOSTED_AI_CALLS.value, 300)
    ]

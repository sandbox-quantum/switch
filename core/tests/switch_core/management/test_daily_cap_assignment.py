"""The workspace's daily AI cap reaches its hosted controllers
through the assignment, and a change bumps only that workspace's hosted
controllers' revisions. Against Postgres."""

from __future__ import annotations

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    UsageBudget,
    UsageMetric,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.budget_store import bump_hosted_controllers, hosted_daily_cap
from switch_core.tenant_context import tenant_scope
from tests.switch_core.hosted_machine_helpers import add_tenant
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
async def test_a_hosted_controller_reads_the_workspace_s_daily_cap(
    harness: Harness,
) -> None:
    from tests.switch_core.management.test_hosted_block_refusals import _on_machine

    cloud = await _controller(harness, "ada", ec2=True)
    await _on_machine(harness, cloud, "box")
    v1_machine = await _controller(harness, "cy", ec2=True)
    await _on_machine(harness, v1_machine, "vm")
    own_computer = await _controller(harness, "bob", ec2=False)
    assert (await _assignment(harness, cloud))["gateway_daily_cap"] is None
    await _set_daily_cap(harness, 300)
    assert (await _assignment(harness, cloud))["gateway_daily_cap"] == 300
    # A person's own computer, and a v1 machine, are never capped this way: the
    # cap is a v2 box's (sweep row 7).
    assert "gateway_daily_cap" not in await _assignment(harness, own_computer)
    assert "gateway_daily_cap" not in await _assignment(harness, v1_machine)
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        assert await hosted_daily_cap(session, TENANT_ZERO_ID) == 300


async def test_a_change_bumps_only_this_workspace_s_hosted_controllers(
    harness: Harness,
) -> None:
    cloud = await _controller(harness, "ada", ec2=True)
    own_computer = await _controller(harness, "bob", ec2=False)
    async with harness.session_factory() as session:
        await add_tenant(session, "other-workspace")
        await session.commit()
    with tenant_scope("other-workspace"):
        async with harness.session_factory() as session:
            elsewhere = AgentController(
                tenant_id="other-workspace",
                owner_id=cloud.owner.id,
                name="Switch cloud",
                kind="ec2",
            )
            session.add(elsewhere)
            await session.commit()
            elsewhere_id = elsewhere.id

    async def revisions() -> dict[str, int]:
        found: dict[str, int] = {}
        for tenant, ids in (
            (TENANT_ZERO_ID, [cloud.controller_id, own_computer.controller_id]),
            ("other-workspace", [elsewhere_id]),
        ):
            async with tenant_session(harness.session_factory, tenant) as session:
                rows = await session.execute(
                    select(
                        AgentController.id, AgentController.assignment_revision
                    ).where(AgentController.id.in_(ids))
                )
                found.update({i: int(r) for i, r in rows.all()})
        return found

    before = await revisions()
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        bumped = await bump_hosted_controllers(session, TENANT_ZERO_ID)
        await session.commit()
    after = await revisions()
    assert set(bumped) == {cloud.controller_id}
    assert after[cloud.controller_id] == before[cloud.controller_id] + 1
    assert after[own_computer.controller_id] == before[own_computer.controller_id]
    assert after[elsewhere_id] == before[elsewhere_id]

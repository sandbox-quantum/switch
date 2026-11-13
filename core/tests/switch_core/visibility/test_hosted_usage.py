"""The workspace admin's Usage tab: awake hours and AI
calls this month per person, this workspace's members only, admins only."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.db.models import (
    Agent,
    TenantMember,
    UsageMetric,
    User,
    require_tenant_id,
)
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session, get_user_store
from switch_core.visibility.hosted_usage import (
    awake_hours,
    cap_in_force,
    month_start,
    router,
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    ControllerApp,
    controller_app,
    enrolled,
)


def test_the_month_starts_at_midnight_utc_on_the_first() -> None:
    now = datetime(2026, 10, 29, 13, 45, tzinfo=UTC)
    assert month_start(now) == datetime(2026, 10, 1, tzinfo=UTC)


def test_the_cap_in_force_comes_from_the_report_and_is_display_only() -> None:
    machine = {"gateway_daily_cap": 200, "gateway_cap_source": "local"}
    assert cap_in_force({"machine": machine}) == (200, "local")
    assert cap_in_force({"machine": {"gateway_daily_cap": 50}}) == (50, None)
    for bad in (
        None,
        {},
        {"machine": "x"},
        {"machine": {"gateway_daily_cap": "200"}},
        {"machine": {"gateway_daily_cap": 0}},
        {"machine": {"gateway_daily_cap": True}},
    ):
        assert cap_in_force(bad) == (None, None), bad
    odd = {"machine": {"gateway_daily_cap": 80, "gateway_cap_source": "admin typed"}}
    assert cap_in_force(odd) == (80, None)


def test_awake_minutes_read_as_hours_to_one_decimal() -> None:
    assert (awake_hours(0), awake_hours(90), awake_hours(61)) == (0.0, 1.5, 1.0)


async def _client_ids(base: ControllerApp, agent_ids: list[str]) -> list[str]:
    async with base.factory() as session:
        rows = await session.scalars(
            select(Agent.client_id).where(Agent.id.in_(agent_ids))
        )
        return list(rows)


async def _record(
    base: ControllerApp, client_id: str, metric: UsageMetric, amount: int
) -> None:
    async with base.factory() as session:
        await UsageStore().record(
            session,
            tenant_id=require_tenant_id(),
            metric=metric,
            client_id=client_id,
            model="",
            amount=amount,
        )
        await session.commit()


@pytest.fixture
async def usage(controller_app):  # noqa: F811
    base = controller_app
    async with base.factory() as session:
        admin = User(
            name="Robin Admin",
            email="robin@example.com",
            role="user",
            password_hash="x",
        )
        member = User(
            name="Alex Member", email="alex@example.com", role="user", password_hash="x"
        )
        session.add_all([admin, member])
        await session.flush()
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=admin.id, role="admin")
        )
        session.add(
            TenantMember(
                tenant_id=require_tenant_id(), user_id=member.id, role="member"
            )
        )
        await session.commit()
        users = {"admin": admin, "member": member}
    app = FastAPI()
    app.include_router(router)

    async def session_dep():
        async with base.factory() as opened:
            yield opened

    app.dependency_overrides[get_session] = session_dep
    app.dependency_overrides[get_current_user] = lambda: app.state.current
    # Its own store, so the admin check never reads the shared dependency state
    # another test may have left behind.
    app.dependency_overrides[get_user_store] = UserStore
    app.state.current = users["admin"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield base, client, app, users


async def test_each_person_s_awake_hours_and_ai_calls_this_month(usage) -> None:
    base, client, _app, _users = usage
    _, agent_ids = await enrolled(base, agents=2)
    first, second = await _client_ids(base, agent_ids)
    await _record(base, first, UsageMetric.AWAKE_MINUTES, 90)
    await _record(base, second, UsageMetric.AWAKE_MINUTES, 30)
    await _record(base, first, UsageMetric.HOSTED_AI_CALLS, 7)
    # Another metric isn't part of this view.
    await _record(base, first, UsageMetric.TURNS, 99)

    answer = await client.get(f"/tenants/{require_tenant_id()}/hosted-usage")

    assert answer.status_code == 200, answer.text
    assert answer.headers["cache-control"] == "no-store"
    body = answer.json()
    assert body["people"] == [
        {
            "user_id": base.owner_id,
            "name": "owner",
            "awake_hours": 2.0,
            "ai_calls": 7,
            "cap_in_force": None,
            "cap_source": None,
        }
    ]
    assert datetime.fromisoformat(body["since"]).day == 1


async def test_a_plain_member_or_another_workspace_is_refused(usage) -> None:
    _base, client, app, users = usage
    app.state.current = users["member"]
    assert (
        await client.get(f"/tenants/{require_tenant_id()}/hosted-usage")
    ).status_code == 403
    app.state.current = users["admin"]
    assert (
        await client.get("/tenants/some-other-workspace/hosted-usage")
    ).status_code == 403

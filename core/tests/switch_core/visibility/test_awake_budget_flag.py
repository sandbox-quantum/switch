"""Awake-time budgets wait for `hosted_awake_budgets`: off, the budgets route refuses one; on, it creates it."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.gateway import dependencies as gw_deps
from tests.switch_core.gateway.test_tenant_api_routes import (
    _KEYRING,
    TENANT_A,
    _app,
    _client,
    _make_agent_with_key,
    _make_member,
    _make_tenant,
    _token,
)


def _with_flag(app, enabled: bool):  # type: ignore[no-untyped-def]
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
        gateway_max_workspaces_per_user=3,
        gateway_signup_mode="default_tenant",
        gateway_invite_emails_per_day=20,
        dashboard_base_url="https://switch.example.com/",
        hosted_awake_budgets_enabled=enabled,
    )
    return app


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(("enabled", "status"), [(False, 422), (True, 201)])
async def test_awake_budgets_follow_the_flag(
    session_factory: async_sessionmaker[AsyncSession], enabled: bool, status: int
) -> None:
    await _make_tenant(session_factory, TENANT_A)
    user_id = await _make_member(
        session_factory, name="awake-admin", tenant_id=TENANT_A, role="admin"
    )
    agent_id, _, _ = await _make_agent_with_key(
        session_factory, tenant_id=TENANT_A, owner_id=user_id
    )
    token = _token(user_id, "awake-admin@example.invalid", TENANT_A)
    async with _client(_with_flag(_app(session_factory), enabled), token) as client:
        response = await client.post(
            f"/tenants/{TENANT_A}/budgets",
            json={
                "agent_id": agent_id,
                "metric": "awake_minutes",
                "model": "",
                "amount_limit": 600,
                "period_hours": 720,
            },
        )
    assert response.status_code == status, response.text

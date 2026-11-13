"""A workspace admin switching a service connector is reported once per
change: switching it to what it already is says nothing."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.gateway import workspace_services as workspace_services_routes
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import build_service_harness
from tests.switch_core.gateway.test_workspace_services import SERVICES, _person, _put
from tests.switch_core.management.harness import cookies_for
from tests.telemetry_records import recording_telemetry


async def test_on_off_and_back_to_the_default(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    telemetry, sink = recording_telemetry()
    monkeypatch.setattr(
        workspace_services_routes, "current_telemetry", lambda: telemetry
    )
    harness = build_service_harness(session_factory, FakeVendor(), workspace_gate=True)[
        0
    ]
    admin = await _person(harness.session_factory, "admin", member_role="admin")

    for enabled in (True, True, False):
        response = await _put(harness, admin, "datadog", {"enabled": enabled})
        assert response.status_code == 200, response.text
    async with harness.client() as client:
        cleared = await client.delete(f"{SERVICES}/datadog", cookies=cookies_for(admin))
    assert cleared.status_code == 200, cleared.text

    assert [e["setting"] for e in sink.events("service_switched")] == [
        "on",
        "off",
        "default",
    ]
    assert {
        (e["service"], e["scope"], e["locked"]) for e in sink.events("service_switched")
    } == {("datadog", "workspace", False)}

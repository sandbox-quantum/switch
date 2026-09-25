"""A connector the deployment registered itself is not a person onboarding.

The standalone stack, the Helm chart and every Console-managed local server run
a setup step that registers the bundled Mattermost seconds after install. Left
alone, that connector claims `first_connector_added` on every such deployment,
so "time to first connector" reads as boot time and the connector a person
actually added later is never a milestone at all.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.db.models import CollaborationBridge
from tests.switch_core.bridges.collaboration.test_lifecycle_tenant_binding import (
    _make_bridge,
    _make_tenant,
    _StubAdapter,
    _StubConfig,
)
from tests.switch_core.telemetry.test_bridge_connect_reporting import (
    _RecordingSink,
    _service_with_telemetry,
)

INSTALLED = datetime.now(UTC) - timedelta(minutes=5)


def _running(
    service: CollaborationBridgeLifecycleService,
    bridge_id: str,
    *,
    preconfigured: bool,
) -> None:
    """What `start()` records for a bridge before it connects."""
    service._bridges[bridge_id] = MagicMock()
    if preconfigured:
        service._preconfigured.add(bridge_id)


async def _events(
    service: CollaborationBridgeLifecycleService, sink: _RecordingSink, name: str
) -> list[dict[str, Any]]:
    await service._telemetry.aclose()  # type: ignore[union-attr]
    return [
        dict(record.properties)
        for record in sink.sent
        if record.name == f"switch_core.{name}"
    ]


class TestTheBundledConnector:
    async def test_it_reports_itself_as_preconfigured(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
        bundled = f"bundled-{uuid.uuid4().hex[:8]}"
        _running(service, bundled, preconfigured=True)

        await service._report_connector_up(bundled, "mattermost", INSTALLED)

        [added] = await _events(service, sink, "connector_added")
        assert added["is_preconfigured"] is True
        assert added["is_first_connector"] is False

    async def test_it_does_not_claim_the_first_connector_milestone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
        bundled = f"bundled-{uuid.uuid4().hex[:8]}"
        _running(service, bundled, preconfigured=True)

        await service._report_connector_up(bundled, "mattermost", INSTALLED)

        assert await _events(service, sink, "first_connector_added") == []

    async def test_reconnecting_later_still_does_not_claim_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The path taken once this bridge's own claim is spent, on every
        restart after the first."""
        service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
        bundled = f"bundled-{uuid.uuid4().hex[:8]}"
        _running(service, bundled, preconfigured=True)

        await service._report_connector_up(bundled, "mattermost", INSTALLED)
        await service._report_connector_up(bundled, "mattermost", INSTALLED)

        assert await _events(service, sink, "first_connector_added") == []


class TestTheConnectorAPersonAdds:
    async def test_it_is_the_first_connector_despite_the_bundled_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
        bundled = f"bundled-{uuid.uuid4().hex[:8]}"
        slack = f"slack-{uuid.uuid4().hex[:8]}"
        _running(service, bundled, preconfigured=True)
        await service._report_connector_up(bundled, "mattermost", INSTALLED)
        _running(service, slack, preconfigured=False)

        await service._report_connector_up(slack, "slack", INSTALLED)

        added = await _events(service, sink, "connector_added")
        assert [(a["bridge_platform"], a["is_first_connector"]) for a in added] == [
            ("mattermost", False),
            ("slack", True),
        ]
        assert added[1]["is_preconfigured"] is False

    async def test_it_claims_the_first_connector_milestone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
        bundled = f"bundled-{uuid.uuid4().hex[:8]}"
        slack = f"slack-{uuid.uuid4().hex[:8]}"
        _running(service, bundled, preconfigured=True)
        await service._report_connector_up(bundled, "mattermost", INSTALLED)
        _running(service, slack, preconfigured=False)

        await service._report_connector_up(slack, "slack", INSTALLED)

        [milestone] = await _events(service, sink, "first_connector_added")
        assert milestone["bridge_platform"] == "slack"

    async def test_a_second_one_is_not_the_first(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
        slack = f"slack-{uuid.uuid4().hex[:8]}"
        teams = f"teams-{uuid.uuid4().hex[:8]}"
        _running(service, slack, preconfigured=False)
        await service._report_connector_up(slack, "slack", INSTALLED)
        _running(service, teams, preconfigured=False)

        await service._report_connector_up(teams, "teams", INSTALLED)

        added = await _events(service, sink, "connector_added")
        assert [a["is_first_connector"] for a in added] == [True, False]


class TestTheFlagIsReadOffTheRow:
    async def test_start_records_a_preconfigured_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.execute(
                update(CollaborationBridge)
                .where(CollaborationBridge.id == bridge_id)
                .values(preconfigured=True)
            )
            await session.commit()

        service, _ = _service_with_telemetry(session_factory)
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)
        service._run_bridge = AsyncMock()  # type: ignore[method-assign]

        await service.start(bridge_id)

        assert bridge_id in service._preconfigured

    async def test_start_does_not_record_a_bridge_a_person_added(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service, _ = _service_with_telemetry(session_factory)
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)
        service._run_bridge = AsyncMock()  # type: ignore[method-assign]

        await service.start(bridge_id)

        assert bridge_id not in service._preconfigured


class TestMarkingARunningBridge:
    """The setup step marks a bridge it registered before the flag existed,
    after the bridge is already running. A connector a person adds before the
    next restart must not see it as a person's."""

    def test_a_running_bridge_follows_the_change(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service, _ = _service_with_telemetry(session_factory)
        service._bridge_facts["bundled"] = ("mattermost", INSTALLED)

        service.note_preconfigured("bundled", True)
        assert "bundled" in service._preconfigured

        service.note_preconfigured("bundled", False)
        assert "bundled" not in service._preconfigured

    def test_a_bridge_that_is_not_running_is_not_tracked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """It reads the row when it starts; tracking it here would leave an
        entry nothing ever removes."""
        service, _ = _service_with_telemetry(session_factory)

        service.note_preconfigured("stopped", True)

        assert "stopped" not in service._preconfigured

"""`connector_added` reports setup time only when setup was actually seen.

`seconds_since_configured` is configuration saved to first connect. A first
connect made while telemetry was off went unmeasured, and reporting it on the
next connect after telemetry is switched on reports the connector's whole age
— millions of seconds — as setup time. So the first connect is recorded
whether telemetry is on or not, and only a connector whose first connect
happened while reporting reports it.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.telemetry.service import TelemetryService
from tests.switch_core.telemetry.test_bridge_connect_reporting import (
    _service_with_telemetry,
)
from tests.switch_core.telemetry.test_preconfigured_connectors import (
    INSTALLED,
    _events,
    _running,
)

CONFIGURED_LONG_AGO = datetime.now(UTC) - timedelta(days=60)


def _switched_off(telemetry: TelemetryService) -> TelemetryService:
    return TelemetryService(
        sink=telemetry._sink,
        enabled=False,
        client_id="deployment-uuid",
        version=None,
        telemetry_environment="prod",
        telemetry_internal=False,
        session_factory=telemetry._session_factory,
        installed_at=INSTALLED,
    )


async def test_a_first_connect_while_telemetry_was_off_is_never_reported(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
    reporting = service._telemetry
    assert reporting is not None
    bridge = f"slack-{uuid.uuid4().hex[:8]}"
    _running(service, bridge, preconfigured=False)

    service._telemetry = _switched_off(reporting)
    await service._report_connector_up(bridge, "slack", CONFIGURED_LONG_AGO)
    service._telemetry = reporting
    await service._report_connector_up(bridge, "slack", CONFIGURED_LONG_AGO)

    assert await _events(service, sink, "connector_added") == []


async def test_a_first_connect_while_reporting_reports_its_setup_time(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = _service_with_telemetry(session_factory, installed_at=INSTALLED)
    bridge = f"slack-{uuid.uuid4().hex[:8]}"
    _running(service, bridge, preconfigured=False)
    configured = datetime.now(UTC) - timedelta(seconds=90)

    await service._report_connector_up(bridge, "slack", configured)

    [added] = await _events(service, sink, "connector_added")
    assert 90 <= added["seconds_since_configured"] < 600

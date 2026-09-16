"""Building the telemetry service at boot.

One function, so `main.py` does not have to know the difference between an
enabled deployment and a disabled one — it asks for a service and gets one
either way. Off is a service holding a sink that discards, not a `None` that
every call site would have to remember to check.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.telemetry.deployment import load_deployment_identity
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import NullSink, OtlpRelaySink, TelemetrySink

logger = logging.getLogger(__name__)


async def build_telemetry(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    version: str | None,
) -> tuple[TelemetryService, datetime | None]:
    """The telemetry service, and this deployment's install date.

    The install date comes back alongside because the milestone call sites need
    it and it is read from the same row as the client id — asking twice would
    be two queries for one fact.

    The identity is read even when telemetry is off. It is one query at boot,
    and reading it unconditionally means a deployment that switches reporting
    on later already has the id it was assigned when it was installed, rather
    than minting one on the day it opted in and looking brand new.
    """
    client_id, installed_at = await load_deployment_identity(session_factory)

    sink: TelemetrySink
    if config.telemetry_enabled:
        sink = OtlpRelaySink(
            endpoint=config.telemetry_endpoint,
            timeout_seconds=config.telemetry_timeout_seconds,
        )
        logger.info(
            "Product telemetry is ON: usage counts and timings are reported to "
            "%s. No room, tenant, agent, user or message is identified in them "
            "— see docs/old/telemetry-events.md for exactly what is sent. Set "
            "TELEMETRY_ENABLED=false to switch it off.",
            config.telemetry_endpoint,
        )
    else:
        sink = NullSink()
        logger.info(
            "Product telemetry is off; nothing is collected or sent. Set "
            "TELEMETRY_ENABLED=true to report anonymous usage counts."
        )

    return (
        TelemetryService(
            sink=sink,
            enabled=config.telemetry_enabled,
            client_id=client_id,
            service_name=config.service_name,
            version=version,
            environment=config.environment,
            session_factory=session_factory,
            installed_at=installed_at,
        ),
        installed_at,
    )

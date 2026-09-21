"""Building the telemetry service at boot.

One function, so `main.py` does not have to know the difference between an
enabled deployment and a disabled one — it asks for a service and gets one
either way. Off is a service holding a sink that discards, not a `None` that
every call site would have to remember to check.
"""

from __future__ import annotations

import logging
from datetime import datetime

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.observability.otlp import OtlpClient
from switch_core.telemetry.deployment import load_deployment_identity
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import NullSink, OtlpRelaySink, TelemetrySink

logger = logging.getLogger(__name__)


async def build_telemetry(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    version: str | None,
) -> tuple[TelemetryService, datetime | None, httpx.AsyncClient | None]:
    """The telemetry service, the deployment's install date, and its HTTP client.

    The install date rides along because it is read from the same row. The
    client comes back so `main` can close it.

    Resolved even when telemetry is off, so a deployment that opts in later
    already has the id it was assigned at install.
    """
    try:
        generated_id, installed_at = await load_deployment_identity(session_factory)
    except Exception:
        # Never fatal: refusing to serve over analytics is the one thing this
        # must not do. Disabled rather than given an invented id, which would
        # make one deployment look like a population of installs.
        logger.error(
            "Could not read the deployment identity, so product telemetry is "
            "disabled for this run. Its row is seeded by the telemetry "
            "bookkeeping migration — check that migrations have been applied.",
            exc_info=True,
        )
        return (
            _service(
                config,
                NullSink(),
                client_id="",
                version=version,
                session_factory=session_factory,
                installed_at=None,
                enabled=False,
            ),
            None,
            None,
        )

    # Both streams send `flint.client_id`, so a deployment reporting both must
    # be one subject downstream. The operator's value wins; the generated one
    # cannot be copied between deployments and carries the install date.
    client_id = config.deployment_id or generated_id

    if not config.telemetry_enabled:
        logger.info(
            "Product telemetry is off; nothing is collected or sent. Set "
            "TELEMETRY_ENABLED=true to report anonymous usage counts."
        )
        return (
            _service(
                config,
                NullSink(),
                client_id=client_id,
                version=version,
                session_factory=session_factory,
                installed_at=installed_at,
            ),
            installed_at,
            None,
        )

    http_client = httpx.AsyncClient()
    sink: TelemetrySink = OtlpRelaySink(
        client=OtlpClient(
            base_endpoint=config.telemetry_endpoint,
            timeout_seconds=config.telemetry_timeout_seconds,
            headers={},
            client=http_client,
        )
    )
    logger.info(
        "Product telemetry is ON: usage counts and timings are reported to "
        "%s. No room, tenant, agent, user or message is identified in them — "
        "see docs/old/telemetry-events.md for exactly what is sent. Set "
        "TELEMETRY_ENABLED=false to switch it off.",
        config.telemetry_endpoint,
    )
    return (
        _service(
            config,
            sink,
            client_id=client_id,
            version=version,
            session_factory=session_factory,
            installed_at=installed_at,
        ),
        installed_at,
        http_client,
    )


def _service(
    config: SwitchConfig,
    sink: TelemetrySink,
    *,
    client_id: str,
    version: str | None,
    session_factory: async_sessionmaker[AsyncSession],
    installed_at: datetime | None,
    enabled: bool | None = None,
) -> TelemetryService:
    """`enabled` overrides the setting for the one case that has to: with no
    identity, every event would carry no deployment and be dropped."""
    return TelemetryService(
        sink=sink,
        enabled=config.telemetry_enabled if enabled is None else enabled,
        client_id=client_id,
        service_name=config.service_name,
        version=version,
        environment=config.environment,
        session_factory=session_factory,
        installed_at=installed_at,
    )

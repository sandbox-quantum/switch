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

    The install date comes back alongside because the milestone call sites need
    it and it is read from the same row as the fallback client id — asking
    twice would be two queries for one fact. The client comes back so `main`
    can close it: this package opens it and something has to own the shutdown.

    The identity is resolved even when telemetry is off. It is one query at
    boot, and reading it unconditionally means a deployment that switches
    reporting on later already has the id it was assigned when it was
    installed, rather than minting one on the day it opted in and looking
    brand new.
    """
    try:
        generated_id, installed_at = await load_deployment_identity(session_factory)
    except Exception:
        # Never fatal. The row is seeded by a migration that boot runs before
        # this, so its absence means a schema older than the code or a row
        # deleted by hand — and in either case refusing to serve would take
        # the whole deployment down over analytics, which is the one thing
        # this subsystem must never be able to do. Reported at error, because
        # it is a real misconfiguration, and reporting is switched off rather
        # than run against an identity invented on the spot: a fresh id per
        # boot would make one deployment look like a population of installs,
        # which is worse than no data.
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

    # `DEPLOYMENT_ID` wins where an operator set one. Both this and the
    # operational export send `flint.client_id`, and a deployment reporting
    # both must appear downstream as one subject rather than two — so the
    # operator's choice, which the operational export requires, is also the
    # one used here. Where it is unset, the generated id stands: it cannot be
    # copied between deployments by copying a values file, and it is the only
    # one that comes with an install date.
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
    """`enabled` overrides the setting, for the one case that has to: an
    identity we could not read means reporting is off for this run whatever
    the operator asked for, because every event would carry no deployment and
    the relay drops those in silence."""
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

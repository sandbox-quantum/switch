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
from switch_core.telemetry.deployment import (
    load_deployment_identity,
    record_telemetry_switch,
    settle_from_evidence,
)
from switch_core.telemetry.reporter import read_watermark
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import NullSink, OtlpRelaySink, TelemetrySink
from switch_core.telemetry.snapshot import milestones_passed

logger = logging.getLogger(__name__)

# How the relay sink batches. Five seconds keeps an event's delay well inside
# what analytics cares about; two hundred records is a request of a few tens of
# kilobytes. The buffer holds roughly a minute of a very busy server, so a
# relay that is down for longer loses events rather than growing memory.
_FLUSH_INTERVAL_SECONDS = 5.0
_MAX_BATCH = 200
_MAX_BUFFERED = 10_000


async def _milestones_passed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    enabled: bool,
    enabled_since: datetime | None,
) -> set[str]:
    """`milestones_passed`, leaving to the snapshot pass any room it will
    report: with telemetry on, one that went live after both the last pass
    and the moment reporting began. Before the first pass, which reports no
    room, and with telemetry off, every room is evidence."""
    watermark = await read_watermark(session_factory) if enabled else None
    activated_before = (
        None
        if watermark is None
        else max(watermark, enabled_since)
        if enabled_since is not None
        else watermark
    )
    return await milestones_passed(session_factory, activated_before=activated_before)


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
                enabled_since=None,
                enabled=False,
            ),
            None,
            None,
        )

    # Both streams send `switch_trust.client_id`, so a deployment reporting both must
    # be one subject downstream. The operator's value wins; the generated one
    # cannot be copied between deployments and carries the install date.
    client_id = config.deployment_id or generated_id

    try:
        enabled_since, switched_on = await record_telemetry_switch(
            session_factory, enabled=config.telemetry_enabled
        )
    except Exception:
        # Not fatal, and not a reason to stop reporting: without it, events
        # about the past are dated no earlier than the install alone.
        logger.error(
            "Could not record when product telemetry was switched on; events "
            "about the past this run are clamped to the install date only.",
            exc_info=True,
        )
        enabled_since, switched_on = None, False
    # Before any service that reports a milestone is built.
    await settle_from_evidence(
        session_factory,
        lambda: _milestones_passed(
            session_factory,
            enabled=config.telemetry_enabled,
            enabled_since=enabled_since,
        ),
        switched_on=switched_on,
    )

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
                enabled_since=None,
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
        ),
        flush_interval_seconds=_FLUSH_INTERVAL_SECONDS,
        max_batch=_MAX_BATCH,
        max_buffered=_MAX_BUFFERED,
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
            enabled_since=enabled_since,
        ),
        installed_at,
        http_client,
    )


def telemetry_environment(config: SwitchConfig, version: str | None) -> str:
    """The Amplitude project this deployment reports to (`switch_trust.env`).

    `TELEMETRY_ENVIRONMENT` when it is set. Otherwise `dev` for a build that
    is not a release (a `.dev` version, as every image built from main is), so
    a development server nobody configured does not report as production, and
    `prod` for a release, which is what every customer runs. A source checkout
    reports the release version in `core/pyproject.toml`, so it is read as a
    release; `just init-env` sets `TELEMETRY_ENVIRONMENT=local` for one.
    """
    if "telemetry_environment" in config.model_fields_set:
        return config.telemetry_environment
    if version is not None and ".dev" in version:
        return "dev"
    return config.telemetry_environment


def _service(
    config: SwitchConfig,
    sink: TelemetrySink,
    *,
    client_id: str,
    version: str | None,
    session_factory: async_sessionmaker[AsyncSession],
    installed_at: datetime | None,
    enabled_since: datetime | None,
    enabled: bool | None = None,
) -> TelemetryService:
    """`enabled` overrides the setting for the one case that has to: with no
    identity, every event would carry no deployment and be dropped."""
    return TelemetryService(
        sink=sink,
        enabled=config.telemetry_enabled if enabled is None else enabled,
        client_id=client_id,
        version=version,
        telemetry_environment=telemetry_environment(config, version),
        telemetry_internal=config.telemetry_internal,
        deployment_kind=config.deployment_kind,
        session_factory=session_factory,
        installed_at=installed_at,
        enabled_since=enabled_since,
    )

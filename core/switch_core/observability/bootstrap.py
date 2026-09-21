"""Assembles observability from config and the running process's own objects.

Apart from ``main`` so what is measured can be read and tested without starting
a server. The health monitor always runs whatever the config says: readiness is
how Kubernetes routes traffic, and cannot depend on whether anyone is
collecting metrics. Only the export is gated.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass

import httpx
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.logging_context import LogContextFilter
from switch_core.observability.catalogue import (
    AGENTS_CONNECTED,
    BRIDGES_RUNNING,
    CLIENTS_RUNNING,
    CONNECTORS_RUNNING,
    DB_POOL_IN_USE,
    DB_POOL_OVERFLOW,
    DB_POOL_SIZE,
)
from switch_core.observability.exporter import MetricsExporter
from switch_core.observability.health import (
    HealthMonitor,
    bridges_check,
    connectors_check,
    database_check,
    message_listener_check,
)
from switch_core.observability.logs import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_QUEUE_CAPACITY,
    LogExporter,
    OtlpLogHandler,
)
from switch_core.observability.metrics import (
    GaugeReading,
    MetricsRegistry,
    install,
    uninstall,
)
from switch_core.observability.otlp import OtlpClient, OtlpResource
from switch_core.observability.pool import PoolStats
from switch_core.observability.runtime import (
    EventLoopLag,
    RuntimeMetrics,
    log_unreadable_sources,
)

logger = logging.getLogger(__name__)

# Matched to the kubelet's probe period; longer and a fault is reported one
# probe later than it could have been.
HEALTH_REFRESH_INTERVAL_SECONDS = 10.0

# Far shorter than the metric interval: a metric interval is a bucket, a log is
# read by someone looking at an incident now.
LOG_EXPORT_INTERVAL_SECONDS = 5.0


@dataclass(frozen=True)
class RuntimeProbes:
    """Live state, as callables over whatever holds it.

    Callables rather than the services, so this module does not depend on half
    the application and a test can supply the numbers without a bridge.
    """

    listener_connected: Callable[[], bool]
    bridges_running: Callable[[], int]
    bridges_configured: Callable[[], int]
    clients_running: Callable[[], int]
    connectors_running: Callable[[], int]
    connectors_configured: Callable[[], int]
    agents_connected: Callable[[], int]
    # None when the engine's pool does not keep these — see
    # :mod:`switch_core.observability.pool`.
    pool_stats: Callable[[], PoolStats | None]


@dataclass
class Observability:
    """What the server needs to hold on to: the monitor, and how to stop."""

    monitor: HealthMonitor
    lag: EventLoopLag
    _tasks: list[asyncio.Task[None]]
    _http_client: httpx.AsyncClient | None
    _log_handler: OtlpLogHandler | None

    async def aclose(self) -> None:
        # Detached first, so shutdown logging is not queued for an exporter
        # about to stop draining it.
        if self._log_handler is not None:
            logging.getLogger().removeHandler(self._log_handler)
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("An observability task failed on shutdown.")
        if self._http_client is not None:
            await self._http_client.aclose()
        uninstall()


def _state_readings(probes: RuntimeProbes) -> Callable[[], Iterator[GaugeReading]]:
    def readings() -> Iterator[GaugeReading]:
        yield GaugeReading(AGENTS_CONNECTED, float(probes.agents_connected()), {})
        yield GaugeReading(CLIENTS_RUNNING, float(probes.clients_running()), {})
        yield GaugeReading(BRIDGES_RUNNING, float(probes.bridges_running()), {})
        yield GaugeReading(CONNECTORS_RUNNING, float(probes.connectors_running()), {})

        stats = probes.pool_stats()
        if stats is not None:
            yield GaugeReading(DB_POOL_IN_USE, float(stats.in_use), {})
            yield GaugeReading(DB_POOL_SIZE, float(stats.size), {})
            yield GaugeReading(DB_POOL_OVERFLOW, float(stats.overflow), {})

    return readings


def start_observability(
    config: SwitchConfig,
    version: str | None,
    session_factory: async_sessionmaker,
    probes: RuntimeProbes,
) -> Observability:
    """Install the registry, start the loops, and hand back the handle.

    Called once, from the server's lifespan.
    """
    monitor = HealthMonitor(
        checks=[
            database_check(session_factory),
            message_listener_check(probes.listener_connected),
            bridges_check(probes.bridges_running, probes.bridges_configured),
            connectors_check(probes.connectors_running, probes.connectors_configured),
        ],
        interval_seconds=HEALTH_REFRESH_INTERVAL_SECONDS,
    )
    lag = EventLoopLag()
    tasks: list[asyncio.Task[None]] = [
        asyncio.create_task(monitor.run_forever(), name="health-monitor")
    ]

    if not config.observability_enabled:
        logger.info(
            "No OTLP_ENDPOINT is configured, so nothing is reported off this "
            "server. Health checks still run and /health/ready still answers."
        )
        return Observability(
            monitor=monitor,
            lag=lag,
            _tasks=tasks,
            _http_client=None,
            _log_handler=None,
        )

    registry = MetricsRegistry()
    install(registry)

    monitor.install(registry)
    RuntimeMetrics(lag).install(registry)
    registry.register_observer(_state_readings(probes))
    log_unreadable_sources()

    http_client = httpx.AsyncClient()
    client = OtlpClient(
        base_endpoint=str(config.otlp_endpoint),
        timeout_seconds=config.otlp_timeout_seconds,
        headers=config.otlp_header_map,
        client=http_client,
    )
    resource = OtlpResource(
        service_name=config.service_name,
        service_version=version,
        environment=config.environment,
        deployment_id=str(config.deployment_id),
    )

    if config.otlp_metrics_enabled:
        exporter = MetricsExporter(
            registry=registry,
            client=client,
            resource=resource,
            interval_seconds=config.otlp_export_interval_seconds,
        )
        tasks.append(
            asyncio.create_task(exporter.run_forever(), name="metrics-exporter")
        )
        logger.info(
            "Reporting metrics to %s every %.0fs as service %r.",
            client.url_for("metrics"),
            config.otlp_export_interval_seconds,
            config.service_name,
        )
    else:
        logger.warning(
            "OTLP_ENDPOINT is set but OTLP_METRICS_ENABLED is false, so no "
            "metrics are being reported."
        )

    log_handler: OtlpLogHandler | None = None
    if config.otlp_logs_enabled:
        log_handler = OtlpLogHandler(capacity=DEFAULT_QUEUE_CAPACITY)
        # The same filter the stderr handler carries; without it a shipped
        # record has no tenant, request or agent on it.
        log_handler.addFilter(LogContextFilter(config.tenant_id))
        logging.getLogger().addHandler(log_handler)
        tasks.append(
            asyncio.create_task(
                LogExporter(
                    handler=log_handler,
                    client=client,
                    resource=resource,
                    interval_seconds=LOG_EXPORT_INTERVAL_SECONDS,
                    batch_size=DEFAULT_BATCH_SIZE,
                ).run_forever(),
                name="log-exporter",
            )
        )
        logger.info(
            "Also shipping logs to %s. They continue to be written to this "
            "container's output, which remains the primary copy.",
            client.url_for("logs"),
        )

    return Observability(
        monitor=monitor,
        lag=lag,
        _tasks=tasks,
        _http_client=http_client,
        _log_handler=log_handler,
    )

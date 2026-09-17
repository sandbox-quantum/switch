"""The loop that drains the registry and posts an interval to the collector."""

from __future__ import annotations

import asyncio
import logging

from switch_core.observability.metrics import MetricsRegistry
from switch_core.observability.otlp import (
    OtlpClient,
    OtlpResource,
    OtlpSendError,
    build_metrics_payload,
    now_nanos,
)

logger = logging.getLogger(__name__)

# Consecutive failed exports before the complaint is escalated. One failure is
# a flaky network and says nothing; a run of them means the dashboards have
# been blank for long enough that somebody is about to be misled by them.
_FAILURES_BEFORE_ERROR = 3


class MetricsExporter:
    """Collects and posts on a fixed interval until cancelled."""

    def __init__(
        self,
        registry: MetricsRegistry,
        client: OtlpClient,
        resource: OtlpResource,
        interval_seconds: float,
    ) -> None:
        self._registry = registry
        self._client = client
        self._resource = resource
        self._interval_seconds = interval_seconds
        self._interval_start_nanos = now_nanos()
        self._consecutive_failures = 0

    async def flush_once(self) -> None:
        """Post everything recorded since the previous flush.

        The interval window is closed before the request is made, not after it
        succeeds: a failed post loses that interval rather than folding it into
        the next one, which would otherwise report a minute's traffic as though
        it had happened in a second.
        """
        end_nanos = now_nanos()
        start_nanos = self._interval_start_nanos
        self._interval_start_nanos = end_nanos

        payloads = self._registry.collect()
        if not payloads:
            return

        body = build_metrics_payload(payloads, self._resource, start_nanos, end_nanos)
        try:
            await self._client.post("metrics", body)
        except OtlpSendError as error:
            self._consecutive_failures += 1
            if self._consecutive_failures >= _FAILURES_BEFORE_ERROR:
                logger.error(
                    "Metrics export has failed %d times in a row; this "
                    "deployment's dashboards are stale. Last error: %s",
                    self._consecutive_failures,
                    error,
                )
            else:
                logger.warning(
                    "Metrics export failed, dropping the interval: %s", error
                )
            return

        if self._consecutive_failures:
            logger.info(
                "Metrics export recovered after %d failed interval(s).",
                self._consecutive_failures,
            )
        self._consecutive_failures = 0

    async def run_forever(self) -> None:
        """Flush on the interval. Survives everything but cancellation.

        A metrics exporter that can take the server down with it is worse than
        no metrics exporter, so the only exception it re-raises is the one that
        means "stop".
        """
        while True:
            try:
                await asyncio.sleep(self._interval_seconds)
                await self.flush_once()
            except asyncio.CancelledError:
                # One last window, so a clean shutdown reports what it did
                # rather than discarding its final minute.
                await self._flush_on_shutdown()
                raise
            except Exception:
                logger.exception("Metrics export loop raised; continuing.")

    async def _flush_on_shutdown(self) -> None:
        try:
            await self.flush_once()
        except Exception:
            # Already shutting down; a failure here has nowhere useful to go
            # and must not displace whatever is actually stopping the process.
            logger.warning("Final metrics flush failed.", exc_info=True)

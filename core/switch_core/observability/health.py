"""Readiness: what has to be true for this server to be worth sending traffic to.

``/health`` stays a cheap always-ok reply. Besides the kubelet's liveness
probe, the gateway Deployment and the setup Job wait on it at boot, so anything
it checked would become a boot-ordering dependency for them.

``/health/ready`` is the real one, and **what gates it is deliberately narrow.**
switch-core runs as a single replica with `Recreate`, so a failing readiness
probe does not shift traffic to a healthy pod — it empties the Service. Only
the database gates, because without it every request is an error anyway. A
crashed bridge is reported and alerted on but never fatal.

The checks run on their own schedule; the kubelet and the metrics exporter read
one cached answer. The cache carries its age, and one nobody is refreshing
reports itself as a failure — which is also how a wedged event loop surfaces.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Iterator, Sequence
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.observability.catalogue import HEALTH_CHECK
from switch_core.observability.metrics import GaugeReading, MetricsRegistry

logger = logging.getLogger(__name__)

# Generous next to a healthy `SELECT 1`, and under the kubelet's own timeout so
# a slow answer is reported here rather than cut off with no detail.
DATABASE_TIMEOUT_SECONDS = 5.0

# Multiples of the refresh interval: enough that a slow refresh does not make
# the answer flap, few enough to catch a refresher that has stopped.
_STALENESS_MULTIPLIER = 4


@dataclass(frozen=True)
class CheckOutcome:
    name: str
    healthy: bool
    # What is wrong, for an operator reading a 503. Empty when it passed.
    detail: str


@dataclass(frozen=True)
class HealthCheck:
    name: str
    # Whether a failure takes the server out of service. On a single-replica
    # deployment that is a bigger decision than it looks — see the docstring.
    gates_readiness: bool
    probe: Callable[[], Awaitable[CheckOutcome]]


@dataclass(frozen=True)
class ReadinessReport:
    ready: bool
    checks: Sequence[CheckOutcome]
    taken_at: float

    def as_response(self) -> dict[str, object]:
        return {
            "status": "ready" if self.ready else "not ready",
            "checks": {
                check.name: {
                    "healthy": check.healthy,
                    **({"detail": check.detail} if check.detail else {}),
                }
                for check in self.checks
            },
        }


def database_check(session_factory: async_sessionmaker) -> HealthCheck:
    """One round trip, on an unbound session.

    `SELECT 1` rather than a real table: every scoped table is behind row-level
    security, and an unbound read raises under the restricted runtime role
    while passing in development.
    """

    async def probe() -> CheckOutcome:
        try:
            async with asyncio.timeout(DATABASE_TIMEOUT_SECONDS):
                async with session_factory() as session:
                    await session.execute(text("SELECT 1"))
        except TimeoutError:
            return CheckOutcome(
                name="database",
                healthy=False,
                detail=(
                    f"No answer within {DATABASE_TIMEOUT_SECONDS:.0f}s. The "
                    "database is unreachable, or the pool is exhausted and "
                    "every connection is held."
                ),
            )
        except Exception as error:
            return CheckOutcome(
                name="database",
                healthy=False,
                detail=f"{type(error).__name__}: {error}",
            )
        return CheckOutcome(name="database", healthy=True, detail="")

    return HealthCheck(name="database", gates_readiness=True, probe=probe)


def message_listener_check(is_connected: Callable[[], bool]) -> HealthCheck:
    """Whether room delivery is actually happening.

    Every room's fan-out is woken through this `LISTEN`. When it is down the
    API still answers and rooms still accept writes while no message moves. It
    reconnects itself, so restarting the pod would not fix it faster and would
    drop every live session to find out.
    """

    async def probe() -> CheckOutcome:
        if is_connected():
            return CheckOutcome(name="message_listener", healthy=True, detail="")
        return CheckOutcome(
            name="message_listener",
            healthy=False,
            detail=(
                "The Postgres LISTEN connection is down, so no room message is "
                "being delivered. It retries with backoff; if this persists, "
                "the database is refusing connections."
            ),
        )

    return HealthCheck(name="message_listener", gates_readiness=False, probe=probe)


def bridges_check(
    running: Callable[[], int], configured: Callable[[], int]
) -> HealthCheck:
    """Whether every configured collaboration bridge still has a live task.

    A bridge that raises is dropped from the running set with its exception
    logged and discarded. Reported, never gating.
    """

    async def probe() -> CheckOutcome:
        live = running()
        expected = configured()
        if live >= expected:
            return CheckOutcome(name="bridges", healthy=True, detail="")
        return CheckOutcome(
            name="bridges",
            healthy=False,
            detail=(
                f"{expected - live} of {expected} configured collaboration "
                "bridge(s) have crashed and are no longer running. The "
                "platforms they serve are cut off; the rest of Switch is not."
            ),
        )

    return HealthCheck(name="bridges", gates_readiness=False, probe=probe)


def connectors_check(
    running: Callable[[], int], configured: Callable[[], int]
) -> HealthCheck:
    """Whether every server-side connector this process meant to run is running.

    Started fire-and-forget, with each failure logged and stepped over, so one
    that never came up is a dead agent host with no other trace. Reported,
    never gating.
    """

    async def probe() -> CheckOutcome:
        live = running()
        expected = configured()
        if live >= expected:
            return CheckOutcome(name="connectors", healthy=True, detail="")
        return CheckOutcome(
            name="connectors",
            healthy=False,
            detail=(
                f"{expected - live} of {expected} server-side connector(s) are "
                "not running. The agents they host are unreachable; the boot "
                "log names which failed and why."
            ),
        )

    return HealthCheck(name="connectors", gates_readiness=False, probe=probe)


class HealthMonitor:
    """Runs the checks on an interval and holds the latest answer."""

    def __init__(self, checks: Sequence[HealthCheck], interval_seconds: float) -> None:
        self._checks = checks
        self._interval_seconds = interval_seconds
        self._latest: ReadinessReport | None = None

    async def refresh(self) -> ReadinessReport:
        outcomes = []
        for check in self._checks:
            try:
                outcomes.append(await check.probe())
            except Exception as error:
                # A check that raises is a failed check: reporting healthy
                # because we could not find out inverts the whole point.
                logger.exception("Health check %s raised", check.name)
                outcomes.append(
                    CheckOutcome(
                        name=check.name,
                        healthy=False,
                        detail=f"The check itself failed: {type(error).__name__}: {error}",
                    )
                )

        gating = {check.name for check in self._checks if check.gates_readiness}
        ready = all(outcome.healthy for outcome in outcomes if outcome.name in gating)
        report = ReadinessReport(
            ready=ready, checks=outcomes, taken_at=time.monotonic()
        )
        self._latest = report
        return report

    def current(self) -> ReadinessReport:
        """The last answer, or a failing one when there is not a fresh answer.

        Never optimistic: "nobody has checked" and "the checker has stopped"
        both mean the server cannot vouch for itself.
        """
        latest = self._latest
        if latest is None:
            return ReadinessReport(
                ready=False,
                checks=[
                    CheckOutcome(
                        name="startup",
                        healthy=False,
                        detail="No health check has completed yet.",
                    )
                ],
                taken_at=time.monotonic(),
            )

        age = time.monotonic() - latest.taken_at
        if age > self._interval_seconds * _STALENESS_MULTIPLIER:
            return ReadinessReport(
                ready=False,
                checks=[
                    CheckOutcome(
                        name="health_monitor",
                        healthy=False,
                        detail=(
                            f"The last health check was {age:.0f}s ago and the "
                            "refresher runs every "
                            f"{self._interval_seconds:.0f}s. It has stopped, or "
                            "the event loop is blocked."
                        ),
                    ),
                    *latest.checks,
                ],
                taken_at=latest.taken_at,
            )
        return latest

    async def run_forever(self) -> None:
        while True:
            try:
                await self.refresh()
            except asyncio.CancelledError:
                raise
            except Exception:
                # `refresh` handles a failing check; reaching here means the
                # monitor itself is broken, and it must not stop looping.
                logger.exception("Health monitor refresh raised; continuing.")
            await asyncio.sleep(self._interval_seconds)

    def install(self, registry: MetricsRegistry) -> None:
        registry.register_observer(self._readings)

    def _readings(self) -> Iterator[GaugeReading]:
        for outcome in self.current().checks:
            yield GaugeReading(
                HEALTH_CHECK, 1.0 if outcome.healthy else 0.0, {"check": outcome.name}
            )

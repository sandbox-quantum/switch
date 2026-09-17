"""Readiness: what has to be true for this server to be worth sending traffic to.

Two routes, because they answer different questions and Kubernetes does
different things with the answers.

``/health`` is liveness, and it stays exactly what it was — a cheap, always-ok
reply. It is not only the kubelet's liveness probe: the gateway Deployment and
the setup Job both wait on it before they start, so tightening it would change
boot ordering and could deadlock a deploy on a dependency that is not up yet.

``/health/ready`` is readiness, and it is new.

**What gates readiness is deliberately narrow.** switch-core runs as a single
replica with a `Recreate` strategy, because it holds live sessions in memory and
cannot be scaled out. So a failing readiness probe does not shift traffic to a
healthy pod — there is no other pod. It empties the Service and takes the whole
deployment off the air. That makes readiness worth failing only where *not*
serving is genuinely better than serving: the database, without which every
request is an error anyway.

A crashed collaboration bridge is a real fault, and it is reported here and
alerted on — but it must not fail readiness. Taking Switch offline entirely
because Slack's adapter died would turn one broken bridge into every broken
bridge.

The checks run on their own schedule rather than per request. The kubelet asks
every ten seconds and the metrics exporter asks once a minute; both read the
same cached answer, so neither adds a database round trip to the other's
budget. The cache carries the time it was taken, and a cache that has stopped
being refreshed is itself reported as a failure — which is also how a wedged
event loop shows up here.
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

# How long a database round trip may take before the database counts as
# unreachable. Generous next to a healthy `SELECT 1`, and well under the
# kubelet's own probe timeout, so a slow answer is reported by us rather than
# cut off by the probe with no detail at all.
DATABASE_TIMEOUT_SECONDS = 5.0

# A cached result older than this is treated as no result. Set against the
# refresh interval rather than the probe interval: it has to allow a refresh to
# be slow without the answer flapping, while still catching a refresher that
# has stopped entirely.
_STALENESS_MULTIPLIER = 4


@dataclass(frozen=True)
class CheckOutcome:
    name: str
    healthy: bool
    # What is wrong, in a sentence an operator reading a 503 can act on. Empty
    # when the check passed — there is nothing to say about a working thing.
    detail: str


@dataclass(frozen=True)
class HealthCheck:
    name: str
    # Whether a failure should take the server out of service. See the module
    # docstring: on a single-replica deployment this is a much bigger decision
    # than it looks.
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

    `SELECT 1` deliberately, rather than counting a real table. Every scoped
    table is behind row-level security, and a read with no tenant bound raises
    under the restricted runtime role while passing in development — so a
    health check written against real data would be the one thing that works
    everywhere except production.
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

    The listener holds a Postgres `LISTEN`, and every room's fan-out is woken
    through it. When it is down nothing is delivered to anyone — the API still
    answers, rooms still accept writes, and no message moves. It reconnects
    itself with backoff, which is why this does not gate readiness: restarting
    the pod would not fix it any faster, and would drop every live session to
    find that out.
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

    A bridge that raises is dropped from the running set and its exception is
    logged and discarded, so without this the only evidence is a line in a log
    nobody is reading. Reported, never gating — see the module docstring.
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
                # A check that raises is a failed check. Swallowing it would
                # report the dependency as healthy on the grounds that we could
                # not find out, which is the exact inversion of the point.
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

        Never optimistic. "Nobody has checked" and "the checker has stopped"
        both mean the server cannot vouch for itself, and a probe that answers
        ok on that basis is worse than no probe.
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
                # `refresh` already handles a failing check; reaching here means
                # the monitor itself is broken, and it must not stop looping.
                logger.exception("Health monitor refresh raised; continuing.")
            await asyncio.sleep(self._interval_seconds)

    def install(self, registry: MetricsRegistry) -> None:
        registry.register_observer(self._readings)

    def _readings(self) -> Iterator[GaugeReading]:
        for outcome in self.current().checks:
            yield GaugeReading(
                HEALTH_CHECK, 1.0 if outcome.healthy else 0.0, {"check": outcome.name}
            )

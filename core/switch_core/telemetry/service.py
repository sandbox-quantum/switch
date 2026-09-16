"""The one call every site uses to report an event.

`emit` is deliberately fire-and-forget and deliberately synchronous to call: a
room being created must not wait on an analytics relay, and a call site must
not have to decide whether reporting is worth an `await`. It validates against
the catalogue immediately — that part is cheap and its failures are bugs — and
hands the send to a background task.

The asymmetry in how failures are treated is the point:

- **A bad event raises.** An undeclared event, an undeclared property, a value
  outside its set: each is a programming error, each is caught by the tests
  that build the event, and each would otherwise put something unintended on
  the wire. Silence here would defeat the catalogue.
- **A failed send does not.** The relay being slow, unreachable or unhappy is
  an operational condition that has nothing to do with the caller, and Switch
  continuing to work while analytics is down is the only acceptable behaviour.
  It is logged and dropped.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.telemetry.catalogue import PropertyValue, validate, wire_name
from switch_core.telemetry.deployment import claim_milestone, seconds_since_install
from switch_core.telemetry.sink import TelemetryRecord, TelemetrySink

logger = logging.getLogger(__name__)


class TelemetryService:
    """Validates, tags and dispatches events.

    Holds a sink unconditionally — :class:`~switch_core.telemetry.sink.NullSink`
    when telemetry is off — so that no call site ever tests whether reporting
    is enabled. One place decides; everywhere else just reports.
    """

    def __init__(
        self,
        *,
        sink: TelemetrySink,
        enabled: bool,
        client_id: str,
        service_name: str,
        version: str | None,
        environment: str | None,
        session_factory: async_sessionmaker[AsyncSession] | None = None,
        installed_at: datetime | None = None,
    ) -> None:
        self._sink = sink
        self._enabled = enabled
        # Only the milestone path needs these. Optional so the ordinary
        # `emit` is usable from a test that has no database at all.
        self._session_factory = session_factory
        self._installed_at = installed_at
        self._resource = {
            "service.name": service_name,
            "flint.client_id": client_id,
        }
        # Omitted rather than sent empty: an absent attribute reads as "not
        # configured", where `""` reads as a real environment named nothing.
        if version:
            self._resource["service.version"] = version
        if environment:
            self._resource["deployment.environment"] = environment
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def installed_at(self) -> datetime | None:
        """When this deployment was installed, or None if that is unknown."""
        return self._installed_at

    def emit(self, event: str, **properties: PropertyValue) -> None:
        """Report one event. Never blocks; raises only on a malformed event."""
        # Validated even when disabled, so a mistake in a rarely-taken branch
        # is caught by whichever test exercises it rather than lying dormant
        # until the day a deployment switches telemetry on.
        validate(event, properties)
        if not self._enabled:
            return
        self._dispatch(
            TelemetryRecord(
                name=wire_name(event),
                properties=dict(properties),
                resource=dict(self._resource),
                timestamp_ns=time.time_ns(),
            )
        )

    async def emit_milestone(self, event: str, **properties: PropertyValue) -> None:
        """Report a once-ever activation milestone, if it has not been reported.

        Adds `seconds_since_install` and takes the claim that makes it
        once-ever, so a call site only has to say which milestone it is and
        what else it carries.

        Silently does nothing in three cases, each of them correct:

        - **telemetry is off**, so there is nothing to report and no claim
          should be taken — switching it on later must not find every
          milestone already used up;
        - **the deployment predates this telemetry** and has no install date,
          so elapsed time is unknowable and a guess would be worse than
          silence (see `telemetry/deployment.py`);
        - **the milestone is already claimed**, which is the whole point.
        """
        if not self._enabled or self._session_factory is None:
            return
        elapsed = seconds_since_install(self._installed_at)
        if elapsed is None:
            return
        if not await claim_milestone(self._session_factory, event):
            return
        self.emit(event, seconds_since_install=elapsed, **properties)

    def _dispatch(self, record: TelemetryRecord) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Reported from somewhere with no event loop — a management
            # command, or a test calling a synchronous helper directly. Worth
            # a line rather than a crash: the caller was doing something
            # legitimate and telemetry is not its job.
            logger.debug(
                "Telemetry event %s not sent: no running event loop.", record.name
            )
            return

        task = loop.create_task(self._send(record))
        # Held for the lifetime of the send. An un-referenced task can be
        # garbage-collected mid-flight, which drops the event silently and is
        # exactly the kind of bug telemetry code is bad at revealing.
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send(self, record: TelemetryRecord) -> None:
        try:
            await self._sink.send(record)
        except asyncio.CancelledError:
            raise
        except Exception:
            # The sink is expected to swallow its own transport failures, so
            # reaching here means a bug in the sink rather than a bad relay.
            # Still not allowed to propagate: this runs in a bare task, where
            # an exception becomes an unretrievable "task exception was never
            # retrieved" at some later garbage collection.
            logger.exception("Telemetry sink failed on event %s", record.name)

    async def aclose(self) -> None:
        """Let in-flight sends finish, then close the sink.

        Shutdown is the one time waiting is right: the events worth losing
        least are the ones emitted just before the process goes away, and the
        sink's own timeout already bounds how long this can take.
        """
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        await self._sink.aclose()


def emit_safely(
    telemetry: TelemetryService | None,
    event: str,
    properties: Mapping[str, PropertyValue],
) -> None:
    """Report an event from a path that must not fail because of telemetry.

    For call sites in the middle of real work — creating a room, opening a
    session — where a catalogue bug must not take the operation down with it.
    The mistake is still loud, because it is logged with a stack trace at
    error level, but it costs the user nothing.

    Paths that can afford to fail (the snapshot task, tests) should call
    :meth:`TelemetryService.emit` directly and let the error out.

    `telemetry` is optional because several services are constructed in tests
    and in tooling without one.
    """
    if telemetry is None:
        return
    try:
        telemetry.emit(event, **dict(properties))
    except Exception:
        logger.exception(
            "Telemetry event %s could not be reported; continuing. This is a "
            "bug in the event, not a relay problem.",
            event,
        )

"""The one call every site uses to report an event.

`emit` is fire-and-forget and synchronous to call: creating a room must not
wait on a relay. It validates against the catalogue first, then hands the
record to the sink, which only buffers it.

The asymmetry is deliberate. **A bad event raises** — it is a programming error
and silence would defeat the catalogue. **A failed send does not** — it is
logged and dropped.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import Session, SessionTransaction

from switch_core.config import DeploymentKind
from switch_core.telemetry.catalogue import (
    DEPLOYMENT_KIND_PROPERTY,
    PropertyValue,
    validate,
    wire_name,
)
from switch_core.telemetry.deployment import (
    claim_milestone,
    seconds_since_install,
    settle_superseded_milestones,
)
from switch_core.telemetry.sink import TelemetryRecord, TelemetrySink

logger = logging.getLogger(__name__)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


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
        version: str | None,
        telemetry_environment: str,
        telemetry_internal: bool,
        deployment_kind: DeploymentKind,
        session_factory: async_sessionmaker[AsyncSession] | None = None,
        installed_at: datetime | None = None,
    ) -> None:
        self._sink = sink
        self._enabled = enabled
        self._deployment_kind = deployment_kind
        # Only the milestone path needs these. Optional so the ordinary
        # `emit` is usable from a test that has no database at all.
        self._session_factory = session_factory
        self._installed_at = installed_at
        self._resource = {
            "flint.client_id": client_id,
            # The relay picks the Amplitude project from this. Sent even as
            # `prod`, so an event says where it belongs rather than relying on
            # what the relay does with silence.
            "flint_env": telemetry_environment,
            # A string, as Switch Console sends it, where `unknown` is a third
            # answer; a deployment always knows which it is.
            "flint_internal": "true" if telemetry_internal else "false",
        }
        # Omitted rather than sent empty: an absent attribute reads as "not
        # known", where `""` reads as a real version named nothing.
        if version:
            self._resource["service.version"] = version

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def installed_at(self) -> datetime | None:
        """When this deployment was installed, or None if that is unknown."""
        return self._installed_at

    def emit(self, event: str, **properties: PropertyValue) -> None:
        """Report one event. Never blocks; raises only on a malformed event."""
        self._emit(event, time.time_ns(), properties)

    def emit_at(self, event: str, at: datetime, **properties: PropertyValue) -> None:
        """`emit`, dated `at` rather than now: for an event about a time that
        has passed, which a chart must place where it happened."""
        microseconds = (at - _EPOCH) // timedelta(microseconds=1)
        self._emit(event, microseconds * 1_000, properties)

    def _emit(
        self, event: str, timestamp_ns: int, properties: dict[str, PropertyValue]
    ) -> None:
        # Validated even when disabled, so a mistake in a rarely-taken branch
        # is caught by whichever test exercises it rather than lying dormant
        # until the day a deployment switches telemetry on.
        validate(event, properties)
        if not self._enabled:
            return
        self._dispatch(
            TelemetryRecord(
                name=wire_name(event),
                properties={
                    **properties,
                    DEPLOYMENT_KIND_PROPERTY: self._deployment_kind,
                },
                resource=dict(self._resource),
                timestamp_ns=timestamp_ns,
            )
        )

    async def settle_superseded_milestones(self) -> None:
        """Claim without reporting the milestones this deployment passed
        before they existed (`deployment.SUPERSEDED_MILESTONES`). Once, at boot,
        before anything can report one. Nothing while telemetry is off, for the
        reason `emit_milestone` gives."""
        if not self._enabled or self._session_factory is None:
            return
        await settle_superseded_milestones(self._session_factory)

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
            asyncio.get_running_loop()
        except RuntimeError:
            # A management command or a sync helper; not its job to have one.
            logger.debug(
                "Telemetry event %s not sent: no running event loop.", record.name
            )
            return
        try:
            self._sink.send(record)
        except Exception:
            # A bug in the sink, not a bad relay. `emit` raises only for a
            # malformed event, so this must not reach the caller either.
            logger.exception("Telemetry sink failed on event %s", record.name)

    async def aclose(self) -> None:
        """Close the sink, which posts what it still holds.

        Shutdown is the one time waiting is right: the events worth losing
        least are the ones emitted just before the process goes away, and the
        caller's timeout bounds how long this can take.
        """
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


def emit_after_commit(
    session: AsyncSession,
    telemetry: TelemetryService | None,
    event: str,
    properties: Mapping[str, PropertyValue],
) -> None:
    """`emit_safely` once `session` commits, and never if it rolls back.

    For a state change made where the transaction is committed by a caller
    further up, or not at all when a later step refuses: reporting it at the
    point it is decided would count a change that never happened.
    """
    if telemetry is None:
        return
    sync = session.sync_session
    committed = False
    decided = False

    def on_commit(_session: Session) -> None:
        nonlocal committed
        committed = True

    def on_end(_session: Session, transaction: SessionTransaction) -> None:
        nonlocal decided
        # A savepoint ending, committed or rolled back, decides nothing: only
        # the outermost transaction does. The listeners stay registered, inert
        # once decided: removing one while the session dispatches its events
        # is refused, and they go with the session.
        if decided or transaction.parent is not None:
            return
        decided = True
        if committed:
            emit_safely(telemetry, event, properties)

    sa_event.listen(sync, "after_commit", on_commit)
    sa_event.listen(sync, "after_transaction_end", on_end)

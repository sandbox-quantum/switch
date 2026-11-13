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
    EmittedValue,
    validate,
    wire_name,
)
from switch_core.telemetry.deployment import (
    seconds_since_install,
    settle_superseded_milestones,
    take_claim,
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
        enabled_since: datetime | None = None,
    ) -> None:
        self._sink = sink
        self._enabled = enabled
        self._deployment_kind = deployment_kind
        # Only the milestone path and the reporter need these. Optional so the
        # ordinary `emit` is usable from a test that has no database at all.
        self._session_factory = session_factory
        self._installed_at = installed_at
        self._enabled_since = enabled_since
        # Milestones this process knows are claimed (`take_milestone`).
        self._claimed: set[str] = set()
        self._resource = {
            "switch_trust.client_id": client_id,
            # The relay picks the Amplitude project from this. Sent even as
            # `prod`, so an event says where it belongs rather than relying on
            # what the relay does with silence.
            "switch_trust.env": telemetry_environment,
            # A string, as Switch Console sends it, where `unknown` is a third
            # answer; a deployment always knows which it is.
            "switch_trust.internal": "true" if telemetry_internal else "false",
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

    @property
    def reporting_since(self) -> datetime | None:
        """The earliest moment an event about the past may be dated: the later
        of the install and the moment telemetry was last switched on, or None
        if neither is known. Nothing before it was watched, and dating an
        event earlier would make Amplitude count the deployment as new before
        it was installed or agreed to report."""
        known = [
            moment if moment.tzinfo else moment.replace(tzinfo=UTC)
            for moment in (self._installed_at, self._enabled_since)
            if moment is not None
        ]
        return max(known) if known else None

    def emit(self, event: str, **properties: EmittedValue) -> None:
        """Report one event. Never blocks; raises only on a malformed event."""
        self._emit(event, time.time_ns(), properties)

    def emit_at(self, event: str, at: datetime, **properties: EmittedValue) -> None:
        """`emit`, dated `at` rather than now: for an event about a time that
        has passed, which a chart must place where it happened."""
        microseconds = (at - _EPOCH) // timedelta(microseconds=1)
        self._emit(event, microseconds * 1_000, properties)

    def _emit(
        self, event: str, timestamp_ns: int, properties: dict[str, EmittedValue]
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
                    **{
                        name: value
                        for name, value in properties.items()
                        if value is not None
                    },
                    DEPLOYMENT_KIND_PROPERTY: self._deployment_kind,
                },
                resource=dict(self._resource),
                timestamp_ns=timestamp_ns,
            )
        )

    async def settle_superseded_milestones(self) -> None:
        """Claim without reporting the milestones this deployment passed
        before they existed (`deployment.SUPERSEDED_MILESTONES`). Once, at boot,
        before anything can report one, whether telemetry is on or not, as
        every milestone is claimed (`emit_milestone`)."""
        if self._session_factory is None:
            return
        await settle_superseded_milestones(self._session_factory)

    async def take_milestone(self, name: str) -> bool:
        """Take a once-ever milestone's claim. True if this call took it.

        Remembered in this process once the database has answered either way,
        so a milestone asked about on every agent connection costs a write
        until it is claimed and nothing after. False, and not remembered, when
        the database could not answer: a lost milestone beats a failed
        request, and the next ask tries again.
        """
        if self._session_factory is None or name in self._claimed:
            return False
        try:
            claimed = await take_claim(self._session_factory, name)
        except Exception:
            logger.exception(
                "Could not record the %s telemetry milestone; not reporting it.",
                name,
            )
            return False
        self._claimed.add(name)
        return claimed

    async def emit_milestone(self, event: str, **properties: EmittedValue) -> None:
        """Report a once-ever activation milestone, if it has not been reported.

        Adds `seconds_since_install` and takes the claim that makes it
        once-ever, so a call site only has to say which milestone it is and
        what else it carries.

        **Claimed whether telemetry is on or not.** Reported only while it is
        on, but claimed either way, so a deployment that switches it on months
        in does not announce, the next time each happens, a "first" it passed
        long ago.

        **Never raises.** It is called on the way to answering a host's
        session report, opening an agent's stream and registering an agent, so
        a mistake in the event is logged rather than failing any of them, and
        a database that cannot take the claim costs the milestone, not the
        request.

        Does nothing for a deployment that predates this telemetry and has no
        install date, so elapsed time is unknowable and a guess would be worse
        than silence (see `telemetry/deployment.py`), and for one already
        claimed, which is the whole point.
        """
        elapsed = seconds_since_install(self._installed_at)
        if elapsed is None:
            return
        if not await self.take_milestone(event):
            return
        emit_safely(self, event, {"seconds_since_install": elapsed, **properties})

    async def report_installed(self) -> None:
        """Report `deployment_installed`, dated to the install, if it has not
        been reported.

        The one milestone not claimed while telemetry is off: it is the start
        of the activation funnel, and the earliest event Amplitude counts a
        deployment as new from, so a deployment that switches telemetry on
        months in still needs one, at the moment it was really installed.
        `seconds_since_install` is how long after the install it was sent.
        """
        if not self._enabled or self._installed_at is None:
            return
        elapsed = seconds_since_install(self._installed_at)
        if not await self.take_milestone("deployment_installed"):
            return
        emit_safely_at(
            self,
            "deployment_installed",
            self._installed_at,
            {"seconds_since_install": elapsed},
        )

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
    properties: Mapping[str, EmittedValue],
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


def emit_safely_at(
    telemetry: TelemetryService | None,
    event: str,
    at: datetime,
    properties: Mapping[str, EmittedValue],
) -> None:
    """`emit_safely`, dated `at`: for an event about a moment that has passed,
    reported from a path that must not fail because of telemetry."""
    if telemetry is None:
        return
    try:
        telemetry.emit_at(event, at, **dict(properties))
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
    properties: Mapping[str, EmittedValue],
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

    def on_commit(session: Session) -> None:
        nonlocal committed
        # A savepoint's commit fires this too, with the savepoint still
        # current; only the outermost commit makes the change durable.
        if not session.in_nested_transaction():
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

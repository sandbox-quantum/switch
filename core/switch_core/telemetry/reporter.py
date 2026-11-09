"""The background task that sends the daily snapshot.

Anchored to a watermark rather than to uptime, so restarts do not change the
cadence.

Every switch-core process runs this loop, so the watermark is claimed before
anything is sent: a conditional write moves it to now only while it is still
due, and only the process whose write took sends. Two processes polling in the
same minute would otherwise both read "due" and both send the day's snapshot.

The first pass sends the snapshot but not the room-activation events: with no
watermark, "first interaction since then" means every room that ever went
active, arriving at once. Nor the finished periods (`periods.py`): with no
watermark there is no telling which were sent before.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TelemetrySnapshotWatermark
from switch_core.telemetry.periods import periods_ending_between
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.session_start import prune_session_start_claims
from switch_core.telemetry.snapshot import (
    UsageCounts,
    as_utc,
    collect_each_period_counts,
    collect_usage,
    newly_active_rooms,
    summarise,
)

logger = logging.getLogger(__name__)

# How long to wait before the first pass. Long enough that a restart loop
# cannot turn boot into a stream of snapshots, short enough that a developer
# switching telemetry on does not have to wait a day to see whether it works.
_FIRST_PASS_DELAY_SECONDS = 60.0

# How often to wake and ask whether a snapshot is due. Well under the interval
# itself, so a deployment that was down over its due time sends promptly on the
# next start rather than waiting a further full period.
_POLL_INTERVAL_SECONDS = 300.0


async def read_watermark(
    session_factory: async_sessionmaker[AsyncSession],
) -> datetime | None:
    """When the last snapshot pass ran, or None before the first."""
    async with session_factory() as session:
        row = (
            await session.execute(select(TelemetrySnapshotWatermark).limit(1))
        ).scalar_one_or_none()
    if row is None:
        return None
    stamp = row.last_sent_at
    return stamp.replace(tzinfo=UTC) if stamp.tzinfo is None else stamp


class SnapshotReporter:
    """Collects and sends the usage snapshot on a schedule."""

    def __init__(
        self,
        *,
        telemetry: TelemetryService,
        session_factory: async_sessionmaker[AsyncSession],
        interval_hours: float,
        installed_at: datetime | None,
        live_session_count: Callable[[], int],
    ) -> None:
        self._telemetry = telemetry
        self._session_factory = session_factory
        self._interval = timedelta(hours=interval_hours)
        self._installed_at = installed_at
        # A callable rather than the registry: no business knowing what a
        # connection is.
        self._live_session_count = live_session_count

    async def run_forever(self) -> None:
        await asyncio.sleep(_FIRST_PASS_DELAY_SECONDS)
        while True:
            try:
                await self.run_once_if_due()
            except asyncio.CancelledError:
                raise
            except Exception:
                # One bad pass must not end the loop — a transient database
                # error would otherwise switch telemetry off for the life of
                # the process, silently.
                logger.exception("Usage snapshot pass failed")
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)

    async def run_once_if_due(self) -> bool:
        """Send a snapshot if one is due and no other process has claimed
        it. True if this process sent it."""
        now = datetime.now(UTC)
        last_sent = await self._read_watermark()
        if last_sent is not None and now - last_sent < self._interval:
            return False
        if not await self._claim(now, last_sent):
            return False
        try:
            counts = await self._send_snapshot(now)
        except BaseException:
            # Nothing was sent: `_send_snapshot` raises only before its emit.
            # The claim is handed back so the next poll, here or in another
            # process, tries again rather than skipping the day.
            await self._release(now, last_sent)
            raise
        # The snapshot is out, so nothing from here hands the claim back, a
        # shutdown cancelling the pass included: the next pass would send the
        # snapshot, and every room and period already reported, again.
        await self._report_window(counts, now=now, since=last_sent)
        await self._prune(now)
        return True

    async def _prune(self, now: datetime) -> None:
        """Drop session start claims past their use, once a day with the
        snapshot. After the watermark, so a failure here can never make the
        snapshot go again; logged rather than raised, since the pass it rides
        on has already done its work."""
        try:
            pruned = await prune_session_start_claims(self._session_factory, now=now)
        except Exception:
            logger.exception("Pruning old session start claims failed")
            return
        if pruned:
            logger.info("Pruned %d session start claim(s) past their use", pruned)

    async def run_once(self, *, now: datetime, since: datetime | None) -> None:
        """Collect and report one snapshot, plus any room that just went live."""
        counts = await self._send_snapshot(now)
        await self._report_window(counts, now=now, since=since)

    async def _send_snapshot(self, now: datetime) -> UsageCounts:
        """Collect and emit the snapshot. Raises only before the emit."""
        counts = await collect_usage(self._session_factory, now=now)
        self._telemetry.emit(
            "usage_snapshot",
            **counts.as_event_properties(
                session_live_count=int(self._live_session_count())
            ),
        )
        return counts

    async def _report_window(
        self, counts: UsageCounts, *, now: datetime, since: datetime | None
    ) -> None:
        """What happened since the last pass: rooms that went live, and the
        periods that ended.

        Run after the snapshot is emitted, and no exception leaves it: the
        loop retries every poll interval, so a pass that failed here and ran
        again would re-send the same snapshot every five minutes for as long
        as the condition lasted, turning one lost pass into hundreds of
        duplicates of a figure meant to be daily. The rooms are the part that
        is given up instead: the window has moved past them, which is the
        trade the docstring on `newly_active_rooms` already describes, and it
        keeps "no room is reported twice" true.
        """
        try:
            # Skipped entirely on the first pass — see the module docstring.
            # Nor is a room that went live before reporting began: it was
            # used while nothing was being reported, and dating it then would
            # put an event before the deployment's install or opt-in.
            reporting_since = self._telemetry.reporting_since
            window_start = (
                since
                if since is None or reporting_since is None
                else max(as_utc(since), reporting_since)
            )
            active = (
                await newly_active_rooms(
                    self._session_factory, since=window_start, now=now
                )
                if window_start is not None
                else []
            )

            logger.info("Usage snapshot: %s", summarise(counts, active))

            # Dated when each room went live, not when this pass noticed: a
            # pass runs up to a day later, and a funnel times its steps from
            # the events' own times.
            for room in active:
                self._telemetry.emit_at(
                    "room_became_active",
                    room.first_active_at,
                    seconds_since_room_created=room.seconds_since_room_created,
                    bridge_platform=room.bridge_platform,
                    channel_type=room.channel_type,
                    agent_count=room.agent_count,
                    created_by_kind=room.created_by_kind,
                )

            await self._report_first_room_active(active)
        except Exception:
            logger.exception(
                "Usage snapshot: the snapshot was sent, but newly-active rooms "
                "could not be reported for this window. Any room that went "
                "active in it is not reported at all — the next window starts "
                "after it."
            )

        if since is not None:
            await self._report_periods(since=since, now=now)

    async def _report_periods(self, *, since: datetime, now: datetime) -> None:
        """One period event for every day, week and month that ended in this
        pass's window, other than one that ended before the deployment was
        installed or telemetry was switched on (`Period.dated`). Each is
        contained, so one that fails costs only itself; it is not reported,
        and the next window starts after it."""
        reporting_since = self._telemetry.reporting_since
        periods = [
            (period, dated)
            for period in periods_ending_between(since, now)
            if (dated := period.dated(reporting_since)) is not None
        ]
        if not periods:
            return
        try:
            counted = await collect_each_period_counts(
                self._session_factory,
                [(period.start, period.end) for period, _ in periods],
            )
        except Exception:
            logger.exception(
                "Usage period: the %d period(s) that ended in this window could "
                "not be counted, and are not reported.",
                len(periods),
            )
            return
        for (period, (at, partial)), counts in zip(periods, counted, strict=True):
            if counts is None:
                continue
            try:
                self._telemetry.emit_at(
                    period.event,
                    at,
                    room_active=counts.room_active,
                    person_identity_active=counts.person_identity_active,
                    bot_identity_active=counts.bot_identity_active,
                    account_active=counts.account_active,
                    agent_active=counts.agent_active,
                    message_count=counts.message_count,
                    turn_human_to_agent=counts.turn_human_to_agent,
                    turn_agent_to_human=counts.turn_agent_to_human,
                    turn_agent_to_agent=counts.turn_agent_to_agent,
                    is_partial=partial,
                    tenant_failed_count=counts.tenant_failed_count,
                )
            except Exception:
                logger.exception(
                    "Usage period: the %s from %s could not be reported.",
                    period.kind,
                    period.start.date().isoformat(),
                )

    async def _report_first_room_active(self, active: list) -> None:
        """The activation milestone: the first room a person actually used.

        Fires once, so all three of these are permanent if wrong. Measured and
        dated from the interaction, not from this pass, which is always late
        in the same direction. The *earliest* room, not the quickest. And
        user-created only, matching `first_room_created`.

        Not `emit_milestone`, because the elapsed time and the date come from
        the room rather than from now. This pass runs only while telemetry is
        on; a room first used while it was off is settled at the boot that
        switches it on (`deployment.settle_from_evidence`).
        """
        by_a_person = [room for room in active if room.created_by_kind == "user"]
        if not by_a_person or self._installed_at is None:
            return

        earliest = min(by_a_person, key=lambda room: room.first_active_at)
        elapsed = (
            earliest.first_active_at - as_utc(self._installed_at)
        ).total_seconds()
        if not await self._telemetry.take_milestone("first_room_active"):
            return
        self._telemetry.emit_at(
            "first_room_active",
            earliest.first_active_at,
            seconds_since_install=max(elapsed, 0.0),
            bridge_platform=earliest.bridge_platform,
            seconds_since_room_created=earliest.seconds_since_room_created,
        )

    async def _read_watermark(self) -> datetime | None:
        return await read_watermark(self._session_factory)

    async def _claim(self, now: datetime, last_sent: datetime | None) -> bool:
        """Move the watermark from `last_sent` to `now`, if no other process
        has moved it since this one read it. True if this process did."""
        async with self._session_factory() as session:
            if last_sent is None:
                result = await session.execute(
                    pg_insert(TelemetrySnapshotWatermark)
                    .values(id=1, last_sent_at=now)
                    .on_conflict_do_nothing(index_elements=["id"])
                    .returning(TelemetrySnapshotWatermark.id)
                )
            else:
                result = await session.execute(
                    update(TelemetrySnapshotWatermark)
                    .where(
                        TelemetrySnapshotWatermark.id == 1,
                        TelemetrySnapshotWatermark.last_sent_at == last_sent,
                    )
                    .values(last_sent_at=now)
                    .returning(TelemetrySnapshotWatermark.id)
                )
            claimed = result.first() is not None
            await session.commit()
        return claimed

    async def _release(self, claimed_at: datetime, last_sent: datetime | None) -> None:
        """Put the watermark back where it was, unless something has moved it
        on since this process claimed it."""
        async with self._session_factory() as session:
            if last_sent is None:
                await session.execute(
                    delete(TelemetrySnapshotWatermark).where(
                        TelemetrySnapshotWatermark.last_sent_at == claimed_at
                    )
                )
            else:
                await session.execute(
                    update(TelemetrySnapshotWatermark)
                    .where(TelemetrySnapshotWatermark.last_sent_at == claimed_at)
                    .values(last_sent_at=last_sent)
                )
            await session.commit()

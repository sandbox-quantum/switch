"""The background task that sends the daily snapshot.

One loop, anchored to what was last sent rather than to how long this process
has been up. A timer started at boot would send several snapshots on a day with
several restarts and none on a day the server happened to be down at the wrong
moment; a watermark in the database gives the same cadence whatever the process
does.

The first pass on a deployment that already has history is the one case worth
knowing about. It sends the snapshot — those are current-state counts and are
correct immediately — but not the room-activation events, because "first human
interaction since the watermark" with no watermark means every room that ever
went active, arriving at once and all dated today. The watermark is set instead,
and the next pass reports normally.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TelemetrySnapshotWatermark
from switch_core.telemetry.deployment import claim_milestone
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.snapshot import (
    as_utc,
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
        # A zero-argument callable rather than the registry itself: the
        # reporter has no business knowing what a connection is, and a test
        # should not have to build one to check a count.
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
        """Send a snapshot if one is due. True if one was sent."""
        now = datetime.now(UTC)
        last_sent = await self._read_watermark()
        if last_sent is not None and now - last_sent < self._interval:
            return False
        await self.run_once(now=now, since=last_sent)
        await self._write_watermark(now)
        return True

    async def run_once(self, *, now: datetime, since: datetime | None) -> None:
        """Collect and report one snapshot, plus any room that just went live."""
        counts = await collect_usage(self._session_factory, now=now)

        # Skipped entirely on the first pass — see the module docstring.
        active = (
            await newly_active_rooms(self._session_factory, since=since, now=now)
            if since is not None
            else []
        )

        logger.info("Usage snapshot: %s", summarise(counts, active))

        self._telemetry.emit(
            "usage_snapshot",
            **counts.as_event_properties(
                session_live_count=int(self._live_session_count())
            ),
        )

        for room in active:
            self._telemetry.emit(
                "room_became_active",
                seconds_since_room_created=room.seconds_since_room_created,
                bridge_platform=room.bridge_platform,
                channel_type=room.channel_type,
                agent_count=room.agent_count,
                created_by_kind=room.created_by_kind,
            )

        await self._report_first_room_active(active)

    async def _report_first_room_active(self, active: list) -> None:
        """The activation milestone: the first room a person actually used.

        Three things here are easy to get wrong and all three matter, because
        the milestone fires once and whatever it reports is permanent.

        **Measured from the interaction, not from this pass.** A snapshot runs
        on an interval, so it learns about an activation up to a whole interval
        after it happened — and always late, never early. Reporting
        `now - installed_at` would add that lag to every deployment's headline
        activation time in the same direction.

        **The earliest room, not the quickest.** A batch can contain several
        newly-active rooms; the one that activated *first* is the deployment's
        activation. The one that went from creation to use fastest is a
        different and much smaller number.

        **User-created rooms only**, matching `first_room_created` and the
        design note. A room an agent provisioned for its own orchestration is
        not a customer getting started, and it must not be allowed to consume
        the claim.
        """
        by_a_person = [room for room in active if room.created_by_kind == "user"]
        if not by_a_person or self._installed_at is None:
            return
        # Not `emit_milestone`, because the elapsed time is computed from the
        # room rather than from now — so the enabled gate it would have applied
        # is applied here instead. Without it a deployment with telemetry off
        # would spend the claim and never be able to report this again.
        if not self._telemetry.enabled:
            return

        earliest = min(by_a_person, key=lambda room: room.first_active_at)
        elapsed = (
            earliest.first_active_at - as_utc(self._installed_at)
        ).total_seconds()
        if not await claim_milestone(self._session_factory, "first_room_active"):
            return
        self._telemetry.emit(
            "first_room_active",
            seconds_since_install=max(elapsed, 0.0),
            bridge_platform=earliest.bridge_platform,
            seconds_since_room_created=earliest.seconds_since_room_created,
        )

    async def _read_watermark(self) -> datetime | None:
        async with self._session_factory() as session:
            row = (
                await session.execute(select(TelemetrySnapshotWatermark).limit(1))
            ).scalar_one_or_none()
        if row is None:
            return None
        stamp = row.last_sent_at
        return stamp.replace(tzinfo=UTC) if stamp.tzinfo is None else stamp

    async def _write_watermark(self, when: datetime) -> None:
        async with self._session_factory() as session:
            await session.execute(
                pg_insert(TelemetrySnapshotWatermark)
                .values(id=1, last_sent_at=when)
                .on_conflict_do_update(
                    index_elements=["id"], set_={"last_sent_at": when}
                )
            )
            await session.commit()

"""Usage counted per finished day, week and month (`usage_period`).

The snapshot's trailing `*_7d` counts add up wrong over a week: each room is
counted on every day it was in the window. A period is counted once, over
exactly its own span, and each pass reports the periods that ended in its
window, so successive passes report every period once.

The counting is against real Postgres, because it is SQL; the period
arithmetic needs none.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.admin_messages import SENDER_IS_APP_MARKER
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    ClientRoom,
    Message,
    Room,
    TelemetrySnapshotWatermark,
)
from switch_core.db.session_scope import tenant_session
from switch_core.telemetry.periods import BACKFILL, Period, periods_ending_between
from switch_core.telemetry.reporter import SnapshotReporter
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord
from switch_core.telemetry.snapshot import collect_period_counts


def _at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


def _spans(periods: list[Period]) -> list[tuple[str, str, str]]:
    return [
        (period.kind, period.start.date().isoformat(), period.end.date().isoformat())
        for period in periods
    ]


class TestWhichPeriodsAPassReports:
    def test_an_ordinary_day_is_reported_alone(self) -> None:
        # Wednesday to Thursday: no week or month ends in between.
        periods = periods_ending_between(
            _at("2026-11-04T14:00:00"), _at("2026-11-05T14:00:00")
        )

        assert _spans(periods) == [("day", "2026-11-04", "2026-11-05")]

    def test_a_window_over_a_monday_and_the_first_reports_the_week_and_month(
        self,
    ) -> None:
        periods = periods_ending_between(
            _at("2026-11-29T10:00:00"), _at("2026-12-01T10:00:00")
        )

        assert _spans(periods) == [
            ("day", "2026-11-29", "2026-11-30"),
            ("day", "2026-11-30", "2026-12-01"),
            ("week", "2026-11-23", "2026-11-30"),
            ("month", "2026-11-01", "2026-12-01"),
        ]

    def test_successive_passes_report_every_period_once(self) -> None:
        """Passes are a day apart give or take, as the watermark keeps them,
        across a year boundary and a short month."""
        start = _at("2026-12-20T09:13:00")
        moments = [start]
        for step in range(80):
            moments.append(moments[-1] + timedelta(hours=24, minutes=7 * (step % 5)))

        reported: list[Period] = []
        for since, now in zip(moments, moments[1:], strict=False):
            reported.extend(periods_ending_between(since, now))

        assert len(reported) == len(set(reported))
        days = [period for period in reported if period.kind == "day"]
        assert all(
            later.start == earlier.end
            for earlier, later in zip(days, days[1:], strict=False)
        )
        weeks = [period for period in reported if period.kind == "week"]
        assert all(week.start.weekday() == 0 for week in weeks)
        assert all(
            later.start == earlier.end
            for earlier, later in zip(weeks, weeks[1:], strict=False)
        )
        assert _spans([period for period in reported if period.kind == "month"]) == [
            ("month", "2026-12-01", "2027-01-01"),
            ("month", "2027-01-01", "2027-02-01"),
            ("month", "2027-02-01", "2027-03-01"),
        ]

    def test_a_long_gap_reports_only_what_ended_within_the_backfill(self) -> None:
        now = _at("2026-11-03T12:00:00")

        periods = periods_ending_between(now - timedelta(days=200), now)

        assert periods
        assert min(period.end for period in periods) > now - BACKFILL
        assert ("month", "2026-10-01", "2026-11-01") in _spans(periods)

    def test_each_is_dated_to_its_middle(self) -> None:
        day, week, month = periods_ending_between(
            _at("2026-11-29T10:00:00"), _at("2026-12-01T10:00:00")
        )[1:]

        assert day.midpoint == _at("2026-11-30T12:00:00")
        # Thursday noon, inside the same week whether weeks start on Sunday or
        # Monday, in any timezone.
        assert week.midpoint == _at("2026-11-26T12:00:00")
        assert month.midpoint == _at("2026-11-16T00:00:00")


async def _room_with_posts(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    posts: list[tuple[datetime, bool]],
) -> None:
    """A room with an agent in it, where one chat identity posts at each
    `(sent_at, as_app)`."""
    suffix = uuid.uuid4().hex[:8]
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        identity = Client(
            transport_user_id=f"@identity-{suffix}:test",
            display_name="identity",
            type="user",
        )
        agent = Client(
            transport_user_id=f"@agent-{suffix}:test",
            display_name="agent",
            type="agent",
        )
        room = Room(
            transport_room_id=f"!{suffix}:test",
            name=f"room-{suffix}",
            description="",
            metadata_={"created_by_kind": "user"},
        )
        session.add_all([identity, agent, room])
        await session.flush()
        session.add(ClientRoom(client_id=agent.id, room_id=room.id))
        for seq, (sent_at, as_app) in enumerate(posts, start=1):
            content: dict[str, object] = {"body": "hello"}
            if as_app:
                content[SENDER_IS_APP_MARKER] = True
            session.add(
                Message(
                    room_id=room.id,
                    seq=seq,
                    transport_event_id=f"$evt-{suffix}-{seq}",
                    sender_id=identity.transport_user_id,
                    sender_client_id=identity.id,
                    event_type="m.room.message",
                    msgtype="m.text",
                    body="hello",
                    content=content,
                    sent_at=sent_at,
                )
            )
        await session.commit()


class TestCountingAPeriod:
    async def test_only_what_happened_inside_the_period_counts(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        start, end = _at("2026-11-02T00:00:00"), _at("2026-11-09T00:00:00")
        await _room_with_posts(session_factory, posts=[(start, False)])
        await _room_with_posts(
            session_factory, posts=[(end - timedelta(microseconds=1), False)]
        )
        await _room_with_posts(
            session_factory, posts=[(start - timedelta(seconds=1), False)]
        )
        await _room_with_posts(session_factory, posts=[(end, False)])

        counts = await collect_period_counts(session_factory, start=start, end=end)

        assert counts.room_active == 2
        assert counts.person_identity_active == 2
        assert counts.tenant_failed_count == 0

    async def test_a_bot_uses_a_room_but_is_not_a_person(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        start, end = _at("2026-11-02T00:00:00"), _at("2026-11-03T00:00:00")
        await _room_with_posts(
            session_factory, posts=[(start + timedelta(hours=1), True)]
        )

        counts = await collect_period_counts(session_factory, start=start, end=end)

        assert counts.room_active == 1
        assert counts.person_identity_active == 0


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _reporter(
    sink: _RecordingSink, session_factory: async_sessionmaker[AsyncSession]
) -> SnapshotReporter:
    service = TelemetryService(
        sink=sink,  # type: ignore[arg-type]
        enabled=True,
        client_id="deployment-uuid",
        version="1.0.0",
        telemetry_environment="prod",
        telemetry_internal=False,
        deployment_kind="self_hosted",
        session_factory=session_factory,
        installed_at=datetime.now(UTC) - timedelta(days=30),
    )
    return SnapshotReporter(
        telemetry=service,
        session_factory=session_factory,
        interval_hours=24.0,
        installed_at=service.installed_at,
        live_session_count=lambda: 0,
    )


def _periods_sent(sink: _RecordingSink) -> list[TelemetryRecord]:
    return [record for record in sink.sent if record.name == "switch_core.usage_period"]


class TestThePassReportsThem:
    async def test_each_finished_period_is_sent_dated_to_its_middle(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _room_with_posts(
            session_factory,
            posts=[(_at("2026-11-30T09:00:00"), False)],
        )
        sink = _RecordingSink()

        await _reporter(sink, session_factory).run_once(
            now=_at("2026-12-01T10:00:00"), since=_at("2026-11-30T10:00:00")
        )

        sent = _periods_sent(sink)
        assert [record.properties["period"] for record in sent] == ["day", "month"]
        day, month = sent
        assert day.timestamp_ns == int(_at("2026-11-30T12:00:00").timestamp()) * 10**9
        assert day.properties["room_active"] == 1
        assert day.properties["person_identity_active"] == 1
        assert month.timestamp_ns == int(_at("2026-11-16T00:00:00").timestamp()) * 10**9
        assert month.properties["room_active"] == 1

    async def test_the_first_pass_sends_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """With no watermark there is no telling which periods were sent."""
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            await session.commit()
        sink = _RecordingSink()

        assert await _reporter(sink, session_factory).run_once_if_due() is True

        assert "switch_core.usage_snapshot" in [record.name for record in sink.sent]
        assert _periods_sent(sink) == []

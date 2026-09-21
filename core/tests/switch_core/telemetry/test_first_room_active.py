"""The activation milestone, which fires once and is permanent if wrong.

A review found four independent defects in seven lines of this method, none of
which any test would have caught because nothing exercised it. Each case below
pins one of them.

The value matters more than most: `first_room_active` is the end of the
activation funnel, it is claimed once per deployment ever, and a wrong number
cannot be corrected by a later pass.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TelemetryMilestone
from switch_core.telemetry.deployment import claim_milestone
from switch_core.telemetry.reporter import SnapshotReporter
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord
from switch_core.telemetry.snapshot import NewlyActiveRoom

INSTALLED = datetime(2026, 9, 1, 0, 0, tzinfo=UTC)


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _room(
    *,
    first_active_at: datetime,
    since_created: float = 60.0,
    kind: str = "user",
    platform: str = "slack",
) -> NewlyActiveRoom:
    return NewlyActiveRoom(
        first_active_at=first_active_at,
        seconds_since_room_created=since_created,
        bridge_platform=platform,
        channel_type="channel_public",
        agent_count=1,
        created_by_kind=kind,
    )


def _reporter(
    sink: _RecordingSink,
    session_factory: async_sessionmaker[AsyncSession],
    *,
    enabled: bool = True,
) -> SnapshotReporter:
    service = TelemetryService(
        sink=sink,  # type: ignore[arg-type]
        enabled=enabled,
        client_id="deployment-uuid",
        service_name="switch-core",
        version="1.0.0",
        environment=None,
        session_factory=session_factory,
        installed_at=INSTALLED,
    )
    return SnapshotReporter(
        telemetry=service,
        session_factory=session_factory,
        interval_hours=24.0,
        installed_at=INSTALLED,
        live_session_count=lambda: 0,
    )


async def _clear(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        await session.execute(delete(TelemetryMilestone))
        await session.commit()


async def _report(reporter: SnapshotReporter, rooms: list) -> None:
    """Report, then let the fire-and-forget send actually run.

    `emit` hands the send to a background task by design, so a test that
    inspects the sink immediately races it.
    """
    await reporter._report_first_room_active(rooms)
    await reporter._telemetry.aclose()


def _milestone(sink: _RecordingSink) -> TelemetryRecord | None:
    return next(
        (r for r in sink.sent if r.name == "switch_core.first_room_active"), None
    )


class TestItIsMeasuredFromTheInteraction:
    async def test_the_elapsed_time_is_install_to_activation_not_install_to_now(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The snapshot runs on an interval, so it always learns about an
        activation late — and always in the same direction. Measuring to `now`
        would add a day to every deployment's headline activation figure."""
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory)

        activated = INSTALLED + timedelta(hours=3)
        await _report(reporter, [_room(first_active_at=activated)])

        record = _milestone(sink)
        assert record is not None
        assert record.properties["seconds_since_install"] == 3 * 3600


class TestItPicksTheEarliestRoom:
    async def test_the_first_room_to_activate_wins_not_the_quickest(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A batch can hold several. The deployment activated when the first of
        them did; the one that went from creation to use fastest is a different
        and much smaller number."""
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory)

        earliest = _room(
            first_active_at=INSTALLED + timedelta(hours=2),
            since_created=9999.0,
            platform="teams",
        )
        quickest = _room(
            first_active_at=INSTALLED + timedelta(days=5),
            since_created=1.0,
            platform="slack",
        )

        await _report(reporter, [quickest, earliest])

        record = _milestone(sink)
        assert record is not None
        assert record.properties["seconds_since_install"] == 2 * 3600
        assert record.properties["bridge_platform"] == "teams"


class TestOnlyARoomAPersonMade:
    async def test_an_agent_created_room_does_not_activate_the_deployment(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An orchestration spinning up a scratch room is not a customer
        getting started, and must not consume the once-ever claim."""
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory)

        await _report(
            reporter,
            [_room(first_active_at=INSTALLED + timedelta(hours=1), kind="agent")],
        )

        assert _milestone(sink) is None
        # And the claim is still available for the real activation.
        assert await claim_milestone(session_factory, "first_room_active") is True

    async def test_a_system_adopted_room_does_not_either(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory)

        await _report(
            reporter,
            [_room(first_active_at=INSTALLED + timedelta(hours=1), kind="system")],
        )

        assert _milestone(sink) is None

    async def test_the_user_room_is_chosen_from_a_mixed_batch(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory)

        await _report(
            reporter,
            [
                _room(first_active_at=INSTALLED + timedelta(hours=1), kind="agent"),
                _room(
                    first_active_at=INSTALLED + timedelta(hours=4),
                    kind="user",
                    platform="discord",
                ),
            ],
        )

        record = _milestone(sink)
        assert record is not None
        assert record.properties["seconds_since_install"] == 4 * 3600
        assert record.properties["bridge_platform"] == "discord"


class TestTheClaimIsNotSpentWhenNobodyIsListening:
    async def test_a_disabled_deployment_keeps_its_claim(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Otherwise a deployment that opts in later has already used up the
        milestone and can never report its activation."""
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory, enabled=False)

        await _report(reporter, [_room(first_active_at=INSTALLED + timedelta(hours=1))])

        assert sink.sent == []
        assert await claim_milestone(session_factory, "first_room_active") is True


class TestItFiresOnce:
    async def test_a_second_batch_reports_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory)

        await _report(reporter, [_room(first_active_at=INSTALLED + timedelta(hours=1))])
        await _report(reporter, [_room(first_active_at=INSTALLED + timedelta(hours=2))])

        assert len([r for r in sink.sent if r.name.endswith("first_room_active")]) == 1

    async def test_a_deployment_with_no_install_date_reports_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _clear(session_factory)
        sink = _RecordingSink()
        reporter = _reporter(sink, session_factory)
        reporter._installed_at = None

        await _report(reporter, [_room(first_active_at=INSTALLED + timedelta(hours=1))])

        assert _milestone(sink) is None

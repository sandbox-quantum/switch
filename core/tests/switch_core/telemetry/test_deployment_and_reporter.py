"""Deployment identity, once-ever milestones, and the snapshot schedule.

Against real Postgres, because all three are claims about durability: an
identity that survives a restart, a milestone that cannot fire twice, and a
schedule anchored to what was sent rather than to how long the process has
been up. None of those can be tested against a mock — the second in particular
relies on a primary-key collision being the guard.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import DeploymentIdentity, TelemetrySnapshotWatermark
from switch_core.telemetry.deployment import (
    DeploymentIdentityMissingError,
    claim_milestone,
    load_deployment_identity,
    seconds_since_install,
)
from switch_core.telemetry.reporter import SnapshotReporter
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


async def _seed_identity(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    installed_at: datetime | None,
) -> None:
    async with session_factory() as session:
        await session.execute(delete(DeploymentIdentity))
        session.add(
            DeploymentIdentity(
                id=1, client_id=str(uuid.uuid4()), installed_at=installed_at
            )
        )
        await session.commit()


class TestDeploymentIdentity:
    async def test_the_identity_is_read_back(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_identity(session_factory, installed_at=NOW)

        client_id, installed_at = await load_deployment_identity(session_factory)

        assert uuid.UUID(client_id)
        assert installed_at is not None

    async def test_a_missing_identity_raises_rather_than_minting_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Only the migration ran early enough to tell a new deployment from an
        existing one. Re-creating the row here would give a year-old
        installation an install date of today and a brand-new analytics
        identity."""
        async with session_factory() as session:
            await session.execute(delete(DeploymentIdentity))
            await session.commit()

        with pytest.raises(DeploymentIdentityMissingError):
            await load_deployment_identity(session_factory)

    async def test_only_one_identity_can_exist(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two would mean one installation reporting as two subjects, silently
        doubling every count derived from it."""
        await _seed_identity(session_factory, installed_at=NOW)

        with pytest.raises(Exception):
            async with session_factory() as session:
                session.add(DeploymentIdentity(id=2, client_id=str(uuid.uuid4())))
                await session.commit()


class TestTheInstallClock:
    def test_a_deployment_with_no_install_date_is_unmeasurable(self) -> None:
        """Not zero — `None`, which every milestone call site treats as "do not
        report". A pre-existing deployment stays out of the funnel rather than
        appearing to have activated instantly."""
        assert seconds_since_install(None) is None

    def test_elapsed_time_is_measured_from_the_install(self) -> None:
        elapsed = seconds_since_install(datetime.now(UTC) - timedelta(hours=2))
        assert elapsed is not None
        assert 7100 < elapsed < 7300

    def test_a_naive_timestamp_is_read_as_utc(self) -> None:
        """A `timestamptz` read back without a zone must not raise on
        comparison."""
        naive = (datetime.now(UTC) - timedelta(minutes=5)).replace(tzinfo=None)
        elapsed = seconds_since_install(naive)
        assert elapsed is not None and elapsed > 0


class TestMilestonesFireOnce:
    async def test_the_first_claim_wins_and_the_second_does_not(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert await claim_milestone(session_factory, "first_room_created") is True
        assert await claim_milestone(session_factory, "first_room_created") is False

    async def test_different_milestones_do_not_collide(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert await claim_milestone(session_factory, "first_room_created") is True
        assert await claim_milestone(session_factory, "first_connector_added") is True

    async def test_a_milestone_survives_a_restart(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The claim is a row, not process state — otherwise every restart
        would re-report "first room created" on finding a room."""
        await claim_milestone(session_factory, "deployment_installed")
        assert await claim_milestone(session_factory, "deployment_installed") is False


class TestEmitMilestone:
    def _service(
        self,
        sink: _RecordingSink,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        enabled: bool = True,
        installed_at: datetime | None = None,
    ) -> TelemetryService:
        return TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=enabled,
            client_id="deployment-uuid",
            service_name="switch-core",
            version="1.0.0",
            environment=None,
            session_factory=session_factory,
            installed_at=installed_at,
        )

    async def test_a_milestone_is_reported_once_with_its_elapsed_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        sink = _RecordingSink()
        service = self._service(
            sink, session_factory, installed_at=datetime.now(UTC) - timedelta(hours=1)
        )

        await service.emit_milestone("first_connector_added", bridge_platform="slack")
        await service.emit_milestone("first_connector_added", bridge_platform="slack")
        await service.aclose()

        assert len(sink.sent) == 1
        assert sink.sent[0].name == "switch_core.first_connector_added"
        assert 3500 < float(sink.sent[0].properties["seconds_since_install"]) < 3700

    async def test_a_deployment_with_no_install_date_reports_no_milestone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        sink = _RecordingSink()
        service = self._service(sink, session_factory, installed_at=None)

        await service.emit_milestone("first_connector_added", bridge_platform="slack")
        await service.aclose()

        assert sink.sent == []

    async def test_a_disabled_deployment_does_not_use_up_its_claims(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Switching telemetry on later must not find every milestone already
        spent."""
        sink = _RecordingSink()
        off = self._service(
            sink, session_factory, enabled=False, installed_at=datetime.now(UTC)
        )

        await off.emit_milestone("first_connector_added", bridge_platform="slack")

        assert await claim_milestone(session_factory, "first_connector_added") is True


class TestTheSnapshotSchedule:
    def _reporter(
        self,
        sink: _RecordingSink,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        interval_hours: float = 24.0,
    ) -> SnapshotReporter:
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id="deployment-uuid",
            service_name="switch-core",
            version="1.0.0",
            environment=None,
            session_factory=session_factory,
            installed_at=datetime.now(UTC) - timedelta(days=1),
        )
        return SnapshotReporter(
            telemetry=service,
            session_factory=session_factory,
            interval_hours=interval_hours,
            installed_at=service.installed_at,
            live_session_count=lambda: 2,
        )

    async def _clear_watermark(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            await session.commit()

    async def test_the_first_pass_sends_a_snapshot_and_sets_the_watermark(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await self._clear_watermark(session_factory)
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        assert await reporter.run_once_if_due() is True

        names = [record.name for record in sink.sent]
        assert "switch_core.usage_snapshot" in names

    async def test_a_second_pass_inside_the_interval_does_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await self._clear_watermark(session_factory)
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        await reporter.run_once_if_due()
        sent_after_first = len(sink.sent)

        assert await reporter.run_once_if_due() is False
        assert len(sink.sent) == sent_after_first

    async def test_the_schedule_follows_the_watermark_not_the_process(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A restart must not send a second snapshot the same day, and a
        deployment that was down over its due time must send promptly rather
        than waiting a further full period."""
        await self._clear_watermark(session_factory)
        sink = _RecordingSink()
        first = self._reporter(sink, session_factory)
        await first.run_once_if_due()

        # A brand-new reporter, as a restart would build.
        restarted = self._reporter(_RecordingSink(), session_factory)
        assert await restarted.run_once_if_due() is False

    async def test_a_lapsed_watermark_sends_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            session.add(
                TelemetrySnapshotWatermark(
                    id=1, last_sent_at=datetime.now(UTC) - timedelta(days=3)
                )
            )
            await session.commit()

        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        assert await reporter.run_once_if_due() is True

    async def test_the_first_pass_reports_no_room_activations(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """With no watermark, "first interaction since then" means every room
        that ever went active, arriving at once and all dated today."""
        await self._clear_watermark(session_factory)
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        await reporter.run_once_if_due()

        assert not [
            record
            for record in sink.sent
            if record.name == "switch_core.room_became_active"
        ]

    async def test_the_snapshot_carries_the_live_session_count(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await self._clear_watermark(session_factory)
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        await reporter.run_once_if_due()

        snapshot = next(
            record
            for record in sink.sent
            if record.name == "switch_core.usage_snapshot"
        )
        assert snapshot.properties["session_live_count"] == 2

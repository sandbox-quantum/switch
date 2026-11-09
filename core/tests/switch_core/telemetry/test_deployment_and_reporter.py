"""Deployment identity, once-ever milestones, and the snapshot schedule.

Against real Postgres, because all three are claims about durability: an
identity that survives a restart, a milestone that cannot fire twice, and a
schedule anchored to what was sent rather than to how long the process has
been up. None of those can be tested against a mock — the second in particular
relies on a primary-key collision being the guard.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    DeploymentIdentity,
    TelemetrySnapshotWatermark,
)
from switch_core.telemetry import service as service_module
from switch_core.telemetry import snapshot as snapshot_module
from switch_core.telemetry.deployment import (
    DeploymentIdentityMissingError,
    claim_milestone,
    load_deployment_identity,
    record_telemetry_switch,
    seconds_since_install,
)
from switch_core.telemetry.reporter import SnapshotReporter
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)


@contextlib.asynccontextmanager
async def _always_broken_tenant_session(
    factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> AsyncIterator[AsyncSession]:
    """A `tenant_session` replacement that fails for every tenant, every time.

    Stands in for a tenant whose queries never succeed — a permanently broken
    row, a statement that always times out — so a test can ask whether the
    schedule keeps moving regardless, rather than reproducing such a query.
    """
    raise RuntimeError("permanently broken tenant")
    yield  # pragma: no cover - unreachable; keeps this an async generator


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    def send(self, record: TelemetryRecord) -> None:
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


class TestWhenTelemetryWasSwitchedOn:
    async def test_the_first_boot_with_it_on_starts_the_clock(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_identity(session_factory, installed_at=NOW)

        since, switched_on = await record_telemetry_switch(
            session_factory, enabled=True
        )

        assert since is not None
        assert switched_on is True

    async def test_a_later_boot_with_it_on_keeps_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_identity(session_factory, installed_at=NOW)
        first, _ = await record_telemetry_switch(session_factory, enabled=True)

        again, switched_on = await record_telemetry_switch(
            session_factory, enabled=True
        )

        assert again == first
        assert switched_on is False

    async def test_a_boot_with_it_off_forgets_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """So the next boot with it on starts again from then: what happened
        while it was off is never dated as reported."""
        await _seed_identity(session_factory, installed_at=NOW)
        first, _ = await record_telemetry_switch(session_factory, enabled=True)

        assert await record_telemetry_switch(session_factory, enabled=False) == (
            None,
            False,
        )
        again, switched_on = await record_telemetry_switch(
            session_factory, enabled=True
        )

        assert switched_on is True
        assert again is not None and first is not None and again >= first

    def test_events_about_the_past_are_dated_no_earlier_than_either(self) -> None:
        installed = datetime(2026, 9, 1, tzinfo=UTC)
        switched_on = datetime(2026, 10, 1, tzinfo=UTC)

        def service(
            installed_at: datetime | None, enabled_since: datetime | None
        ) -> TelemetryService:
            return TelemetryService(
                sink=_RecordingSink(),  # type: ignore[arg-type]
                enabled=True,
                client_id="deployment-uuid",
                version="1.0.0",
                telemetry_environment="prod",
                telemetry_internal=False,
                deployment_kind="self_hosted",
                installed_at=installed_at,
                enabled_since=enabled_since,
            )

        assert service(installed, switched_on).reporting_since == switched_on
        assert service(switched_on, installed).reporting_since == switched_on
        assert service(installed, None).reporting_since == installed
        assert service(None, None).reporting_since is None


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
            version="1.0.0",
            telemetry_environment="prod",
            telemetry_internal=False,
            deployment_kind="self_hosted",
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

    async def test_a_disabled_deployment_claims_its_milestones_without_reporting(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Switching telemetry on later must not report, as a first, what the
        deployment did long before."""
        sink = _RecordingSink()
        off = self._service(
            sink, session_factory, enabled=False, installed_at=datetime.now(UTC)
        )

        await off.emit_milestone("first_connector_added", bridge_platform="slack")

        assert sink.sent == []
        assert await claim_milestone(session_factory, "first_connector_added") is False

    async def test_a_mistake_in_the_event_never_reaches_the_caller(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """It runs on the way to answering a session report, opening a stream
        and registering an agent: none of them may fail over telemetry."""
        sink = _RecordingSink()
        service = self._service(
            sink, session_factory, enabled=True, installed_at=datetime.now(UTC)
        )

        await service.emit_milestone("first_agent_registered", known_agent_type="x")

        assert sink.sent == []

    async def test_a_claimed_milestone_costs_nothing_the_next_time(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Asked on every agent connection, so the process remembers once the
        database has answered, rather than writing a claim each time."""
        sink = _RecordingSink()
        service = self._service(
            sink, session_factory, enabled=True, installed_at=datetime.now(UTC)
        )
        writes = 0
        original = service_module.take_claim

        async def counting(factory: object, name: str) -> bool:
            nonlocal writes
            writes += 1
            return await original(factory, name)  # type: ignore[arg-type]

        monkeypatch.setattr(service_module, "take_claim", counting)

        for _ in range(3):
            await service.emit_milestone(
                "first_agent_connected", known_agent_type="codex"
            )

        assert writes == 1
        assert len(sink.sent) == 1


class TestTheInstallIsReportedWhenItHappened:
    def _service(
        self,
        sink: _RecordingSink,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        enabled: bool,
    ) -> TelemetryService:
        return TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=enabled,
            client_id="deployment-uuid",
            version="1.0.0",
            telemetry_environment="prod",
            telemetry_internal=False,
            deployment_kind="self_hosted",
            session_factory=session_factory,
            installed_at=NOW,
        )

    async def test_it_is_dated_to_the_install_whenever_it_is_sent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The start of the funnel, and the moment Amplitude counts the
        deployment as new from, even when telemetry is switched on months in."""
        sink = _RecordingSink()

        await self._service(sink, session_factory, enabled=True).report_installed()

        [record] = sink.sent
        assert record.name == "switch_core.deployment_installed"
        assert record.timestamp_ns == int(NOW.timestamp()) * 10**9
        assert record.properties["seconds_since_install"] > 0

    async def test_it_waits_for_telemetry_rather_than_being_claimed_while_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        off_sink, on_sink = _RecordingSink(), _RecordingSink()

        await self._service(off_sink, session_factory, enabled=False).report_installed()
        await self._service(on_sink, session_factory, enabled=True).report_installed()
        await self._service(on_sink, session_factory, enabled=True).report_installed()

        assert off_sink.sent == []
        assert [record.name for record in on_sink.sent] == [
            "switch_core.deployment_installed"
        ]


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
            version="1.0.0",
            telemetry_environment="prod",
            telemetry_internal=False,
            deployment_kind="self_hosted",
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

    async def test_the_room_half_failing_does_not_resend_the_snapshot_forever(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The snapshot is emitted before the newly-active-room half runs, so a
        failure there does not discard a pass already collected. That move has
        a trap: the watermark only advances when `run_once` returns, and
        `run_forever` retries every five minutes — so a raise *after* the emit
        would re-send the same daily figure hundreds of times a day, which is
        far worse than losing one pass. The room half is therefore contained
        too: the pass completes, the window moves on, and the rooms in it are
        given up rather than reported twice.
        """
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        # A watermark a day old: the pass below is due, and `since` is set —
        # which is what makes the room half run at all.
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            session.add(
                TelemetrySnapshotWatermark(
                    id=1, last_sent_at=datetime.now(UTC) - timedelta(days=2)
                )
            )
            await session.commit()

        # Only the room half: `collect_usage` runs before the emit, and a
        # failure there is the case the per-tenant containment already covers.
        def _explode(*_args: object, **_kwargs: object) -> list[object]:
            raise RuntimeError("the room query fell over")

        monkeypatch.setattr(
            "switch_core.telemetry.reporter.newly_active_rooms", _explode
        )

        with caplog.at_level(logging.ERROR, logger="switch_core.telemetry.reporter"):
            assert await reporter.run_once_if_due() is True

        # The pass completed, so the watermark advanced and the next one is not
        # due — which is what stops the duplicate.
        assert await reporter.run_once_if_due() is False
        # And it is disclosed rather than swallowed.
        assert any("newly-active rooms" in record.message for record in caplog.records)
        assert (
            len([r for r in sink.sent if r.name == "switch_core.usage_snapshot"]) == 1
        )

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

    async def test_a_room_that_went_live_is_dated_when_it_did(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Not when the pass noticed, up to a day later; and the window starts
        no earlier than reporting began, so a room used while telemetry was
        off is not reported, dated before the opt-in, once it is on."""
        went_live = datetime.now(UTC) - timedelta(hours=3)
        asked: list[datetime] = []

        async def rooms(
            factory: object, *, since: datetime, now: datetime
        ) -> list[snapshot_module.NewlyActiveRoom]:
            asked.append(since)
            return [
                snapshot_module.NewlyActiveRoom(
                    first_active_at=went_live,
                    seconds_since_room_created=60.0,
                    bridge_platform="none",
                    channel_type="none",
                    agent_count=1,
                    created_by_kind="agent",
                )
            ]

        monkeypatch.setattr("switch_core.telemetry.reporter.newly_active_rooms", rooms)
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)
        # Later than the install, a day ago.
        switched_on = datetime.now(UTC) - timedelta(hours=12)
        reporter._telemetry._enabled_since = switched_on

        await reporter.run_once(
            now=datetime.now(UTC), since=datetime.now(UTC) - timedelta(days=5)
        )

        assert asked == [switched_on]
        [record] = [r for r in sink.sent if r.name == "switch_core.room_became_active"]
        assert record.timestamp_ns == int(went_live.timestamp() * 1_000_000) * 1_000

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

    async def test_a_permanently_broken_tenant_still_advances_the_watermark(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The regression test for the defect a review found: `collect_usage`
        and `newly_active_rooms` used to let one tenant's exception escape the
        whole fan-out, and `_write_watermark` only runs after `run_once`
        returns — so a deterministically-failing tenant meant the watermark
        never advanced and no snapshot was ever sent again, for any tenant,
        for the life of the process. Contained per tenant, a snapshot still
        goes out and the schedule still moves, pass after pass, regardless."""
        await self._clear_watermark(session_factory)
        monkeypatch.setattr(
            snapshot_module, "tenant_session", _always_broken_tenant_session
        )
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        with caplog.at_level(logging.ERROR, logger="switch_core.telemetry.snapshot"):
            sent_first = await reporter.run_once_if_due()

        assert sent_first is True
        assert "switch_core.usage_snapshot" in [record.name for record in sink.sent]
        assert any(TENANT_ZERO_ID in record.message for record in caplog.records)

        # The watermark really did advance: called again immediately, the
        # schedule says not due rather than trying, and failing, again.
        assert await reporter.run_once_if_due() is False

        # And it keeps moving on a later pass, not only the first one.
        async with session_factory() as session:
            await session.execute(
                update(TelemetrySnapshotWatermark).values(
                    last_sent_at=datetime.now(UTC) - timedelta(days=2)
                )
            )
            await session.commit()

        assert await reporter.run_once_if_due() is True


class TestOneProcessSendsTheSnapshot:
    """Every switch-core process runs the snapshot loop. The watermark is
    claimed before anything is sent, so two processes due at the same moment
    send one snapshot between them."""

    def _reporter(
        self, sink: _RecordingSink, session_factory: async_sessionmaker[AsyncSession]
    ) -> SnapshotReporter:
        return TestTheSnapshotSchedule()._reporter(sink, session_factory)

    async def _sent(self, sink: _RecordingSink) -> int:
        return len([r for r in sink.sent if r.name == "switch_core.usage_snapshot"])

    @pytest.mark.parametrize("watermark_days_ago", [None, 2])
    async def test_two_processes_due_together_send_one_snapshot(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        watermark_days_ago: int | None,
    ) -> None:
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            if watermark_days_ago is not None:
                session.add(
                    TelemetrySnapshotWatermark(
                        id=1,
                        last_sent_at=datetime.now(UTC)
                        - timedelta(days=watermark_days_ago),
                    )
                )
            await session.commit()
        first_sink, second_sink = _RecordingSink(), _RecordingSink()
        first = self._reporter(first_sink, session_factory)
        second = self._reporter(second_sink, session_factory)

        # Both read the watermark as due before either claims it: the window
        # the claim exists to close.
        read_both = asyncio.Barrier(2)
        for reporter in (first, second):
            original = reporter._read_watermark

            async def read_then_wait(original=original) -> datetime | None:
                value = await original()
                await read_both.wait()
                return value

            reporter._read_watermark = read_then_wait  # type: ignore[method-assign]

        results = await asyncio.gather(
            first.run_once_if_due(), second.run_once_if_due()
        )

        assert sorted(results) == [False, True]
        assert await self._sent(first_sink) + await self._sent(second_sink) == 1

    async def test_a_pass_that_fails_before_sending_hands_the_claim_back(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Otherwise one failed count would skip the day for every process."""
        before = datetime.now(UTC) - timedelta(days=2)
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            session.add(TelemetrySnapshotWatermark(id=1, last_sent_at=before))
            await session.commit()

        async def broken(*args: object, **kwargs: object) -> object:
            raise RuntimeError("the count fell over")

        monkeypatch.setattr("switch_core.telemetry.reporter.collect_usage", broken)
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        with pytest.raises(RuntimeError, match="the count fell over"):
            await reporter.run_once_if_due()

        assert await reporter._read_watermark() == before
        monkeypatch.undo()
        assert await reporter.run_once_if_due() is True
        assert await self._sent(sink) == 1

    async def test_a_shutdown_after_the_snapshot_keeps_the_claim(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A cancellation is not an `Exception`, so it passes every guard in
        the pass. Once the snapshot is out it must not hand the claim back, or
        the next process to start sends the snapshot and every period again."""
        before = datetime.now(UTC) - timedelta(days=2)
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            session.add(TelemetrySnapshotWatermark(id=1, last_sent_at=before))
            await session.commit()

        async def cancelled(*args: object, **kwargs: object) -> object:
            raise asyncio.CancelledError

        monkeypatch.setattr(
            "switch_core.telemetry.reporter.collect_each_period_counts", cancelled
        )
        sink = _RecordingSink()
        reporter = self._reporter(sink, session_factory)

        with pytest.raises(asyncio.CancelledError):
            await reporter.run_once_if_due()

        assert await self._sent(sink) == 1
        watermark = await reporter._read_watermark()
        assert watermark is not None and watermark > before
        monkeypatch.undo()
        assert await reporter.run_once_if_due() is False
        assert await self._sent(sink) == 1

    async def test_a_first_pass_that_fails_leaves_no_watermark(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            await session.commit()

        async def broken(*args: object, **kwargs: object) -> object:
            raise RuntimeError("the count fell over")

        monkeypatch.setattr("switch_core.telemetry.reporter.collect_usage", broken)
        reporter = self._reporter(_RecordingSink(), session_factory)

        with pytest.raises(RuntimeError):
            await reporter.run_once_if_due()

        assert await reporter._read_watermark() is None

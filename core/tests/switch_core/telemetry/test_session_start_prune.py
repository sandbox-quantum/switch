"""Session start claims are kept only as long as they are useful.

They share `telemetry_milestones` with claims that must never go — a once-ever
milestone or a connector's first connect, which pruning would report again —
so the prune is held to its own rows by name and by age.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TelemetryMilestone, TelemetrySnapshotWatermark
from switch_core.telemetry import reporter as reporter_module
from switch_core.telemetry.session_start import CLAIM_TTL, prune_session_start_claims
from tests.switch_core.telemetry.test_deployment_and_reporter import (
    TestTheSnapshotSchedule,
    _RecordingSink,
)

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)
OLD = NOW - CLAIM_TTL - timedelta(hours=1)
RECENT = NOW - timedelta(days=1)


async def _claims(
    session_factory: async_sessionmaker[AsyncSession], rows: dict[str, datetime]
) -> None:
    async with session_factory() as session:
        await session.execute(delete(TelemetryMilestone))
        session.add_all(
            TelemetryMilestone(name=name, emitted_at=when)
            for name, when in rows.items()
        )
        await session.commit()


async def _left(session_factory: async_sessionmaker[AsyncSession]) -> set[str]:
    async with session_factory() as session:
        return set((await session.execute(select(TelemetryMilestone.name))).scalars())


async def test_it_removes_only_session_claims_past_their_use(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _claims(
        session_factory,
        {
            "session_started:agent-1:old": OLD,
            "session_started:agent-1:recent": RECENT,
            # Never pruned, however old: each would be reported again.
            "connector_added:bridge-1": OLD,
            "first_connector_added": OLD,
            "first_session_started": OLD,
        },
    )

    pruned = await prune_session_start_claims(session_factory, now=NOW)

    assert pruned == 1
    assert await _left(session_factory) == {
        "session_started:agent-1:recent",
        "connector_added:bridge-1",
        "first_connector_added",
        "first_session_started",
    }


async def test_the_prefix_is_matched_literally(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An underscore is a wildcard to LIKE. Matched unescaped, a name that
    merely resembles the prefix would be deleted with the claims."""
    await _claims(session_factory, {"sessionXstarted:agent-1:old": OLD})

    assert await prune_session_start_claims(session_factory, now=NOW) == 0
    assert await _left(session_factory) == {"sessionXstarted:agent-1:old"}


class TestItRunsWithTheDailySnapshot:
    async def test_a_snapshot_pass_prunes_old_claims(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            await session.commit()
        stale = datetime.now(UTC) - CLAIM_TTL - timedelta(hours=1)
        await _claims(session_factory, {"session_started:agent-1:old": stale})
        reporter = TestTheSnapshotSchedule()._reporter(
            _RecordingSink(), session_factory
        )

        assert await reporter.run_once_if_due() is True

        assert await _left(session_factory) == set()

    async def test_a_failed_prune_does_not_send_the_snapshot_again(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        async with session_factory() as session:
            await session.execute(delete(TelemetrySnapshotWatermark))
            await session.commit()

        async def broken(*args: object, **kwargs: object) -> int:
            raise RuntimeError("database went away")

        monkeypatch.setattr(reporter_module, "prune_session_start_claims", broken)
        sink = _RecordingSink()
        reporter = TestTheSnapshotSchedule()._reporter(sink, session_factory)

        assert await reporter.run_once_if_due() is True
        # The watermark was written before the prune failed, so the next
        # poll finds nothing due rather than sending the snapshot again.
        assert await reporter.run_once_if_due() is False

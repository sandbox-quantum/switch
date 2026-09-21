"""`milestone_claimed`: a tri-state read of a once-ever milestone.

Distinct from `claim_milestone` (`test_deployment_and_reporter.py`), which
takes the claim and is always safe to report `False` from: each of its
callers takes the claim itself, so losing a race or a lookup only means
reporting nothing rather than reporting wrongly.

`milestone_claimed` is read-only, for the one caller that needs to know a
thing once happened without claiming it — a connector's removal asking
whether it ever connected. A lookup that cannot run is not evidence either
way, so it reports `"unknown"` rather than collapsing into `"false"`, which
would misfile a lookup failure as "this connector never worked".
"""

from __future__ import annotations

from types import TracebackType

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.telemetry.deployment import claim_milestone, milestone_claimed


class _BrokenSession:
    """Fails on entry, the way a lost connection or a locked table would."""

    async def __aenter__(self) -> _BrokenSession:
        raise RuntimeError("database unreachable")

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        return False


def _broken_session_factory() -> _BrokenSession:
    return _BrokenSession()


class TestMilestoneClaimedIsTriState:
    async def test_an_unclaimed_milestone_reports_false(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        result = await milestone_claimed(session_factory, "first_room_created")

        assert result == "false"

    async def test_a_claimed_milestone_reports_true(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await claim_milestone(session_factory, "first_room_created")

        result = await milestone_claimed(session_factory, "first_room_created")

        assert result == "true"

    async def test_a_failed_lookup_reports_unknown_rather_than_false(self) -> None:
        """The defect this guards: a connector that worked for months, removed
        while the milestone table cannot be read, must not report as though it
        never connected — `connector_removed.was_ever_connected` would then
        say "failed setup" about a deployment for which the opposite is true."""
        result = await milestone_claimed(
            _broken_session_factory,  # type: ignore[arg-type]
            "connector_added:some-bridge",
        )

        assert result == "unknown"

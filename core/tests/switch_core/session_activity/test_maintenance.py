from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from switch_core.db.models import ApprovalRequest, SessionActivityEvent
from switch_core.session_activity.maintenance import maintain_once
from switch_core.session_activity.service import ApprovalOption

from .conftest import AGENT

SESSION = "session-demo"


async def _backdate(session_factory, model, **values) -> None:
    async with session_factory() as db, db.begin():
        await db.execute(update(model).values(**values))


async def test_a_pass_expires_overdue_requests_and_prunes_only_when_asked(
    service, session_factory
):
    await service.open_approval(
        AGENT,
        SESSION,
        request_id="req-1",
        question="Deploy?",
        options=[ApprovalOption("yes", "Yes", "accept")],
        room_id=None,
        thread_id=None,
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    await service.report_activity(
        AGENT,
        SESSION,
        seq=1,
        type="notice",
        summary="old news",
        detail={},
        turn_id=None,
        room_id=None,
        thread_id=None,
        occurred_at=datetime.now(UTC),
    )
    past = datetime.now(UTC) - timedelta(days=30)
    await _backdate(session_factory, ApprovalRequest, expires_at=past)
    await _backdate(session_factory, SessionActivityEvent, created_at=past)

    await maintain_once(session_factory, prune=False)
    [owed] = await service.undelivered_outcomes(AGENT)
    assert owed.state == "expired"
    assert len(await service.activity_since(AGENT, SESSION, 0, 10)) == 1

    await maintain_once(session_factory, prune=True)
    assert await service.activity_since(AGENT, SESSION, 0, 10) == []

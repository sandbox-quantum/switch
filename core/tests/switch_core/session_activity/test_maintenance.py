from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from switch_core.db.models import ApprovalRequest, SessionActivityItem
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
        turn_id="turn-1",
        kind="approval",
        title="Deploy?",
        detail=None,
        questions=[],
        options=[ApprovalOption("yes", "Yes", "accept")],
        room_id=None,
        thread_id=None,
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    await service.report_item(
        AGENT,
        SESSION,
        turn_id="turn-1",
        item_id="notice:1",
        kind="notice",
        revision=0,
        status="info",
        title="Notice",
        text="old news",
        command_id=None,
        room_id=None,
        thread_id=None,
        message_id=None,
        occurred_at=datetime.now(UTC),
        usage=[],
    )
    past = datetime.now(UTC) - timedelta(days=30)
    await _backdate(session_factory, ApprovalRequest, expires_at=past)
    await _backdate(session_factory, SessionActivityItem, updated_at=past)

    await maintain_once(session_factory, prune=False)
    [owed] = await service.undelivered_outcomes(AGENT)
    assert owed.state == "expired"
    assert len(await service.turn_items(AGENT, SESSION, "turn-1")) == 1

    await maintain_once(session_factory, prune=True)
    assert await service.turn_items(AGENT, SESSION, "turn-1") == []

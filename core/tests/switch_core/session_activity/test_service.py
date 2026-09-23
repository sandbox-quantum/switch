from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from switch_core.addressing import owner_only_policy
from switch_core.db.models import ApprovalRequest
from switch_core.session_activity.service import (
    ApprovalOption,
    PlatformPerson,
    SwitchUser,
)
from switch_core.sessions.service import SessionError

from .conftest import AGENT, make_agent, make_person, make_room

SESSION = "session-demo"
OPTIONS = [ApprovalOption("allow", "Allow"), ApprovalOption("deny", "Deny")]


def _activity(**overrides):
    values = dict(
        seq=1,
        type="tool.called",
        summary="Ran `pytest`",
        detail={"tool": "bash"},
        turn_id="turn-1",
        room_id=None,
        occurred_at=datetime(2026, 9, 23, 12, 0, tzinfo=UTC),
    )
    values.update(overrides)
    return values


async def _open(service, request_id="req-1", **overrides):
    values = dict(
        request_id=request_id,
        question="Run `rm -rf build`?",
        options=OPTIONS,
        room_id=None,
        thread_id=None,
        expires_at=None,
    )
    values.update(overrides)
    return await service.open_approval(AGENT, SESSION, **values)


# ── Activity ─────────────────────────────────────────────────────────────────


async def test_activity_is_recorded_once_and_announced(service, changes):
    assert await service.report_activity(AGENT, SESSION, **_activity()) is True
    assert await service.report_activity(AGENT, SESSION, **_activity()) is False

    [line] = await service.activity_since(AGENT, SESSION, after_seq=0, limit=10)
    assert (line.type, line.summary, line.detail) == (
        "tool.called",
        "Ran `pytest`",
        {"tool": "bash"},
    )
    [change] = await changes.expect([("activity", "1")])
    assert change.row["summary"] == "Ran `pytest`"


async def test_a_reused_seq_with_different_content_is_refused(service):
    await service.report_activity(AGENT, SESSION, **_activity())
    with pytest.raises(SessionError) as error:
        await service.report_activity(AGENT, SESSION, **_activity(summary="other"))
    assert error.value.code == "ACTIVITY_CONFLICT"


async def test_activity_is_read_back_in_seq_order_after_a_cursor(service):
    for seq in (3, 1, 2):
        await service.report_activity(
            AGENT, SESSION, **_activity(seq=seq, summary=f"step {seq}")
        )
    lines = await service.activity_since(AGENT, SESSION, after_seq=1, limit=10)
    assert [line.seq for line in lines] == [2, 3]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"type": "tool.exploded"}, "Unknown activity type"),
        ({"summary": "  "}, "needs a summary"),
        ({"summary": "x" * 2001}, "longer than"),
    ],
)
async def test_malformed_activity_is_refused(service, overrides, message):
    with pytest.raises(SessionError, match=message) as error:
        await service.report_activity(AGENT, SESSION, **_activity(**overrides))
    assert error.value.code == "INVALID_EVENT"


async def test_activity_for_a_room_the_agent_is_not_in_is_refused(
    service, session_factory
):
    async with session_factory() as db, db.begin():
        joined = await make_room(db, member=AGENT)
        foreign = await make_room(db, member=None)

    assert await service.report_activity(AGENT, SESSION, **_activity(room_id=joined))
    with pytest.raises(SessionError) as error:
        await service.report_activity(
            AGENT, SESSION, **_activity(seq=2, room_id=foreign)
        )
    assert error.value.code == "NOT_AUTHORIZED"


async def test_old_activity_is_pruned(service, session_factory):
    await service.report_activity(AGENT, SESSION, **_activity())
    assert await service.prune_activity(timedelta(days=1)) == 0
    assert await service.prune_activity(timedelta(seconds=-1)) == 1
    assert await service.activity_since(AGENT, SESSION, 0, 10) == []


# ── Approval requests ────────────────────────────────────────────────────────


async def test_opening_is_idempotent_and_announced_once(service, changes):
    first = await _open(service)
    again = await _open(service)
    assert (first.state, again.state) == ("open", "open")
    assert again.options == [
        {"id": "allow", "label": "Allow"},
        {"id": "deny", "label": "Deny"},
    ]
    await changes.expect([("approval.open", "req-1")])


async def test_reopening_with_different_content_is_refused(service):
    await _open(service)
    with pytest.raises(SessionError) as error:
        await _open(service, question="Something else?")
    assert error.value.code == "REQUEST_CONFLICT"


@pytest.mark.parametrize(
    "overrides",
    [
        {"question": " "},
        {"options": []},
        {"options": [ApprovalOption("a", "A"), ApprovalOption("a", "B")]},
        {"options": [ApprovalOption("a", "")]},
        {"expires_at": datetime.now(UTC) - timedelta(seconds=1)},
        {"expires_at": datetime.now(UTC) + timedelta(hours=25)},
    ],
)
async def test_malformed_requests_are_refused(service, overrides):
    with pytest.raises(SessionError) as error:
        await _open(service, **overrides)
    assert error.value.code == "INVALID_EVENT"


async def test_an_answer_is_recorded_and_owed_to_the_agent(service, changes, people):
    await _open(service)
    answered = await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    assert (answered.state, answered.answer, answered.answered_by) == (
        "answered",
        "allow",
        people.owner,
    )
    assert answered.answered_at is not None
    _, answered_change = await changes.expect(
        [("approval.open", "req-1"), ("approval.answered", "req-1")]
    )
    assert answered_change.row["answer"] == "allow"
    [owed] = await service.undelivered_outcomes(AGENT)
    assert owed.request_id == "req-1"


async def test_the_same_answer_twice_is_a_no_op(service, changes, people):
    await _open(service)
    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    await changes.expect([("approval.open", "req-1"), ("approval.answered", "req-1")])


async def test_a_second_answer_is_refused(service, people):
    await _open(service)
    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer="deny",
            answerer=PlatformPerson(people.owner),
        )
    assert error.value.code == "REQUEST_CLOSED"


async def test_an_answer_that_is_not_an_option_is_refused(service, people):
    await _open(service)
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer="maybe",
            answerer=PlatformPerson(people.owner),
        )
    assert error.value.code == "INVALID_ANSWER"


async def test_answering_an_unknown_request_is_not_found(service, people):
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "nope",
            answer="allow",
            answerer=PlatformPerson(people.owner),
        )
    assert error.value.code == "NOT_FOUND"


async def _backdate(session_factory, request_id: str) -> None:
    async with session_factory() as db, db.begin():
        await db.execute(
            update(ApprovalRequest)
            .where(ApprovalRequest.request_id == request_id)
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )


async def test_a_late_answer_is_refused_and_the_expiry_is_kept(
    service, session_factory, changes, people
):
    await _open(service, expires_at=datetime.now(UTC) + timedelta(minutes=5))
    await _backdate(session_factory, "req-1")

    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer="allow",
            answerer=PlatformPerson(people.owner),
        )
    assert error.value.code == "REQUEST_CLOSED"

    [owed] = await service.undelivered_outcomes(AGENT)
    assert owed.state == "expired"
    await changes.expect([("approval.open", "req-1"), ("approval.expired", "req-1")])


async def test_overdue_requests_expire_on_the_timer(service, session_factory, changes):
    await _open(service, "due", expires_at=datetime.now(UTC) + timedelta(minutes=5))
    await _open(service, "not-due", expires_at=datetime.now(UTC) + timedelta(minutes=5))
    await _open(service, "no-deadline")
    await _backdate(session_factory, "due")

    expired = await service.expire_due()
    assert [row.request_id for row in expired] == ["due"]
    await changes.expect(
        [
            ("approval.open", "due"),
            ("approval.open", "not-due"),
            ("approval.open", "no-deadline"),
            ("approval.expired", "due"),
        ]
    )
    assert await service.expire_due() == []


async def test_closing_an_open_request_and_a_settled_one(service, changes, people):
    await _open(service, "open-one")
    await _open(service, "answered-one")
    await service.answer_approval(
        AGENT,
        SESSION,
        "answered-one",
        answer="deny",
        answerer=PlatformPerson(people.owner),
    )

    assert (await service.close_approval(AGENT, SESSION, "open-one")).state == "closed"
    assert (
        await service.close_approval(AGENT, SESSION, "answered-one")
    ).state == "answered"
    await changes.expect(
        [
            ("approval.open", "open-one"),
            ("approval.open", "answered-one"),
            ("approval.answered", "answered-one"),
            ("approval.closed", "open-one"),
        ]
    )


async def test_delivery_is_marked_once_and_only_for_an_outcome(service, people):
    await _open(service)
    with pytest.raises(SessionError) as error:
        await service.mark_delivered(AGENT, SESSION, "req-1")
    assert error.value.code == "REQUEST_OPEN"

    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    first = await service.mark_delivered(AGENT, SESSION, "req-1")
    again = await service.mark_delivered(AGENT, SESSION, "req-1")
    assert first.delivered_at is not None
    assert again.delivered_at == first.delivered_at
    assert await service.undelivered_outcomes(AGENT) == []


async def test_nothing_is_announced_when_the_transaction_rolls_back(
    service, session_factory, changes
):
    async with session_factory() as db, db.begin():
        room = await make_room(db, member=None)
    with pytest.raises(SessionError):
        await _open(service, room_id=room)
    await changes.expect([])


# ── Who may answer ───────────────────────────────────────────────────────────


async def test_outside_a_room_only_the_owner_may_answer(service, people):
    await _open(service)
    for sender in (people.stranger, "@nobody:example.test"):
        with pytest.raises(SessionError) as error:
            await service.answer_approval(
                AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(sender)
            )
        assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    assert answered.state == "answered"


async def test_in_a_room_an_open_policy_lets_anyone_answer(
    service, session_factory, people
):
    async with session_factory() as db, db.begin():
        room = await make_room(db, member=AGENT)
    await _open(service, room_id=room)
    answered = await service.answer_approval(
        AGENT, SESSION, "req-1", answer="deny", answerer=PlatformPerson(people.stranger)
    )
    assert answered.answered_by == people.stranger


async def test_in_a_room_the_agents_policy_decides(service, session_factory):
    async with session_factory() as db, db.begin():
        owner_id = await make_agent(db, "guarded", policy=owner_only_policy([]))
        owner = await make_person(db, claimed_by=owner_id)
        stranger = await make_person(db, claimed_by=None)
        room = await make_room(db, member="guarded")
    await service.open_approval(
        "guarded",
        SESSION,
        request_id="req-1",
        question="Deploy?",
        options=OPTIONS,
        room_id=room,
        thread_id=None,
        expires_at=None,
    )
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            "guarded",
            SESSION,
            "req-1",
            answer="allow",
            answerer=PlatformPerson(stranger),
        )
    assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        "guarded", SESSION, "req-1", answer="allow", answerer=PlatformPerson(owner)
    )
    assert answered.state == "answered"


async def test_a_refused_answerer_leaves_the_request_open(service, people, changes):
    await _open(service)
    with pytest.raises(SessionError):
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer="allow",
            answerer=PlatformPerson(people.stranger),
        )
    await changes.expect([("approval.open", "req-1")])
    assert await service.undelivered_outcomes(AGENT) == []


async def test_a_row_too_large_to_announce_is_announced_by_key(service, changes):
    await _open(service, question="é" * 4000)
    [change] = await changes.expect([("approval.changed", "req-1")])
    assert change.row is None
    assert (change.agent_id, change.session_id) == (AGENT, SESSION)


async def test_a_signed_in_owner_may_answer_outside_a_room(service, session_factory):
    async with session_factory() as db, db.begin():
        owner_id = await make_agent(db, "console-agent")
    await service.open_approval(
        "console-agent",
        SESSION,
        request_id="req-1",
        question="Deploy?",
        options=OPTIONS,
        room_id=None,
        thread_id=None,
        expires_at=None,
    )
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            "console-agent",
            SESSION,
            "req-1",
            answer="allow",
            answerer=SwitchUser("someone-else"),
        )
    assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        "console-agent", SESSION, "req-1", answer="allow", answerer=SwitchUser(owner_id)
    )
    assert answered.answered_by == f"user:{owner_id}"


async def test_a_signed_in_user_is_judged_by_the_rooms_policy(service, session_factory):
    async with session_factory() as db, db.begin():
        owner_id = await make_agent(db, "guarded", policy=owner_only_policy([]))
        room = await make_room(db, member="guarded")
    await service.open_approval(
        "guarded",
        SESSION,
        request_id="req-1",
        question="Deploy?",
        options=OPTIONS,
        room_id=room,
        thread_id=None,
        expires_at=None,
    )
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            "guarded", SESSION, "req-1", answer="deny", answerer=SwitchUser("stranger")
        )
    assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        "guarded", SESSION, "req-1", answer="deny", answerer=SwitchUser(owner_id)
    )
    assert answered.state == "answered"

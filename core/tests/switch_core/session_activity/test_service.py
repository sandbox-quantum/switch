from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from switch_core.addressing import owner_only_policy
from switch_core.db.models import ApprovalRequest, TenantUsage
from switch_core.session_activity.service import (
    ApprovalOption,
    PlatformPerson,
    Question,
    QuestionOption,
    SwitchUser,
    TokenSpend,
)
from switch_core.sessions.contract import Answer, QuestionsResult
from switch_core.sessions.errors import SessionError

from .conftest import AGENT, make_agent, make_person, make_room, pick

SESSION = "session-demo"
OPTIONS = [
    ApprovalOption("allow", "Allow", "accept"),
    ApprovalOption("deny", "Deny", "decline"),
]
QUESTIONS = [
    Question(
        id="q-env",
        title="Environment",
        prompt="Where should it go?",
        options=[
            QuestionOption("staging", "Staging", None),
            QuestionOption("prod", "Production", "Live traffic"),
        ],
        multi_select=False,
        allow_custom_answer=True,
    ),
    Question(
        id="q-checks",
        title="Checks",
        prompt="Which checks first?",
        options=[
            QuestionOption("lint", "Lint", None),
            QuestionOption("tests", "Tests", None),
        ],
        multi_select=True,
        allow_custom_answer=False,
    ),
]


def _step(**overrides):
    values = dict(
        turn_id="turn-1",
        item_id="tool-1",
        kind="tool-activity",
        revision=1,
        status="in-progress",
        title="Ran `pytest`",
        text="12 passed",
        command_id=None,
        room_id=None,
        thread_id=None,
        message_id=None,
        occurred_at=datetime(2026, 9, 23, 12, 0, tzinfo=UTC),
        usage=[],
    )
    values.update(overrides)
    return values


async def _open(service, request_id="req-1", **overrides):
    values = dict(
        request_id=request_id,
        turn_id="turn-1",
        kind="approval",
        title="Run `rm -rf build`?",
        detail=None,
        options=OPTIONS,
        questions=[],
        room_id=None,
        thread_id=None,
        expires_at=None,
    )
    values.update(overrides)
    return await service.open_approval(AGENT, SESSION, **values)


def _answers(*entries: tuple[str, list[str], str | None]) -> QuestionsResult:
    return QuestionsResult(
        kind="questions",
        answers=[
            Answer(question_id=q, selected_option_ids=picked, custom_text=custom)
            for q, picked, custom in entries
        ],
    )


# ── Turn steps ───────────────────────────────────────────────────────────────


async def test_a_step_is_upserted_by_revision_and_announced_by_turn(service, changes):
    assert await service.report_item(AGENT, SESSION, **_step()) is True
    assert await service.report_item(AGENT, SESSION, **_step()) is False
    assert (
        await service.report_item(
            AGENT, SESSION, **_step(revision=2, status="completed", text="done")
        )
        is True
    )
    assert (
        await service.report_item(AGENT, SESSION, **_step(revision=1, text="stale"))
        is False
    )
    [step] = await service.turn_items(AGENT, SESSION, "turn-1")
    assert (step.revision, step.status, step.text) == (2, "completed", "done")
    announced = await changes.expect([("activity", "turn-1"), ("activity", "turn-1")])
    assert all(change.row is None for change in announced)


def _turn(turn_id: str, revision: int, status: str, usage=()):
    return _step(
        turn_id=turn_id,
        item_id="turn",
        kind="turn",
        revision=revision,
        status=status,
        title="",
        text="",
        usage=list(usage),
    )


async def _turns_counted(session_factory) -> int:
    async with session_factory() as db:
        rows = await db.scalars(
            select(TenantUsage.amount).where(TenantUsage.metric == "turns")
        )
        return sum(rows)


async def test_a_turn_is_counted_once_when_first_reported(service, session_factory):
    # A turn is spent once it exists: its later statuses, a retried report and
    # its steps are the same turn, and one that errors still cost model time.
    await service.report_item(AGENT, SESSION, **_turn("turn-1", 1, "running"))
    await service.report_item(AGENT, SESSION, **_turn("turn-1", 1, "running"))
    await service.report_item(AGENT, SESSION, **_step(revision=2))
    await service.report_item(AGENT, SESSION, **_turn("turn-1", 3, "error"))
    assert await _turns_counted(session_factory) == 1

    await service.report_item(AGENT, SESSION, **_turn("turn-2", 4, "completed"))
    assert await _turns_counted(session_factory) == 2


def _spend(model: str, input_tokens: int) -> TokenSpend:
    return TokenSpend(
        model=model,
        input_tokens=input_tokens,
        output_tokens=1,
        cache_read_tokens=0,
        cache_write_tokens=0,
    )


async def _tokens_counted(session_factory) -> list[tuple[str, str, int]]:
    async with session_factory() as db:
        rows = await db.execute(
            select(TenantUsage.metric, TenantUsage.model, TenantUsage.amount).where(
                TenantUsage.metric != "turns"
            )
        )
        return sorted(tuple(row) for row in rows)


async def test_a_turns_tokens_are_counted_once_when_it_first_ends(
    service, session_factory
):
    spent = [_spend("small", 7), _spend("big", 10)]
    await service.report_item(AGENT, SESSION, **_turn("turn-1", 1, "running"))
    await service.report_item(AGENT, SESSION, **_turn("turn-1", 2, "completed", spent))
    # A retried report, and a later revision of an ended turn, spend nothing new.
    await service.report_item(AGENT, SESSION, **_turn("turn-1", 2, "completed", spent))
    await service.report_item(
        AGENT, SESSION, **_turn("turn-1", 3, "interrupted", spent)
    )
    assert await _tokens_counted(session_factory) == [
        ("input_tokens", "big", 10),
        ("input_tokens", "small", 7),
        ("output_tokens", "big", 1),
        ("output_tokens", "small", 1),
    ]


async def test_usage_on_a_turn_that_has_not_ended_is_refused(service):
    with pytest.raises(SessionError, match="ended turn"):
        await service.report_item(
            AGENT, SESSION, **_turn("turn-1", 1, "running", [_spend("big", 1)])
        )


async def test_a_turns_steps_are_read_in_the_order_first_reported(service):
    for item_id, kind, status in [
        ("turn", "turn", "running"),
        ("m-1", "assistant-message", "completed"),
        ("tool-1", "tool-activity", "in-progress"),
    ]:
        await service.report_item(
            AGENT, SESSION, **_step(item_id=item_id, kind=kind, status=status)
        )
    await service.report_item(
        AGENT,
        SESSION,
        **_step(
            item_id="m-1", kind="assistant-message", status="completed", revision=5
        ),
    )
    steps = await service.turn_items(AGENT, SESSION, "turn-1")
    assert [step.item_id for step in steps] == ["turn", "m-1", "tool-1"]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"kind": "tool.exploded"}, "Unknown activity kind"),
        ({"status": "running"}, "not a status"),
        ({"item_id": "turn"}, "Only the turn's own row"),
        ({"kind": "turn", "status": "running"}, "Only the turn's own row"),
        ({"kind": "notice", "status": "info"}, "starts with"),
        ({"command_id": "c-1"}, "carries a command id"),
        ({"title": "x" * 501}, "at most"),
    ],
)
async def test_malformed_steps_are_refused(service, overrides, message):
    with pytest.raises(SessionError, match=message) as error:
        await service.report_item(AGENT, SESSION, **_step(**overrides))
    assert error.value.code == "INVALID_EVENT"


async def test_a_step_for_a_room_the_agent_is_not_in_is_refused(
    service, session_factory
):
    async with session_factory() as db, db.begin():
        joined = await make_room(db, member=AGENT)
        foreign = await make_room(db, member=None)

    assert await service.report_item(AGENT, SESSION, **_step(room_id=joined))
    with pytest.raises(SessionError) as error:
        await service.report_item(
            AGENT, SESSION, **_step(item_id="tool-2", room_id=foreign)
        )
    assert error.value.code == "NOT_AUTHORIZED"


async def test_old_steps_are_pruned(service):
    await service.report_item(AGENT, SESSION, **_step())
    assert await service.prune_activity(timedelta(days=1)) == 0
    assert await service.prune_activity(timedelta(seconds=-1)) == 1
    assert await service.turn_items(AGENT, SESSION, "turn-1") == []


# ── Approval requests ────────────────────────────────────────────────────────


async def test_opening_is_idempotent_and_announced_once(service, changes):
    first = await _open(service)
    again = await _open(service)
    assert (first.state, again.state) == ("open", "open")
    assert again.options == [
        {"id": "allow", "label": "Allow", "decision": "accept"},
        {"id": "deny", "label": "Deny", "decision": "decline"},
    ]
    await changes.expect([("approval.open", "req-1")])


async def test_reopening_with_different_content_is_refused(service):
    await _open(service)
    with pytest.raises(SessionError) as error:
        await _open(service, title="Something else?")
    assert error.value.code == "REQUEST_CONFLICT"


@pytest.mark.parametrize(
    "overrides",
    [
        {"title": " "},
        {"options": []},
        {
            "options": [
                ApprovalOption("a", "A", "accept"),
                ApprovalOption("a", "B", "decline"),
            ]
        },
        {"options": [ApprovalOption("a", "", "accept")]},
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
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
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
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
    )
    await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
    )
    await changes.expect([("approval.open", "req-1"), ("approval.answered", "req-1")])


async def test_a_second_answer_is_refused(service, people):
    await _open(service)
    await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
    )
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer=pick("deny"),
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
            answer=pick("maybe"),
            answerer=PlatformPerson(people.owner),
        )
    assert error.value.code == "INVALID_ANSWER"


async def test_answering_an_unknown_request_is_not_found(service, people):
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "nope",
            answer=pick("allow"),
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
            answer=pick("allow"),
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
        answer=pick("deny"),
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
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
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
                AGENT,
                SESSION,
                "req-1",
                answer=pick("allow"),
                answerer=PlatformPerson(sender),
            )
        assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
    )
    assert answered.state == "answered"


async def test_in_a_room_an_open_policy_lets_anyone_answer(
    service, session_factory, people
):
    async with session_factory() as db, db.begin():
        room = await make_room(db, member=AGENT)
    await _open(service, room_id=room)
    answered = await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=pick("deny"),
        answerer=PlatformPerson(people.stranger),
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
        turn_id="turn-1",
        kind="approval",
        title="Deploy?",
        detail=None,
        questions=[],
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
            answer=pick("allow"),
            answerer=PlatformPerson(stranger),
        )
    assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        "guarded",
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(owner),
    )
    assert answered.state == "answered"


async def test_a_refused_answerer_leaves_the_request_open(service, people, changes):
    await _open(service)
    with pytest.raises(SessionError):
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer=pick("allow"),
            answerer=PlatformPerson(people.stranger),
        )
    await changes.expect([("approval.open", "req-1")])
    assert await service.undelivered_outcomes(AGENT) == []


async def test_a_row_too_large_to_announce_is_announced_by_key(service, changes):
    await _open(service, detail="é" * 3990)
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
        turn_id="turn-1",
        kind="approval",
        title="Deploy?",
        detail=None,
        questions=[],
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
            answer=pick("allow"),
            answerer=SwitchUser("someone-else"),
        )
    assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        "console-agent",
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=SwitchUser(owner_id),
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
        turn_id="turn-1",
        kind="approval",
        title="Deploy?",
        detail=None,
        questions=[],
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
            answer=pick("deny"),
            answerer=SwitchUser("stranger"),
        )
    assert error.value.code == "NOT_AUTHORIZED"
    answered = await service.answer_approval(
        "guarded", SESSION, "req-1", answer=pick("deny"), answerer=SwitchUser(owner_id)
    )
    assert answered.state == "answered"


# ── Questions ────────────────────────────────────────────────────────────────


async def test_a_questions_request_is_answered_per_question(service, people, changes):
    opened = await _open(service, kind="questions", options=[], questions=QUESTIONS)
    assert opened.questions[0]["options"][1] == {
        "id": "prod",
        "label": "Production",
        "description": "Live traffic",
    }
    answered = await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=_answers(
            ("q-checks", ["tests", "lint"], None), ("q-env", [], "  canary  ")
        ),
        answerer=PlatformPerson(people.owner),
    )
    assert answered.answer is None
    assert answered.answers == [
        {"question_id": "q-env", "selected_option_ids": [], "custom_text": "canary"},
        {
            "question_id": "q-checks",
            "selected_option_ids": ["lint", "tests"],
            "custom_text": None,
        },
    ]
    _, change = await changes.expect(
        [("approval.open", "req-1"), ("approval.answered", "req-1")]
    )
    assert change.row["answers"] == answered.answers


@pytest.mark.parametrize(
    "answer",
    [
        pick("staging"),
        _answers(("q-env", ["staging"], None)),
        _answers(("q-env", ["staging", "prod"], None), ("q-checks", ["lint"], None)),
        _answers(("q-env", ["staging"], None), ("q-checks", [], "anything")),
        _answers(("q-env", ["nope"], None), ("q-checks", ["lint"], None)),
        _answers(("q-env", [], None), ("q-checks", ["lint"], None)),
        _answers(
            ("q-env", ["staging"], None),
            ("q-env", ["prod"], None),
            ("q-checks", ["lint"], None),
        ),
    ],
)
async def test_an_answer_that_does_not_fit_the_questions_is_refused(
    service, people, answer
):
    await _open(service, kind="questions", options=[], questions=QUESTIONS)
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer=answer,
            answerer=PlatformPerson(people.owner),
        )
    assert error.value.code == "INVALID_ANSWER"


async def test_an_approval_answered_as_questions_is_refused(service, people):
    await _open(service)
    with pytest.raises(SessionError) as error:
        await service.answer_approval(
            AGENT,
            SESSION,
            "req-1",
            answer=_answers(("q-env", ["staging"], None)),
            answerer=PlatformPerson(people.owner),
        )
    assert error.value.code == "INVALID_ANSWER"


@pytest.mark.parametrize(
    "overrides",
    [
        {"kind": "questions", "options": [], "questions": []},
        {"kind": "questions", "options": OPTIONS, "questions": QUESTIONS},
        {"kind": "approval", "options": OPTIONS, "questions": QUESTIONS},
        {"kind": "survey"},
    ],
)
async def test_a_request_of_the_wrong_shape_for_its_kind_is_refused(service, overrides):
    with pytest.raises(SessionError) as error:
        await _open(service, **overrides)
    assert error.value.code == "INVALID_EVENT"


async def test_long_question_text_is_cut_rather_than_refused(service):
    long = Question(
        id="q-long",
        title="t" * 900,
        prompt="p" * 9000,
        options=[QuestionOption("o", "l" * 900, "d" * 5000)],
        multi_select=False,
        allow_custom_answer=False,
    )
    row = await _open(service, kind="questions", options=[], questions=[long])
    [stored] = row.questions
    assert len(stored["title"]) == 500 and stored["title"].endswith("…")
    assert len(stored["prompt"]) == 4000
    assert len(stored["options"][0]["label"]) == 500
    assert len(stored["options"][0]["description"]) == 1000


# ── Room controls ────────────────────────────────────────────────────────────


async def test_a_room_control_takes_the_agents_addressing_policy(
    service, session_factory
):
    async with session_factory() as db, db.begin():
        owner_id = await make_agent(db, "guarded", policy=owner_only_policy([]))
        owner = await make_person(db, claimed_by=owner_id)
        stranger = await make_person(db, claimed_by=None)
        room = await make_room(db, member="guarded")
    await service.authorize_room_control(
        "guarded", room, PlatformPerson(owner), doing="stop it"
    )
    with pytest.raises(SessionError, match="may not stop it") as error:
        await service.authorize_room_control(
            "guarded", room, PlatformPerson(stranger), doing="stop it"
        )
    assert error.value.code == "NOT_AUTHORIZED"

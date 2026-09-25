from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.collaboration.adapter import RequestCard, TurnActivity
from switch_core.db.models import (
    ApprovalRequestPost,
    BridgeMessageMap,
    TurnStatusPost,
)
from switch_core.session_activity.bridge_publisher import (
    SessionActivityBridgePublisher,
)
from switch_core.session_activity.listener import SessionActivityListener
from switch_core.session_activity.service import (
    ApprovalOption,
    PlatformPerson,
    Question,
    QuestionOption,
)
from switch_core.sessions.contract import Answer, QuestionsResult
from switch_core.tenant_context import current_tenant_id

from .bridge_fixtures import BridgedRoom, RecordingPlatform, make_bridged_room
from .conftest import AGENT, make_room, pick

SESSION = "session-demo"
OPTIONS = [
    ApprovalOption("allow", "Allow", "accept"),
    ApprovalOption("deny", "Deny", "decline"),
]
ASKED = "sw_asked"
ASKED_POST = "1700000000.0001"


class Online:
    def __init__(self) -> None:
        self.value = True

    def __call__(self, _agent_id: str) -> bool:
        return self.value


@pytest.fixture
async def bridged(session_factory, people) -> BridgedRoom:
    async with session_factory() as db, db.begin():
        bridged = await make_bridged_room(db, member=AGENT)
        db.add(
            BridgeMessageMap(
                bridge_id=bridged.bridge_id,
                external_channel_id=bridged.channel_id,
                transport_event_id=ASKED,
                external_post_id=ASKED_POST,
            )
        )
    return bridged


@pytest.fixture
async def listener(postgres_url) -> AsyncIterator[SessionActivityListener]:
    listener = SessionActivityListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )
    await listener.start()
    await asyncio.wait_for(listener.connected.wait(), 5)
    try:
        yield listener
    finally:
        await listener.stop()


@pytest.fixture
def platform() -> RecordingPlatform:
    return RecordingPlatform()


@pytest.fixture
def online() -> Online:
    return Online()


def _publisher(session_factory, bridged, listener, platform, online):
    tenant = current_tenant_id()
    assert tenant is not None
    return SessionActivityBridgePublisher(
        adapter=platform,  # type: ignore[arg-type]
        bridge_id=bridged.bridge_id,
        bridge_type="slack",
        tenant_id=tenant,
        listener=listener,
        session_factory=session_factory,
        agent_online=online,
        gateway_public_url="https://switch.example",
    )


@pytest.fixture
async def publisher(
    session_factory, bridged, listener, platform, online
) -> AsyncIterator[SessionActivityBridgePublisher]:
    publisher = _publisher(session_factory, bridged, listener, platform, online)
    publisher.start()
    try:
        yield publisher
    finally:
        await publisher.stop()


async def _open(service, room_id, request_id="req-1", thread_id=None, **overrides):
    values = dict(
        request_id=request_id,
        turn_id="turn-1",
        kind="approval",
        title="Run `rm -rf build`?",
        detail="In the repository root.",
        options=OPTIONS,
        questions=[],
        room_id=room_id,
        thread_id=thread_id,
        expires_at=None,
    )
    values.update(overrides)
    return await service.open_approval(AGENT, SESSION, **values)


async def _card_post(session_factory, request_id="req-1") -> ApprovalRequestPost:
    async with session_factory() as db:
        return (
            await db.execute(
                select(ApprovalRequestPost).where(
                    ApprovalRequestPost.request_id == request_id
                )
            )
        ).scalar_one()


async def _turn_post(session_factory, turn_id="turn-1") -> TurnStatusPost:
    async with session_factory() as db:
        return (
            await db.execute(
                select(TurnStatusPost).where(TurnStatusPost.turn_id == turn_id)
            )
        ).scalar_one()


async def _step(
    service,
    room_id,
    *,
    item_id,
    kind,
    status,
    revision,
    turn_id="turn-1",
    title="",
    text="",
):
    await service.report_item(
        AGENT,
        SESSION,
        turn_id=turn_id,
        item_id=item_id,
        kind=kind,
        revision=revision,
        status=status,
        title=title,
        text=text,
        command_id="command-1" if kind == "turn" else None,
        room_id=room_id,
        thread_id=ASKED,
        message_id=ASKED,
        occurred_at=datetime.now(UTC),
        usage=[],
    )


async def _turn(service, room_id, status, revision, turn_id="turn-1"):
    await _step(
        service,
        room_id,
        item_id="turn",
        kind="turn",
        status=status,
        revision=revision,
        turn_id=turn_id,
    )


def _turns(platform: RecordingPlatform) -> list:
    return [
        drawn
        for drawn in platform.drawn
        if isinstance(drawn.content, TurnActivity) and not drawn.content.status_only
    ]


# ── Request cards ────────────────────────────────────────────────────────────


async def test_an_open_request_is_posted_and_redrawn_once_answered(
    service, publisher, platform, bridged, people, session_factory
):
    await _open(service, bridged.room_id)
    [posted] = await platform.wait_for(1)
    assert posted.call == "post_rich"
    assert posted.channel_id == bridged.channel_id
    request = posted.content.request
    assert request.state == "open"
    assert request.content.detail == "In the repository root."
    assert posted.content.reference.handle == "A1"
    assert [o.decision for o in request.content.options] == ["accept", "decline"]
    post = await _card_post(session_factory)
    assert post.external_post_id == posted.ref
    assert post.token == posted.content.reference.token

    await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
    )
    _, redrawn = await platform.wait_for(2)
    assert redrawn.call == "update_rich"
    assert redrawn.ref == posted.ref
    request = redrawn.content.request
    assert request.state == "resolved"
    assert request.result.result.option_id == "allow"
    assert request.decided_by.surface == "slack"


async def test_a_questions_card_is_drawn_and_shows_its_answers(
    service, publisher, platform, bridged, people
):
    await _open(
        service,
        bridged.room_id,
        kind="questions",
        detail=None,
        options=[],
        questions=[
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
            )
        ],
    )
    [posted] = await platform.wait_for(1)
    content = posted.content.request.content
    assert content.kind == "questions"
    assert [o.option_id for o in content.questions[0].options] == ["staging", "prod"]

    await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=QuestionsResult(
            kind="questions",
            answers=[
                Answer(
                    question_id="q-env", selected_option_ids=[], custom_text="canary"
                )
            ],
        ),
        answerer=PlatformPerson(people.owner),
    )
    _, redrawn = await platform.wait_for(2)
    result = redrawn.content.request.result.result
    assert result.kind == "questions"
    assert result.answers[0].custom_text == "canary"


async def test_a_request_outside_the_bridge_is_not_posted(
    service, publisher, platform, session_factory
):
    async with session_factory() as db, db.begin():
        elsewhere = await make_room(db, member=AGENT)
    await _open(service, elsewhere)
    await _open(service, None, request_id="req-2")
    await asyncio.sleep(0.5)
    assert platform.drawn == []


async def test_a_card_goes_into_the_thread_it_answers(
    service, publisher, platform, bridged, session_factory
):
    await _open(service, bridged.room_id, thread_id=ASKED)
    [posted] = await platform.wait_for(1)
    assert posted.thread_ref == ASKED_POST
    assert (await _card_post(session_factory)).thread_ref == ASKED_POST


async def test_a_refused_post_releases_its_handle(
    service, publisher, platform, bridged, session_factory
):
    platform.refuse_posts = True
    await _open(service, bridged.room_id)
    await asyncio.sleep(0.5)
    async with session_factory() as db:
        assert (await db.execute(select(ApprovalRequestPost))).first() is None


async def test_open_requests_are_posted_on_start(
    service, session_factory, bridged, listener, platform, online
):
    await _open(service, bridged.room_id)
    publisher = _publisher(session_factory, bridged, listener, platform, online)
    publisher.start()
    try:
        [posted] = await platform.wait_for(1)
        assert posted.call == "post_rich"
    finally:
        await publisher.stop()


async def test_an_answered_card_is_taken_off_a_platform_that_removes_them(
    service, publisher, platform, bridged, people, session_factory
):
    platform.removes_answered_cards = True
    await _open(service, bridged.room_id)
    [posted] = await platform.wait_for(1)
    await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=pick("deny"),
        answerer=PlatformPerson(people.owner),
    )
    await platform.wait_until(lambda: bool(platform.of("remove_publication")))
    [removed] = platform.of("remove_publication")
    assert removed.ref == posted.ref
    assert platform.of("update_rich") == []
    assert (await _card_post(session_factory)).removed_at is not None


async def test_an_unconfirmed_card_is_disclosed_once_where_it_cannot_be_found(
    service, session_factory, bridged, listener, platform, online
):
    platform.recovers_uncertain_posts = False
    platform.discloses_unconfirmed_posts = True
    await _open(service, bridged.room_id)
    async with session_factory() as db, db.begin():
        db.add(
            ApprovalRequestPost(
                bridge_id=bridged.bridge_id,
                agent_id=AGENT,
                session_id=SESSION,
                request_id="req-1",
                token="tok-lost",
                handle="A1",
                external_channel_id=bridged.channel_id,
                external_post_id=None,
            )
        )
    publisher = _publisher(session_factory, bridged, listener, platform, online)
    publisher.start()
    try:
        [notice] = await platform.wait_for(1)
        assert notice.call == "admin_message"
        assert "**A1**" in notice.content
        assert "[Switch Console](switchdash://session?" in notice.content
        assert (await _card_post(session_factory)).unconfirmed_notice_at is not None
        await service.close_approval(AGENT, SESSION, "req-1")
        await asyncio.sleep(0.5)
        assert len(platform.drawn) == 1
    finally:
        await publisher.stop()


async def test_a_card_says_the_host_is_offline(
    service, publisher, platform, bridged, online
):
    online.value = False
    await _open(service, bridged.room_id)
    [posted] = await platform.wait_for(1)
    assert isinstance(posted.content, RequestCard)
    assert "offline" in (posted.content.unavailable_reason or "")


# ── Turns ────────────────────────────────────────────────────────────────────


async def test_a_turn_is_drawn_step_by_step_in_one_message(
    service, publisher, platform, bridged, session_factory
):
    await _turn(service, bridged.room_id, "running", 1)
    [first] = await platform.wait_for(1)
    assert first.call == "post_rich"
    assert first.thread_ref == ASKED_POST
    assert first.content.turn.status == "running"
    assert first.content.interrupt_turn_id == "turn-1"
    assert first.content.session_url.startswith("switchdash://session?")

    await _step(
        service,
        bridged.room_id,
        item_id="tool-1",
        kind="tool-activity",
        status="in-progress",
        revision=1,
        title="Ran `pytest`",
    )
    await platform.wait_until(lambda: len(_turns(platform)) == 2)
    second = _turns(platform)[1]
    assert (second.call, second.ref) == ("update_rich", first.ref)
    assert [(i.item_id, i.status) for i in second.content.items] == [
        ("tool-1", "in-progress")
    ]

    await _step(
        service,
        bridged.room_id,
        item_id="said-1",
        kind="assistant-message",
        status="in-progress",
        revision=1,
        text="Looking at the failures",
    )
    await asyncio.sleep(0.5)
    assert len(_turns(platform)) == 2, "prose alone does not redraw the message"

    await _step(
        service,
        bridged.room_id,
        item_id="tool-1",
        kind="tool-activity",
        status="completed",
        revision=2,
        title="Ran `pytest`",
    )
    await _turn(service, bridged.room_id, "completed", 5)
    await platform.wait_until(
        lambda: _turns(platform)[-1].content.turn.status == "completed"
    )
    last = _turns(platform)[-1]
    assert last.ref == first.ref
    assert last.content.interrupt_turn_id is None
    assert [i.item_id for i in last.content.items] == ["tool-1", "said-1"]
    assert last.content.items[1].text == "Looking at the failures"
    assert last.content.elapsed_seconds is not None
    post = await _turn_post(session_factory)
    assert post.external_post_id == first.ref


async def test_the_asking_message_is_marked_working_while_the_turn_runs(
    service, publisher, platform, bridged, session_factory
):
    # Queued with nothing ahead of it, the turn is about to start: no queued
    # mark flashes on the message first.
    await _turn(service, bridged.room_id, "queued", 1)
    await platform.wait_until(lambda: platform.marks == [(ASKED_POST, "working", True)])
    post = await _turn_post(session_factory)
    assert (post.reaction_message_ref, post.mark) == (ASKED_POST, "working")

    await _turn(service, bridged.room_id, "running", 2)
    await asyncio.sleep(0.3)
    assert platform.marks == [(ASKED_POST, "working", True)]

    await _turn(service, bridged.room_id, "completed", 3)
    await platform.wait_until(lambda: len(platform.marks) == 2)
    assert platform.marks[-1] == (ASKED_POST, "working", False)
    assert (await _turn_post(session_factory)).mark is None


async def test_a_marker_two_turns_share_comes_off_with_the_last(
    service, publisher, platform, bridged
):
    await _turn(service, bridged.room_id, "running", 1, turn_id="turn-1")
    await _turn(service, bridged.room_id, "running", 1, turn_id="turn-2")
    await platform.wait_until(lambda: len(platform.marks) == 2)
    await _turn(service, bridged.room_id, "completed", 2, turn_id="turn-1")
    await asyncio.sleep(0.5)
    assert all(on for _, _, on in platform.marks)
    await _turn(service, bridged.room_id, "completed", 2, turn_id="turn-2")
    await platform.wait_until(lambda: platform.marks[-1][2] is False)
    assert [on for _, _, on in platform.marks].count(False) == 1


async def test_a_stuck_turn_gets_a_message_of_its_own_until_it_clears(
    service, publisher, platform, bridged, online, session_factory
):
    online.value = False
    await _turn(service, bridged.room_id, "running", 1)
    await platform.wait_until(
        lambda: any(
            isinstance(d.content, TurnActivity) and d.content.status_only
            for d in platform.drawn
        )
    )
    [attention] = [
        d
        for d in platform.drawn
        if isinstance(d.content, TurnActivity) and d.content.status_only
    ]
    assert attention.call == "post_rich"
    assert "offline" in attention.content.error_summary
    assert (await _turn_post(session_factory)).attention_post_id == attention.ref

    online.value = True
    await _turn(service, bridged.room_id, "completed", 2)
    await platform.wait_until(
        lambda: (
            platform.drawn[-1].call == "update_rich"
            and platform.drawn[-1].ref == attention.ref
        )
    )
    assert platform.drawn[-1].content.error_summary is None


async def test_a_turn_that_failed_says_so(service, publisher, platform, bridged):
    await _turn(service, bridged.room_id, "error", 1)
    await platform.wait_until(
        lambda: any(
            isinstance(d.content, TurnActivity) and d.content.error_summary
            for d in platform.drawn
        )
    )


async def test_a_queued_turns_stop_control_follows_the_running_turn(
    service, publisher, platform, bridged
):
    await _turn(service, bridged.room_id, "running", 1, turn_id="turn-1")
    await _turn(service, bridged.room_id, "queued", 1, turn_id="turn-2")
    await platform.wait_until(lambda: len(_turns(platform)) >= 2)

    def queued_names():
        return [
            d.content.interrupt_turn_id
            for d in _turns(platform)
            if d.content.turn.turn_id == "turn-2"
        ]

    assert queued_names()[-1] == "turn-1"
    await _turn(service, bridged.room_id, "completed", 2, turn_id="turn-1")
    await _turn(service, bridged.room_id, "running", 2, turn_id="turn-2")
    await platform.wait_until(lambda: queued_names()[-1] == "turn-2")


async def test_a_press_on_a_turns_message_finds_its_turn(
    service, publisher, platform, bridged
):
    await _turn(service, bridged.room_id, "running", 1)
    [posted] = await platform.wait_for(1)
    target = await publisher.stop_target(bridged.channel_id, posted.ref)
    assert target is not None
    assert (target.agent_id, target.session_id, target.room_id) == (
        AGENT,
        SESSION,
        bridged.room_id,
    )
    assert target.running_turn_id == "turn-1"
    shown = await publisher.activity_shown_at(bridged.channel_id, posted.ref)
    assert shown is not None and shown.turn.turn_id == "turn-1"
    assert await publisher.stop_target(bridged.channel_id, "elsewhere") is None
    assert await publisher.stop_target("another-channel", posted.ref) is None


async def test_a_restart_redraws_running_turns_but_not_ones_already_shown_ended(
    service, session_factory, bridged, listener, online
):
    platform = RecordingPlatform()
    publisher = _publisher(session_factory, bridged, listener, platform, online)
    publisher.start()
    try:
        await _turn(service, bridged.room_id, "running", 1, turn_id="turn-1")
        await _turn(service, bridged.room_id, "running", 1, turn_id="turn-2")
        await platform.wait_until(lambda: len(_turns(platform)) == 2)
        await _turn(service, bridged.room_id, "completed", 2, turn_id="turn-1")
        await platform.wait_until(
            lambda: any(d.content.turn.status == "completed" for d in _turns(platform))
        )
    finally:
        await publisher.stop()

    restarted = RecordingPlatform()
    publisher = _publisher(session_factory, bridged, listener, restarted, online)
    publisher.start()
    try:
        await restarted.wait_until(lambda: len(_turns(restarted)) >= 1)
        await asyncio.sleep(0.3)
        assert [(d.call, d.content.turn.turn_id) for d in _turns(restarted)] == [
            ("update_rich", "turn-2")
        ]
    finally:
        await publisher.stop()

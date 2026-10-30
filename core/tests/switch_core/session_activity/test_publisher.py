from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.db.models import (
    Agent,
    AgentSessionActivityItem,
    ApprovalRequestPost,
    BridgeMessageMap,
    Client,
    ClientRoom,
    ExternalUser,
    ExternalUserClaim,
    TurnStatusPost,
)
from switch_core.delivery.addressing import AddressingDecision
from switch_core.session_activity import publisher as publisher_module
from switch_core.session_activity.listener import AgentSessionActivityListener
from switch_core.session_activity.publisher import (
    AgentSessionActivityPublisher,
)
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
async def listener(postgres_url) -> AsyncIterator[AgentSessionActivityListener]:
    listener = AgentSessionActivityListener(
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
    return AgentSessionActivityPublisher(
        adapter=platform,  # type: ignore[arg-type]
        bridge_id=bridged.bridge_id,
        bridge_type="slack",
        tenant_id=tenant,
        listener=listener,
        session_factory=session_factory,
        agent_online=online,
    )


@pytest.fixture
async def publisher(
    session_factory, bridged, listener, platform, online
) -> AsyncIterator[AgentSessionActivityPublisher]:
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


async def test_a_card_in_a_thread_names_the_owner_who_may_answer_it(
    service, publisher, platform, bridged, session_factory
):
    """Slack's thread following reaches only the people already in the thread,
    and the owner who has to answer is often not one of them."""
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as db, db.begin():
        owner_id = await db.scalar(select(Agent.owner_id).where(Agent.id == AGENT))
        client = Client(
            transport_user_id=f"@owner-{suffix}:test", display_name="owner", type="user"
        )
        db.add(client)
        await db.flush()
        account = ExternalUser(
            bridge_id=bridged.bridge_id,
            external_user_id=f"U{suffix.upper()}",
            external_username=f"owner-{suffix}",
            client_id=client.id,
        )
        db.add_all([account, ClientRoom(client_id=client.id, room_id=bridged.room_id)])
        await db.flush()
        db.add(ExternalUserClaim(external_user_id=account.id, user_id=owner_id))

    await _open(service, bridged.room_id, thread_id=ASKED)
    [posted] = await platform.wait_for(1)
    assert posted.thread_ref == ASKED_POST
    assert posted.content.notify_external_id == f"U{suffix.upper()}"


def _bare_publisher() -> AgentSessionActivityPublisher:
    return AgentSessionActivityPublisher(
        adapter=RecordingPlatform(),  # type: ignore[arg-type]
        bridge_id="bridge",
        bridge_type="slack",
        tenant_id="tenant",
        listener=MagicMock(),
        session_factory=MagicMock(),
        agent_online=Online(),
    )


async def test_a_card_at_the_channel_root_names_whoever_asked_as_before(monkeypatch):
    publisher = _bare_publisher()
    asked = AsyncMock(return_value="UASKER")
    answerer = AsyncMock()
    monkeypatch.setattr(publisher_module, "notification_recipient", asked)
    monkeypatch.setattr(publisher_module, "request_card_recipient", answerer)
    agent = SimpleNamespace(name="agent", owner_id="owner")

    assert (
        await publisher._card_recipient(AsyncMock(), "room", agent, None, None)  # type: ignore[arg-type]
        == "UASKER"
    )
    assert asked.call_args.kwargs["thread_id"] is None
    assert asked.call_args.kwargs["surface"] == "slack"
    answerer.assert_not_called()


async def test_a_card_in_a_thread_asks_the_addressing_policy_who_may_answer(
    monkeypatch,
):
    publisher = _bare_publisher()
    asked = AsyncMock()
    answerer = AsyncMock(return_value="UOWNER")
    permitted = AsyncMock(return_value=AddressingDecision(allowed=False, refusal="no"))
    monkeypatch.setattr(publisher_module, "notification_recipient", asked)
    monkeypatch.setattr(publisher_module, "request_card_recipient", answerer)
    monkeypatch.setattr(publisher._addressing, "permitted", permitted)
    agent = SimpleNamespace(name="agent", owner_id="owner")
    db = AsyncMock()

    assert (
        await publisher._card_recipient(db, "room", agent, None, "123.456")  # type: ignore[arg-type]
        == "UOWNER"
    )
    asked.assert_not_called()
    kwargs = answerer.call_args.kwargs
    assert (kwargs["bridge_id"], kwargs["room_id"]) == ("bridge", "room")
    assert await kwargs["may_answer"]("@someone:switch") is False
    permitted.assert_awaited_once_with(
        db, agent=agent, room_id="room", sender="@someone:switch"
    )


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
        assert "answer it in Switch Console instead" in notice.content
        assert "switchdash://" not in notice.content
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
        # Turns, not draws: turn-1 drawn before turn-2 started is redrawn to
        # name turn-2 in its stop control, a third draw that can land in the
        # same poll as the second.
        await platform.wait_until(
            lambda: (
                {d.content.turn.turn_id for d in _turns(platform)}
                == {"turn-1", "turn-2"}
            )
        )
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


# ── Under a rate limit ───────────────────────────────────────────────────────


def _key(turn_id: str) -> tuple[str, ...]:
    return ("turn", AGENT, SESSION, turn_id)


async def test_the_asking_message_is_marked_before_its_card_can_be_posted(
    service, publisher, platform, bridged, session_factory
):
    """The 👀 says the agent has the message, so it goes on as the turn starts
    rather than once the platform has room for the card."""
    platform.turn_post_errors["turn-1"] = RichContentThrottled(retry_after=0.2, text="")
    await _turn(service, bridged.room_id, "running", 1)
    await platform.wait_until(lambda: platform.marks == [(ASKED_POST, "working", True)])
    assert _turns(platform) == []

    del platform.turn_post_errors["turn-1"]
    await platform.wait_until(lambda: len(_turns(platform)) == 1)
    assert platform.marks == [(ASKED_POST, "working", True)]
    assert (await _turn_post(session_factory)).mark == "working"


async def test_a_turn_that_ends_before_its_card_posts_takes_its_mark_off(
    service, publisher, platform, bridged
):
    platform.turn_post_errors["turn-1"] = RichContentFailed("refused", text="")
    await _turn(service, bridged.room_id, "running", 1)
    await platform.wait_until(lambda: platform.marks == [(ASKED_POST, "working", True)])

    await _turn(service, bridged.room_id, "completed", 2)
    await platform.wait_until(lambda: len(platform.marks) == 2)
    assert platform.marks[-1] == (ASKED_POST, "working", False)


async def test_a_mark_put_on_before_its_card_is_not_taken_off_by_another_turn(
    service, publisher, platform, bridged
):
    """Every agent shares one 👀 here, and a turn whose card has not posted yet
    still holds it."""
    await _turn(service, bridged.room_id, "running", 1, turn_id="turn-1")
    await platform.wait_until(lambda: len(platform.marks) == 1)
    platform.turn_post_errors["turn-2"] = RichContentThrottled(retry_after=0.2, text="")
    await _turn(service, bridged.room_id, "running", 1, turn_id="turn-2")
    await platform.wait_until(lambda: len(platform.marks) == 2)

    await _turn(service, bridged.room_id, "completed", 2, turn_id="turn-1")
    await asyncio.sleep(0.5)
    assert all(on for _, _, on in platform.marks)


async def test_a_card_opened_but_not_yet_drawn_is_drawn_into_rather_than_posted_again(
    service, publisher, platform, bridged, session_factory
):
    platform.open_undrawn.add("turn-1")
    await _turn(service, bridged.room_id, "running", 1)
    await platform.wait_until(lambda: len(_turns(platform)) == 1)

    [opened] = platform.of("opened")
    [drawn] = _turns(platform)
    assert (drawn.call, drawn.ref) == ("update_rich", opened.ref)
    assert platform.of("post_rich") == []
    assert (await _turn_post(session_factory)).external_post_id == opened.ref


async def test_a_running_turn_is_not_redrawn_every_few_seconds_for_its_clock(
    service, session_factory, bridged, listener, online, monkeypatch
):
    """Slack takes about fifty edits a minute for a whole workspace. A clock
    redrawn every five seconds spends that on cards where nothing happened, so
    it moves once a minute and every real change still goes out at once."""
    monkeypatch.setattr(publisher_module, "_TICK_SECONDS", 0.05)
    platform = RecordingPlatform(redraws_for_elapsed_time=True)
    publisher = _publisher(session_factory, bridged, listener, platform, online)
    publisher.start()
    try:
        await _turn(service, bridged.room_id, "running", 1)
        await platform.wait_until(lambda: len(_turns(platform)) == 1)
        await asyncio.sleep(2.5)
        assert len(_turns(platform)) == 1

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
    finally:
        await publisher.stop()


async def test_a_message_the_platform_closes_on_its_own_is_redrawn_just_after(
    service, session_factory, bridged, listener, online, monkeypatch
):
    """Slack closes a stream ten minutes after it opens and marks the steps
    still running as failed. Left to the clock, that could show for a minute."""
    monkeypatch.setattr(publisher_module, "_TICK_SECONDS", 0.05)
    monkeypatch.setattr(
        publisher_module, "_AFTER_PLATFORM_CLOSE", timedelta(seconds=0.1)
    )
    platform = RecordingPlatform(
        redraws_for_elapsed_time=True, closes_activity_after=0.5
    )
    publisher = _publisher(session_factory, bridged, listener, platform, online)
    publisher.start()
    try:
        await _turn(service, bridged.room_id, "running", 1)
        await platform.wait_until(lambda: len(_turns(platform)) == 1)
        await platform.wait_until(lambda: len(_turns(platform)) == 2)
        assert _turns(platform)[1].call == "update_rich"

        await asyncio.sleep(1.0)
        assert len(_turns(platform)) == 2, "once, and then the clock again"
    finally:
        await publisher.stop()


async def test_the_clock_asks_for_a_redraw_when_its_minute_turns_and_edits_are_taken():
    publisher = _bare_publisher()
    platform = publisher._adapter
    platform.redraws_for_elapsed_time = True  # type: ignore[misc]
    now = datetime.now(UTC)
    for turn_id in ("due", "later"):
        publisher._live_turns[_key(turn_id)] = AGENT
    publisher._online_seen[AGENT] = True
    publisher._remembered(_key("due")).clock_due = now - timedelta(seconds=1)
    publisher._remembered(_key("later")).clock_due = now + timedelta(seconds=30)

    platform.held_for = 4.0  # type: ignore[attr-defined]
    publisher._tick(now)
    assert publisher._pending == {}

    platform.held_for = 0.0  # type: ignore[attr-defined]
    publisher._tick(now)
    assert publisher._pending == {_key("due"): publisher_module._CLOCK}


async def test_new_work_goes_ahead_of_retries_and_retries_ahead_of_the_clock():
    """A new turn's card and 👀 must not wait behind every running card's clock,
    nor behind every card a rate limit sent back at the same moment."""
    publisher = _bare_publisher()
    for turn_id in ("old-1", "old-2", "old-3"):
        publisher._enqueue(_key(turn_id), publisher_module._CLOCK)
    publisher._enqueue(_key("retry"), publisher_module._SOON)
    publisher._enqueue(_key("new"), publisher_module._NOW)
    # Something happened on a turn that was only waiting for its clock.
    publisher._enqueue(_key("old-3"), publisher_module._NOW)

    order = [(await publisher._next())[0][3] for _ in range(5)]

    assert order == ["new", "old-3", "retry", "old-1", "old-2"]
    assert publisher._pending == {}


async def test_a_clock_redraw_the_platform_refuses_is_dropped_but_a_change_is_retried(
    monkeypatch,
):
    """The next minute redraws the clock anyway; a real change is still owed."""
    publisher = _bare_publisher()
    handled: list[tuple[str, ...]] = []

    async def handle(key: tuple[str, ...]) -> None:
        handled.append(key)
        raise RichContentThrottled(retry_after=0.05, text="")

    monkeypatch.setattr(publisher, "_handle", handle)
    publisher._enqueue(_key("clock"), publisher_module._CLOCK)
    publisher._enqueue(_key("change"), publisher_module._NOW)
    running = asyncio.create_task(publisher._run())
    await asyncio.sleep(0.4)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running

    assert handled.count(_key("clock")) == 1
    assert handled.count(_key("change")) > 1


async def test_a_turn_whose_rows_were_pruned_is_no_longer_watched(
    service, publisher, platform, bridged, session_factory
):
    await _turn(service, bridged.room_id, "running", 1)
    await platform.wait_until(lambda: len(_turns(platform)) == 1)
    assert _key("turn-1") in publisher._live_turns

    async with session_factory() as db, db.begin():
        await db.execute(
            delete(AgentSessionActivityItem).where(
                AgentSessionActivityItem.turn_id == "turn-1"
            )
        )
    publisher._enqueue(_key("turn-1"), publisher_module._NOW)
    await platform.wait_until(lambda: _key("turn-1") not in publisher._live_turns)


# ── Stopping ─────────────────────────────────────────────────────────────────


async def test_a_task_that_died_is_logged_on_stopping_and_not_raised(
    service, session_factory, bridged, listener, platform, monkeypatch, caplog
):
    """The tick has no guard of its own, so an online check that raises ends
    it. Stopping logs what ended it rather than raising it, so the bridge
    stopping the publisher goes on to close its connection, and a second stop
    has nothing left to raise."""
    monkeypatch.setattr(publisher_module, "_TICK_SECONDS", 0.01)
    answering = True
    refused = asyncio.Event()

    def online(_agent_id: str) -> bool:
        if answering:
            return True
        refused.set()
        raise RuntimeError("the connection registry is gone")

    publisher = _publisher(session_factory, bridged, listener, platform, online)
    publisher.start()
    await _turn(service, bridged.room_id, "running", 1)
    await platform.wait_until(lambda: len(_turns(platform)) == 1)
    answering = False
    await asyncio.wait_for(refused.wait(), 5)

    with caplog.at_level("ERROR"):
        await publisher.stop()
        await publisher.stop()

    died = [r for r in caplog.records if "stopped on an error" in r.getMessage()]
    assert len(died) == 1
    assert "tick" in died[0].getMessage()

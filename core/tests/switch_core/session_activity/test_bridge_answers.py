from __future__ import annotations

import pytest
from sqlalchemy import select, update

from switch_core.addressing import owner_only_policy
from switch_core.bridges.collaboration.models import InboundInteraction, InboundMessage
from switch_core.bridges.collaboration.session.refusal import Refused
from switch_core.bridges.collaboration.session.renderers import (
    ANSWER_ACTION,
    position_action,
)
from switch_core.db.models import Agent, ApprovalRequest, ApprovalRequestPost
from switch_core.session_activity.bridge_answers import Answered, ApprovalAnswers
from switch_core.session_activity.service import ApprovalOption

from .bridge_fixtures import BridgedRoom, RecordingPlatform, make_bridged_room
from .conftest import AGENT

SESSION = "session-demo"
CARD_POST = "1700000000.0002"
TOKEN = "tok-abc"


@pytest.fixture
async def bridged(session_factory, people) -> BridgedRoom:
    async with session_factory() as db, db.begin():
        return await make_bridged_room(db, member=AGENT)


@pytest.fixture
async def card(service, session_factory, bridged) -> ApprovalRequestPost:
    await service.open_approval(
        AGENT,
        SESSION,
        request_id="req-1",
        question="Deploy?",
        options=[
            ApprovalOption("allow", "Allow", "accept"),
            ApprovalOption("deny", "Deny", "decline"),
        ],
        room_id=bridged.room_id,
        thread_id=None,
        expires_at=None,
    )
    post = ApprovalRequestPost(
        bridge_id=bridged.bridge_id,
        agent_id=AGENT,
        session_id=SESSION,
        request_id="req-1",
        token=TOKEN,
        handle="A1",
        external_channel_id=bridged.channel_id,
        external_post_id=CARD_POST,
    )
    async with session_factory() as db, db.begin():
        db.add(post)
    return post


class Identify:
    def __init__(self, mxid: str | None) -> None:
        self.mxid = mxid

    async def __call__(self, _actor) -> str | None:
        return self.mxid


def _answers(service, session_factory, bridged, mxid, platform=None):
    platform = platform or RecordingPlatform()
    return ApprovalAnswers(
        bridge_id=bridged.bridge_id,
        service=service,
        session_factory=session_factory,
        identify=Identify(mxid),
        is_first_reply=platform.is_first_reply,
    )


def _press(bridged, action_id, token=TOKEN, message_ref=CARD_POST):
    return InboundInteraction(
        channel_id=bridged.channel_id,
        sender_id="U1",
        sender_name="person",
        action_id=action_id,
        value=token,
        message_ref=message_ref,
    )


def _typed(bridged, content, root_id=None):
    return InboundMessage(
        channel_id=bridged.channel_id,
        channel_type="channel_public",
        sender_id="U1",
        sender_name="person",
        content=content,
        message_ref="1700000000.0099",
        root_id=root_id,
    )


async def _state(session_factory) -> tuple[str, str | None, str | None]:
    async with session_factory() as db:
        row = (await db.execute(select(ApprovalRequest))).scalar_one()
        return row.state, row.answer, row.answered_by


async def test_a_press_answers_the_card(
    service, session_factory, bridged, card, people
):
    answers = _answers(service, session_factory, bridged, people.owner)
    outcome = await answers.for_press(_press(bridged, f"{ANSWER_ACTION}:allow"))
    assert outcome == Answered(handle="A1")
    assert await _state(session_factory) == ("answered", "allow", people.owner)


async def test_a_press_by_position_answers_the_card(
    service, session_factory, bridged, card, people
):
    answers = _answers(service, session_factory, bridged, people.owner)
    outcome = await answers.for_press(_press(bridged, position_action(2)))
    assert outcome == Answered(handle="A1")
    assert (await _state(session_factory))[1] == "deny"


async def test_someone_who_may_not_address_the_agent_is_refused(
    service, session_factory, bridged, card, people
):
    async with session_factory() as db, db.begin():
        await db.execute(
            update(Agent)
            .where(Agent.id == AGENT)
            .values(addressing_policy=owner_only_policy([]).model_dump())
        )
    answers = _answers(service, session_factory, bridged, people.stranger)
    outcome = await answers.for_press(_press(bridged, f"{ANSWER_ACTION}:allow"))
    assert isinstance(outcome, Refused)
    assert "may not address this agent" in outcome.told()
    assert (await _state(session_factory))[0] == "open"


async def test_a_press_on_another_message_is_refused(
    service, session_factory, bridged, card, people
):
    answers = _answers(service, session_factory, bridged, people.owner)
    outcome = await answers.for_press(
        _press(bridged, f"{ANSWER_ACTION}:allow", message_ref="elsewhere")
    )
    assert isinstance(outcome, Refused)
    assert (await _state(session_factory))[0] == "open"


async def test_a_token_this_table_does_not_know_is_left_to_others(
    service, session_factory, bridged, card, people
):
    answers = _answers(service, session_factory, bridged, people.owner)
    assert (
        await answers.for_press(_press(bridged, f"{ANSWER_ACTION}:allow", "nope"))
        is None
    )
    assert await answers.for_press(_press(bridged, "someone-else:thing")) is None


async def test_no_identity_is_refused(service, session_factory, bridged, card):
    answers = _answers(service, session_factory, bridged, None)
    outcome = await answers.for_press(_press(bridged, f"{ANSWER_ACTION}:allow"))
    assert isinstance(outcome, Refused)
    assert (await _state(session_factory))[0] == "open"


@pytest.mark.parametrize(("typed", "answer"), [("A1 yes", "allow"), ("a1 2", "deny")])
async def test_a_typed_handle_answers_the_card(
    service, session_factory, bridged, card, people, typed, answer
):
    answers = _answers(service, session_factory, bridged, people.owner)
    assert await answers.for_text(_typed(bridged, typed)) == Answered(handle="A1")
    assert (await _state(session_factory))[1] == answer


async def test_a_bare_yes_answers_only_as_the_first_reply(
    service, session_factory, bridged, card, people
):
    later = RecordingPlatform(first_reply=False)
    answers = _answers(service, session_factory, bridged, people.owner, later)
    assert await answers.for_text(_typed(bridged, "yes", root_id=CARD_POST)) is None
    assert (await _state(session_factory))[0] == "open"

    answers = _answers(service, session_factory, bridged, people.owner)
    assert await answers.for_text(_typed(bridged, "no", root_id=CARD_POST)) == Answered(
        handle="A1"
    )
    assert (await _state(session_factory))[1] == "deny"


async def test_other_messages_are_left_alone(
    service, session_factory, bridged, card, people
):
    answers = _answers(service, session_factory, bridged, people.owner)
    for content, root in [
        ("R1 yes", None),
        ("A9 yes", None),
        ("yes", None),
        ("sounds good", CARD_POST),
    ]:
        assert await answers.for_text(_typed(bridged, content, root)) is None
    assert (await _state(session_factory))[0] == "open"

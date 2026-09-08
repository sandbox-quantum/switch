"""What the person who answered gets told when the answer does not land.

Everything else about answering is about the session: which command it becomes,
which revision it stands against. This is the other end. A press or a typed
handle that goes nowhere in silence looks exactly like one that worked, and the
person waits for a card that is never going to move.

So the question every test here asks is which of two outcomes a message got:
nothing, because this layer decided it was not an answer, or a notice, because
it took it as one and then could not complete it. Getting that line wrong in
either direction is a real cost — silence strands someone, and noise means
every "yes" said near a card comes back at whoever said it.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from switch_core.bridges.collaboration.session.inbound import Refused
from switch_core.bridges.collaboration.session.renderers import ANSWER_ACTION
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter

from .test_session_answers import _interactions, _post, _press, _run
from .test_session_text_answers import CARD, _bridge, _typed


def _told(outcome: Any) -> str:
    assert isinstance(outcome, Refused), outcome
    return outcome.told()


# ── Told ─────────────────────────────────────────────────────────────────────


def test_a_press_that_lands_nowhere_says_which_card_and_why() -> None:
    """A press is the least ambiguous thing anyone does with a card."""
    interactions = _interactions(_post())

    outcome = _run(
        interactions.command_for(_press(action_id=f"{ANSWER_ACTION}:made-up"))
    )

    assert _told(outcome) == (
        "Your answer to R42 did not land, because 'made-up' is not one of the "
        "options that card offered."
    )


def test_a_press_on_a_card_with_no_record_left_cannot_name_it() -> None:
    """The handle lives on the row, so a token resolving to none has no handle.

    Still worth saying: the person pressed something and nothing happened, and
    the notice is the only place that shows up.
    """
    interactions = _interactions(_post())

    outcome = _run(interactions.command_for(_press(value="made-up")))

    assert _told(outcome) == (
        "Your answer did not land, because this card is no longer connected to "
        "a live request."
    )


def test_a_handle_that_names_no_card_here_is_told_rather_than_ignored() -> None:
    """Typing `R42` out is aiming at something, even when nothing is there."""
    interactions = _interactions(_post(external_channel_id="C2"))

    outcome = _run(interactions.command_for_text(_typed("R42 1")))

    assert _told(outcome) == (
        "Your answer to R42 did not land, because no card in this channel is "
        "called that."
    )


def test_a_bare_yes_that_was_taken_as_an_answer_is_told_when_it_fails() -> None:
    """First reply under an approval, so it counted; the word fit no option."""
    interactions = _interactions(
        _post(
            form={
                "kind": "approval",
                "options": [
                    {"optionId": "always", "decision": "acceptForSession"},
                    {"optionId": "deny", "decision": "decline"},
                ],
            }
        )
    )

    outcome = _run(interactions.command_for_text(_typed("yes", root_id=CARD)))

    assert "did not land" in _told(outcome)
    assert "R42" in _told(outcome)


def test_someone_switch_cannot_name_is_told_that_rather_than_nothing() -> None:
    """The one refusal that is not about the card, and it reads the same either way."""
    pressed = _run(_interactions(_post(), actor=None).command_for(_press()))
    typed = _run(_interactions(_post(), actor=None).command_for_text(_typed("R42 1")))

    assert _told(pressed) == _told(typed)
    assert "does not know who this account belongs to" in _told(pressed)


# ── Not told ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "said", ["sounds good to me", "R42 is the one I meant", "①", "ok"]
)
def test_ordinary_talk_is_not_answered_back(said: str) -> None:
    """A bridge that told people their chat was not an answer is unusable."""
    assert _run(_interactions(_post()).command_for_text(_typed(said))) is None


def test_a_yes_further_down_a_card_thread_is_not_answered_back() -> None:
    """Agreeing with someone in a card's thread is the common case, not a failure.

    This is the branch where being told would be worst: the card is right
    there, so a notice would go to whoever was talking about it rather than to
    whoever was answering it.
    """
    interactions = _interactions(_post(), first_reply=False)

    assert _run(interactions.command_for_text(_typed("yes", root_id=CARD))) is None


def test_a_bare_word_on_a_card_that_asks_questions_is_not_answered_back() -> None:
    """Refused before this knows whether it was the first reply, so it cannot tell
    an answer from agreement, and silence is the only honest outcome."""
    interactions = _interactions(
        _post(
            form={
                "kind": "questions",
                "questions": [
                    {
                        "questionId": "q1",
                        "optionIds": ["a", "b"],
                        "multiSelect": False,
                        "allowCustomAnswer": False,
                    }
                ],
            }
        )
    )

    assert _run(interactions.command_for_text(_typed("yes", root_id=CARD))) is None


def test_a_control_this_layer_did_not_write_is_not_answered_back() -> None:
    """Another app's button on another app's message. Not ours to comment on."""
    interactions = _interactions(_post())

    assert _run(interactions.command_for(_press(action_id="other-app:go"))) is None


def test_an_app_is_not_told_its_answer_did_not_land() -> None:
    """A Slack workflow posting "R42 1" has nobody to tell.

    Checked before the card is looked up, so an app naming a handle that does
    not exist does not produce a notice aimed at a bot either.
    """

    class _Explodes:
        async def get_by_handle(self, *args: object) -> None:
            raise AssertionError("An app's answer was looked up.")

        async def get_by_post(self, *args: object) -> None:
            raise AssertionError("An app's answer was looked up.")

    interactions = _interactions(_post())
    interactions._posts = _Explodes()  # type: ignore[assignment]

    outcome = _run(interactions.command_for_text(_typed("R42 1", sender_is_app=True)))

    assert outcome is None


# ── What a reason is allowed to carry ────────────────────────────────────────


def test_a_reason_quoting_the_host_cannot_run_away_with_the_notice() -> None:
    """An option id is `min_length=1` in the contract and has no maximum.

    A press carries one back, and a press for an option the card does not offer
    puts it in the sentence. Nothing between the host and this notice bounds
    it, so this does.
    """
    interactions = _interactions(_post())

    outcome = _run(
        interactions.command_for(_press(action_id=f"{ANSWER_ACTION}:{'x' * 5000}"))
    )

    told = _told(outcome)
    assert len(told) < 400
    assert told.endswith("….")


def test_a_refusal_that_names_no_card_leaves_the_card_out_of_the_sentence() -> None:
    """Rather than saying "to None", which is how that reads if nobody checks."""
    assert Refused(reason="of something", handle=None).told() == (
        "Your answer did not land, because of something."
    )


# ── Where it comes out ───────────────────────────────────────────────────────


def test_a_typed_answer_is_answered_back_in_the_thread_it_was_typed_in() -> None:
    bridge, _ = _bridge(_interactions(_post(external_channel_id="C2")))

    _run(bridge._handle_inbound_message(_typed("R42 1", root_id=CARD)))

    assert [(actor, thread) for _, actor, thread, _ in bridge._adapter.told] == [
        ("U1", CARD)
    ]


def test_a_press_is_answered_back_in_the_channel() -> None:
    """A press says nothing about where in the channel it happened.

    Only the person who pressed sees it either way, and the notice names the
    card, which is the part that has to be right.
    """
    bridge, _ = _bridge(_interactions(_post()))

    _run(bridge._handle_inbound_interaction(_press(value="made-up")))

    assert [(actor, thread) for _, actor, thread, _ in bridge._adapter.told] == [
        ("U1", None)
    ]


def test_an_answer_that_did_land_is_not_answered_back() -> None:
    bridge, _ = _bridge(_interactions(_post()))

    _run(bridge._handle_inbound_message(_typed("R42 1")))

    assert bridge._adapter.told == []


def test_the_message_still_reaches_the_room_after_a_notice() -> None:
    """Being told the answer failed is not instead of having said it."""
    bridge, relayed = _bridge(_interactions(_post(external_channel_id="C2")))

    _run(bridge._handle_inbound_message(_typed("R42 1")))

    assert len(bridge._adapter.told) == 1
    assert len(relayed) == 1


# ── What each platform does with it ──────────────────────────────────────────


def test_a_platform_with_no_private_reply_logs_instead_of_posting(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The base every adapter inherits until it can say something to one person.

    Saying it in the channel instead would put a failed answer in front of
    everyone who was not answering, so the base says nothing there and leaves
    the refusal in the log, where it already is.
    """
    adapter = TelegramAdapter.__new__(TelegramAdapter)

    with caplog.at_level(logging.WARNING):
        _run(adapter.tell_actor("C1", "U1", None, "Your answer did not land."))

    assert "Telegram" in caplog.text
    assert "Your answer did not land." in caplog.text


def test_slack_says_it_to_one_person_where_they_were() -> None:
    """An ephemeral: that person, that thread, and nothing left behind."""
    calls: list[dict[str, Any]] = []

    class _Web:
        async def chat_postEphemeral(self, **kwargs: Any) -> None:
            calls.append(kwargs)

    adapter = SlackAdapter.__new__(SlackAdapter)
    adapter._web_client = _Web()  # type: ignore[assignment]

    _run(adapter.tell_actor("C1", "U1", "C1:111.0", "did not land"))

    assert calls == [
        {
            "channel": "C1",
            "user": "U1",
            "text": "did not land",
            "thread_ts": "111.0",
        }
    ]


def test_slack_escapes_what_the_host_put_in_the_reason() -> None:
    """An option id is host text and mrkdwn reads `<…>` as a link."""
    calls: list[dict[str, Any]] = []

    class _Web:
        async def chat_postEphemeral(self, **kwargs: Any) -> None:
            calls.append(kwargs)

    adapter = SlackAdapter.__new__(SlackAdapter)
    adapter._web_client = _Web()  # type: ignore[assignment]

    _run(adapter.tell_actor("C1", "U1", None, "because '<@U9>' is not an option"))

    assert calls[0]["text"] == "because '&lt;@U9&gt;' is not an option"


def test_slack_failing_to_say_it_does_not_lose_the_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Someone answering from a channel the app is not in is the ordinary case."""

    class _Web:
        async def chat_postEphemeral(self, **kwargs: Any) -> None:
            raise RuntimeError("user_not_in_channel")

    adapter = SlackAdapter.__new__(SlackAdapter)
    adapter._web_client = _Web()  # type: ignore[assignment]

    with caplog.at_level(logging.WARNING):
        _run(adapter.tell_actor("C1", "U1", None, "did not land"))

    assert "user_not_in_channel" in caplog.text

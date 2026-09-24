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

from switch_core.bridges.collaboration.models import (
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.refusal import Refused
from switch_core.bridges.collaboration.session.renderers import ANSWER_ACTION
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter
from switch_core.session_activity.bridge_answers import Answered

from .test_session_text_answers import _bridge, _run, _typed

CARD = "C1:111.0"
MISSED = Refused(
    reason="'9' is not one of the options that card offered",
    handle="A1",
    card_ref=CARD,
)


class _Refusing:
    """Approval answers that turn down every press and every typed answer."""

    def __init__(self, refused: Refused) -> None:
        self.refused = refused

    async def for_press(self, interaction: InboundInteraction) -> Refused:
        return self.refused

    async def for_text(self, message: InboundMessage) -> Refused:
        return self.refused


def _press(**overrides: Any) -> InboundInteraction:
    fields: dict[str, Any] = {
        "channel_id": "C1",
        "sender_id": "U1",
        "sender_name": "someone",
        "action_id": f"{ANSWER_ACTION}:allow-once",
        "value": "opaque-token",
        "message_ref": CARD,
    }
    fields.update(overrides)
    return InboundInteraction(**fields)


# ── What a reason is allowed to carry ────────────────────────────────────────


def test_a_reason_quoting_the_host_cannot_run_away_with_the_notice() -> None:
    """An option id is `min_length=1` in the contract and has no maximum.

    A press carries one back, and a press for an option the card does not offer
    puts it in the sentence. Nothing between the host and this notice bounds
    it, so this does.
    """
    told = Refused(
        reason=f"'{'x' * 5000}' is not one of the options that card offered",
        handle="A1",
    ).told()
    assert len(told) < 400
    assert told.endswith("….")


def test_a_refusal_that_names_no_card_leaves_the_card_out_of_the_sentence() -> None:
    """Rather than saying "to None", which is how that reads if nobody checks."""
    assert Refused(reason="of something", handle=None).told() == (
        "Your answer did not land, because of something."
    )


# ── Where it comes out ───────────────────────────────────────────────────────


def test_a_typed_answer_from_the_channel_root_still_lands_in_the_cards_thread() -> None:
    """The ordinary way to answer by handle: no thread at all, just the channel.

    `msg.root_id` is None here, so a notice threaded on the answer rather than
    the card would have nowhere to go and would silently log instead — which
    is exactly what the answer path is supposed to prevent.
    """
    bridge, _ = _bridge(_Refusing(MISSED))

    _run(bridge._handle_inbound_message(_typed("A1 9")))

    assert [(actor, thread) for _, actor, _, thread, _ in bridge._adapter.told] == [
        ("U1", CARD)
    ]


class _Landing:
    async def for_press(self, interaction: InboundInteraction) -> Answered:
        return Answered(handle="A1")

    async def for_text(self, message: InboundMessage) -> Answered:
        return Answered(handle="A1")


def test_an_answer_that_did_land_is_not_answered_back() -> None:
    bridge, _ = _bridge(_Landing())

    _run(bridge._handle_inbound_message(_typed("A1 1")))
    _run(bridge._handle_inbound_interaction(_press()))

    assert bridge._adapter.told == []


def test_the_notice_carries_the_name_of_whoever_answered() -> None:
    """An adapter with no private reply says it in the thread and has to name them.

    Slack does not use it, so nothing about a Slack channel would notice this
    going missing — and on the other four the notice would then be addressed
    to nobody in a thread several people can be answering in.
    """
    bridge, _ = _bridge(_Refusing(MISSED))

    _run(bridge._handle_inbound_message(_typed("A1 9", root_id=CARD)))

    assert [name for _, _, name, _, _ in bridge._adapter.told] == ["someone"]


def test_a_press_is_answered_back_in_the_channel() -> None:
    """A press says nothing about where in the channel it happened.

    The notice names the card, which is the part that has to be right; where
    a platform with no thread to put it in leaves it is that adapter's call.
    """
    bridge, _ = _bridge(_Refusing(MISSED))

    _run(bridge._handle_inbound_interaction(_press()))

    assert [(actor, thread) for _, actor, _, thread, _ in bridge._adapter.told] == [
        ("U1", None)
    ]


def test_the_message_still_reaches_the_room_after_a_notice() -> None:
    """Being told the answer failed is not instead of having said it."""
    bridge, relayed = _bridge(_Refusing(MISSED))

    _run(bridge._handle_inbound_message(_typed("A1 9")))

    assert len(bridge._adapter.told) == 1
    assert len(relayed) == 1


# ── What each platform does with it ──────────────────────────────────────────


def _no_private_reply() -> tuple[Any, list[tuple[str, str, str | None]]]:
    """The base every adapter inherits until it can say something to one person.

    Built on Telegram because it is the furthest from Slack of the four — no
    per-message identity, no interactive controls at all — so what it inherits
    is what the other three do too. `admin_message` is the platform's own
    system-notice rendering and each of the four overrides it, so it is stood
    in for here rather than reimplemented.
    """
    posted: list[tuple[str, str, str | None]] = []
    adapter = TelegramAdapter.__new__(TelegramAdapter)

    async def _admin(
        channel_id: str, content: str, thread_root_id: str | None = None, **_: Any
    ) -> None:
        posted.append((channel_id, content, thread_root_id))

    adapter.admin_message = _admin  # type: ignore[method-assign,assignment]
    return adapter, posted


def test_a_platform_with_no_private_reply_says_it_in_the_thread() -> None:
    """Everyone in the thread reads it, which beats the person waiting forever.

    Addressed by name, because the thread under a card is somewhere several
    people can be answering and an unaddressed notice tells none of them it
    was theirs.
    """
    adapter, posted = _no_private_reply()

    _run(adapter.tell_actor("C1", "U1", "someone", "C1:111", "did not land"))

    assert posted == [("C1", "someone: did not land", "C1:111")]


def test_a_platform_with_no_private_reply_and_no_thread_still_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A press carries no thread, and the channel root is a wider audience.

    Unreachable while the controls are inert everywhere this base runs, which
    is the point: it is what stops a platform gaining buttons from quietly
    starting to announce failed answers to the whole channel.
    """
    adapter, posted = _no_private_reply()

    with caplog.at_level(logging.WARNING):
        _run(adapter.tell_actor("C1", "U1", "someone", None, "did not land."))

    assert posted == []
    assert "Telegram" in caplog.text
    assert "did not land." in caplog.text


def test_a_notice_in_a_thread_cannot_forge_markup() -> None:
    """A refusal quotes the person's word back, and the reason quotes the host's.

    Both land in a body the platform renders, so both go through the same
    per-platform defusal a display name does.
    """
    adapter, posted = _no_private_reply()

    _run(
        adapter.tell_actor(
            "C1", "U1", "@channel", "C1:111", "because '@here' is not an option"
        )
    )

    assert "@channel" not in posted[0][1]
    assert "@here" not in posted[0][1]


def test_a_notice_that_cannot_be_posted_does_not_lose_the_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """This runs ahead of the relay, so raising costs the room the message."""
    adapter, _ = _no_private_reply()

    async def _explode(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("channel_archived")

    adapter.admin_message = _explode  # type: ignore[method-assign,assignment]

    with caplog.at_level(logging.WARNING):
        _run(adapter.tell_actor("C1", "U1", "someone", "C1:111", "did not land"))

    assert "channel_archived" in caplog.text


def test_slack_says_it_to_one_person_where_they_were() -> None:
    """An ephemeral: that person, that thread, and nothing left behind."""
    calls: list[dict[str, Any]] = []

    class _Web:
        async def chat_postEphemeral(self, **kwargs: Any) -> None:
            calls.append(kwargs)

    adapter = SlackAdapter.__new__(SlackAdapter)
    adapter._web_client = _Web()  # type: ignore[assignment]

    _run(adapter.tell_actor("C1", "U1", "someone", "C1:111.0", "did not land"))

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

    _run(
        adapter.tell_actor(
            "C1", "U1", "someone", None, "because '<@U9>' is not an option"
        )
    )

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
        _run(adapter.tell_actor("C1", "U1", "someone", None, "did not land"))

    assert "user_not_in_channel" in caplog.text

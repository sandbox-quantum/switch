"""Stopping an agent's current work from the Telegram message showing it.

The control itself is the shared one: which turn it stops is bound when the
message is drawn, the press goes in as an interaction, and who may press it is
settled by the session against the room. What is Telegram's own is what the
button may carry and what it may look like.

Two things follow. A callback payload holds 64 *bytes* and a turn id is
whatever the provider made it, so the length is checked before the button is
drawn — and unlike a card, which refuses to be posted at all rather than be
posted unanswerable, a status draws itself without the control and logs why.
The status is the whole account of a turn; losing it over a button it can do
without would be the worse trade, and `!interrupt` still stops the turn.

And Telegram gives a bot no destructive style — every inline button looks the
same — so the label is the whole of the warning. There is nothing else on a
status message to sit beside: the tool log travels in the message itself, in a
block the reader's own client opens, so the stop control is the only button a
status has ever carried.

Removing it is free here, as on Discord and unlike Mattermost: an edit carries
the whole keyboard, so a redraw with nothing to stop is a message with no
buttons, and a queued turn that starts re-points the control without anything
having to remember what the message last carried.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    INTERRUPT_QUEUED_NOTE,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    _MAX_CALLBACK_BYTES,
    TelegramAdapter,
    _interrupt_data,
)
from switch_core.bridges.collaboration.telegram.chunking import MAX_MESSAGE

from .test_session_activity import _item, _turn
from .test_telegram_adapter import (
    CHAT_ID,
    _adapter,
    _bot,
    _FakeCallbackQuery,
    _FakeUpdate,
)
from .test_telegram_sdk_only import (
    CHANNEL,
    TOPIC_ID,
    _edited,
    _forum,
    _keyboard,
    _posted,
    _press,
)

RUNNING_TURN = "turn-running"
OTHER_TURN = "turn-next"
STATUS_REF = f"{CHAT_ID}:501"
PRESSER_ID = "7"
PRESSER_NAME = "alice"
PRESS_MESSAGE_REF = f"{CHAT_ID}:11"


# ── Helpers ──────────────────────────────────────────────────────────────────


def _activity(status: str = "running", **fields: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    defaults: dict[str, Any] = {"interrupt_turn_id": RUNNING_TURN}
    return TurnActivity(items, _turn(status), **{**defaults, **fields})


def _stopper() -> TelegramAdapter:
    """An adapter whose presses have somewhere to land, so controls are drawn."""
    adapter = _adapter()

    async def ignore(_interaction: InboundInteraction) -> None:
        return None

    adapter.set_interaction_handler(ignore)
    return adapter


def _labels(message: dict[str, Any]) -> list[str]:
    return [label for label, _data in _keyboard(message["reply_markup"])]


def _stop_data(message: dict[str, Any]) -> str:
    """The payload on the one stop button in a post or an edit."""
    payloads = [
        data
        for label, data in _keyboard(message["reply_markup"])
        if label == INTERRUPT_LABEL
    ]
    assert len(payloads) == 1
    return payloads[0]


async def _post(adapter: TelegramAdapter, content: TurnActivity) -> str:
    return await adapter.post_rich(CHANNEL, "my-agent", content, None)


async def _redraw(adapter: TelegramAdapter, content: TurnActivity) -> None:
    await adapter.update_rich(CHANNEL, "my-agent", STATUS_REF, content, None)


def _unpaced(adapter: TelegramAdapter) -> None:
    """Forget when this chat was last written to.

    Progress redraws are held back to one every second and a half, which is
    about what a Telegram chat can take and nothing to do with what the control
    is bound to. Waiting it out would only make these slow.
    """
    adapter._rich_drawn_at.clear()


# ── Drawing the control ──────────────────────────────────────────────────────


async def test_a_running_turn_is_offered_a_stop_control() -> None:
    adapter = _stopper()

    await _post(adapter, _activity())

    assert _keyboard(_posted(adapter)["reply_markup"]) == [
        (INTERRUPT_LABEL, _interrupt_data(RUNNING_TURN))
    ]


async def test_the_stop_control_is_red_on_the_wire_and_not_only_on_the_object() -> None:
    """Bot API 9.4's `danger` style, which is the red one.

    The field is newer than the pinned client library, so it travels in
    `api_kwargs` — worth nothing unless the library serialises it into the
    button. The assertion is therefore on the dict the request is built from
    rather than on the object, because that is the part that would quietly stop
    being true on a library change.
    """
    adapter = _stopper()

    await _post(adapter, _activity())

    assert _posted(adapter)["reply_markup"].to_dict()["inline_keyboard"] == [
        [
            {
                "text": INTERRUPT_LABEL,
                "callback_data": _interrupt_data(RUNNING_TURN),
                "style": "danger",
            }
        ]
    ]


async def test_the_control_carries_the_turn_it_was_drawn_against() -> None:
    """Not the turn the message is about. A queued turn's status offers to stop
    the running turn in front of it, which is the only thing there is to stop,
    and the message it is on cannot say so."""
    adapter = _stopper()

    await _post(adapter, _activity("queued"))

    assert _stop_data(_posted(adapter)) == _interrupt_data(RUNNING_TURN)


async def test_nothing_to_stop_means_no_control() -> None:
    """A session whose provider cannot be interrupted, or one with no turn
    running behind this message."""
    adapter = _stopper()

    await _post(adapter, _activity(interrupt_turn_id=None))

    assert _posted(adapter)["reply_markup"] is None


async def test_a_finished_turn_keeps_no_control() -> None:
    """The status stays in the chat as the record that the turn ran. Nothing on
    it should still be inviting a press."""
    adapter = _stopper()

    await _post(adapter, _activity("completed"))

    assert _posted(adapter)["reply_markup"] is None


async def test_no_control_where_a_press_has_nowhere_to_land() -> None:
    """A bridge that takes no interactions would be drawing a button nothing
    answers, and a press on it spins on the reader's client until it gives up."""
    adapter = _adapter()

    await _post(adapter, _activity())

    assert _posted(adapter)["reply_markup"] is None


async def test_a_turn_that_needs_attention_can_still_be_stopped() -> None:
    """A session asking for help is often the one somebody wants to stop, and
    what the control's presence turns on is whether there is a turn to end —
    the same rule every platform applies."""
    adapter = _stopper()

    await _post(adapter, replace(_activity(), error_summary="Needs attention."))

    assert _labels(_posted(adapter)) == [INTERRUPT_LABEL]


async def test_a_turn_id_too_long_to_carry_is_not_offered_as_a_button(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Telegram allows 64 bytes in a callback payload and a provider chooses how
    long its turn ids are. A card in this position refuses to be posted, because
    an unanswerable card is worse than none; a status is the only account of the
    turn, so it is posted without the control and says so in the log."""
    adapter = _stopper()
    oversized = "t" * _MAX_CALLBACK_BYTES

    with caplog.at_level(logging.WARNING):
        await _post(adapter, _activity(interrupt_turn_id=oversized))

    assert _posted(adapter)["reply_markup"] is None
    assert "Not offering the stop control" in caplog.text
    assert "typed command still stops it" in caplog.text


async def test_the_budget_is_bytes_because_telegram_counts_them() -> None:
    """A turn id is host text in any script, and the payload it travels in is
    measured the way Telegram measures it. Counting characters would offer a
    button on an id that takes two bytes a letter and have Telegram refuse the
    post."""
    adapter = _stopper()
    cyrillic = "ход-" * 15

    await _post(adapter, _activity(interrupt_turn_id=cyrillic))

    assert len(cyrillic) < _MAX_CALLBACK_BYTES
    assert _posted(adapter)["reply_markup"] is None


async def test_a_forum_topic_is_offered_the_control_too() -> None:
    """The keyboard belongs to the message, and a topic's messages are ordinary
    messages with a thread id on them."""
    adapter = _stopper()
    _forum(adapter)

    await adapter.post_rich(CHANNEL, "my-agent", _activity(), TOPIC_ID)

    assert _posted(adapter)["message_thread_id"] == int(TOPIC_ID)
    assert _stop_data(_posted(adapter)) == _interrupt_data(RUNNING_TURN)


# ── The note under a queued turn ─────────────────────────────────────────────


async def test_a_queued_turn_says_pressing_stop_leaves_it_queued() -> None:
    """The control stops what is running. A reader looking at their own queued
    message needs telling that it is not what comes off."""
    adapter = _stopper()

    await _post(adapter, _activity("queued"))

    assert INTERRUPT_QUEUED_NOTE in _posted(adapter)["text"]


async def test_a_running_turn_says_no_such_thing() -> None:
    """There is no queued message to reassure anyone about."""
    adapter = _stopper()

    await _post(adapter, _activity())

    assert INTERRUPT_QUEUED_NOTE not in _posted(adapter)["text"]


async def test_the_note_goes_with_the_control_it_explains() -> None:
    """A queued status with no stop button on it has nothing to explain, and a
    line about a control that is not there is a control a reader looks for."""
    adapter = _stopper()

    await _post(adapter, _activity("queued", interrupt_turn_id=None))

    assert _posted(adapter)["reply_markup"] is None
    assert INTERRUPT_QUEUED_NOTE not in _posted(adapter)["text"]


async def test_a_republished_status_carries_neither_the_note_nor_a_button() -> None:
    """`rich_fallback_text` is what the publisher posts when the drawing itself
    was refused. Nothing there can carry a keyboard, so a line explaining one
    would be describing a control that does not exist."""
    adapter = _stopper()

    assert INTERRUPT_QUEUED_NOTE not in adapter.rich_fallback_text(_activity("queued"))


async def test_the_note_is_charged_to_the_message_it_is_printed_on() -> None:
    """Telegram rejects an over-long message outright and an edit cannot be
    split, so the note has to come out of the status's budget rather than be
    added to a message already at the limit. Added afterwards it is the part
    the backstop cuts, which is how a reader loses the sentence saying their
    message stays queued while keeping the button that needed it."""
    adapter = _stopper()
    crowded = TurnActivity(
        [_item(kind="assistant-message", title="", text="word " * 2000)],
        _turn("queued"),
        interrupt_turn_id=RUNNING_TURN,
        error_summary="Needs attention. " * 400,
    )

    await _post(adapter, crowded)

    text = _posted(adapter)["text"]
    assert len(text) <= MAX_MESSAGE
    assert text.endswith(INTERRUPT_QUEUED_NOTE)


# ── What a redraw does to it ─────────────────────────────────────────────────


async def test_the_control_comes_off_when_the_turn_ends() -> None:
    """An edit carries the whole keyboard, so a redraw with none takes the
    button off the message that had one."""
    adapter = _stopper()
    await _post(adapter, _activity())

    await _redraw(adapter, _activity("completed", interrupt_turn_id=None))

    assert _posted(adapter)["reply_markup"] is not None
    assert _edited(adapter)["reply_markup"] is None


async def test_a_queued_turn_starting_repoints_the_control() -> None:
    """The queued message offered to stop the turn in front of it. Once that
    turn ends and this one starts, the same message offers to stop this one —
    and the press carries the turn the reader can now see."""
    adapter = _stopper()

    await _redraw(adapter, _activity("queued"))
    _unpaced(adapter)
    await _redraw(adapter, _activity("running", interrupt_turn_id=OTHER_TURN))

    edits = _bot(adapter).edits
    assert _stop_data(edits[0]) == _interrupt_data(RUNNING_TURN)
    assert _stop_data(edits[1]) == _interrupt_data(OTHER_TURN)
    assert INTERRUPT_QUEUED_NOTE not in edits[1]["text"]


async def test_a_redraw_after_a_restart_draws_the_same_control() -> None:
    """Nothing in this process is holding the button. The keyboard is built
    from the content every time, which is what makes a restart cost nothing."""
    first = _stopper()
    restarted = _stopper()

    await _redraw(first, _activity())
    await _redraw(restarted, _activity())

    assert _stop_data(_edited(first)) == _stop_data(_edited(restarted))


# ── The press ────────────────────────────────────────────────────────────────


async def test_a_stop_press_goes_in_under_the_shared_action_id() -> None:
    """The turn comes off the button and the session off the message, so a
    payload cannot name a session it was never shown."""
    adapter = _adapter()

    seen = await _press(adapter, _interrupt_data(RUNNING_TURN))

    assert seen == [
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id=PRESSER_ID,
            sender_name=PRESSER_NAME,
            action_id=INTERRUPT_ACTION,
            value=RUNNING_TURN,
            message_ref=PRESS_MESSAGE_REF,
        )
    ]


async def test_a_turn_id_with_a_colon_in_it_comes_back_whole() -> None:
    """The payload is split once. A provider that punctuates its turn ids is
    not a provider whose stop button quietly targets a prefix of one."""
    adapter = _adapter()
    punctuated = "run:2026-09-17:14"

    seen = await _press(adapter, _interrupt_data(punctuated))

    assert [interaction.value for interaction in seen] == [punctuated]


async def test_a_stop_press_naming_no_turn_is_not_ours() -> None:
    """Read as strictly as it is written. Nothing downstream is asked about a
    press this bridge cannot account for — and the press is still closed, or it
    spins on the presser's client until it gives up."""
    adapter = _adapter()

    assert await _press(adapter, "sx:") == []
    assert await _press(adapter, "sx") == []
    assert len(_bot(adapter).answers) == 2


async def test_the_presser_is_told_the_outcome_and_nobody_else() -> None:
    """Whether the agent was asked to stop or the press was refused, it is said
    in the reply to the press — an alert on that person's client, so the chat
    does not watch somebody be told no."""
    adapter = _adapter()

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id,
            interaction.sender_id,
            interaction.sender_name,
            None,
            "You may not stop this agent.",
        )

    adapter.set_interaction_handler(refuse)
    await adapter._handle_update(
        _FakeUpdate(
            callback_query=_FakeCallbackQuery(data=_interrupt_data(RUNNING_TURN))
        )
    )

    answer = _bot(adapter).answers[0]
    assert answer["show_alert"] is True
    assert answer["text"] == "You may not stop this agent."
    assert _bot(adapter).messages == []


async def test_a_press_taken_without_a_refusal_claims_nothing() -> None:
    """The message's own redraw is what says the agent was asked to stop.
    Saying it on the button would be saying it before anything has happened."""
    adapter = _adapter()

    await _press(adapter, _interrupt_data(RUNNING_TURN))

    assert _bot(adapter).answers[0]["text"] is None
    assert _bot(adapter).answers[0]["show_alert"] is False


async def test_a_stop_press_is_not_read_as_an_answer_to_a_card() -> None:
    """Two keyboards come back through one handler. A stop read as an option
    would resolve against whatever request that token found and answer it."""
    adapter = _adapter()

    seen = await _press(adapter, _interrupt_data("1"))

    assert [interaction.action_id for interaction in seen] == [INTERRUPT_ACTION]

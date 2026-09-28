"""Stopping an agent's current work from the Teams card showing it.

The control itself is the shared one: which turn it stops is bound when the
card is drawn, the press goes in as an interaction, and who may press it is
settled by the session against the room. What is Teams' own is the shape the
button has to take and what that costs the card.

It is an `Action.Execute` with a verb of its own, because that is the only card
action whose press reaches the bot with a reply the presser alone is shown —
the same reason a request card's options are. Two consequences are tested here.
A card carrying one declares schema 1.5, so a running turn's status asks more
of a client than a finished one does; and a client too old to run the action
drops it and keeps the card, which is why `!interrupt` is named in the setup
docs rather than assumed.

Nothing here measures the turn id. Teams states no limit on an action's data,
unlike Telegram's 64 bytes and Discord's 100 characters, and the connector
already weighs the whole serialised activity — so the id travels whole.

Removing the control is free: every redraw rebuilds the card from the content
it is given, so a turn that ends loses the button and gains its folded log
without anything having to remember what the card last carried.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    INTERRUPT_QUEUED_NOTE,
)
from switch_core.bridges.collaboration.teams.adapter import (
    _PUBLICATION_LIMIT,
    TeamsAdapter,
    _publication_ref,
)
from switch_core.bridges.collaboration.teams.cards import (
    ANSWER_VERB,
    INTERRUPT_VERB,
    read_answer_action,
    read_interrupt_action,
)

from .session_fixtures import _item, _turn
from .test_teams_adapter import _card_text
from .test_teams_card_buttons import (
    CARD_ID,
    CONVERSATION,
    PRESSER,
    _handled,
    _press,
)
from .test_teams_sdk_only import (
    AGENT,
    CHANNEL,
    CHAT,
    ROOT,
    SERVICE_URL,
    _Connector,
    _restart,
    _teams,
)

RUNNING_TURN = "turn-running"
OTHER_TURN = "turn-next"
STATUS_REF = _publication_ref(SERVICE_URL, CONVERSATION, "MSG1")
DETAIL_ID = "switchActivityDetail"


# ── Helpers ──────────────────────────────────────────────────────────────────


def _activity(status: str = "running", **fields: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    defaults: dict[str, Any] = {"interrupt_turn_id": RUNNING_TURN}
    return TurnActivity(items, _turn(status), **{**defaults, **fields})


def _actions(activity: dict[str, Any]) -> list[dict[str, Any]]:
    """Every action on a card, whichever `ActionSet` it sits in."""
    card = activity["attachments"][0]["content"]
    return [
        dict(action)
        for block in card["body"]
        if block.get("type") == "ActionSet"
        for action in block["actions"]
    ]


def _stops(activity: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        action for action in _actions(activity) if action.get("verb") == INTERRUPT_VERB
    ]


def _stopped_turn(activity: dict[str, Any]) -> str:
    """The turn named by the one stop control on a card."""
    stops = _stops(activity)
    assert len(stops) == 1
    turn_id = stops[0]["data"]["switchInterrupt"]["turn"]
    assert isinstance(turn_id, str)
    return turn_id


def _posted(connector: _Connector) -> dict[str, Any]:
    return dict(connector.sends[0]["activity"])


def _edited(connector: _Connector, index: int = 0) -> dict[str, Any]:
    return dict(connector.updates[index]["activity"])


def _stop_press(turn_id: str = RUNNING_TURN, **overrides: Any) -> dict[str, Any]:
    """The invoke Teams delivers when someone presses the stop control."""
    return _press(
        1,
        value={
            "action": {
                "type": "Action.Execute",
                "verb": INTERRUPT_VERB,
                "data": {"switchInterrupt": {"turn": turn_id}},
            },
            "trigger": "manual",
        },
        **overrides,
    )


async def _post(adapter: TeamsAdapter, content: TurnActivity) -> str:
    return await adapter.post_rich(CHANNEL, AGENT, content, ROOT)


# ── Drawing the control ──────────────────────────────────────────────────────


async def test_a_running_turn_is_offered_a_stop_control() -> None:
    adapter, connector, _ = _handled()

    await _post(adapter, _activity())

    stop = _stops(_posted(connector))[0]
    assert stop["title"] == INTERRUPT_LABEL
    assert stop["type"] == "Action.Execute"
    assert stop["style"] == "destructive"
    assert stop["fallback"] == "drop"
    assert stop["data"] == {"switchInterrupt": {"turn": RUNNING_TURN}}


async def test_the_control_carries_the_turn_it_was_drawn_against() -> None:
    """A queued turn's card offers to stop the turn in front of it, which is
    the turn the session is running and not the turn the card is about."""
    adapter, connector, _ = _handled()

    await _post(adapter, _activity("queued"))

    assert _stopped_turn(_posted(connector)) == RUNNING_TURN


async def test_a_session_with_nothing_running_offers_nothing_to_stop() -> None:
    adapter, connector, _ = _handled()

    await _post(adapter, _activity(interrupt_turn_id=None))

    assert _stops(_posted(connector)) == []


async def test_a_finished_turn_is_offered_its_log_instead_of_a_stop() -> None:
    """The two are exclusive by the turn's own state: the log is folded under
    an ended turn, and an ended turn has nothing left to stop. A status kept as
    the record of a turn that ran is not a place to offer stopping anything."""
    adapter, connector, _ = _handled()
    ended = TurnActivity(
        [_item(title="Ran a test")], _turn("completed"), interrupt_turn_id=RUNNING_TURN
    )

    await _post(adapter, ended)

    card = _posted(connector)["attachments"][0]["content"]
    assert _stops(_posted(connector)) == []
    assert [block["id"] for block in card["body"] if block.get("id") == DETAIL_ID]


async def test_no_control_where_a_press_has_nowhere_to_land() -> None:
    """Every press here arrives as an invoke that has to be answered, and one
    answered with nothing to route it to is a button that spins and then
    reports a failure of its own."""
    adapter, connector = _teams()

    await _post(adapter, _activity())

    assert _stops(_posted(connector)) == []


async def test_a_turn_that_needs_attention_can_still_be_stopped() -> None:
    """A turn reporting a problem is still running until it is stopped, and the
    one thing a reader wants at that point is the button that stops it."""
    adapter, connector, _ = _handled()

    await _post(adapter, _activity(error_summary="The provider is not answering."))

    assert _stopped_turn(_posted(connector)) == RUNNING_TURN


async def test_a_long_turn_id_travels_whole_rather_than_being_cut() -> None:
    """Teams sets no limit on what an action's data carries, so nothing here
    shortens the id. A press carrying half of one would name a turn that does
    not exist, which is worse than a card the connector refuses by size with
    the reason named."""
    adapter, connector, _ = _handled()
    long_turn = "turn-" + "x" * 400

    await _post(adapter, _activity(interrupt_turn_id=long_turn))

    assert _stopped_turn(_posted(connector)) == long_turn


async def test_a_chat_status_is_offered_the_control_too() -> None:
    adapter, connector = _teams(chat=True)

    async def ignore(_interaction: InboundInteraction) -> None:
        return None

    adapter.set_interaction_handler(ignore)

    await adapter.post_rich(CHAT, AGENT, _activity(), None)

    assert _stopped_turn(_posted(connector)) == RUNNING_TURN


async def test_a_status_with_a_stop_control_asks_for_the_newer_schema() -> None:
    """`Action.Execute` is what a card pays 1.5 for, and a client too old for
    the version a card names shows its fallback text instead of the card. So a
    running turn asks more of a client than a finished one does, and the card
    goes back to the base version the moment there is nothing to stop."""
    adapter, connector, _ = _handled()

    await _post(adapter, _activity())
    await _post(adapter, _activity(interrupt_turn_id=None))

    assert _posted(connector)["attachments"][0]["content"]["version"] == "1.5"
    quiet = connector.sends[1]["activity"]["attachments"][0]["content"]
    assert quiet["version"] == "1.4"


# ── The note under a queued turn ─────────────────────────────────────────────


async def test_a_queued_turn_says_it_stays_queued() -> None:
    """The button stops the work in front of this message. Without the sentence
    a reader would reasonably read it as cancelling their own message."""
    adapter, connector, _ = _handled()

    await _post(adapter, _activity("queued"))

    assert INTERRUPT_QUEUED_NOTE in _card_text(_posted(connector))


async def test_a_running_turn_does_not_say_it_stays_queued() -> None:
    adapter, connector, _ = _handled()

    await _post(adapter, _activity())

    assert INTERRUPT_QUEUED_NOTE not in _card_text(_posted(connector))


async def test_the_note_goes_with_the_control_it_explains() -> None:
    """Nothing to stop, so nothing to explain: the sentence describes a button,
    and on its own it is a claim about a control the reader cannot see."""
    adapter, connector, _ = _handled()

    await _post(adapter, _activity("queued", interrupt_turn_id=None))

    assert INTERRUPT_QUEUED_NOTE not in _card_text(_posted(connector))


async def test_the_note_is_charged_to_the_same_budget_as_the_status() -> None:
    """A status written up to the budget, plus a sentence under it, is a status
    over the budget. Added afterwards the note is the part that would be cut,
    which is how a reader loses the sentence saying their message stays queued
    and keeps the button that needed it. The status gives the room up instead."""
    adapter, connector, _ = _handled()
    crowded = TurnActivity(
        [_item(kind="assistant-message", title="", text="word " * 2000)],
        _turn("queued"),
        interrupt_turn_id=RUNNING_TURN,
        error_summary="Needs attention. " * 400,
    )

    await _post(adapter, crowded)

    text = _card_text(_posted(connector)).strip()
    assert len(text) <= _PUBLICATION_LIMIT
    assert text.endswith(INTERRUPT_QUEUED_NOTE)


async def test_the_note_is_not_in_the_text_a_failed_publication_carries() -> None:
    """`rich_fallback_text` is what a card that never reached Teams says it
    would have said. There is no button in it, so there is nothing to explain."""
    adapter, _connector, _ = _handled()

    text = adapter.rich_fallback_text(_activity("queued"))

    assert INTERRUPT_QUEUED_NOTE not in text


# ── Redrawing ────────────────────────────────────────────────────────────────


async def test_the_control_comes_off_when_the_turn_ends() -> None:
    """A redraw rebuilds the card, so the button leaves with the state that
    justified it — and the log that belongs to an ended turn arrives in the
    same edit."""
    adapter, connector, _ = _handled()
    ref = await _post(adapter, _activity())

    ended = TurnActivity([_item(title="Ran a test")], _turn("completed"))
    await adapter.update_rich(CHANNEL, AGENT, ref, ended, ROOT)

    assert _stops(_posted(connector)) != []
    assert _stops(_edited(connector)) == []


async def test_a_queued_turn_starting_repoints_the_control() -> None:
    """The turn in front of it finished, this turn is the one running now, and
    the same button has to stop this one instead. The note goes with the queue
    it described."""
    adapter, connector, _ = _handled()
    ref = await _post(adapter, _activity("queued"))

    await adapter.update_rich(CHANNEL, AGENT, ref, _activity("queued"), ROOT)
    await adapter.update_rich(
        CHANNEL, AGENT, ref, _activity(interrupt_turn_id=OTHER_TURN), ROOT
    )

    assert _stopped_turn(_edited(connector, 0)) == RUNNING_TURN
    assert _stopped_turn(_edited(connector, 1)) == OTHER_TURN
    assert INTERRUPT_QUEUED_NOTE not in _card_text(_edited(connector, 1))


async def test_a_redraw_after_a_restart_draws_the_same_control() -> None:
    """Nothing about the control is remembered between draws: the turn to stop
    arrives with the content, so a process that has just started rebuilds the
    same card the one before it posted."""
    adapter, connector, _ = _handled()
    _restart(adapter)

    await adapter.update_rich(CHANNEL, AGENT, STATUS_REF, _activity(), ROOT)

    assert _stopped_turn(_edited(connector)) == RUNNING_TURN


# ── The press ────────────────────────────────────────────────────────────────


async def test_a_stop_press_goes_in_under_the_shared_action_id() -> None:
    """Which session it stops is the publication's to answer, so the press
    carries the message it was on and the turn the button was drawn against,
    and says nothing about who pressed — Teams fills that in."""
    adapter, _connector, seen = _handled()

    assert await adapter._dispatch_activity(_stop_press()) is None

    assert seen == [
        InboundInteraction(
            channel_id=CHANNEL,
            sender_id=PRESSER,
            sender_name="kim",
            action_id=INTERRUPT_ACTION,
            value=RUNNING_TURN,
            message_ref=_publication_ref(SERVICE_URL, CONVERSATION, CARD_ID),
        )
    ]


async def test_the_presser_alone_is_told_what_came_of_it() -> None:
    """The invoke's own answer, which Teams shows to whoever pressed. A stop is
    told even when it is taken, because unlike an answered card there is no
    redraw of its own to prove it landed."""
    adapter, connector = _teams()

    async def accept(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id,
            interaction.sender_id,
            interaction.sender_name,
            None,
            "Switch has asked the agent to stop its current work.",
        )

    adapter.set_interaction_handler(accept)

    answer = await adapter._dispatch_activity(_stop_press())

    assert answer is not None
    assert answer["type"] == "application/vnd.microsoft.activity.message"
    assert "asked the agent to stop" in str(answer["value"])
    assert connector.sends == []


async def test_a_press_this_bridge_did_not_draw_is_not_read_as_a_stop() -> None:
    """The verb is what a press is recognised by, and the data under it has to
    be the shape the button was written with. Neither half on its own is a stop
    — an app that copied the data into its own card's action, or a client that
    sent our data under the wrong verb, is not a turn to end.

    Every one of them is still answered, because an unanswered invoke spins on
    the presser's client until it decides for itself that something broke.
    """
    adapter, _connector, seen = _handled()
    stopping = {"switchInterrupt": {"turn": RUNNING_TURN}}
    unreadable: list[dict[str, Any]] = [
        {"action": {"verb": ANSWER_VERB, "data": stopping}},
        {"action": {"verb": "other-app/stop", "data": stopping}},
        {"action": {"verb": INTERRUPT_VERB, "data": {}}},
        {"action": {"verb": INTERRUPT_VERB, "data": {"switchInterrupt": {}}}},
        {"action": {"verb": INTERRUPT_VERB, "data": {"switchInterrupt": {"turn": ""}}}},
        {"action": {"verb": INTERRUPT_VERB, "data": {"switchInterrupt": {"turn": 7}}}},
    ]

    for value in unreadable:
        answer = await adapter._dispatch_activity(_press(1, value=value))
        assert answer is not None
        assert answer["type"] == "application/vnd.microsoft.error"

    assert seen == []


async def test_a_stop_and_an_answer_cannot_be_read_as_each_other() -> None:
    """Two controls, two verbs, two keys under the data. Either reader handed
    the other's press has to come back with nothing, or a stop would settle a
    request — or an answer would stop a turn."""
    stop = _stop_press()["value"]
    answer = _press(2)["value"]

    assert read_answer_action(stop) is None
    assert read_interrupt_action(answer) is None
    assert read_interrupt_action(stop) == RUNNING_TURN
    assert read_answer_action(answer) == ("tok-1", 2)
    assert ANSWER_VERB != INTERRUPT_VERB

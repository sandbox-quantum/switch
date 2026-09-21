"""Stopping an agent's current work from the Mattermost message showing it.

The control itself is the shared one: which turn it stops is bound when the
message is drawn, the press goes in as an interaction, and who may press it is
settled by the session against the room. What is Mattermost's own is how a
button gets onto a post here and how it gets off again.

Two things follow from that and neither is incidental. A Mattermost action id
holds letters and digits only, so the id the rest of Switch routes a stop press
on cannot be written onto the wire — the press is recognised by the shape of
the signed context it carried, and the shared id is put back on the way in. And
a Mattermost post's buttons live in its props, which a redraw did not touch
until now: a status post is redrawn on every tool call, and rewriting props
means reading the post back first. So the props are written when the buttons
have actually changed and left alone when they have not, which over a turn is
the difference between two round trips and a hundred.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.ingress import CallbackRefused
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.mattermost.callback import (
    ACTIVITY_ACTION_ID,
    CONTEXT_KEY,
    INTERRUPT_ACTION_ID,
    activity_action,
    interrupt_action,
)
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    INTERRUPT_QUEUED_NOTE,
)

from .test_mattermost_activity_view import CALLBACK_URL, _buttons, _resolving, _shown
from .test_mattermost_press import (
    CHANNEL,
    POST,
    USER,
    _adapter,
    _body,
    _key,
    _record,
)
from .test_mattermost_sdk_only import _posts
from .test_session_activity import _item, _turn

RUNNING_TURN = "turn-running"
OTHER_TURN = "turn-next"
OTHER_CHANNEL = "chan-2"


def _activity(status: str = "running", **fields: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    defaults: dict[str, Any] = {"interrupt_turn_id": RUNNING_TURN}
    return TurnActivity(items, _turn(status), **{**defaults, **fields})


def _stopper(**kwargs: Any) -> tuple[MattermostAdapter, list[Any]]:
    """A bridge that can draw the control, and the presses it takes inwards."""
    adapter = _adapter(**kwargs)
    return adapter, _record(adapter)


def _restart(adapter: MattermostAdapter) -> MattermostAdapter:
    """A second bridge against the same Mattermost, remembering none of this.

    A restart loses what the process knew about its posts; the posts are still
    there, so a fake starting empty would be testing an outage instead.
    """
    restarted, _ = _stopper()
    server = _posts(adapter)
    drivers: list[Any] = [
        *restarted._bot_drivers.values(),
        restarted._admin_driver,
        restarted._admin_bot_driver,
    ]
    for driver in drivers:
        driver.posts._posts = server
    return restarted


def _stop_button(post: dict[str, Any]) -> dict[str, Any]:
    buttons = [b for b in _buttons(post) if b["id"] == INTERRUPT_ACTION_ID]
    assert len(buttons) == 1
    return buttons[0]


def _context(button: dict[str, Any]) -> dict[str, Any]:
    carried = button["integration"]["context"][CONTEXT_KEY]
    assert isinstance(carried, dict)
    return carried


def _press(turn: str = RUNNING_TURN, channel: str = CHANNEL, **overrides: Any) -> dict:
    action = interrupt_action(_key(), CALLBACK_URL, channel, turn)
    return _body(action["integration"]["context"], **overrides)


# ── Drawing the control ──────────────────────────────────────────────────────


async def test_a_running_turn_is_offered_a_stop_control() -> None:
    adapter, _ = _stopper()

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    button = _stop_button(_posts(adapter).created[0])
    assert button["name"] == INTERRUPT_LABEL
    assert button["style"] == "danger"
    assert button["integration"]["url"] == CALLBACK_URL


async def test_the_control_carries_the_turn_it_was_drawn_against() -> None:
    """Not the turn the message is showing. A queued turn's message offers to
    stop what is in front of it, which is the only thing that can be stopped."""
    adapter, _ = _stopper()

    await adapter.post_rich(CHANNEL, "worker", _activity("queued"), "root-1")

    assert _context(_stop_button(_posts(adapter).created[0]))["turn"] == RUNNING_TURN


async def test_a_session_with_nothing_running_gets_no_stop_control() -> None:
    adapter, _ = _stopper()

    await adapter.post_rich(
        CHANNEL, "worker", _activity(interrupt_turn_id=None), "root-1"
    )

    assert _buttons(_posts(adapter).created[0]) == []


async def test_a_finished_turns_message_is_not_offered_one() -> None:
    """Whatever is running now, a reader scrolled back to yesterday's turn is
    not handed a control over today's work."""
    adapter, _ = _stopper()

    await adapter.post_rich(CHANNEL, "worker", _activity("completed"), "root-1")

    assert _buttons(_posts(adapter).created[0]) == []


async def test_a_bridge_with_nowhere_to_send_a_press_draws_no_control() -> None:
    adapter, _ = _stopper(callback_base_url=None)

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    assert _buttons(_posts(adapter).created[0]) == []


async def test_the_control_sits_beside_the_one_that_opens_the_log() -> None:
    adapter, _ = _stopper()
    _resolving(adapter)

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    ids = [button["id"] for button in _buttons(_posts(adapter).created[0])]
    assert ids == [ACTIVITY_ACTION_ID, INTERRUPT_ACTION_ID]


async def test_a_queued_turns_message_says_what_the_control_stops() -> None:
    """The button is not about the message it sits on. Under "Queued" a bare
    "Stop current work" reads as a cancel of the thing being looked at."""
    adapter, _ = _stopper()

    await adapter.post_rich(CHANNEL, "worker", _activity("queued"), "root-1")

    assert INTERRUPT_QUEUED_NOTE in _posts(adapter).created[0]["message"]


async def test_a_running_turns_message_needs_no_such_line() -> None:
    adapter, _ = _stopper()

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    assert INTERRUPT_QUEUED_NOTE not in _posts(adapter).created[0]["message"]


async def test_the_line_goes_with_the_control_it_explains() -> None:
    """A queued message on a bridge that can draw no button has nothing to
    explain, and the sentence alone would promise a control that is not there."""
    adapter, _ = _stopper(callback_base_url=None)

    await adapter.post_rich(CHANNEL, "worker", _activity("queued"), "root-1")

    assert INTERRUPT_QUEUED_NOTE not in _posts(adapter).created[0]["message"]


# ── Taking it off again ──────────────────────────────────────────────────────


async def test_a_redraw_that_changes_no_button_does_not_touch_the_props() -> None:
    """The hot path. A running turn redraws on every tool call, and writing
    props means reading the post back from the server first."""
    adapter, _ = _stopper()
    ref = await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    await adapter.update_rich(CHANNEL, "worker", ref, _activity(), "root-1")

    assert "props" not in _posts(adapter).patched[0][1]
    assert _stop_button(_posts(adapter).stored[ref])


async def test_the_control_comes_off_when_the_turn_ends() -> None:
    adapter, _ = _stopper()
    ref = await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    await adapter.update_rich(CHANNEL, "worker", ref, _activity("completed"), "root-1")

    assert _buttons(_posts(adapter).stored[ref]) == []


async def test_a_queued_turn_starting_repoints_the_control() -> None:
    """The message now shows the turn it was waiting behind, and the control on
    it has to stop that one rather than the one that has already finished."""
    adapter, _ = _stopper()
    ref = await adapter.post_rich(CHANNEL, "worker", _activity("queued"), "root-1")

    await adapter.update_rich(
        CHANNEL,
        "worker",
        ref,
        _activity("running", interrupt_turn_id=OTHER_TURN),
        "root-1",
    )

    assert _context(_stop_button(_posts(adapter).stored[ref]))["turn"] == OTHER_TURN


async def test_taking_the_control_off_keeps_props_the_server_owns() -> None:
    """A patch replaces props wholesale, and the marker saying the post came
    from a bot is one the Mattermost server put there."""
    adapter, _ = _stopper()
    ref = await adapter.post_rich(
        CHANNEL, "worker", _activity(publication_token="tok-turn"), "root-1"
    )

    await adapter.update_rich(CHANNEL, "worker", ref, _activity("completed"), "root-1")

    props = _posts(adapter).stored[ref]["props"]
    assert props["from_bot"] == "true"
    assert props["switch_publication"] == "tok-turn"


async def test_a_redraw_after_a_restart_writes_buttons_it_cannot_vouch_for() -> None:
    """Nothing here knows what is on a post it did not make. Unknown counts as
    changed, so the write happens even where it turns out to change nothing —
    the alternative is a bridge that never corrects a post it has forgotten."""
    adapter, _ = _stopper()
    ref = await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    restarted = _restart(adapter)
    await restarted.update_rich(CHANNEL, "worker", ref, _activity(), "root-1")

    assert "props" in _posts(adapter).patched[0][1]
    assert _stop_button(_posts(adapter).stored[ref])


async def test_and_stops_writing_them_once_it_knows() -> None:
    """One read-back per post after a restart, not one per tool call."""
    adapter, _ = _stopper()
    ref = await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")
    restarted = _restart(adapter)

    await restarted.update_rich(CHANNEL, "worker", ref, _activity(), "root-1")
    await restarted.update_rich(CHANNEL, "worker", ref, _activity(), "root-1")

    assert ["props" in patch for _, patch in _posts(adapter).patched] == [True, False]


async def test_what_a_post_carries_is_remembered_per_post() -> None:
    """Two turns redrawing in the same channel are two posts, and one of them
    going terminal says nothing about the other."""
    adapter, _ = _stopper()
    first = await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")
    second = await adapter.post_rich(CHANNEL, "worker", _activity(), "root-2")

    await adapter.update_rich(
        CHANNEL, "worker", first, _activity("completed"), "root-1"
    )
    await adapter.update_rich(CHANNEL, "worker", second, _activity(), "root-2")

    assert _buttons(_posts(adapter).stored[first]) == []
    assert _stop_button(_posts(adapter).stored[second])
    assert [ref for ref, patch in _posts(adapter).patched if "props" in patch] == [
        first
    ]


# ── Reading the press ────────────────────────────────────────────────────────


async def test_a_stop_press_goes_in_under_the_shared_action_id() -> None:
    """Mattermost allows letters and digits in an action id and the shared one
    is neither, so it is rebuilt here from the shape of the signed context."""
    adapter, seen = _stopper()

    answer = await adapter._handle_callback(_press())

    assert answer == {}
    assert len(seen) == 1
    assert seen[0].action_id == INTERRUPT_ACTION
    assert seen[0].value == RUNNING_TURN
    assert seen[0].message_ref == POST
    assert seen[0].sender_id == USER


async def test_a_turn_the_signature_does_not_cover_is_not_a_press() -> None:
    """The turn is the one subject here a press supplies. Unsigned, it would be
    a way to stop any turn on the server from outside."""
    adapter, seen = _stopper()
    body = _press()
    body["context"][CONTEXT_KEY]["turn"] = OTHER_TURN

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(body)
    assert seen == []


async def test_a_context_minted_to_open_a_log_cannot_stop_a_turn() -> None:
    """Both are signed for the same channel with the same key. What keeps them
    apart is the purpose folded into each signature."""
    adapter, seen = _stopper()
    context = activity_action(_key(), CALLBACK_URL, CHANNEL)["integration"]["context"]
    context[CONTEXT_KEY]["turn"] = RUNNING_TURN

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(_body(context))
    assert seen == []


async def test_a_control_lifted_into_another_channel_is_refused() -> None:
    adapter, seen = _stopper()

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(_press(channel=OTHER_CHANNEL))
    assert seen == []


async def test_a_stop_press_never_reaches_the_activity_read() -> None:
    """The two buttons share a route and a key and mean entirely different
    things. Nothing about a stop may land as a read of the log."""
    adapter, _ = _stopper()
    asked = _resolving(adapter)

    await adapter._handle_callback(_press())

    assert asked == []


async def test_the_presser_is_told_the_outcome_and_nobody_else() -> None:
    """The reply to a press is the one thing a callback can say privately.
    Mattermost shows `ephemeral_text` to the presser and puts nothing in the
    channel."""
    adapter, _ = _stopper()

    async def handle(interaction: Any) -> None:
        await adapter.tell_actor(
            interaction.channel_id,
            interaction.sender_id,
            interaction.sender_name,
            None,
            "Switch has asked the agent to stop.",
        )

    adapter.set_interaction_handler(handle)

    answer = await adapter._handle_callback(_press())

    assert _shown(answer) == "Switch has asked the agent to stop."
    assert _posts(adapter).created == []

"""Stopping an agent's current work from the Discord message showing it.

The control itself is the shared one: which turn it stops is bound when the
message is drawn, the press goes in as an interaction, and who may press it is
settled by the session against the room. What is Discord's own is where the
button can exist at all and what it is allowed to carry.

Two things follow. A component id holds a hundred characters and a turn id is
whatever the provider made it, so the length is checked before the button is
drawn rather than discovered when Discord refuses the press — an offered
control a reader cannot use is worse than none, because `!interrupt` is still
there and nobody types a command they can see a button for. And Discord only
lets an application-owned webhook carry components, so a status published
through somebody else's webhook has no stop button and the typed command is the
whole of what is on offer.

The rest is free here in a way it was not on Mattermost: every redraw builds
the view again from the content and Discord replaces the components with it, so
the control comes off at the terminal redraw and re-points itself when a queued
turn starts without anything having to remember what the message last carried.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.discord.adapter import (
    _ACTIVITY_LABEL,
    _MAX_CUSTOM_ID,
    _PUBLICATION_WEBHOOK_NAME,
    _WEBHOOK_NAME,
    DiscordAdapter,
    _interrupt_id,
)
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    INTERRUPT_QUEUED_NOTE,
)

from .test_discord_activity_view import (
    STATUS_MESSAGE_ID,
    _guild_with,
    _resolving,
    _snapshot,
)
from .test_discord_card_buttons import (
    PRESSER_ID,
    PRESSER_NAME,
    _buttons,
    _handled,
    _Interaction,
)
from .test_discord_sdk_only import (
    BOT_USER_ID,
    CHANNEL_ID,
    DM_CHANNEL_ID,
    ROOT_MESSAGE_ID,
    _adapter,
    _DMChannel,
    _guild_setup,
    _http_error,
    _Webhook,
)
from .test_session_activity import _item, _turn

RUNNING_TURN = "turn-running"
OTHER_TURN = "turn-next"
THREAD_REF = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
STATUS_REF = f"{ROOT_MESSAGE_ID}:901"


# ── Helpers ──────────────────────────────────────────────────────────────────


def _activity(status: str = "running", **fields: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    defaults: dict[str, Any] = {"interrupt_turn_id": RUNNING_TURN}
    return TurnActivity(items, _turn(status), **{**defaults, **fields})


def _stopper() -> tuple[DiscordAdapter, Any, Any]:
    """A guild channel that can draw the control, and the webhook it draws on.

    Both halves are wired: an activity resolver, so the log button is there to
    sit beside, and an interaction handler, so a press has somewhere to land.
    """
    adapter, _channel, _thread, webhook = _guild_setup()
    _resolving(adapter, _snapshot())
    seen = _handled(adapter)
    return adapter, webhook, seen


def _labels(payload: dict[str, Any]) -> list[str]:
    return [label for label, _custom_id in _buttons(payload)]


def _stop_id(payload: dict[str, Any]) -> str:
    """The id on the one stop button in a send or edit."""
    ids = [
        custom_id for label, custom_id in _buttons(payload) if label == INTERRUPT_LABEL
    ]
    assert len(ids) == 1
    return ids[0]


async def _post(adapter: DiscordAdapter, content: TurnActivity) -> None:
    await adapter.post_rich(str(CHANNEL_ID), "my-agent", content, THREAD_REF)


async def _redraw(adapter: DiscordAdapter, content: TurnActivity) -> None:
    await adapter.update_rich(str(CHANNEL_ID), "my-agent", STATUS_REF, content, None)


class _Posted:
    """The status message a press arrived on, as Discord names it."""

    id = STATUS_MESSAGE_ID


def _press(channel: Any, custom_id: str = _interrupt_id(RUNNING_TURN)) -> _Interaction:
    return _Interaction(custom_id, channel=channel, message=_Posted())


# ── Drawing the control ──────────────────────────────────────────────────────


async def test_a_running_turn_is_offered_a_stop_control() -> None:
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity())

    assert _stop_id(webhook.sent[0]) == _interrupt_id(RUNNING_TURN)
    view = webhook.sent[0]["view"]
    stop = [item for item in view.children if item.label == INTERRUPT_LABEL][0]
    assert stop.style.name == "danger"


async def test_the_control_carries_the_turn_it_was_drawn_against() -> None:
    """Not the turn the message is about. A queued turn's status offers to stop
    the running turn in front of it, which is the only thing there is to stop,
    and the message it is on cannot say so."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity("queued"))

    assert _stop_id(webhook.sent[0]) == _interrupt_id(RUNNING_TURN)


async def test_it_sits_beside_the_way_into_the_log() -> None:
    """Two controls about the same turn, in the order a reader meets them: what
    it is doing, then stopping it."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity())

    assert _labels(webhook.sent[0]) == [_ACTIVITY_LABEL, INTERRUPT_LABEL]


async def test_nothing_to_stop_means_no_control() -> None:
    """A session whose provider cannot be interrupted, or one with no turn
    running behind this message. The log button is unaffected."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity(interrupt_turn_id=None))

    assert _labels(webhook.sent[0]) == [_ACTIVITY_LABEL]


async def test_a_finished_turn_keeps_no_control() -> None:
    """The status stays as the record that the turn ran. Nothing on it should
    still be inviting a press."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity("completed"))

    assert _labels(webhook.sent[0]) == [_ACTIVITY_LABEL]


async def test_no_control_where_a_press_has_nowhere_to_land() -> None:
    """A bridge that takes no interactions would be drawing a button nothing
    answers. The log is read a different way and is still offered."""
    adapter, _channel, _thread, webhook = _guild_setup()
    _resolving(adapter, _snapshot())

    await _post(adapter, _activity())

    assert _labels(webhook.sent[0]) == [_ACTIVITY_LABEL]


async def test_the_attention_slot_keeps_the_stop_and_drops_the_log() -> None:
    """A session that needs attention is often one somebody wants to stop, and
    what the control's presence turns on is whether there is a turn to end —
    the same rule every platform applies. The log button is the one that goes:
    that message is one sentence asking somebody to act."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, replace(_activity(), error_summary="Needs attention."))

    assert _labels(webhook.sent[0]) == [INTERRUPT_LABEL]


async def test_a_turn_id_too_long_to_carry_is_not_offered_as_a_button(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Discord allows a hundred characters in a component id and a provider
    chooses how long its turn ids are. A button whose press Discord would
    refuse is worse than no button, because the typed command is still there
    and nobody types one they can see a control for."""
    adapter, webhook, _seen = _stopper()
    oversized = "t" * (_MAX_CUSTOM_ID + 1)

    with caplog.at_level(logging.WARNING):
        await _post(adapter, _activity(interrupt_turn_id=oversized))

    assert _labels(webhook.sent[0]) == [_ACTIVITY_LABEL]
    assert "Not offering the stop control" in caplog.text
    assert "typed command still stops it" in caplog.text


async def test_a_webhook_this_application_does_not_own_carries_no_control() -> None:
    """Discord drops components from one it does not, so the button would not
    survive the post — and a status that says nothing about being stoppable is
    better than one whose control silently vanished."""
    adapter, channel, _thread, _webhook = _guild_setup()
    _resolving(adapter, _snapshot())
    _handled(adapter)
    channel.existing_webhooks = [
        _Webhook(_WEBHOOK_NAME),
        _Webhook(_PUBLICATION_WEBHOOK_NAME, creator=BOT_USER_ID + 1),
    ]
    theirs = channel.existing_webhooks[1]

    await _post(adapter, _activity())

    assert _buttons(theirs.sent[0]) == []


async def test_a_direct_message_is_offered_the_control_too() -> None:
    """There is no webhook in a DM to own or not own: the status is the bot's
    own message, and a bot may always put components on one."""
    channel = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: channel})
    _resolving(adapter, _snapshot())
    _handled(adapter)

    await adapter.post_rich(str(DM_CHANNEL_ID), "my-agent", _activity(), None)

    assert _stop_id(channel.sent[0]) == _interrupt_id(RUNNING_TURN)


# ── The note under a queued turn ─────────────────────────────────────────────


async def test_a_queued_turn_says_pressing_stop_leaves_it_queued() -> None:
    """The control stops what is running. A reader looking at their own queued
    message needs telling that it is not what comes off."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity("queued"))

    assert INTERRUPT_QUEUED_NOTE in webhook.sent[0]["content"]


async def test_a_running_turn_says_no_such_thing() -> None:
    """There is no queued message to reassure anyone about."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity())

    assert INTERRUPT_QUEUED_NOTE not in webhook.sent[0]["content"]


async def test_the_note_goes_with_the_control_it_explains() -> None:
    """A queued status with no stop button on it has nothing to explain, and a
    line about a control that is not there is a control a reader looks for."""
    adapter, webhook, _seen = _stopper()

    await _post(adapter, _activity("queued", interrupt_turn_id=None))

    assert _labels(webhook.sent[0]) == [_ACTIVITY_LABEL]
    assert INTERRUPT_QUEUED_NOTE not in webhook.sent[0]["content"]


# ── What a redraw does to it ─────────────────────────────────────────────────


async def test_the_control_comes_off_when_the_turn_ends() -> None:
    adapter, webhook, _seen = _stopper()

    await _redraw(adapter, _activity("completed", interrupt_turn_id=None))

    assert _labels(webhook.edits[0]) == [_ACTIVITY_LABEL]


async def test_a_queued_turn_starting_repoints_the_control() -> None:
    """The queued message offered to stop the turn in front of it. Once that
    turn ends and this one starts, the same message offers to stop this one —
    and the press carries the turn the reader can now see."""
    adapter, webhook, _seen = _stopper()

    await _redraw(adapter, _activity("queued"))
    await _redraw(adapter, _activity("running", interrupt_turn_id=OTHER_TURN))

    assert _stop_id(webhook.edits[0]) == _interrupt_id(RUNNING_TURN)
    assert _stop_id(webhook.edits[1]) == _interrupt_id(OTHER_TURN)


async def test_a_redraw_after_a_restart_draws_the_control_again() -> None:
    """Nothing in this process is holding the button. The view is built from
    the content every time, which is what makes a press work — and what makes
    a restart cost nothing."""
    first, webhook, _seen = _stopper()
    restarted, _channel, _thread, same_webhook = _guild_setup()
    _resolving(restarted, _snapshot())
    _handled(restarted)

    await _redraw(first, _activity())
    await _redraw(restarted, _activity())

    assert _stop_id(webhook.edits[0]) == _stop_id(same_webhook.edits[0])


# ── The press ────────────────────────────────────────────────────────────────


async def test_a_stop_press_goes_in_under_the_shared_action_id() -> None:
    """The turn comes off the button and the session off the message, so a
    payload cannot name a session it was never shown."""
    adapter, channel = _guild_with({PRESSER_ID})
    seen = _handled(adapter)

    await adapter._handle_interaction(_press(channel))  # type: ignore[arg-type]

    assert seen == [
        InboundInteraction(
            channel_id=str(CHANNEL_ID),
            sender_id=str(PRESSER_ID),
            sender_name=PRESSER_NAME,
            action_id=INTERRUPT_ACTION,
            value=RUNNING_TURN,
            message_ref=f"{CHANNEL_ID}:{STATUS_MESSAGE_ID}",
        )
    ]


async def test_the_press_is_acknowledged_before_any_switch_work() -> None:
    """Discord allows three seconds and the authority check is not bounded by
    them. The acknowledgement changes nothing on screen: the message's own
    redraw is what says the agent was asked to stop."""
    adapter, channel = _guild_with({PRESSER_ID})
    press = _press(channel)
    deferred: list[int] = []

    async def took(interaction: InboundInteraction) -> None:
        deferred.append(press.response.deferred)

    adapter.set_interaction_handler(took)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert deferred == [1]


async def test_a_stop_press_never_reaches_the_activity_read() -> None:
    """The two controls sit on the same message and are answered by different
    halves of the bridge. A stop that went through the log reader would open a
    private tool log and stop nothing."""
    adapter, channel = _guild_with({PRESSER_ID})
    asked = _resolving(adapter, _snapshot())
    _handled(adapter)

    await adapter._handle_interaction(_press(channel))  # type: ignore[arg-type]

    assert asked == []


async def test_the_presser_is_told_the_outcome_and_nobody_else() -> None:
    """Whether the agent was stopped or the press was refused, it is said in a
    follow-up on the press itself — so a channel does not watch somebody be
    told no."""
    adapter, channel = _guild_with({PRESSER_ID})

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id,
            interaction.sender_id,
            interaction.sender_name,
            None,
            "You may not stop this agent.",
        )

    adapter.set_interaction_handler(refuse)
    press = _press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert press.followup.sent == [
        {"content": "You may not stop this agent.", "ephemeral": True}
    ]
    assert channel.sent == []


async def test_a_turn_id_with_a_colon_in_it_comes_back_whole() -> None:
    """The id is split once. A provider that punctuates its turn ids is not a
    provider whose stop button quietly targets a prefix of one."""
    adapter, channel = _guild_with({PRESSER_ID})
    seen = _handled(adapter)
    punctuated = "run:2026-09-17:14"
    press = _press(channel, _interrupt_id(punctuated))

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert [interaction.value for interaction in seen] == [punctuated]


async def test_a_stop_press_naming_no_turn_is_not_ours() -> None:
    """Read as strictly as it is written. Nothing downstream is asked about a
    press this bridge cannot account for."""
    adapter, channel = _guild_with({PRESSER_ID})
    seen = _handled(adapter)
    bare = _press(channel, "swstop:")

    await adapter._handle_interaction(bare)  # type: ignore[arg-type]

    assert seen == []
    assert bare.response.deferred == 0


async def test_a_press_discord_would_not_acknowledge_is_not_acted_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A press that was not acknowledged in time is one the presser is told
    failed. Stopping an agent behind that notice would be a stop nobody in the
    channel was told about."""
    adapter, channel = _guild_with({PRESSER_ID})
    seen = _handled(adapter)
    press = _press(channel)
    press.response.error = _http_error(400)

    with caplog.at_level(logging.ERROR):
        await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert seen == []
    assert "not acknowledged in time" in caplog.text

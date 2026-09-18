"""Stopping an agent from the message that shows what it is doing.

`!interrupt` already exists and already works. What it costs is knowing the
word, and knowing it while watching a turn run away from you — which is exactly
when nobody wants to look anything up. So the same thing gets a button on the
activity message, and everything here is about the two ways that button can
lie.

The first is stopping the wrong turn. The control is drawn against whatever is
running when the message is drawn, and a message is not redrawn the instant a
turn changes: a reader with a stale screen is pressing a button bound to a turn
that has already ended. It must not fall through to the current one. So the
turn travels in the control's own payload, the press is refused for naming an
ended turn, and nothing on the way in re-reads what is running now.

The second is a button on a message where there is nothing to stop. A queued
turn's message carries one — it stops what is in front of it, which is the
thing that has to end before this one starts — and says so, because otherwise
it reads as a cancel. A finished turn's message carries none. That last part is
harder than it sounds on a stream, which cannot take a block back: a control
left out of an append stays exactly where it was drawn, live-looking, over a
turn that ended an hour ago.

Every Slack shape below was measured against the real API before it was
written, not inferred from the documentation: the button in a stream, both
block shapes, one replacing the other under a single `block_id`, and a block
surviving its own omission.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.inbound import interrupt_command
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    _MAX_POST_BYTES,
    STREAM_SLOTS,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import CommandStatus, Item, Origin, TurnUpsert
from switch_core.sessions.publication import ActivityControlTarget
from switch_core.sessions.service import SessionAuthority, SessionError

from .slack_fakes import FakeWebClient
from .test_session_answers import _run

CHANNEL = "C1"
THREAD = "C1:root"
ASKER = "U0ASKER"
RUNNING_TURN = "turn-running"
QUEUED_TURN = "turn-queued"


def _adapter(client: FakeWebClient, *, streaming: bool) -> SlackAdapter:
    """A Slack adapter drawing into a thread, streaming or not.

    A stream needs a thread with a known requester to address itself to. Taking
    that away is how the same turn is drawn as an ordinary post instead, which
    is the other path the control has to appear on.
    """
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._team_id = "T123"
    adapter._channel_type_cache[CHANNEL] = "channel"
    if streaming:
        adapter._thread_requester[(CHANNEL, "root")] = ASKER
    return adapter


def _turn(turn_id: str = RUNNING_TURN, status: str = "running") -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": turn_id, "status": status, "commandId": None}
    )


def _tool(turn_id: str = RUNNING_TURN) -> Item:
    return Item.model_validate(
        {
            "itemId": "t1",
            "turnId": turn_id,
            "revision": 1,
            "kind": "tool-activity",
            "status": "in-progress",
            "title": "Read",
            "text": "",
            "attachments": [],
            "origin": None,
        }
    )


def _steps(count: int) -> list[Item]:
    """Enough activity to push a turn across as many section boundaries as it takes.

    A section holds forty-nine cards, so one step is one section, fifty is two,
    and ninety-nine is the three a stream draws at most.
    """
    return [
        _tool().model_copy(update={"item_id": f"t{n}", "title": f"Read {n}"})
        for n in range(count)
    ]


def _activity(
    turn: TurnUpsert,
    *,
    stops: str | None = RUNNING_TURN,
    items: list[Item] | None = None,
) -> TurnActivity:
    return TurnActivity(
        items if items is not None else [_tool(turn.turn_id)],
        turn,
        1.0,
        interrupt_turn_id=stops,
    )


def _streamed(client: FakeWebClient) -> dict[str, dict[str, Any]]:
    """The last block written to each block id, in the order the ids appeared."""
    drawn: dict[str, dict[str, Any]] = {}
    for call in client.appended:
        for chunk in call["chunks"]:
            if chunk["type"] == "blocks":
                for block in chunk["blocks"]:
                    drawn[block["block_id"]] = block
    return drawn


def _control(blocks: list[dict[str, Any]] | dict[str, dict[str, Any]]) -> Any:
    """The stop control's own block as the message holds it, live or spent.

    Found by shape rather than by id, because the id is not fixed: the control
    moves down the message as the turn grows a section. Everything the turn
    itself draws is a `plan` or the `context` line above the sections, so
    whatever is neither is the control's block — the button, or the divider
    left where one used to be.
    """
    held = list(blocks.values()) if isinstance(blocks, dict) else blocks
    return next((b for b in held if b["type"] not in {"plan", "context"}), None)


def _button(block: dict[str, Any]) -> dict[str, Any]:
    """The button itself, whichever block shape is carrying it."""
    if block["type"] == "section":
        return dict(block["accessory"])
    return dict(block["elements"][0])


# ── What the control looks like ──────────────────────────────────────────────


async def test_a_running_turn_gets_a_stop_button_below_its_steps() -> None:
    """Below, not above: the steps are what a reader came to read, and a
    destructive control belongs where it cannot be hit on the way past."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(CHANNEL, "Agent", _activity(_turn()), THREAD)

    drawn = _streamed(client)
    # Slack keeps a block where it was first written, so the order the ids
    # first appeared in is the order down the message.
    control = _control(drawn)
    assert list(drawn)[-1] == control["block_id"]
    assert all(block["type"] == "plan" for block in list(drawn.values())[:-1])
    assert control["type"] == "actions"
    assert _button(control)["text"]["text"] == INTERRUPT_LABEL


async def test_the_button_carries_the_turn_it_was_drawn_against() -> None:
    """Not the turn of the message it sits on. On a queued turn's message those
    are different, and the running one is the one that can be stopped."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        _activity(_turn(QUEUED_TURN, "queued"), stops=RUNNING_TURN),
        THREAD,
    )

    assert _button(_control(_streamed(client)))["value"] == RUNNING_TURN


async def test_a_queued_turns_control_says_what_it_actually_stops() -> None:
    """A bare "Stop current work" under a message reading Queued invites the
    reader to take it as a cancel of that message, which it is not.

    An `actions` block holds interactive elements and nothing else, so the
    sentence needs a block that can carry text — the button becomes a section's
    accessory instead. Measured: Slack takes both shapes in a stream.
    """
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(
        CHANNEL, "Agent", _activity(_turn(QUEUED_TURN, "queued")), THREAD
    )

    control = _control(_streamed(client))
    assert control["type"] == "section"
    assert "stays queued" in control["text"]["text"]
    assert _button(control)["text"]["text"] == INTERRUPT_LABEL


async def test_a_session_with_nothing_running_gets_no_control() -> None:
    """There is nothing to stop, and a button that can only be refused is
    worse than no button. Also how a session that cannot be interrupted at
    all draws: the caller hands back no turn to name."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(CHANNEL, "Agent", _activity(_turn(), stops=None), THREAD)

    assert _control(_streamed(client)) is None


async def test_an_ended_turns_message_gets_no_control_even_mid_session() -> None:
    """A reader scrolling past yesterday's turn is not offered a control over
    today's work, whatever is running now."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        _activity(_turn(QUEUED_TURN, "completed"), stops=RUNNING_TURN),
        THREAD,
    )

    assert _control(_streamed(client)) is None


async def test_an_ordinary_post_carries_the_control_too() -> None:
    """Most channels never get a stream — no thread, or no requester to
    address it to — and the button is not a streaming feature."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=False)

    await adapter.post_rich(CHANNEL, "Agent", _activity(_turn()), THREAD)

    assert client.started == []
    control = _control(client.posted[0]["blocks"])
    assert control is not None
    assert _button(control)["value"] == RUNNING_TURN


async def test_the_control_survives_a_message_trimmed_to_fit() -> None:
    """The control is a fixed few hundred bytes and the steps are not. A
    message that dropped its button to make room for one more step line would
    have traded away the only thing on it a reader can act on."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=False)
    many = [
        _tool().model_copy(update={"item_id": f"t{n}", "text": "x" * 20_000})
        for n in range(40)
    ]

    await adapter.post_rich(CHANNEL, "Agent", _activity(_turn(), items=many), THREAD)

    blocks = client.posted[0]["blocks"]
    # The fit actually ran, so the survival below is the trimming being
    # survived rather than there having been nothing to trim.
    assert len(str(blocks)) < _MAX_POST_BYTES
    assert _control(blocks) is not None


# ── Where it sits as the turn grows ──────────────────────────────────────────


def test_the_slots_are_the_ids_slack_is_already_holding() -> None:
    """Not names — a wire format, and messages on Slack are written in it.

    These are the ids the release before the hand-down created, in the order it
    created them: one section made `switch-steps-top` and put the control under
    it in `switch-interrupt`, and only a second section made
    `switch-steps-middle`, below that control. That order is the fault the
    hand-down fixes, and reusing it is what repairs the messages the fault was
    drawn onto — every block such a message holds is a slot the new draw writes
    to, in the place it already sits.

    So this is not free to renumber. An id nothing on the message answers to is
    a new block, no call removes the old one, and the reader is left with the
    turn drawn twice around a stop button that will never come off.
    """
    assert STREAM_SLOTS == (
        "switch-steps-top",
        "switch-interrupt",
        "switch-steps-middle",
        "switch-steps-bottom",
    )


async def test_the_control_moves_down_as_the_turn_grows_a_section() -> None:
    """Slack fixes a block at the position it was first written, so a control
    created while the turn had one section can never be got below its second.

    What moves is the content rather than the block. The section the turn has
    just grown is written over the block the control was in, and a fresh
    control is created below it — so the control is always the newest block on
    the message and Slack therefore always draws it last.
    """
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    ref = await adapter.post_rich(
        CHANNEL, "Agent", _activity(_turn(), items=_steps(1)), THREAD
    )
    held = _control(_streamed(client))["block_id"]

    await adapter.update_rich(
        CHANNEL, "Agent", ref, _activity(_turn(), items=_steps(50)), THREAD
    )

    drawn = _streamed(client)
    assert drawn[held]["type"] == "plan"
    assert [block["type"] for block in drawn.values()] == ["plan", "plan", "actions"]
    assert list(drawn)[-1] == _control(drawn)["block_id"]


async def test_the_control_is_still_last_on_a_turn_drawn_in_three_blocks() -> None:
    """The widest a stream gets, and the handoff happening twice: the line
    saying what is no longer shown, the two sections still kept, and the
    control under both of them."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    ref = await adapter.post_rich(
        CHANNEL, "Agent", _activity(_turn(), items=_steps(1)), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, _activity(_turn(), items=_steps(50)), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, _activity(_turn(), items=_steps(99)), THREAD
    )

    drawn = _streamed(client)
    assert [block["type"] for block in drawn.values()] == [
        "context",
        "plan",
        "plan",
        "actions",
    ]


async def test_no_block_is_drawn_before_the_turn_has_anything_to_put_in_it() -> None:
    """The first answer to the ordering was to create every section up front so
    that the control could be made below all of them, and it is out: Slack
    draws a plan with no cards in it as a visible empty row, so a turn using
    one section would carry two blank ones for the whole of its life.
    """
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    await adapter.post_rich(
        CHANNEL, "Agent", _activity(_turn(), items=_steps(1)), THREAD
    )

    assert [block["type"] for block in _streamed(client).values()] == [
        "plan",
        "actions",
    ]


# ── Taking it away again ─────────────────────────────────────────────────────


async def test_a_finished_turn_overwrites_its_control_rather_than_omitting_it() -> None:
    """Measured, and the reason this is not simply "stop drawing it".

    A stream keeps a block it is no longer sent. Omitting the control at the
    end of a turn leaves a live-looking Stop button over work that finished,
    and the only way to be rid of one is to send something else under the same
    `block_id`.
    """
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    ref = await adapter.post_rich(CHANNEL, "Agent", _activity(_turn()), THREAD)
    live = _control(_streamed(client))
    assert live["type"] == "actions"

    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        _activity(_turn(status="completed"), stops=None),
        THREAD,
    )

    # The same block, so the rule is where the button was rather than below it.
    assert _control(_streamed(client)) == {
        "type": "divider",
        "block_id": live["block_id"],
    }


async def test_a_turn_that_ends_retires_the_control_it_last_drew_and_no_other() -> None:
    """Which block that is depends on how far the turn got before it ended.

    The block the control started in is a section by now, so a rule sent to the
    id the message opened with would not retire anything — it would rub out a
    section of the turn and leave the button live below it.
    """
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    ref = await adapter.post_rich(
        CHANNEL, "Agent", _activity(_turn(), items=_steps(1)), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, _activity(_turn(), items=_steps(50)), THREAD
    )
    live = _control(_streamed(client))["block_id"]

    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        _activity(_turn(status="completed"), stops=None, items=_steps(50)),
        THREAD,
    )

    drawn = _streamed(client)
    assert drawn[live] == {"type": "divider", "block_id": live}
    assert [block["type"] for block in drawn.values()] == ["plan", "plan", "divider"]


async def test_a_stream_that_never_drew_a_control_is_not_sent_one_to_erase() -> None:
    """The overwrite costs a block on the message. A turn nobody could stop
    never had one, and must not acquire a stray divider at the end."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    ref = await adapter.post_rich(
        CHANNEL, "Agent", _activity(_turn(), stops=None), THREAD
    )
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        _activity(_turn(status="completed"), stops=None),
        THREAD,
    )

    assert _control(_streamed(client)) is None


async def test_a_queued_turns_control_rebinds_when_it_starts_running() -> None:
    """The redraw that starts a turn is also what rebinds its button.

    Until then the message offered to stop the turn in front of it; now it
    offers to stop itself, and the block changes shape with it because the
    sentence about staying queued no longer applies.
    """
    client = FakeWebClient()
    adapter = _adapter(client, streaming=True)

    ref = await adapter.post_rich(
        CHANNEL,
        "Agent",
        _activity(_turn(QUEUED_TURN, "queued"), stops=RUNNING_TURN),
        THREAD,
    )
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        _activity(_turn(QUEUED_TURN, "running"), stops=QUEUED_TURN),
        THREAD,
    )

    control = _control(_streamed(client))
    assert control["type"] == "actions"
    assert _button(control)["value"] == QUEUED_TURN


async def test_an_ordinary_post_simply_stops_drawing_the_control() -> None:
    """An edit replaces the whole blocks array, so the streamed path's problem
    is the streamed path's alone and this one needs no divider."""
    client = FakeWebClient()
    adapter = _adapter(client, streaming=False)

    ref = await adapter.post_rich(CHANNEL, "Agent", _activity(_turn()), THREAD)
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        _activity(_turn(status="completed"), stops=None),
        THREAD,
    )

    assert _control(client.updated[0]["blocks"]) is None


# ── What a press becomes ─────────────────────────────────────────────────────


TARGET = ActivityControlTarget(
    session_id="session-demo",
    epoch="epoch-demo",
    room_id="room-demo",
    thread_id="thread-demo",
    thread_ref="C1:1.0",
)


def _command(
    turn_id: str = RUNNING_TURN,
    actor: str = "@alice:example.test",
    message_ref: str = "C1:9.9",
    thread_id: str | None = TARGET.thread_id,
) -> Any:
    return interrupt_command(
        TARGET,
        turn_id=turn_id,
        message_ref=message_ref,
        origin=Origin(
            surface="slack",
            actor_id=actor,
            room_id=TARGET.room_id,
            thread_id=thread_id,
            message_id=message_ref,
        ),
    )


def test_a_press_becomes_a_turn_interrupt_and_not_a_session_stop() -> None:
    """Two different things. `session.stop` ends the session and empties what
    is behind it; this ends one turn and leaves the queue where it is."""
    command = _command()

    assert command.body.type == "turn.interrupt"
    assert command.body.turn_id == RUNNING_TURN
    assert command.session_id == "session-demo"
    assert command.epoch == "epoch-demo"


def test_the_same_person_pressing_twice_is_one_command() -> None:
    """Which is what someone does to a button that has not visibly moved yet.

    The id is derived, so the second press is the same command and settles as
    a repeat rather than arriving as a second interrupt.
    """
    assert _command().command_id == _command().command_id


def test_two_people_pressing_one_control_are_one_command() -> None:
    """One button, one turn, one request to stop it — whoever reaches it.

    The second presser is answered with the first one's receipt rather than
    submitting a second interrupt, which is what the session would otherwise
    have to reconcile against a turn that is already stopping.
    """
    assert _command().command_id == _command(actor="@bob:example.test").command_id


def test_the_session_does_not_read_two_pressers_as_a_contradiction() -> None:
    """The id alone does not settle it: a repeat is compared against the origin
    of the command already stored, and for anything else a different actor
    there is a different command wearing a borrowed id. An interrupt names a
    turn and nothing about who wants it stopped, so the two agree.
    """
    identity = SessionAuthority._command_identity

    assert identity(_command().model_dump(by_alias=True)) == identity(
        _command(actor="@bob:example.test").model_dump(by_alias=True)
    )


def test_one_turn_shown_in_two_threads_gives_two_controls() -> None:
    """A turn gets an activity message per thread it was asked from, and each
    carries its own stop button. Keyed on the turn alone both presses would
    share an id while arriving from different threads, and the session reads
    that as one id used for two different commands — so the second reader's
    press is refused for contradicting a press they never made.
    """
    first = _command()
    second = _command(message_ref="C1:8.8", thread_id="thread-other")
    identity = SessionAuthority._command_identity

    assert first.command_id != second.command_id
    assert identity(first.model_dump(by_alias=True)) != identity(
        second.model_dump(by_alias=True)
    )


def test_a_press_naming_a_different_turn_is_a_different_command() -> None:
    assert _command().command_id != _command(turn_id=QUEUED_TURN).command_id


# ── Where a press goes ───────────────────────────────────────────────────────


class _Notices:
    """An adapter that only records what it was asked to say to one person."""

    def __init__(self) -> None:
        self.told: list[tuple[str, str, str, str | None, str]] = []

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        self.told.append((channel_id, actor_ref, actor_name, thread_ref, text))


def _receipt(status: str, code: str | None = None, message: str | None = None) -> Any:
    return CommandStatus(
        type="command.status",
        command_id="command-demo",
        status=status,
        code=code,
        message=message,
    )


def _bridge(
    *,
    target: ActivityControlTarget | None = TARGET,
    actor: str | None = "@alice:example.test",
    submit: Any = None,
) -> Any:
    """A bridge core with the press path wired and nothing else.

    Built by hand rather than started, because everything under the press —
    the journal read, the puppet, the authority — is covered where it lives,
    and what is left to check here is the routing between them.
    """

    async def _control_at(channel_id: str, ref: str) -> ActivityControlTarget | None:
        return target

    async def _identify(_actor: object) -> str | None:
        return actor

    bridge = BridgeCore.__new__(BridgeCore)
    bridge._adapter = _Notices()
    bridge._bridge_id = "bridge-1"
    bridge._bridge_type = "slack"
    bridge._session_interactions = None
    bridge._session_publisher = SimpleNamespace(activity_control_at=_control_at)
    bridge._session_authority = SimpleNamespace(
        submit=submit or AsyncMock(return_value=_receipt("accepted"))
    )
    bridge._activity_control_at = _control_at  # type: ignore[assignment]
    bridge._identify_actor = _identify  # type: ignore[assignment]
    bridge.refresh_sdk_session = AsyncMock()  # type: ignore[method-assign]
    return bridge


def _press(action_id: str = INTERRUPT_ACTION, value: str = RUNNING_TURN) -> Any:
    return InboundInteraction(
        channel_id=CHANNEL,
        sender_id="U1",
        sender_name="alice",
        action_id=action_id,
        value=value,
        message_ref="C1:9.9",
    )


def test_a_stop_press_is_submitted_to_the_session() -> None:
    submit = AsyncMock(return_value=_receipt("accepted"))
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press()))

    command = submit.await_args.args[0]
    assert command.body.type == "turn.interrupt"
    assert command.body.turn_id == RUNNING_TURN
    assert command.origin.room_id == "room-demo"
    assert command.origin.actor_id == "@alice:example.test"


def test_an_accepted_press_says_switch_took_it_and_not_that_work_stopped() -> None:
    """A press that lands changes nothing the reader can see for a while: the
    provider has to finish the turn before the activity message says so. So it
    is acknowledged — and the acknowledgement has to be about Switch, because
    claiming the agent has stopped is a claim only the provider can make.
    """
    bridge = _bridge()

    _run(bridge._handle_inbound_interaction(_press()))

    told = bridge._adapter.told[0][4]
    assert "Switch has asked the agent to stop" in told
    assert "has stopped" not in told


def test_the_answer_to_a_press_goes_to_the_thread_the_control_was_in() -> None:
    """A notice about a press is private, and a thread is part of being private.

    Slack answers one of these with an ephemeral, which has no idea where the
    press happened: told no thread it posts at the channel root, so a reply
    meant for one person in a thread surfaces in front of the whole channel
    instead. The platforms that answer the interaction itself never read this,
    but it costs them nothing and it is the only thing Slack has.
    """
    bridge = _bridge()

    _run(bridge._handle_inbound_interaction(_press()))

    assert bridge._adapter.told[0][3] == TARGET.thread_ref


def test_a_refusal_lands_in_the_thread_as_well_as_an_acceptance() -> None:
    """The notice that matters most to place correctly is the one that says the
    press did nothing — it is the one the reader is waiting on."""
    submit = AsyncMock(return_value=_receipt("rejected", "TURN_NOT_ACTIVE", "Gone."))
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press()))

    assert bridge._adapter.told[0][3] == TARGET.thread_ref


def test_a_press_on_a_turn_never_threaded_is_answered_at_the_root() -> None:
    """Not every turn is in a thread. One drawn at the channel root has no
    thread to be put back into, and None is how the adapters are told so."""
    bridge = _bridge(target=replace(TARGET, thread_ref=None))

    _run(bridge._handle_inbound_interaction(_press()))

    assert bridge._adapter.told[0][3] is None


def test_a_stale_press_is_told_so_even_though_nothing_was_raised() -> None:
    """A turn that ended between the render and the press is the ordinary way
    this control fails, and authority answers it with a rejected receipt
    rather than an error. Read only the errors and the commonest refusal there
    is becomes silence — on a button the reader expects to have done something.
    """
    submit = AsyncMock(
        return_value=_receipt(
            "rejected", "TURN_NOT_ACTIVE", "The turn is no longer running."
        )
    )
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press()))

    assert bridge._adapter.told[0][4] == (
        "The agent was not stopped (TURN_NOT_ACTIVE): The turn is no longer running."
    )


def test_a_host_that_cannot_be_interrupted_is_reported_to_the_presser() -> None:
    submit = AsyncMock(
        return_value=_receipt(
            "rejected", "UNSUPPORTED_CAPABILITY", "Interrupt is unavailable."
        )
    )
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press()))

    assert bridge._adapter.told[0][4] == (
        "The agent was not stopped (UNSUPPORTED_CAPABILITY): Interrupt is unavailable."
    )


def test_a_rejected_press_is_not_also_reported_as_accepted() -> None:
    submit = AsyncMock(return_value=_receipt("rejected", "TURN_NOT_ACTIVE", "Gone."))
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press()))

    assert len(bridge._adapter.told) == 1


def test_the_turn_comes_off_the_button_and_not_from_a_fresh_read() -> None:
    """The stale-press guarantee, at the one place it could be undone.

    Nothing on the way in asks what is running now. A button bound to a turn
    that has since ended submits that turn, and the session refuses it —
    rather than falling through to whatever started after it.
    """
    submit = AsyncMock()
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press(value="turn-long-finished")))

    assert submit.await_args.args[0].body.turn_id == "turn-long-finished"


def test_a_press_on_a_message_that_resolves_to_nothing_is_told_so() -> None:
    """Silence here is indistinguishable from a press that worked, and the
    reader is watching an agent they think they just stopped."""
    bridge = _bridge(target=None)

    _run(bridge._handle_inbound_interaction(_press()))

    assert "nothing here to stop" in bridge._adapter.told[0][4]


def test_a_press_from_an_account_switch_cannot_name_is_refused() -> None:
    """Stopping an agent is an act, and an act is recorded against somebody.
    There is no default actor to fall back on."""
    submit = AsyncMock()
    bridge = _bridge(actor=None, submit=submit)

    _run(bridge._handle_inbound_interaction(_press()))

    assert submit.await_count == 0
    assert "does not know who this account belongs to" in bridge._adapter.told[0][4]


def test_a_refused_stop_says_the_agent_is_still_running() -> None:
    """Not "your answer did not land", which is what this path used to say for
    every control. A reader who pressed Stop needs to know it is still going.
    """
    submit = AsyncMock(
        side_effect=SessionError("TURN_NOT_ACTIVE", "The turn is no longer running.")
    )
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press()))

    assert bridge._adapter.told[0][4] == (
        "The agent was not stopped (TURN_NOT_ACTIVE): The turn is no longer running."
    )


def test_a_press_on_somebody_elses_control_is_not_a_stop() -> None:
    """Another app's button on a message in the same channel. The action id is
    the only thing that routes this, so it has to be the thing checked."""
    submit = AsyncMock()
    bridge = _bridge(submit=submit)

    _run(bridge._handle_inbound_interaction(_press(action_id="other-app:go")))

    assert submit.await_count == 0
    assert bridge._adapter.told == []

"""Asking, long afterwards, what turn a message in a channel was showing.

Publishing pushes a turn at a channel because it changed. This is the other
direction: a reader operates a control on a status that has been sitting there
for an hour, and something has to say which turn that message is, and then
whether it may still be read out.

Two things make that hard. The anchor a publisher keeps is a delivery
reservation and is thrown away the moment an ordinary turn ends — while the
message it named is still on the screen, still carrying its button. And the
answer can have gone stale in every direction since it was drawn: the room can
have moved to another bridge, the agent can have been taken out of it, the
session can be gone.

So the address is written down separately from the anchor and survives the
compaction that discards it, and every check the publisher makes before it may
draw a turn in a channel is made again on the way back out.

What is deliberately not re-checked is the surface the command came in on. A
turn is published to the room whatever asked for it, so a session driven from
the console draws in the channel exactly as one driven from the channel does.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.session.activity_journal import ActivityJournal
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.db.models import (
    Agent,
    BridgeMessageMap,
    Client,
    ClientRoom,
    CollaborationBridge,
    Room,
    SdkSession,
    require_tenant_id,
)
from switch_core.sessions.publication import activity_control_at, activity_shown_at

from ..bridges.collaboration.test_session_activity import _turn
from .test_activity_durability import ActivitySlack, activity, publish
from .test_authority import opened, setup

STATUS_REF = "channel-demo:1"
#: The reply that says somebody has to act, posted after the status it follows.
ATTENTION_REF = "channel-demo:2"
#: Switch's id for the thread a command was typed in. No platform can address
#: a message with it, which is the whole reason the translation below exists.
THREAD_ID = "sw_thread-root"
#: The platform's id for that same thread, as the bridge recorded it.
THREAD_REF = "channel-demo:root"


async def read_back(session_factory, renderer, channel="channel-demo", ref=STATUS_REF):
    return await activity_shown_at(
        session_factory,
        "bridge",
        renderer,
        channel,
        ref,
        gateway_public_url="https://switch.example.test",
    )


async def control_target(
    session_factory, renderer, channel="channel-demo", ref=STATUS_REF
):
    return await activity_control_at(
        session_factory,
        "bridge",
        renderer,
        channel,
        ref,
    )


async def published(session_factory, *, status="completed"):
    """A turn drawn into channel-demo and then taken to `status`.

    Ended by default, because that is the case the address exists for: a
    running turn still has its anchor, and a finished one has only this.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = ActivitySlack()
    renderer = activity(session_factory, platform)
    await publish(renderer, "running")
    if status != "running":
        await publish(renderer, status)
    return renderer


async def threaded(session_factory):
    """A turn whose command was typed in a thread, with that thread bridged.

    The default fixture's command has no thread at all, which is the one shape
    that cannot show a translation happening: nothing in, nothing out.
    """
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        db.add(
            BridgeMessageMap(
                bridge_id="bridge",
                external_channel_id="channel-demo",
                transport_event_id=THREAD_ID,
                external_post_id=THREAD_REF,
            )
        )
    await opened(service, epoch, thread_id=THREAD_ID)
    renderer = activity(session_factory, ActivitySlack())
    await publish(renderer, "running")
    return renderer


async def report(renderer, status):
    """One publish of a turn that has a problem to report beside it."""
    return await renderer.publish(
        [],
        _turn(status).model_copy(update={"command_id": "message-demo"}),
        session_id="session-demo",
        channel_id="channel-demo",
        thread_root_id="channel-demo:root",
        asked_on="channel-demo:question",
        agent_name="Agent",
        elapsed_seconds=12,
        error_summary="The host went away.",
    )


async def attended(session_factory, *, status="completed"):
    """A turn drawn into channel-demo with an attention reply beside it.

    Two messages rather than one, and the second is the one this section is
    about: it carries the same controls the status does, so it has to answer
    the same question about which turn a press on it is on.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = ActivitySlack()
    renderer = activity(session_factory, platform)
    await report(renderer, "running")
    if status != "running":
        await report(renderer, status)
    return renderer


# ── The address outlives the turn ────────────────────────────────────────────


async def test_a_finished_turns_status_still_says_which_turn_it_is(session_factory):
    """The anchor is gone by now. This is what is left, and it is enough."""
    renderer = await published(session_factory)

    assert await renderer.shown_at("channel-demo", STATUS_REF) == (
        "session-demo",
        "message-demo",
    )


async def test_the_address_survives_the_compaction_that_discards_the_anchor(
    session_factory,
):
    await published(session_factory)

    async with ActivityJournal(session_factory, "bridge").open(
        "session-demo", "message-demo"
    ) as record:
        assert record is not None
        assert "anchor" not in record.data
        assert record.data["shown"] == {
            "channel_id": "channel-demo",
            "ref": STATUS_REF,
        }


async def test_a_running_turn_can_be_asked_too(session_factory):
    renderer = await published(session_factory, status="running")

    assert await renderer.shown_at("channel-demo", STATUS_REF) is not None


async def test_a_message_this_bridge_posted_nothing_in_says_nothing(session_factory):
    renderer = await published(session_factory)

    assert await renderer.shown_at("channel-demo", "channel-demo:9999") is None


async def test_the_channel_and_the_reference_have_to_agree(session_factory):
    """Matched as a pair, not on the reference alone: a platform numbering its
    messages per channel would otherwise answer for a different channel's."""
    renderer = await published(session_factory)

    assert await renderer.shown_at("channel-elsewhere", STATUS_REF) is None


async def test_a_publisher_with_no_journal_has_nothing_to_answer_from(
    session_factory,
):
    renderer = SessionTurnActivity(ActivitySlack())

    assert await renderer.shown_at("channel-demo", STATUS_REF) is None


# ── What the read gives back ─────────────────────────────────────────────────


async def test_the_read_gives_back_the_turn_that_message_is_showing(session_factory):
    renderer = await published(session_factory)

    snapshot = await read_back(session_factory, renderer)

    assert snapshot is not None
    assert snapshot.turn.turn_id == "turn-demo"
    assert all(item.turn_id == "turn-demo" for item in snapshot.items)


async def test_a_console_driven_turn_is_read_back_like_any_other(session_factory):
    """`opened` submits from the console, which is the ordinary way a session
    is driven. Its turn is published to the channel, so it reads back."""
    renderer = await published(session_factory)

    assert await read_back(session_factory, renderer) is not None


async def test_the_read_says_when_it_happened(session_factory):
    """A view left open ages. It can only say so if it was told the time it
    was taken."""
    renderer = await published(session_factory)

    snapshot = await read_back(session_factory, renderer)

    assert snapshot is not None
    assert snapshot.read_at is not None


async def test_the_read_carries_the_console_link_for_the_session(session_factory):
    renderer = await published(session_factory)

    snapshot = await read_back(session_factory, renderer)

    assert snapshot is not None
    assert snapshot.session_url is not None
    assert "switch.example.test" in snapshot.session_url


# ── Every check the publisher makes, made again ──────────────────────────────


async def test_a_room_that_has_moved_to_another_bridge_is_not_read_back(
    session_factory,
):
    renderer = await published(session_factory)
    async with session_factory() as db, db.begin():
        db.add(
            Client(
                id="other-bridge-client",
                matrix_user_id="@other-bridge:example.test",
                display_name="Other bridge",
                type="bridge",
            )
        )
        await db.flush()
        db.add(
            CollaborationBridge(
                id="other-bridge",
                type="slack",
                display_name="Elsewhere",
                client_id="other-bridge-client",
                status="active",
            )
        )
        await db.flush()
        room = await db.get(Room, "room-demo")
        assert room is not None
        room.bridge_id = "other-bridge"

    assert await read_back(session_factory, renderer) is None


async def test_an_agent_taken_out_of_the_room_is_not_read_back(session_factory):
    """Losing the room is how an agent stops publishing into it. A status it
    left behind must stop answering for the same reason."""
    renderer = await published(session_factory)
    async with session_factory() as db, db.begin():
        agent = await db.get(Agent, "agent-demo")
        assert agent is not None
        membership = await db.get(ClientRoom, (agent.client_id, "room-demo"))
        assert membership is not None
        await db.delete(membership)

    assert await read_back(session_factory, renderer) is None


async def test_a_room_now_pointing_at_another_channel_is_not_read_back(
    session_factory,
):
    """The reference is a locator a platform handed us. It is only answered
    where the room it resolves to is still the channel it names."""
    renderer = await published(session_factory)
    async with session_factory() as db, db.begin():
        room = await db.get(Room, "room-demo")
        assert room is not None
        room.external_channel_id = "channel-moved"

    assert await read_back(session_factory, renderer) is None


async def test_a_session_that_is_gone_is_not_read_back(session_factory):
    renderer = await published(session_factory)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        assert row is not None
        await db.delete(row)

    assert await read_back(session_factory, renderer) is None


# ── The other read: where a control on that message submits ──────────────────
#
# A press acts rather than looks, so it wants the session to address and not the
# turn to draw. It runs the same checks — they are the same function — and the
# tests below are the difference: what it gives back, and that nothing about the
# turn to stop is among it.


async def test_a_press_on_a_running_turns_message_finds_its_session(session_factory):
    renderer = await published(session_factory, status="running")

    target = await control_target(session_factory, renderer)

    assert target is not None
    assert target.session_id == "session-demo"
    assert target.room_id == "room-demo"


async def test_the_target_carries_the_epoch_the_message_was_drawn_under(
    session_factory,
):
    """A command is refused outright against the wrong epoch, so a press that
    guessed one would be a press that never worked after a restart."""
    renderer = await published(session_factory, status="running")

    target = await control_target(session_factory, renderer)

    assert target is not None
    assert target.epoch


async def test_the_target_names_no_turn_at_all(session_factory):
    """The whole stale-press guarantee rests on this.

    Which turn to stop comes off the control, bound when the message was drawn.
    If this read handed one back as well, a press on a message nobody had
    redrawn would quietly stop whatever happened to be running instead.
    """
    renderer = await published(session_factory, status="running")

    target = await control_target(session_factory, renderer)

    assert not hasattr(target, "turn_id")


async def test_a_press_on_a_finished_turns_message_still_resolves(session_factory):
    """Resolving is not permission. A turn that has ended has nothing to stop,
    and the session says so — this read is not the place that decides it."""
    renderer = await published(session_factory)

    assert await control_target(session_factory, renderer) is not None


async def test_the_target_says_which_thread_to_answer_the_press_in(session_factory):
    """A press is answered privately, and on Slack privately means an ephemeral,
    which posts at the channel root unless it is handed a thread. So the thread
    has to come back with the target or the notice meant for one person in a
    thread is shown to the whole channel instead.

    It is the platform's own id for the thread, resolved the same way the
    publisher resolved it to decide where to draw the turn — not the Switch id
    beside it, which no platform can address a message with.
    """
    renderer = await threaded(session_factory)

    target = await control_target(session_factory, renderer)

    assert target is not None
    assert target.thread_id == THREAD_ID
    assert target.thread_ref == THREAD_REF


async def test_a_press_on_a_turn_never_threaded_has_no_thread_to_name(session_factory):
    """A command typed at the channel root leaves nothing to translate, and
    None is the honest answer rather than a reference to somewhere else."""
    renderer = await published(session_factory, status="running")

    target = await control_target(session_factory, renderer)

    assert target is not None
    assert target.thread_ref is None


async def test_a_press_on_a_message_this_bridge_drew_nothing_in_goes_nowhere(
    session_factory,
):
    renderer = await published(session_factory, status="running")

    assert (
        await control_target(session_factory, renderer, ref="channel-demo:9999") is None
    )


async def test_an_agent_taken_out_of_the_room_can_no_longer_be_stopped_from_it(
    session_factory,
):
    """Losing the room is how an agent stops publishing into it. A button it
    left behind in that channel must stop reaching it for the same reason."""
    renderer = await published(session_factory, status="running")
    async with session_factory() as db, db.begin():
        agent = await db.get(Agent, "agent-demo")
        assert agent is not None
        membership = await db.get(ClientRoom, (agent.client_id, "room-demo"))
        assert membership is not None
        await db.delete(membership)

    assert await control_target(session_factory, renderer) is None


# ── The other message: the reply that says somebody has to act ───────────────
#
# A turn with a problem draws twice: the status, and a reply beside it. The
# reply carries the same two controls, so a reader stops the agent, or asks what
# it was doing, from the message that told them something was wrong — and every
# press resolves its session from the message it was made on. The two messages
# are written into the row for different reasons and under different keys, so
# the reply being answerable is its own guarantee and has its own tests.


async def test_the_attention_reply_says_which_turn_it_is_too(session_factory):
    renderer = await attended(session_factory, status="running")

    assert await renderer.shown_at("channel-demo", ATTENTION_REF) == (
        "session-demo",
        "message-demo",
    )


async def test_the_attention_address_survives_the_compaction_too(session_factory):
    """It is on screen for the same reasons the status is, and for longer than
    the reservation it was written down as."""
    renderer = await attended(session_factory)

    async with ActivityJournal(session_factory, "bridge").open(
        "session-demo", "message-demo"
    ) as record:
        assert record is not None
        assert record.data["attention"]["ref"] == ATTENTION_REF
    assert await renderer.shown_at("channel-demo", ATTENTION_REF) is not None


async def test_the_attention_reply_of_another_channel_is_not_answered_for(
    session_factory,
):
    renderer = await attended(session_factory, status="running")

    assert await renderer.shown_at("channel-elsewhere", ATTENTION_REF) is None


async def test_a_press_on_the_attention_reply_reaches_the_session(session_factory):
    """The stop control is on this message precisely because a turn needing
    attention is one somebody wants to stop."""
    renderer = await attended(session_factory, status="running")

    target = await control_target(session_factory, renderer, ref=ATTENTION_REF)

    assert target is not None
    assert target.session_id == "session-demo"
    assert target.room_id == "room-demo"


async def test_a_press_on_a_finished_turns_attention_reply_still_resolves(
    session_factory,
):
    """The message an error left behind is the one still being read afterwards,
    and the compaction that discards the reservation must not silence it."""
    renderer = await attended(session_factory)

    assert (
        await control_target(session_factory, renderer, ref=ATTENTION_REF) is not None
    )


async def test_the_activity_behind_the_attention_reply_can_be_read_back(
    session_factory,
):
    """The other control on it: what the turn was doing when it went wrong."""
    renderer = await attended(session_factory)

    snapshot = await read_back(session_factory, renderer, ref=ATTENTION_REF)

    assert snapshot is not None
    assert snapshot.turn.command_id == "message-demo"


async def test_a_press_naming_another_bridges_room_goes_nowhere(session_factory):
    renderer = await published(session_factory, status="running")
    async with session_factory() as db, db.begin():
        db.add(
            Client(
                id="other-bridge-client",
                matrix_user_id="@other-bridge:example.test",
                display_name="Other bridge",
                type="bridge",
            )
        )
        await db.flush()
        db.add(
            CollaborationBridge(
                id="other-bridge",
                type="slack",
                display_name="Elsewhere",
                client_id="other-bridge-client",
                status="active",
            )
        )
        await db.flush()
        room = await db.get(Room, "room-demo")
        assert room is not None
        room.bridge_id = "other-bridge"

    assert await control_target(session_factory, renderer) is None

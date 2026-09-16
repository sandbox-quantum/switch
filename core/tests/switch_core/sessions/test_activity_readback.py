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
    Client,
    ClientRoom,
    CollaborationBridge,
    Room,
    SdkSession,
    require_tenant_id,
)
from switch_core.sessions.publication import activity_shown_at

from .test_activity_durability import ActivitySlack, activity, publish
from .test_authority import opened, setup

STATUS_REF = "channel-demo:1"


async def read_back(session_factory, renderer, channel="channel-demo", ref=STATUS_REF):
    return await activity_shown_at(
        session_factory,
        "bridge",
        renderer,
        channel,
        ref,
        gateway_public_url="https://switch.example.test",
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

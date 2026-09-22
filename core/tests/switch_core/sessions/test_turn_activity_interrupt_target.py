"""Which turn a status message's stop control is pointed at, and when it moves.

The control is bound at draw time: the turn to stop travels with the message,
not with the press. That makes publishing responsible for two things a renderer
cannot do for itself — naming the turn that is actually running at the moment
each message is drawn, and noticing when that answer changes so the message is
drawn again. The second is the whole of the stale-press story: a queued turn's
message says "stop the turn in front of me", and nothing else about it changes
when that turn ends.
"""

from copy import deepcopy

from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.db.models import SdkSession, require_tenant_id
from switch_core.sessions.publication import SessionPublisher

from .test_authority import command, host_event, opened, setup
from .test_publication import Platform
from .test_publication_retries import cards_for
from .test_turn_activity_publication import ActivityPlatform


def publisher_for(session_factory, activity_platform):
    return SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )


async def queue_second_turn(service, epoch):
    await service.submit(
        command(
            epoch,
            "message-2",
            {
                "type": "message.send",
                "text": "Run them again",
                "attachments": [],
                "delivery": "queue",
            },
        ),
        user_id="owner",
        bridge_id=None,
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "turn.upsert",
                "turnId": "turn-2",
                "status": "queued",
                "commandId": "message-2",
            },
        ),
    )


async def finish_first_turn(service, epoch, sequence):
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            sequence,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "completed",
                "commandId": "message-demo",
            },
        ),
    )


def drawn(activity_platform, turn_id):
    """Every draw of one turn: its first post, then each edit in order."""
    contents = [content for _, content, _ in activity_platform.posts] + [
        content for _, _, content in activity_platform.edits
    ]
    return [content for content in contents if content.turn.turn_id == turn_id]


# ── What each message is pointed at ──────────────────────────────────────────


async def test_a_running_turns_message_offers_to_stop_that_turn(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()

    await publisher_for(session_factory, activity_platform).publish_pending()

    _, content, _ = activity_platform.posts[0]
    assert content.turn.status == "running"
    assert content.interrupt_turn_id == "turn-demo"


async def test_a_queued_turns_message_offers_to_stop_the_turn_in_front_of_it(
    session_factory,
):
    """Not itself: there is nothing to stop yet. The offer is to clear the way,
    and pressing it leaves this message queued where it is.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()
    publisher = publisher_for(session_factory, activity_platform)
    await publisher.publish_pending()

    await queue_second_turn(service, epoch)
    await publisher.publish_pending()

    queued = drawn(activity_platform, "turn-2")
    assert queued
    assert queued[-1].turn.status == "queued"
    assert queued[-1].interrupt_turn_id == "turn-demo"


async def test_a_turn_that_has_ended_offers_nothing(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()
    publisher = publisher_for(session_factory, activity_platform)
    await publisher.publish_pending()

    await finish_first_turn(service, epoch, 3)
    await publisher.publish_pending()

    ended = drawn(activity_platform, "turn-demo")[-1]
    assert ended.turn.status == "completed"
    assert ended.interrupt_turn_id is None


async def test_a_session_that_cannot_be_interrupted_offers_nothing(session_factory):
    """A control the host would refuse is worse than no control: it reads as a
    way out of a long turn right up until someone needs it.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        assert row is not None
        snapshot = deepcopy(row.snapshot)
        assert snapshot["session"]["capabilities"]["interrupt"] is True
        snapshot["session"]["capabilities"]["interrupt"] = False
        row.snapshot = snapshot
    activity_platform = ActivityPlatform()

    await publisher_for(session_factory, activity_platform).publish_pending()

    _, content, _ = activity_platform.posts[0]
    assert content.turn.status == "running"
    assert content.interrupt_turn_id is None


# ── Moving the target is a reason to redraw ──────────────────────────────────


async def test_a_queued_message_is_redrawn_when_the_turn_it_would_stop_ends(
    session_factory,
):
    """The only thing that changed about this message is what its button points
    at. Nothing in the turn it draws moved, so unless the target is part of what
    the redraw guard compares, the button sits there naming a finished turn and
    a press on it does nothing anyone asked for.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()
    publisher = publisher_for(session_factory, activity_platform)
    await publisher.publish_pending()
    await queue_second_turn(service, epoch)
    await publisher.publish_pending()
    before = len(drawn(activity_platform, "turn-2"))

    await finish_first_turn(service, epoch, 4)
    await publisher.publish_pending()

    after = drawn(activity_platform, "turn-2")
    assert len(after) > before
    assert after[-1].turn.status == "queued"
    assert after[-1].interrupt_turn_id is None


async def test_a_message_whose_target_has_not_moved_is_left_alone(session_factory):
    """The mirror of the test above, and the reason it is not free: a target
    folded into the redraw guard must not make every sweep a redraw.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()
    publisher = publisher_for(session_factory, activity_platform)
    await publisher.publish_pending()
    await queue_second_turn(service, epoch)
    await publisher.publish_pending()
    before = len(drawn(activity_platform, "turn-2"))

    await publisher.publish_pending()

    assert len(drawn(activity_platform, "turn-2")) == before

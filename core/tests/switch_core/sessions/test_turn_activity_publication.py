from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.sessions.publication import SessionPublisher

from .test_authority import host_event, opened, setup
from .test_publication import Platform
from .test_publication_retries import cards_for


class ActivityPlatform:
    """A `post_rich` / `update_rich` implementation for `TurnActivity` content.

    Captures what it was given rather than rendering it — these tests only
    care that the right turn, in the right state, reached the right channel,
    not what a renderer does with it.
    """

    def __init__(self):
        self.posts = []
        self.edits = []

    async def post_rich(self, channel, agent, content, thread):
        self.posts.append((channel, content, thread))
        return f"{channel}:activity.1"

    async def update_rich(self, channel, post, content):
        self.edits.append((channel, post, content))


async def test_a_running_turn_is_published_for_a_real_session(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )

    await publisher.publish_pending()

    assert len(activity_platform.posts) == 1
    channel, content, thread = activity_platform.posts[0]
    assert channel == "channel-demo"
    assert content.turn.turn_id == "turn-demo"
    assert content.turn.status == "running"
    assert activity_platform.edits == []


async def test_an_unchanged_turn_is_not_redrawn_on_the_next_cycle(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )
    await publisher.publish_pending()
    assert len(activity_platform.posts) == 1

    # Something else in the session changes — nothing to do with the turn
    # already drawn — so the publisher revisits it.
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "notice",
                "level": "info",
                "code": "TEST",
                "message": "still running",
            },
        ),
    )
    await publisher.publish_pending()

    assert len(activity_platform.posts) == 1
    assert activity_platform.edits == []


async def test_a_bridge_with_no_turn_activity_adapter_still_publishes_cards(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    cards_platform = Platform()
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, cards_platform)
    )

    await publisher.publish_pending()

    assert len(cards_platform.posts) == 1

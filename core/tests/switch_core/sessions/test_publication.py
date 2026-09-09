from sqlalchemy import select

from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.inbound import SessionInteractions
from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.bridges.collaboration.session.renderers import ANSWER_ACTION
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.publication import refresh_cards

from .test_authority import host_event, opened, setup


class Platform:
    def __init__(self):
        self.posts = []
        self.edits = []

    async def post_blocks(self, channel, agent, text, blocks, thread):
        self.posts.append((channel, text, blocks, thread))
        return f"{channel}:111.0"

    async def update_blocks(self, channel, post, text, blocks):
        self.edits.append((channel, post, text, blocks))


async def test_card_callback_reservation_and_confirmed_settlement(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = Platform()
    posts = SessionRequestPostStore()
    cards = SessionRequestCards(
        platform, bridge_id="bridge", posts=posts, session_factory=session_factory
    )
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    assert len(platform.posts) == 1
    assert platform.posts[0][0] == "channel-demo"
    async with session_factory() as db:
        post = await db.scalar(select(SessionRequestPost))
        db.expunge(post)

    async def identify(interaction):
        return "@owner:example.test"

    async def first_reply(channel, root, message):
        return False

    interactions = SessionInteractions(
        bridge_id="bridge",
        surface="slack",
        posts=posts,
        session_factory=session_factory,
        identify=identify,
        is_first_reply=first_reply,
    )
    command = await interactions.command_for(
        InboundInteraction(
            channel_id="channel-demo",
            sender_id="platform-owner",
            sender_name="Owner",
            action_id=f"{ANSWER_ACTION}:allow-once",
            value=post.token,
            message_ref=post.external_post_id,
        )
    )
    assert command is not None
    await service.submit(command, user_id=None, bridge_id="bridge")
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    assert "answering" in platform.edits[-1][2].lower()
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert command in pending
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "request.settled",
                "requestId": command.body.request_id,
                "revision": 2,
                "outcome": "answered",
                "commandId": command.command_id,
                "result": command.body.answer.model_dump(by_alias=True),
            },
        ),
    )
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    assert "@owner:example.test" in platform.edits[-1][2]
    assert "slack" in platform.edits[-1][2].lower()
    assert len(platform.posts) == 1

import pytest
from sqlalchemy import select

from switch_core.bridges.collaboration.adapter import RequestCard
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.inbound import SessionInteractions
from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.bridges.collaboration.session.renderers import ANSWER_ACTION
from switch_core.bridges.collaboration.session.renderers.slack import render_request
from switch_core.db.models import (
    BridgeMessageMap,
    ExternalUser,
    SdkSessionCommand,
    SessionRequestPost,
    require_tenant_id,
)
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.publication import refresh_cards
from switch_core.sessions.service import SessionError

from .test_authority import answer, host_event, opened, setup


class Platform:
    """A `post_rich` / `update_rich` implementation, not a real adapter.

    Renders with the real Slack renderer so the text these tests assert on
    (who answered, what surface, what the card said) is genuine, while
    `posts` / `edits` stay the same shape callers here always checked:
    (channel, text, blocks, thread) and (channel, post, text, blocks).
    """

    def __init__(self):
        self.posts = []
        self.edits = []

    async def post_rich(self, channel, agent, content: RequestCard, thread):
        message = render_request(
            content.request,
            content.reference,
            responder_external_id=content.responder_external_id,
            unavailable_reason=content.unavailable_reason,
        )
        self.posts.append((channel, message.text, message.blocks, thread))
        return f"{channel}:111.0"

    async def update_rich(self, channel, post, content: RequestCard):
        message = render_request(
            content.request,
            content.reference,
            responder_external_id=content.responder_external_id,
            unavailable_reason=content.unavailable_reason,
        )
        self.edits.append((channel, post, message.text, message.blocks))


async def test_card_callback_reservation_and_confirmed_settlement(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    async with session_factory() as db:
        external = await db.scalar(
            select(ExternalUser).where(
                ExternalUser.external_user_id == "platform-owner"
            )
        )
        external.external_user_id = "UOWNER123"
        await db.commit()
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
    assert "<@UOWNER123>" in platform.edits[-1][2]
    assert "@owner:example.test" not in platform.edits[-1][2]
    blocks = platform.edits[-1][3]
    assert len(blocks) == 1
    assert blocks[0]["type"] == "plan"
    assert blocks[0]["block_id"] == f"switch-request:{post.token}"
    assert "Allow once" in platform.edits[-1][2]
    assert len(platform.posts) == 1


@pytest.mark.parametrize("thread", [None, "sw_thread"])
async def test_permission_uses_activity_thread_and_persists_it(session_factory, thread):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    async with session_factory() as db:
        row = await db.get(
            SdkSessionCommand, (require_tenant_id(), "session-demo", "message-demo")
        )
        payload = dict(row.command)
        payload["origin"] = {
            **payload["origin"],
            "messageId": "sw_message",
            "threadId": thread,
        }
        row.command = payload
        for internal, external in [
            ("sw_message", "channel-demo:100.1"),
            ("sw_thread", "channel-demo:100.0"),
        ]:
            db.add(
                BridgeMessageMap(
                    bridge_id="bridge",
                    external_channel_id="channel-demo",
                    transport_event_id=internal,
                    external_post_id=external,
                )
            )
        await db.commit()
    platform = Platform()
    cards = SessionRequestCards(
        platform,
        bridge_id="bridge",
        posts=SessionRequestPostStore(),
        session_factory=session_factory,
    )
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    expected = "channel-demo:100.0" if thread else "channel-demo:100.1"
    assert platform.posts[0][3] == expected
    async with session_factory() as db:
        post = await db.scalar(select(SessionRequestPost))
        assert post.thread_id == expected

    reply = answer(epoch, "thread-answer", actor="@owner:example.test", surface="slack")
    for wrong_thread in ["different-thread", "sw_message", None]:
        wrong = reply.model_copy(
            update={
                "origin": reply.origin.model_copy(update={"thread_id": wrong_thread})
            }
        )
        with pytest.raises(SessionError) as failure:
            await service.submit(wrong, user_id=None, bridge_id="bridge")
        assert failure.value.code == "NOT_AUTHORIZED"
    reply = reply.model_copy(
        update={"origin": reply.origin.model_copy(update={"thread_id": expected})}
    )
    assert (
        await service.submit(reply, user_id=None, bridge_id="bridge")
    ).status == "accepted"

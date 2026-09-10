from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api.session_routes import router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_collab_lifecycle,
    get_session_factory,
)
from switch_core.bridges.collaboration.adapter import RichContentFailed
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.session.outbound import (
    CardNotPosted,
    SessionRequestCards,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import ClientRoom, Room, SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.publication import SessionPublisher, refresh_cards

from .test_authority import EXAMPLES, command, host_event, opened, setup
from .test_publication import Platform


class RecoverablePlatform(Platform):
    async def find_request_card(self, channel, thread, token, created_at):
        for posted_channel, text, blocks, posted_thread in self.posts:
            if (
                posted_channel == channel
                and posted_thread == thread
                and blocks[0].get("block_id") == f"switch-request:{token}"
            ):
                return f"{channel}:111.0"
        return None


def cards_for(factory, platform):
    return SessionRequestCards(
        platform,
        bridge_id="bridge",
        posts=SessionRequestPostStore(),
        session_factory=factory,
    )


async def test_host_ack_and_retry_survive_publication_failure(
    session_factory, monkeypatch, caplog
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )
    bridge = SimpleNamespace(_session_publisher=publisher)

    async def notify(session_id):
        await BridgeCore.refresh_sdk_session(bridge, session_id)

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_agent_from_scope] = lambda: SimpleNamespace(
        id="agent-demo"
    )
    app.dependency_overrides[get_collab_lifecycle] = lambda: SimpleNamespace(
        refresh_sdk_session=notify
    )
    event = host_event(
        epoch,
        3,
        {"type": "notice", "level": "info", "code": "TEST", "message": "still running"},
    )
    with monkeypatch.context() as patch:
        failed_post = AsyncMock(side_effect=RichContentFailed("nope", text="nope"))
        patch.setattr(platform, "post_rich", failed_post)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/sessions/events?host_id=host-demo",
                json=event.model_dump(by_alias=True),
            )
            assert response.status_code == 200
            assert response.json() == {"throughHostSequence": 3}
            failed_post.assert_not_awaited()
            await publisher.publish_pending()
            failed_post.assert_awaited_once()
            assert "will retry" in caplog.text
            assert (
                await service.snapshot("session-demo", "owner")
            ).session.connectivity == "online"
    await publisher.publish_pending()
    assert len(platform.posts) == 1
    # A restarted bridge can reconcile persisted state without another host event.
    restarted = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )
    await restarted.publish_pending()
    assert len(platform.posts) == 1
    assert len(platform.edits) == 1


async def test_revoked_historical_room_does_not_block_other_cards(
    session_factory, caplog
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    cards = cards_for(session_factory, platform)
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "request.settled",
                "requestId": "request-demo",
                "revision": 2,
                "outcome": "interrupted",
                "commandId": None,
                "result": None,
            },
        ),
    )
    async with session_factory() as db, db.begin():
        await db.delete(await db.get(ClientRoom, ("agent-client", "room-demo")))
        db.add(
            Room(
                id="other-room",
                matrix_room_id="!other:example.test",
                name="Other",
                description="",
                bridge_id="bridge",
                external_channel_id="other-channel",
            )
        )
        await db.flush()
        db.add(ClientRoom(client_id="agent-client", room_id="other-room"))
    message = command(
        epoch,
        "other-message",
        {
            "type": "message.send",
            "text": "Continue",
            "attachments": [],
            "delivery": "queue",
        },
    )
    message = message.model_copy(
        update={"origin": message.origin.model_copy(update={"room_id": "other-room"})}
    )
    await service.submit(message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            4,
            {
                "type": "turn.upsert",
                "turnId": "other-turn",
                "commandId": "other-message",
                "status": "running",
            },
        ),
    )
    request = {
        **EXAMPLES["hostRequest"]["body"]["request"],
        "requestId": "other-request",
        "turnId": "other-turn",
    }
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 5, {"type": "request.opened", "request": request}),
    )
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    assert [post[0] for post in platform.posts] == ["channel-demo", "other-channel"]
    assert platform.edits == []
    assert "agent left room" in caplog.text


async def test_commit_failure_recovers_original_card_after_restart(
    session_factory, monkeypatch
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    original_commit = AsyncSession.commit
    commits = 0

    async def fail_confirmation(db):
        nonlocal commits
        commits += 1
        if commits == 2:
            raise RuntimeError("Confirmation commit failed")
        await original_commit(db)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncSession, "commit", fail_confirmation)
        with pytest.raises(RuntimeError, match="Confirmation commit failed"):
            await refresh_cards(
                session_factory,
                "bridge",
                "session-demo",
                cards_for(session_factory, platform),
            )
    async with session_factory() as db:
        post = (await db.scalars(select(SessionRequestPost))).one()
        assert post.external_post_id == post.token
        token = post.token
    assert len(platform.posts) == 1
    await refresh_cards(
        session_factory, "bridge", "session-demo", cards_for(session_factory, platform)
    )
    async with session_factory() as db:
        post = (await db.scalars(select(SessionRequestPost))).one()
        assert post.token == token
        assert post.external_post_id == "channel-demo:111.0"
    assert len(platform.posts) == 1
    assert len(platform.edits) == 1


async def test_uncertain_delivery_is_not_blindly_reposted(session_factory, monkeypatch):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    cards = cards_for(session_factory, platform)
    with monkeypatch.context() as patch:
        patch.setattr(
            platform,
            "post_rich",
            AsyncMock(side_effect=TimeoutError("response lost")),
        )
        with pytest.raises(TimeoutError):
            await refresh_cards(session_factory, "bridge", "session-demo", cards)
    with pytest.raises(CardNotPosted, match="unconfirmed"):
        await refresh_cards(
            session_factory,
            "bridge",
            "session-demo",
            cards_for(session_factory, platform),
        )
    assert platform.posts == []
    async with session_factory() as db:
        post = (await db.scalars(select(SessionRequestPost))).one()
        assert post.external_post_id == post.token


@pytest.mark.parametrize("thread", [None, "channel:100.0"])
async def test_slack_recovery_pages_and_requires_own_bot(thread):
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="workspace"
        )
    )
    adapter._bot_user_id = "our-bot"
    adapter._bot_id = "our-bot-id"
    fake = {
        "ts": "101.0",
        "user": "another-bot",
        "blocks": [{"block_id": "switch-request:token"}],
    }
    real = {**fake, "ts": "102.0", "user": "our-bot"}
    read = AsyncMock(
        side_effect=[
            {"messages": [fake], "response_metadata": {"next_cursor": "next"}},
            {"messages": [real], "response_metadata": {}},
        ]
    )
    client = SimpleNamespace(conversations_history=read, conversations_replies=read)
    adapter._web_client = client
    assert (
        await adapter.find_request_card(
            "channel", thread, "token", datetime(2026, 1, 1, tzinfo=UTC)
        )
        == "channel:102.0"
    )
    assert read.await_count == 2
    assert read.await_args.kwargs["cursor"] == "next"
    if thread:
        assert read.await_args.kwargs["ts"] == "100.0"

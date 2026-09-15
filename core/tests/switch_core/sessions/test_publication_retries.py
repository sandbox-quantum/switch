import logging
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
from switch_core.sessions import publication
from switch_core.sessions.publication import (
    PublicationIncomplete,
    SessionPublisher,
    _RecoveryBackoff,
    refresh_cards,
)

from .test_authority import EXAMPLES, answer, command, host_event, opened, setup
from .test_publication import Platform


class RecoverablePlatform(Platform):
    """A platform that can read its own history back, as Slack's adapter can.

    The flag is what the publisher reads before deciding whether an uncertain
    delivery is worth searching for again, so a fake that implements the search
    has to declare it too or it is treated as a platform that cannot look.
    """

    recovers_uncertain_posts = True

    async def find_request_card(self, channel, thread, token, created_at, handle):
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
        surface="slack",
        posts=SessionRequestPostStore(),
        session_factory=factory,
    )


async def test_host_ack_and_retry_survive_publication_failure(
    session_factory, monkeypatch, caplog
):
    """What a refused first post must not cost: the host's acknowledgement.

    The floor on the publisher's post backoff is taken out of the way so the
    retry happens on the very next cycle. That the backoff is there at all is
    `test_a_card_that_cannot_be_posted_is_not_retried_every_cycle`'s claim;
    this one is about the ack surviving and the card arriving in the end.
    """
    monkeypatch.setattr(_RecoveryBackoff, "_MIN", 0.0)
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


class UnsearchablePlatform(Platform):
    """A platform with no way to look for a message it may have posted.

    Telegram is the real one: a bot cannot read a chat's history, so a send
    whose response was lost can never be matched to what is in the chat. It
    also declines to linkify a `switchdash://` URL, so the Console link in the
    notice has to be the gateway's https redirect to be a link at all.

    It is also the one platform cleared to say so in the channel, which is a
    separate flag on purpose — see `UndisclosingPlatform`.
    """

    renders_custom_url_schemes = False
    discloses_unconfirmed_posts = True

    def __init__(self):
        super().__init__()
        self.notices = []

    async def admin_message(self, channel, content, thread=None, *, message_type=None):
        self.notices.append((channel, content, thread))
        return f"{channel}:333.0"


class UndisclosingPlatform(UnsearchablePlatform):
    """Cannot search either, and has not been cleared to say so in the channel.

    Teams is the real one. The notice writes an unrequested message into a
    conversation this bridge does not own, and whether that is wanted is a
    decision about the channel rather than a fact about the adapter.
    """

    discloses_unconfirmed_posts = False


async def _lose_the_card(session_factory, platform, monkeypatch):
    """Reserve a card, then lose the response to the post that would confirm it."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    with monkeypatch.context() as patch:
        patch.setattr(
            platform,
            "post_rich",
            AsyncMock(side_effect=TimeoutError("response lost")),
        )
        with pytest.raises(TimeoutError):
            await refresh_cards(
                session_factory,
                "bridge",
                "session-demo",
                cards_for(session_factory, platform),
            )


async def test_a_card_that_can_never_be_found_is_disclosed_rather_than_left_silent(
    session_factory, monkeypatch
):
    """The reservation stays, the card is not posted twice, and Console is named.

    On a platform that can search, an unconfirmed delivery is a wait. Here it
    is permanent, and the card — if it arrived at all — asks a question that
    typing an answer to does nothing about. That is the failure mode the error
    rules rank worst, so the channel is told once and pointed somewhere the
    request can actually be answered.
    """
    platform = UnsearchablePlatform()
    await _lose_the_card(session_factory, platform, monkeypatch)

    await refresh_cards(
        session_factory,
        "bridge",
        "session-demo",
        cards_for(session_factory, platform),
        gateway_public_url="https://switch.example",
    )

    assert platform.posts == []
    channel, notice, thread = platform.notices[0]
    assert channel == "channel-demo"
    assert "R1" in notice
    assert "https://switch.example/deeplink/session?" in notice
    async with session_factory() as db:
        post = (await db.scalars(select(SessionRequestPost))).one()
        # Retained, and still its own token: the handle stays held, no second
        # card is ever posted, and a typed answer is still refused.
        assert post.external_post_id == post.token
        assert post.unconfirmed_notice_at is not None


async def test_the_channel_is_told_once_however_many_times_the_session_republishes(
    session_factory, monkeypatch, caplog
):
    """A second notice would say nothing the first did not.

    This runs on every publication cycle for as long as the request is open,
    so "once" has to survive both the loop and a bridge that restarts and
    remembers nothing — which is why the record of it is on the row.
    """
    platform = UnsearchablePlatform()
    await _lose_the_card(session_factory, platform, monkeypatch)

    for _ in range(3):
        await refresh_cards(
            session_factory,
            "bridge",
            "session-demo",
            cards_for(session_factory, platform),
        )

    assert len(platform.notices) == 1
    assert platform.posts == []
    # Disclosed is a settled state, not a failure to report again every cycle.
    assert "will retry" not in caplog.text


async def test_a_notice_that_cannot_be_sent_is_not_retried_into_a_cascade(
    session_factory, monkeypatch, caplog
):
    """The notice can fail too, and its failure must not become the new loop.

    One attempt is made, and the row records that it was made before it is
    tried: a notice lost this way is a card that stays undisclosed, which is
    where this started, rather than a message the publisher keeps re-sending.
    """
    platform = UnsearchablePlatform()
    await _lose_the_card(session_factory, platform, monkeypatch)
    refused = AsyncMock(return_value=None)

    with monkeypatch.context() as patch:
        patch.setattr(platform, "admin_message", refused)
        await refresh_cards(
            session_factory,
            "bridge",
            "session-demo",
            cards_for(session_factory, platform),
        )
    await refresh_cards(
        session_factory,
        "bridge",
        "session-demo",
        cards_for(session_factory, platform),
    )

    refused.assert_awaited_once()
    assert platform.notices == []
    assert "nothing in the channel says so" in caplog.text


async def test_a_platform_not_cleared_to_disclose_says_nothing_in_the_channel(
    session_factory, monkeypatch, caplog
):
    """Being unable to search does not, by itself, authorise the notice.

    The two used to be one flag, so a new platform declaring it could not look
    for a lost card silently started posting an unrequested message into its
    channels. Here the reservation is kept — no second card, and the request is
    still answerable in Console — and the operator is told once.
    """
    platform = UndisclosingPlatform()
    await _lose_the_card(session_factory, platform, monkeypatch)
    cards = cards_for(session_factory, platform)

    with caplog.at_level(logging.ERROR):
        for _ in range(3):
            await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert platform.notices == []
    assert platform.posts == []
    assert len([r for r in caplog.records if "never confirmed" in r.message]) == 1
    async with session_factory() as db:
        post = (await db.scalars(select(SessionRequestPost))).one()
        assert post.external_post_id == post.token
        # Not stamped: the mark means the channel was told, and it has to stay
        # true so the notice can still be made once a policy is agreed.
        assert post.unconfirmed_notice_at is None


async def test_a_platform_that_can_search_still_waits_for_its_card(
    session_factory, monkeypatch
):
    """The disclosure is for platforms with nowhere to look, and only those.

    Slack's lookup finds the card the lost response belonged to, so nothing is
    disclosed and nothing is posted twice — the same outcome as before.
    """
    platform = RecoverablePlatform()
    await _lose_the_card(session_factory, platform, monkeypatch)

    with pytest.raises(CardNotPosted, match="unconfirmed"):
        await refresh_cards(
            session_factory,
            "bridge",
            "session-demo",
            cards_for(session_factory, platform),
        )

    async with session_factory() as db:
        post = (await db.scalars(select(SessionRequestPost))).one()
        assert post.unconfirmed_notice_at is None


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
            "channel", thread, "token", datetime(2026, 1, 1, tzinfo=UTC), "R7"
        )
        == "channel:102.0"
    )
    assert read.await_count == 2
    assert read.await_args.kwargs["cursor"] == "next"
    if thread:
        assert read.await_args.kwargs["ts"] == "100.0"


# ── A stuck card no longer blocks the rest of its session ──────────────────


async def test_a_stuck_cards_post_does_not_block_a_sibling_request(session_factory):
    """Two open requests in one session; only one of them can ever post.

    Before this, `refresh_cards` aborted its loop on the first exception, so
    the second request — reached later in `snapshot.requests` order — was
    never even attempted while the first kept failing.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)  # request-demo / turn-demo, in channel-demo

    request = {
        **EXAMPLES["hostRequest"]["body"]["request"],
        "requestId": "other-request",
        "turnId": "other-turn",
    }
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
    await service.submit(message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "turn.upsert",
                "turnId": "other-turn",
                "commandId": "other-message",
                "status": "running",
            },
        ),
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 4, {"type": "request.opened", "request": request}),
    )

    platform = RecoverablePlatform()
    real_post_rich = platform.post_rich

    async def flaky_post_rich(channel, agent, content, thread):
        if content.request.request_id == "request-demo":
            raise RichContentFailed("nope", text="nope")
        return await real_post_rich(channel, agent, content, thread)

    platform.post_rich = flaky_post_rich
    cards = cards_for(session_factory, platform)

    # Only the one request failed, so what propagates is its own exception
    # (post() turns a refused post into CardNotPosted) rather than a wrapped
    # one — the point of this test is what happened to its sibling, below.
    with pytest.raises(CardNotPosted):
        await refresh_cards(session_factory, "bridge", "session-demo", cards)

    # The stuck one never posted; its sibling, reached after it in the loop,
    # did — which is exactly what aborting on the first failure would miss.
    assert [post[0] for post in platform.posts] == ["channel-demo"]


async def test_two_failed_requests_in_one_session_raise_one_aggregate_error(
    session_factory,
):
    """Two exceptions cannot both propagate as themselves, so when more than
    one request in a session fails, what comes out names the count rather
    than picking one of them arbitrarily."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)

    request = {
        **EXAMPLES["hostRequest"]["body"]["request"],
        "requestId": "other-request",
        "turnId": "other-turn",
    }
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
    await service.submit(message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "turn.upsert",
                "turnId": "other-turn",
                "commandId": "other-message",
                "status": "running",
            },
        ),
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 4, {"type": "request.opened", "request": request}),
    )

    platform = RecoverablePlatform()
    platform.post_rich = AsyncMock(side_effect=RichContentFailed("nope", text="nope"))
    cards = cards_for(session_factory, platform)

    with pytest.raises(PublicationIncomplete, match="2 request.s. failed to publish"):
        await refresh_cards(session_factory, "bridge", "session-demo", cards)
    assert platform.posts == []


# ── Recovery stops hammering a card that never confirms ─────────────────────


def test_recovery_backoff_widens_and_resets_on_success(monkeypatch):
    clock = 0.0

    def fake_monotonic() -> float:
        return clock

    monkeypatch.setattr(publication.time, "monotonic", fake_monotonic)
    backoff = _RecoveryBackoff()

    assert backoff.allowed("token") is True
    assert backoff.allowed("token") is False  # still within the first interval

    clock += _RecoveryBackoff._MIN
    assert backoff.allowed("token") is True  # first interval elapsed
    assert backoff.allowed("token") is False  # the interval doubled

    clock += _RecoveryBackoff._MIN * 2
    assert backoff.allowed("token") is True

    backoff.succeeded("token")
    assert (
        backoff.allowed("token") is True
    )  # cleared, not still waiting out the old one


def test_recovery_backoff_is_tracked_per_token(monkeypatch):
    monkeypatch.setattr(publication.time, "monotonic", lambda: 0.0)
    backoff = _RecoveryBackoff()

    assert backoff.allowed("a") is True
    assert backoff.allowed("b") is True
    assert backoff.allowed("a") is False
    assert backoff.allowed("b") is False


async def test_the_publisher_does_not_re_search_every_cycle_for_a_card_that_never_lands(
    session_factory, monkeypatch
):
    """A card whose post genuinely never landed used to re-scan the channel's
    history every publish cycle, forever. The publisher's backoff means a
    cycle straight after the last one does not attempt it again."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    cards = cards_for(session_factory, platform)
    publisher = SessionPublisher(session_factory, "bridge", cards)

    # The post itself is lost (a timeout, not a clean refusal), leaving the
    # reservation committed but unconfirmed — `post()` writes that row before
    # it ever calls the platform, which is exactly the durability this is
    # meant to let a publisher recover from.
    with monkeypatch.context() as patch:
        patch.setattr(
            platform, "post_rich", AsyncMock(side_effect=TimeoutError("lost"))
        )
        await publisher.publish_pending()
    async with session_factory() as db:
        post = (await db.scalars(select(SessionRequestPost))).one()
        assert post.external_post_id == post.token

    find = AsyncMock(return_value=None)
    monkeypatch.setattr(platform, "find_request_card", find)

    await publisher.publish_pending()
    assert find.await_count == 1

    await publisher.publish_pending()
    assert find.await_count == 1  # backing off; not attempted again immediately


async def test_a_card_that_cannot_be_posted_is_not_retried_every_cycle(
    session_factory, monkeypatch, caplog
):
    """A refused post leaves no row, so the next cycle sees a request with no
    card and reserves, posts and releases all over again — at whatever rate
    the publisher runs, against a destination that is saying no. The first
    post of a card is on the same backoff the recovery search is, so a
    channel the bot has been removed from costs one attempt and then a
    widening wait rather than a permanent spin."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    refused = AsyncMock(side_effect=RichContentFailed("no such channel", text="gone"))
    monkeypatch.setattr(platform, "post_rich", refused)
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )

    await publisher.publish_pending()
    assert refused.await_count == 1
    async with session_factory() as db:
        # Refused outright, so the handle went back rather than being held
        # against a card nobody can see.
        assert (await db.scalars(select(SessionRequestPost))).all() == []

    caplog.clear()
    await publisher.publish_pending()
    assert refused.await_count == 1
    assert "waiting out a retry backoff" in caplog.text


async def test_a_destination_that_never_takes_the_card_is_given_up_on(
    session_factory, monkeypatch, caplog
):
    """The widening wait bounds how often a refused post costs a reservation
    and a released handle. On its own it never ends: a deleted channel is
    posted to every ten minutes for as long as the request is open, and the
    session it belongs to reports the same failure over whatever is new. Once
    the wait has stretched as far as it goes the card is given up on, with one
    record of where the request can still be answered."""
    clock = 0.0

    def fake_monotonic() -> float:
        return clock

    monkeypatch.setattr(publication.time, "monotonic", fake_monotonic)
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    refused = AsyncMock(side_effect=RichContentFailed("no such channel", text="gone"))
    monkeypatch.setattr(platform, "post_rich", refused)
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )

    for _ in range(12):
        clock += _RecoveryBackoff._MAX + 1.0
        await publisher.publish_pending()

    # Doubling from five seconds, the seventh attempt is the one that stretches
    # the wait to the ten-minute cap, and its own refusal is the last.
    assert refused.await_count == 7
    assert caplog.text.count("Giving up posting the card") == 1
    async with session_factory() as db:
        assert (await db.scalars(select(SessionRequestPost))).all() == []

    caplog.clear()
    clock += _RecoveryBackoff._MAX + 1.0
    await publisher.publish_pending()
    assert refused.await_count == 7
    # Nor is it still counted against the session, which would have it report
    # a failure that has been dealt with as well as it can be on every cycle.
    assert "card publication failed" not in caplog.text


# ── A confirmed card is only redrawn when something about it changed ────────


async def test_a_confirmed_card_is_not_redrawn_when_nothing_about_it_changed(
    session_factory,
):
    """A session publishing again — because something else about it changed,
    a new host event bumping its sequence — must not redraw a card whose own
    request is untouched by that change.

    Through the same `SessionPublisher`, which is what actually retries on a
    fixed cycle and is what the redraw guard is scoped to — a bare
    `refresh_cards` call always confirms what it is given, on the assumption
    that a caller reaching for it directly wants exactly that.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )

    await publisher.publish_pending()
    assert len(platform.posts) == 1
    assert platform.edits == []

    # Something else in the session changes — nothing to do with the request
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
    assert platform.edits == []


async def test_a_stuck_siblings_backoff_does_not_redraw_a_confirmed_card_either(
    session_factory, monkeypatch
):
    """The exact shape review found: a session with one good card and one
    that never confirms must not keep re-sending the good one every cycle
    while the publisher waits out the bad one's recovery backoff."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)  # request-demo, posts fine

    request = {
        **EXAMPLES["hostRequest"]["body"]["request"],
        "requestId": "other-request",
        "turnId": "other-turn",
    }
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
    await service.submit(message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "turn.upsert",
                "turnId": "other-turn",
                "commandId": "other-message",
                "status": "running",
            },
        ),
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 4, {"type": "request.opened", "request": request}),
    )

    platform = RecoverablePlatform()
    real_post_rich = platform.post_rich

    async def flaky_post_rich(channel, agent, content, thread):
        if content.request.request_id == "other-request":
            raise TimeoutError("lost")
        return await real_post_rich(channel, agent, content, thread)

    platform.post_rich = flaky_post_rich
    cards = cards_for(session_factory, platform)
    publisher = SessionPublisher(session_factory, "bridge", cards)

    await (
        publisher.publish_pending()
    )  # request-demo posts; other-request left unconfirmed
    assert len(platform.posts) == 1

    monkeypatch.setattr(platform, "find_request_card", AsyncMock(return_value=None))
    await publisher.publish_pending()  # a real recovery attempt for other-request
    await publisher.publish_pending()  # now backing off

    # request-demo's revision never changed, so it is never touched again —
    # only other-request's own recovery is retried.
    assert platform.edits == []


async def test_a_pure_backoff_wait_logs_a_warning_not_an_exception(
    session_factory, monkeypatch, caplog
):
    """A card waiting out its own recovery backoff is working as designed,
    not a fresh failure — it must not read as one on every retry."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    cards = cards_for(session_factory, platform)
    publisher = SessionPublisher(session_factory, "bridge", cards)

    with monkeypatch.context() as patch:
        patch.setattr(
            platform, "post_rich", AsyncMock(side_effect=TimeoutError("lost"))
        )
        await publisher.publish_pending()

    monkeypatch.setattr(platform, "find_request_card", AsyncMock(return_value=None))
    with caplog.at_level(logging.WARNING):
        await publisher.publish_pending()  # a real recovery attempt: a genuine failure
        caplog.clear()
        await publisher.publish_pending()  # backed off: nothing new went wrong

    assert not any(record.levelname == "ERROR" for record in caplog.records)
    assert any(
        record.levelname == "WARNING"
        and "waiting out a retry backoff" in record.message
        for record in caplog.records
    )


async def test_a_request_moved_to_submitting_is_redrawn_though_its_revision_did_not_move(
    session_factory,
):
    """`request.submitting` moves a request from `open` to `submitting` — the
    card loses its buttons and gains "Answering: ..." — at the *same*
    revision the answer was accepted at; only settling it bumps the
    revision. A guard keyed on revision alone would see this as unchanged
    and leave the card looking answerable, with working buttons, for as
    long as deciding the answer takes."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = RecoverablePlatform()
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )

    await publisher.publish_pending()
    assert len(platform.posts) == 1
    assert platform.edits == []

    # Switch itself emits `request.submitting` the moment it accepts an
    # answer — before the host has confirmed anything — so this is
    # triggered the same way a real press or typed answer would.
    await service.submit(
        answer(epoch, "answer-demo", actor="@owner:example.test", surface="slack"),
        user_id=None,
        bridge_id="bridge",
    )
    await publisher.publish_pending()
    assert len(platform.edits) == 1

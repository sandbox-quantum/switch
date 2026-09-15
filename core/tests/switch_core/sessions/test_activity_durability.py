"""Restart and uncertain-delivery tests using real PostgreSQL checkpoints."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import pytest
from mattermostdriver.exceptions import NotEnoughPermissions
from sqlalchemy import select

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.session.activity_journal import ActivityJournal
from switch_core.bridges.collaboration.session.outbound import (
    CardNotPosted,
    SessionTurnActivity,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import SdkSession, SessionActivityPost, require_tenant_id
from switch_core.sessions import publication
from switch_core.sessions.publication import SessionPublisher

from ..bridges.collaboration.test_mattermost_sdk_only import (
    _adapter as mattermost_adapter,
)
from ..bridges.collaboration.test_mattermost_sdk_only import _http_error
from ..bridges.collaboration.test_mattermost_sdk_only import _posts as mm_posts
from ..bridges.collaboration.test_session_activity import _items, _turn
from .test_authority import host_event, opened, setup
from .test_publication import Platform
from .test_publication_retries import cards_for


class ActivitySlack(SlackAdapter):
    def __init__(self):
        super().__init__(
            config=SlackConnectionConfig(
                bot_token="test", app_token="test", workspace_id="T1"
            )
        )
        self.messages = {}
        self.post_count = 0
        self.edit_refs = []
        self.reactions = set()
        self.fail_after_post = False

    async def post_rich(self, channel, agent, content, thread):
        self.post_count += 1
        ref = f"{channel}:{self.post_count}"
        self.messages[ref] = self._render_rich(content)
        if self.fail_after_post:
            self.fail_after_post = False
            raise TimeoutError("Response lost after Slack accepted the post")
        return ref

    async def update_rich(self, channel, agent, ref, content):
        assert ref in self.messages
        self.edit_refs.append(ref)
        self.messages[ref] = self._render_rich(content)

    async def find_request_card(self, channel, thread, token, created_at, handle):
        for ref, message in self.messages.items():
            if any(
                block.get("block_id") == f"switch-request:{token}"
                for block in message.blocks
            ):
                return ref
        return None

    async def mark_activity(self, channel, ref, *, agent_name, working, force=False):
        if working:
            self.reactions.add(ref)
        else:
            self.reactions.discard(ref)


class UnsearchablePlatform(ActivitySlack):
    """A platform that cannot read its own history back, as Telegram cannot.

    Everything else about it is the Slack fake above: what changes is only the
    answer to "can an unacknowledged post be found again", and that is what
    decides whether an uncertain delivery is something to wait for or something
    that will never resolve.
    """

    recovers_uncertain_posts = False


class UnmarkedPlatform(ActivitySlack):
    """Discord's shape: it searches, but only for what prints its own handle.

    A webhook message carries no metadata this bridge can set, so a card is
    recognised by the handle printed on it and a turn's messages, which print
    none, cannot be recognised at all. That is a different thing from Telegram
    having nowhere to look, and it has to be told apart from a search that
    simply has not found the message yet.
    """

    carries_publication_marker = False

    def __init__(self):
        super().__init__()
        self.lookups = 0

    async def find_request_card(self, channel, thread, token, created_at, handle):
        self.lookups += 1
        return await super().find_request_card(
            channel, thread, token, created_at, handle
        )


class PerAgentSlack(ActivitySlack):
    """A platform where each agent marks the message as its own bot.

    Mattermost is the real one: an agent's `:eyes:` is added by that agent's
    own bot account, so two agents working the same message leave two separate
    marks. Slack's single bot leaves one between them, which is why this is a
    capability and not the default.
    """

    activity_reactions_per_agent = True

    def __init__(self):
        super().__init__()
        self.reactions = set()

    async def mark_activity(self, channel, ref, *, agent_name, working, force=False):
        if working:
            self.reactions.add((agent_name, ref))
        else:
            self.reactions.discard((agent_name, ref))


OUTBOUND_LOGGER = "switch_core.bridges.collaboration.session.outbound"

#: Longer than the publisher's longest wait before it retries a turn it could
#: not draw, so a sweep in a test is never the one that is skipped.
PAST_THE_RETRY_BACKOFF = 60.0


def activity(factory, platform):
    return SessionTurnActivity(platform, journal=ActivityJournal(factory, "bridge"))


async def publish(
    renderer, status="running", *, tools=True, agent="Agent", command="message-demo"
):
    turn = _turn(status).model_copy(update={"command_id": command})
    return await renderer.publish(
        await _items() if tools else [],
        turn,
        session_id="session-demo",
        channel_id="channel-demo",
        thread_root_id="channel-demo:root",
        asked_on="channel-demo:question",
        agent_name=agent,
        elapsed_seconds=12,
    )


async def test_restart_reuses_status_and_log_and_does_not_repost_completion(
    session_factory,
):
    await setup(session_factory)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    assert platform.post_count == 2
    before = len(platform.edit_refs)
    await publish(activity(session_factory, platform))
    assert platform.post_count == 2
    # Restart/timer-only refresh must not collapse either unchanged disclosure.
    assert platform.edit_refs[before:] == []
    await publish(activity(session_factory, platform), "completed")
    assert set(platform.messages) == {"channel-demo:1", "channel-demo:2"}
    assert not platform.reactions
    await publish(activity(session_factory, platform), "completed")
    assert platform.post_count == 2


@pytest.mark.parametrize("slot", ["status", "log"])
async def test_lost_post_response_is_recovered_without_duplicate(session_factory, slot):
    await setup(session_factory)
    platform = ActivitySlack()
    original_post = platform.post_rich

    async def lose_response(channel, agent, content, thread):
        if content.tool_log == (slot == "log"):
            platform.fail_after_post = True
        return await original_post(channel, agent, content, thread)

    platform.post_rich = lose_response
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    platform.post_rich = original_post
    await publish(activity(session_factory, platform))
    assert platform.post_count == 2
    assert len(platform.messages) == 2


async def test_final_log_edit_failure_is_retried_after_restart(
    session_factory, monkeypatch
):
    await setup(session_factory)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    original = platform.update_rich

    async def fail_log(channel, agent, ref, content):
        if content.tool_log:
            raise TimeoutError("Final log edit failed")
        return await original(channel, agent, ref, content)

    with monkeypatch.context() as patch:
        patch.setattr(platform, "update_rich", fail_log)
        with pytest.raises(TimeoutError):
            await publish(activity(session_factory, platform), "completed")
    await publish(activity(session_factory, platform), "completed")
    assert set(platform.messages) == {"channel-demo:1", "channel-demo:2"}
    assert platform.post_count == 2
    assert not platform.reactions


async def test_competing_publishers_share_one_durable_anchor(session_factory):
    await setup(session_factory)
    platform = ActivitySlack()
    await asyncio.gather(
        publish(activity(session_factory, platform)),
        publish(activity(session_factory, platform)),
    )
    assert platform.post_count == 2


async def test_lease_expiry_hides_buttons_without_new_events_and_reconnect_restores_them(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = Platform()
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )
    await publisher.publish_pending()
    assert any(b["type"] == "actions" for b in platform.posts[0][2])
    async with session_factory() as db:
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()
    await publisher.publish_pending()
    assert "Host offline" in platform.edits[-1][2]
    assert not any(b["type"] == "actions" for b in platform.edits[-1][3])
    count = len(platform.edits)
    await publisher.publish_pending()
    assert len(platform.edits) == count
    # A new publisher also reconstructs the offline presentation from storage.
    publisher = SessionPublisher(
        session_factory, "bridge", cards_for(session_factory, platform)
    )
    await publisher.publish_pending()
    assert "Host offline" in platform.edits[-1][2]
    async with session_factory() as db:
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=60)
        await db.commit()
    await publisher.publish_pending()
    assert any(b["type"] == "actions" for b in platform.edits[-1][3])
    assert len(platform.posts) == 1


async def test_existing_older_turn_is_finished_after_restart_without_replaying_history(
    session_factory,
):
    from .test_authority import command, host_event

    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "completed",
                "commandId": "message-demo",
            },
        ),
    )
    await service.submit(
        command(
            epoch,
            "message-2",
            {
                "type": "message.send",
                "text": "Next",
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
            4,
            {
                "type": "turn.upsert",
                "turnId": "turn-2",
                "status": "running",
                "commandId": "message-2",
            },
        ),
    )
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        activity(session_factory, platform),
    )
    await publisher.publish_pending()
    assert "channel-demo:1" in platform.messages
    assert "channel-demo:2" in platform.messages
    assert platform.post_count == 4  # New turn creates a status and reserved tool log.
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        activity(session_factory, platform),
    )
    await publisher.publish_pending()
    assert platform.post_count == 4


async def test_unknown_delivery_without_a_match_never_blindly_reposts(session_factory):
    await setup(session_factory)
    platform = ActivitySlack()
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    platform.messages.clear()  # No match visible to the recovery lookup.
    with pytest.raises(CardNotPosted):
        await publish(activity(session_factory, platform))
    assert platform.post_count == 1


async def test_a_status_a_platform_cannot_search_is_never_posted_a_second_time(
    session_factory,
):
    """The other half of the test above, for a platform with nowhere to look.

    There the reservation is held because the lookup may yet find the message.
    Here no lookup exists, so the answer is the same and it is permanent: the
    send probably landed, nothing can confirm it, and posting again — on this
    cycle or on any of the hundreds after it — puts one more copy of the same
    status in the chat each time. The reservation stays and the turn keeps the
    status it may already have.

    What it does not do is refuse: the loss is the status slot's, and the turn
    around it still has work left, so each pass comes back having done as much
    as it can rather than as a failure to try again.
    """
    await setup(session_factory)
    platform = UnsearchablePlatform()
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    assert platform.post_count == 1

    for _ in range(3):
        assert await publish(activity(session_factory, platform)) is True
    assert platform.post_count == 1


async def test_a_status_nobody_can_confirm_is_written_off_once_and_not_again(
    session_factory,
):
    """The journal records the decision, not just the unfinished reservation.

    A slot holding a token and no reference is a question still being asked.
    One that has been given up on is a question closed, and the two look
    identical to anything reading the row afterwards — including a restart,
    which would otherwise report a months-old conclusion as though it had just
    reached it. The stamp is taken once and kept.
    """

    async def stamp():
        async with session_factory() as db:
            row = await db.scalar(select(SessionActivityPost))
            return row.data["status"].get("abandoned_at")

    await setup(session_factory)
    platform = UnsearchablePlatform()
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    assert await stamp() is None  # Unfinished, not yet given up on.

    await publish(activity(session_factory, platform))
    written_off = await stamp()
    assert written_off

    await publish(activity(session_factory, platform))
    assert await stamp() == written_off
    assert platform.post_count == 1


async def test_a_status_nobody_can_confirm_stops_being_reported_as_a_new_failure(
    session_factory, caplog
):
    """Said once, then left alone — the publisher has to be able to settle.

    Nothing about this turn can change: its status is either in the chat or it
    is not, and this platform cannot find out which. Treating that as a fresh
    failure on every cycle put a traceback in the log every few seconds for
    the life of the process, and kept the session out of the publisher's
    "nothing to do here" set, so its whole publication pass ran again each
    time. One warning is the right amount of noise for a permanent condition.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    # The state a lost response leaves behind, written directly: a reservation
    # with a token and no reference. Reaching it by timing a post out would
    # put the turn into a retry backoff first, and what is under test here is
    # what happens once the backoff has let it through.
    async with session_factory() as db:
        db.add(
            SessionActivityPost(
                tenant_id=require_tenant_id(),
                bridge_id="bridge",
                session_id="session-demo",
                command_id="message-demo",
                data={
                    "status": {
                        "token": "lost-token",
                        "channel": "channel-demo",
                        "thread": "channel-demo:root",
                        "created_at": datetime.now(UTC).isoformat(),
                    }
                },
            )
        )
        await db.commit()
    platform = UnsearchablePlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, platform),
        activity(session_factory, platform),
    )

    caplog.clear()
    with caplog.at_level(logging.WARNING):
        await publisher.publish_pending()
    assert [(record.name, record.levelno) for record in caplog.records] == [
        (OUTBOUND_LOGGER, logging.WARNING)
    ]
    assert "status" in caplog.records[0].getMessage()

    caplog.clear()
    with caplog.at_level(logging.WARNING):
        await publisher.publish_pending()
    assert [record.getMessage() for record in caplog.records] == []


class UnsearchableAttention(UnsearchablePlatform):
    """Loses the response to the attention message and nothing else.

    The mirror image of the platform above, and the case that decides how
    broad "abandoned" is allowed to be: the status is fine and still being
    drawn, so writing the whole turn off because a separate notice cannot be
    confirmed would take away a display that is working.
    """

    def __init__(self):
        super().__init__()
        self.dropped = False

    async def post_rich(self, channel, agent, content, thread):
        ref = await super().post_rich(channel, agent, content, thread)
        if getattr(content, "error_summary", None) and not self.dropped:
            self.dropped = True
            raise TimeoutError("Response lost after the attention post landed")
        return ref


async def test_an_attention_message_nobody_can_confirm_leaves_the_turn_drawing(
    session_factory,
):
    """One lost notice is one lost notice, not the end of the turn's status."""
    await setup(session_factory)
    platform = UnsearchableAttention()

    async def report(renderer, status="running"):
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

    with pytest.raises(TimeoutError):
        await report(activity(session_factory, platform))
    posted = platform.post_count

    await report(activity(session_factory, platform))
    assert platform.post_count == posted  # Nothing reposted over the lost one.

    await publish(activity(session_factory, platform), status="completed", tools=False)
    assert platform.edit_refs  # The status is still being drawn.


async def test_a_turn_whose_status_was_abandoned_still_reports_and_ends(
    session_factory,
    monkeypatch,
):
    """Giving up on the status is not giving up on the turn.

    Driven through the real publisher, because the regression it guards was a
    publisher one: an unconfirmable status made the whole turn permanently
    uninteresting, so the failure that happened afterwards was never told to
    anyone and the turn was never tidied up. A status is one of the things a
    turn shows. Losing it says nothing about whether the agent then failed,
    whether somebody needs to be told, or whether the `:eyes:` should come off
    the message that asked.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    clock = [0.0]
    monkeypatch.setattr(publication.time, "monotonic", lambda: clock[0])
    platform = UnsearchablePlatform()
    platform.fail_after_post = True
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        activity(session_factory, platform),
    )

    async def sweep(sequence, status):
        await service.ingest(
            "agent-demo",
            "host-demo",
            host_event(
                epoch,
                sequence,
                {
                    "type": "turn.upsert",
                    "turnId": "turn-demo",
                    "status": status,
                    "commandId": "message-demo",
                },
            ),
        )
        clock[0] += PAST_THE_RETRY_BACKOFF
        await publisher.publish_pending()

    await publisher.publish_pending()  # Sends the status; the response is lost.
    await sweep(3, "running")  # Gives the status up as unconfirmable.
    async with session_factory() as db:
        row = await db.scalar(select(SessionActivityPost))
        assert row.data["status"]["abandoned_at"]

    await sweep(4, "error")

    assert any(
        "could not complete this request" in str(message)
        for message in platform.messages.values()
    )
    async with session_factory() as db:
        row = await db.scalar(select(SessionActivityPost))
        assert row.data["completed"] is True  # Ended and tidied, not left open.


async def test_an_abandoned_turn_still_lets_go_of_the_asking_message(session_factory):
    """The mark is shared, so a turn that gives up still has to release it.

    Two turns are working on one asking message, and the `:eyes:` on it belongs
    to both: it comes off when the last of them finishes, not the first. A turn
    whose status can never be confirmed is still one of the two. If abandoning
    it also abandoned its claim, the mark would sit on the message for the life
    of the process and the other turn would never be able to take it off.
    """
    await setup(session_factory)
    platform = UnsearchablePlatform()
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))  # Loses its status.
    await publish(activity(session_factory, platform), agent="Other", command="other")
    assert platform.reactions == {"channel-demo:question"}

    await publish(activity(session_factory, platform), "completed")
    assert platform.reactions == {"channel-demo:question"}  # The other turn holds it.
    await publish(
        activity(session_factory, platform),
        "completed",
        agent="Other",
        command="other",
    )
    assert not platform.reactions


async def test_a_status_the_search_could_never_match_is_not_searched_for(
    session_factory,
):
    """Knowing the answer beforehand is not the same as a lookup coming back empty.

    This platform can search, and for a card it works. A turn's status prints
    no handle, so the same search has nothing to match on and will answer the
    same way for as long as it is asked. Asking anyway is not harmless: it
    reads a channel's history on every publish cycle, for the life of the
    process, to be told what was known before the first call.
    """
    await setup(session_factory)
    platform = UnmarkedPlatform()
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))

    assert await publish(activity(session_factory, platform)) is True
    assert platform.lookups == 0
    assert platform.post_count == 1
    async with session_factory() as db:
        row = await db.scalar(select(SessionActivityPost))
        assert row.data["status"]["abandoned_at"]


async def test_a_search_that_misses_is_asked_again_and_not_written_off(
    session_factory,
):
    """The opposite case, and the one a capability must not swallow.

    A platform carrying a marker can recognise anything it posted, so a lookup
    that comes back empty means the message is not there *yet* — the post may
    still be settling, or the read may have failed. Treating that as permanent
    would abandon a status that is about to be found, so the reservation is
    kept and the question asked again.
    """
    await setup(session_factory)
    platform = ActivitySlack()
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    posted = dict(platform.messages)
    platform.messages.clear()

    with pytest.raises(CardNotPosted):
        await publish(activity(session_factory, platform))
    async with session_factory() as db:
        row = await db.scalar(select(SessionActivityPost))
        assert "abandoned_at" not in row.data["status"]

    platform.messages.update(posted)
    await publish(activity(session_factory, platform))
    async with session_factory() as db:
        row = await db.scalar(select(SessionActivityPost))
        # Bound to the status that was there all along, not a second one.
        assert row.data["status"]["ref"] in posted


async def test_an_unconfirmed_status_does_not_swallow_the_attention_message(
    session_factory,
):
    """A problem still reaches the channel after a status delivery is lost.

    The attention message is a message of its own, posted rather than edited
    precisely so it can notify. A status nobody can confirm keeps its
    reservation for good on a platform that cannot search, so an attention
    message published behind it would be the one message whose whole job is to
    say "somebody has to act on this" and which is guaranteed never to arrive.
    """
    await setup(session_factory)
    platform = UnsearchablePlatform()
    platform.fail_after_post = True

    async def report(renderer):
        return await renderer.publish(
            [],
            _turn("running").model_copy(update={"command_id": "message-demo"}),
            session_id="session-demo",
            channel_id="channel-demo",
            thread_root_id="channel-demo:root",
            asked_on="channel-demo:question",
            agent_name="Agent",
            elapsed_seconds=12,
            error_summary="The host went away.",
        )

    with pytest.raises(TimeoutError):
        await report(activity(session_factory, platform))
    platform.messages.clear()

    await report(activity(session_factory, platform))
    assert any(
        "The host went away." in str(message) for message in platform.messages.values()
    )


async def test_definite_post_rejection_can_be_retried(session_factory, monkeypatch):
    from unittest.mock import AsyncMock

    from switch_core.bridges.collaboration.adapter import RichContentFailed

    await setup(session_factory)
    platform = ActivitySlack()
    with monkeypatch.context() as patch:
        patch.setattr(
            platform,
            "post_rich",
            AsyncMock(side_effect=RichContentFailed("Rejected", text="Rejected")),
        )
        assert not await publish(activity(session_factory, platform))
    assert await publish(activity(session_factory, platform))
    assert platform.post_count == 2


@pytest.mark.parametrize("restart", [False, True])
@pytest.mark.parametrize("real_status", ["running", "completed"])
async def test_provisional_error_receipt_becomes_real_turn_in_place(
    session_factory, restart, real_status
):
    await setup(session_factory)
    platform = ActivitySlack()
    renderer = activity(session_factory, platform)
    provisional = _turn("error").model_copy(
        update={"turn_id": "pending:message-demo", "command_id": "message-demo"}
    )
    await renderer.publish(
        [],
        provisional,
        session_id="session-demo",
        channel_id="channel-demo",
        thread_root_id="channel-demo:root",
        asked_on="channel-demo:question",
        agent_name="Agent",
        elapsed_seconds=None,
    )
    if restart:
        renderer = activity(session_factory, platform)
    await publish(renderer, real_status, tools=False)
    assert platform.post_count == 2
    assert set(platform.messages) == {"channel-demo:1", "channel-demo:2"}
    assert "errored" not in platform.messages["channel-demo:1"].text.lower()
    assert "channel-demo:1" in platform.edit_refs


@pytest.mark.parametrize("durable", [True, False])
@pytest.mark.parametrize("pending_status", ["accepted", "unknown", "rejected"])
async def test_pending_command_cannot_hide_recorded_completion_or_replay_stale_error(
    session_factory, pending_status, durable
):
    from switch_core.db.models import SdkSessionCommand

    from .test_authority import command, host_event

    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "commandId": "message-demo",
                "status": "completed",
            },
        ),
    )
    await service.submit(
        command(
            epoch,
            "pending-command",
            {
                "type": "message.send",
                "text": "Later message",
                "attachments": [],
                "delivery": "queue",
            },
            actor="@owner:example.test",
            surface="slack",
        ),
        user_id=None,
        bridge_id="bridge",
    )
    async with session_factory() as db:
        row = await db.get(
            SdkSessionCommand, (require_tenant_id(), "session-demo", "pending-command")
        )
        row.status = {**row.status, "status": pending_status}
        await db.commit()
    for _ in range(2):
        publisher = SessionPublisher(
            session_factory,
            "bridge",
            cards_for(session_factory, Platform()),
            activity(session_factory, platform)
            if durable
            else SessionTurnActivity(platform),
        )
        await publisher.publish_pending()
    if durable:
        assert "channel-demo:1" in platform.messages
        assert "channel-demo:2" in platform.messages
        assert platform.post_count == (4 if pending_status == "accepted" else 2)
    else:
        # Each fresh demo publisher redraws the latest real completion. Pending
        # errors are not replayed, and a queued receipt cannot hide that completion.
        assert platform.post_count == (10 if pending_status == "accepted" else 6)


async def test_reaction_failure_retries_without_blocking_log(session_factory):
    from unittest.mock import AsyncMock

    await setup(session_factory)
    platform = ActivitySlack()
    original = platform.mark_activity
    platform.mark_activity = AsyncMock(side_effect=TimeoutError("reaction failed"))
    renderer = activity(session_factory, platform)
    assert await publish(renderer)
    assert platform.post_count == 2
    platform.mark_activity = original
    assert await publish(renderer)
    assert platform.reactions == {"channel-demo:question"}


async def test_first_edit_throttle_still_claims_reaction(session_factory):
    from unittest.mock import AsyncMock

    from switch_core.bridges.collaboration.adapter import RichContentThrottled

    await setup(session_factory)
    platform = ActivitySlack()
    original = platform.update_rich
    platform.update_rich = AsyncMock(
        side_effect=RichContentThrottled(text="slow down", retry_after=5)
    )
    renderer = activity(session_factory, platform)
    with pytest.raises(RichContentThrottled):
        await publish(renderer)
    platform.update_rich = original
    assert await publish(renderer)
    assert platform.reactions == {"channel-demo:question"}


async def test_failed_final_edit_releases_reaction_across_restart(session_factory):
    from unittest.mock import AsyncMock

    await setup(session_factory)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    platform.update_rich = AsyncMock(side_effect=TimeoutError("edit failed"))
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform), "completed")
    assert not platform.reactions
    journal = ActivityJournal(session_factory, "bridge")
    assert not await journal.reaction_held(
        ("another", "command"),
        "channel-demo",
        "channel-demo:question",
        sessions=session_factory,
    )


async def test_one_agents_finished_turn_leaves_another_agents_mark_alone(
    session_factory,
):
    """Each agent's mark is its own bot's, so each has to come off on its own.

    Two turns on one message is the shared case the journal exists for — but
    scoped per agent, the other agent still working says nothing about whether
    this one's mark should stay. Unscoped, the first agent to finish reads the
    second's live anchor as a reason to hold, and its own eyes stay on the
    message for good.

    Both turns run under one session here because the journal keys rows by
    session and command together; two commands is what makes two turns, and
    which session they belong to is not what the scoping reads.
    """
    await setup(session_factory)
    platform = PerAgentSlack()
    await publish(activity(session_factory, platform))
    await publish(activity(session_factory, platform), agent="Other", command="other")
    assert platform.reactions == {
        ("Agent", "channel-demo:question"),
        ("Other", "channel-demo:question"),
    }

    await publish(activity(session_factory, platform), "completed")

    assert platform.reactions == {("Other", "channel-demo:question")}


async def test_a_shared_bots_single_mark_survives_one_of_two_turns_ending(
    session_factory,
):
    """The inverse, and why the scoping is a capability rather than the rule.

    Where every agent reacts as the same bot there is one mark between them,
    and taking it off when the first turn ends would strip it from a turn that
    is still running.
    """
    await setup(session_factory)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    await publish(activity(session_factory, platform), agent="Other", command="other")

    await publish(activity(session_factory, platform), "completed")

    assert platform.reactions == {"channel-demo:question"}


async def test_busy_journal_is_skipped_until_next_sweep(session_factory):
    await setup(session_factory)
    journal = ActivityJournal(session_factory, "bridge")
    platform = ActivitySlack()
    async with journal.open("session-demo", "message-demo") as record:
        assert record is not None
        assert not await asyncio.wait_for(
            publish(activity(session_factory, platform)), 2
        )
        assert platform.post_count == 0
    assert await publish(activity(session_factory, platform))


async def test_throttled_initial_post_retries_without_uncertain_reservation(
    session_factory,
):
    from unittest.mock import AsyncMock

    from switch_core.bridges.collaboration.adapter import RichContentThrottled

    await setup(session_factory)
    platform = ActivitySlack()
    original = platform.post_rich
    platform.post_rich = AsyncMock(
        side_effect=RichContentThrottled(text="slow down", retry_after=5)
    )
    renderer = activity(session_factory, platform)
    with pytest.raises(RichContentThrottled):
        await publish(renderer)
    platform.post_rich = original
    assert await publish(renderer)
    assert platform.post_count == 2


async def test_completed_journal_discards_anchors_but_keeps_replay_receipt(
    session_factory,
):
    await setup(session_factory)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    await publish(activity(session_factory, platform), "completed")
    async with ActivityJournal(session_factory, "bridge").open(
        "session-demo", "message-demo"
    ) as record:
        assert record is not None
        assert record.data == {
            "turn_id": _turn("completed").turn_id,
            "ended": True,
            "completed": True,
        }
    await publish(activity(session_factory, platform), "completed")
    assert platform.post_count == 2


async def test_publisher_reserves_activity_before_an_early_request(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    platform = ActivitySlack()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, platform),
        activity(session_factory, platform),
    )
    await publisher.publish_pending()
    messages = list(platform.messages.values())
    assert len(messages) == 3
    assert "Working" in messages[0].text
    assert "No tool calls yet" in messages[1].text
    assert any(block["type"] == "actions" for block in messages[2].blocks)


# ── The real Mattermost adapter, not a stand-in ──────────────────────────────
#
# Everything above replaces `post_rich` on a platform object, so it exercises
# the reservation machinery against whatever exception the test chose to
# raise. What decides the reservation's fate in production is the adapter's
# own reading of what the driver threw, and that is not covered by a
# stand-in. These run the same machinery over `MattermostAdapter`.


def mattermost(*, agent="Agent"):
    adapter = mattermost_adapter(agent)
    posts = mm_posts(adapter)

    def remember(post, created):
        """Keep what was posted where recovery will look for it."""
        root = post.get("root_id")
        record = {
            "id": created["id"],
            "user_id": f"bot-{agent}",
            "props": post.get("props") or {},
            "create_at": len(posts.created),
        }
        (posts.thread if root else posts.channel)[created["id"]] = record

    return adapter, posts, remember


async def test_a_lost_mattermost_response_keeps_its_reservation(session_factory):
    """A timeout is not a refusal. The reservation stands, the post is found
    again by the marker that travelled in its props, and the channel is left
    with one status rather than two."""
    await setup(session_factory)
    adapter, posts, remember = mattermost()
    accepted = posts.create_post

    def lose_the_response(post):
        created = accepted(post)
        remember(post, created)
        raise TimeoutError("accepted on the server, response lost")

    posts.create_post = lose_the_response
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, adapter))

    posts.create_post = accepted
    assert await publish(activity(session_factory, adapter))
    assert len(posts.created) == 1


async def test_a_mattermost_rate_limit_retries_without_a_second_post(session_factory):
    await setup(session_factory)
    adapter, posts, _ = mattermost()
    posts.create_error = _http_error(429, **{"Retry-After": "5"})
    renderer = activity(session_factory, adapter)

    with pytest.raises(RichContentThrottled):
        await publish(renderer)

    posts.create_error = None
    assert await publish(renderer)
    assert len(posts.created) == 1


async def test_a_post_mattermost_refused_is_reserved_again_and_retried(
    session_factory,
):
    """The other half of the contract: a refusal really does release the
    reservation, so the turn is posted rather than waiting for a post that
    was never made."""
    await setup(session_factory)
    adapter, posts, _ = mattermost()
    posts.create_error = NotEnoughPermissions("403 permission denied")

    assert not await publish(activity(session_factory, adapter))

    posts.create_error = None
    assert await publish(activity(session_factory, adapter))
    assert len(posts.created) == 1


class RefusingPlatform(ActivitySlack):
    """A chat that will not take the mark, keeping its own state across a restart.

    The reactions live in a set owned by the test rather than by the adapter,
    because that is the arrangement the defect needs: the channel remembers
    what is on the message and a new process does not.
    """

    def __init__(self, chat, *, refuse_add=False, refuse_remove=False):
        super().__init__()
        self.reactions = chat["reactions"]
        self.messages = chat["messages"]
        self.refuse_add = refuse_add
        self.refuse_remove = refuse_remove

    async def mark_activity(self, channel, ref, *, agent_name, working, force=False):
        if working:
            if self.refuse_add:
                raise ActivityMarkRefused("reactions are switched off in this chat")
            self.reactions.add(ref)
        elif self.refuse_remove:
            raise ActivityMarkRefused("the bot may no longer react here")
        else:
            self.reactions.discard(ref)


async def test_a_mark_left_on_the_message_after_a_restart_is_not_reported_as_cleaned_up(
    session_factory,
):
    """Add the mark, restart, lose the permission, end the turn.

    The mark is still on the message, so the chat is saying an agent is working
    on something it has finished. Reporting the turn as finished stops the
    publisher asking, and permission coming back later then changes nothing.
    The old code decided this from a process-local set that the restart had
    emptied, read an empty set as "nothing was added", and returned success.
    """
    await setup(session_factory)
    chat = {"reactions": set(), "messages": {}}
    assert await publish(activity(session_factory, RefusingPlatform(chat)))
    assert chat["reactions"] == {"channel-demo:question"}

    after_restart = RefusingPlatform(chat, refuse_remove=True)
    drawn = await publish(activity(session_factory, after_restart), "completed")

    assert chat["reactions"] == {"channel-demo:question"}
    assert not drawn


async def test_a_chat_that_never_took_the_mark_does_not_hold_the_turn_open(
    session_factory,
):
    """The other half, and the reason the answer cannot simply be "always raise".

    A chat with reactions switched off refuses to clear a mark as readily as to
    add one, and there is nothing there to clear. Holding the turn open for it
    would leave every turn in that chat retrying its cleanup for ever. The
    refusal to add is recorded when it happens, so the refusal to remove is
    still understood after a restart.
    """
    await setup(session_factory)
    chat = {"reactions": set(), "messages": {}}
    first = RefusingPlatform(chat, refuse_add=True)
    assert await publish(activity(session_factory, first))
    assert not chat["reactions"]

    after_restart = RefusingPlatform(chat, refuse_add=True, refuse_remove=True)

    assert await publish(activity(session_factory, after_restart), "completed")


async def test_two_turns_sharing_a_mark_nobody_could_add_do_not_wait_for_it(
    session_factory,
):
    """Reactions off throughout, and the turn that finishes last never tried.

    Two turns on one asking message share a single reaction, so only the first
    attempts to add it and only the last attempts to take it off — and they are
    rarely the same turn. The first one's completion reduces its row to a
    receipt. If what it learned lived on that row as a fact about the turn, the
    last holder would find nothing, assume a mark it must remove, and go on
    failing at a reaction that was never there. The evidence is about the mark,
    so it outlives whichever turn recorded it.
    """
    await setup(session_factory)
    chat = {"reactions": set(), "messages": {}}
    renderer = activity(session_factory, RefusingPlatform(chat, refuse_add=True))

    assert await publish(renderer, command="first")
    assert await publish(renderer, command="second")
    assert await publish(renderer, "completed", command="first")
    assert not chat["reactions"]

    renderer._adapter.refuse_remove = True

    assert await publish(renderer, "completed", command="second")


async def test_a_mark_that_went_on_later_outranks_the_refusal_that_came_first(
    session_factory,
):
    """One turn is refused the mark; the next puts it there; the first ends last.

    The refusal says nothing about the mark once somebody else has managed to
    add it — they are the same reaction. Deciding from the ending turn's own
    history reports a clean finish with the 👀 still on the message, which is
    the failure this is all about, so the answer comes from what is expected of
    the mark rather than from what happened to a turn.
    """
    await setup(session_factory)
    chat = {"reactions": set(), "messages": {}}
    refusing = RefusingPlatform(chat, refuse_add=True)
    assert await publish(activity(session_factory, refusing), command="first")
    assert not chat["reactions"]

    after_restart = RefusingPlatform(chat)
    renderer = activity(session_factory, after_restart)
    assert await publish(renderer, command="second")
    assert chat["reactions"] == {"channel-demo:question"}

    # The first turn is still live, so the second leaves the shared mark alone.
    assert await publish(renderer, "completed", command="second")
    assert chat["reactions"] == {"channel-demo:question"}

    after_restart.refuse_remove = True
    assert not await publish(renderer, "completed", command="first")
    assert chat["reactions"] == {"channel-demo:question"}

    after_restart.refuse_remove = False
    assert await publish(renderer, "completed", command="first")
    assert not chat["reactions"]


async def test_a_publisher_with_no_journal_still_owes_a_mark_it_put_there(
    session_factory,
):
    """Without a journal there is no restart to survive, but there is a mark.

    Nothing durable is recorded for this publisher, so its own memory is all
    the evidence there is — and it is enough, because a process that cannot be
    restarted into cannot be asked a question it was not there for. What it
    must not do is treat having no journal as proof that nothing was added.
    """
    await setup(session_factory)
    chat = {"reactions": set(), "messages": {}}
    platform = RefusingPlatform(chat)
    renderer = SessionTurnActivity(platform)

    assert await publish(renderer)
    assert chat["reactions"] == {"channel-demo:question"}

    platform.refuse_remove = True
    assert not await publish(renderer, "completed")
    assert chat["reactions"] == {"channel-demo:question"}

    elsewhere = RefusingPlatform(
        {"reactions": set(), "messages": {}}, refuse_add=True, refuse_remove=True
    )
    unmarked = SessionTurnActivity(elsewhere)
    assert await publish(unmarked)
    assert await publish(unmarked, "completed")

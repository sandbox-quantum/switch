"""Restart and uncertain-delivery tests using real PostgreSQL checkpoints."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from switch_core.bridges.collaboration.session.activity_journal import ActivityJournal
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import SdkSession, require_tenant_id
from switch_core.sessions.publication import SessionPublisher

from ..bridges.collaboration.test_session_activity import _items, _turn
from .test_authority import opened, setup
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
        self.fail_delete = False

    async def post_rich(self, channel, agent, content, thread):
        self.post_count += 1
        ref = f"{channel}:{self.post_count}"
        self.messages[ref] = self._render_rich(content)
        if self.fail_after_post:
            self.fail_after_post = False
            raise TimeoutError("Response lost after Slack accepted the post")
        return ref

    async def update_rich(self, channel, ref, content):
        assert ref in self.messages
        self.edit_refs.append(ref)
        self.messages[ref] = self._render_rich(content)

    async def find_request_card(self, channel, thread, token, created_at):
        for ref, message in self.messages.items():
            if any(
                block.get("block_id") == f"switch-request:{token}"
                for block in message.blocks
            ):
                return ref
        return None

    async def delete_activity_message(self, channel, ref):
        if self.fail_delete:
            self.fail_delete = False
            raise TimeoutError("Delete failed")
        self.messages.pop(ref, None)

    async def mark_activity(self, channel, ref, *, working, force=False):
        if working:
            self.reactions.add(ref)
        else:
            self.reactions.discard(ref)


def activity(factory, platform):
    return SessionTurnActivity(platform, journal=ActivityJournal(factory, "bridge"))


async def publish(renderer, status="running", *, tools=True):
    turn = _turn(status).model_copy(update={"command_id": "message-demo"})
    return await renderer.publish(
        await _items() if tools else [],
        turn,
        session_id="session-demo",
        channel_id="channel-demo",
        thread_root_id="channel-demo:root",
        asked_on="channel-demo:question",
        agent_name="Agent",
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
    # Timer-only refresh must not collapse the unchanged log, even after restart.
    assert platform.edit_refs[before:] == ["channel-demo:1"]
    await publish(activity(session_factory, platform), "completed")
    assert set(platform.messages) == {"channel-demo:2"}
    assert not platform.reactions
    await publish(activity(session_factory, platform), "completed")
    assert platform.post_count == 2


@pytest.mark.parametrize("slot", ["status", "log"])
async def test_lost_post_response_is_recovered_without_duplicate(session_factory, slot):
    await setup(session_factory)
    platform = ActivitySlack()
    if slot == "log":
        await publish(activity(session_factory, platform), tools=False)
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    await publish(activity(session_factory, platform))
    assert platform.post_count == 2
    assert len(platform.messages) == 2


async def test_cleanup_failure_is_retried_after_restart(session_factory):
    await setup(session_factory)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    platform.fail_delete = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform), "completed")
    await publish(activity(session_factory, platform), "completed")
    assert set(platform.messages) == {"channel-demo:2"}
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
    assert "channel-demo:1" not in platform.messages
    assert "channel-demo:2" in platform.messages
    assert platform.post_count == 3  # Only the new turn created a new status.
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        activity(session_factory, platform),
    )
    await publisher.publish_pending()
    assert platform.post_count == 3


async def test_unknown_delivery_without_a_match_never_blindly_reposts(session_factory):
    from switch_core.bridges.collaboration.session.outbound import CardNotPosted

    await setup(session_factory)
    platform = ActivitySlack()
    platform.fail_after_post = True
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    platform.messages.clear()  # No match visible to the recovery lookup.
    with pytest.raises(CardNotPosted):
        await publish(activity(session_factory, platform))
    assert platform.post_count == 1


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
    assert platform.post_count == 1
    assert set(platform.messages) == {"channel-demo:1"}
    assert "errored" not in platform.messages["channel-demo:1"].text.lower()
    assert platform.edit_refs[-1] == "channel-demo:1"


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
        assert "channel-demo:1" not in platform.messages
        assert "channel-demo:2" in platform.messages
        assert platform.post_count == (3 if pending_status == "accepted" else 2)
    else:
        # Each fresh demo publisher redraws the latest real completion. Pending
        # errors are not replayed, and a queued receipt cannot hide that completion.
        assert platform.post_count == (6 if pending_status == "accepted" else 4)


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

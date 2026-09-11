from switch_core.bridges.collaboration.adapter import RichContentFailed
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.sessions import publication
from switch_core.sessions.contract import Command, HostEvent
from switch_core.sessions.publication import (
    SessionPublisher,
    _RecoveryBackoff,
    _turn_elapsed_seconds,
)

from .test_authority import command, host_event, opened, setup
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
    assert content.elapsed_seconds is None
    # opened()'s command has neither a thread nor a message id, so there is
    # nothing to thread under — posts at the channel root, as before.
    assert thread is None


async def test_a_turn_addressed_at_the_root_threads_under_its_own_message(
    session_factory,
):
    """A command with no thread of its own still has the message that
    triggered it — activity now threads under that message instead of
    posting beside it at the channel root.
    """
    service, epoch = await setup(session_factory)
    message = Command(
        contract_version=1,
        command_id="message-demo",
        session_id="session-demo",
        epoch=epoch,
        origin={
            "surface": "console",
            "actorId": "owner",
            "roomId": "room-demo",
            "threadId": None,
            "messageId": "trigger-message-1",
        },
        body={
            "type": "message.send",
            "text": "Run tests",
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
            1,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "running",
                "commandId": "message-demo",
            },
        ),
    )
    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )

    await publisher.publish_pending()

    assert len(activity_platform.posts) == 1
    _, _, thread = activity_platform.posts[0]
    assert thread == "trigger-message-1"


async def test_a_reply_inside_an_existing_thread_reacts_to_the_reply_not_the_root(
    session_factory, monkeypatch
):
    """A command answered inside an existing thread threads its activity
    under that thread's root — posting needs somewhere to go — but the
    message that actually asked is the reply itself, which can be a
    different message from whatever the thread was originally about. The two
    are carried separately rather than the root standing in for both.
    """
    service, epoch = await setup(session_factory)
    reply = Command(
        contract_version=1,
        command_id="message-demo",
        session_id="session-demo",
        epoch=epoch,
        origin={
            "surface": "console",
            "actorId": "owner",
            "roomId": "room-demo",
            "threadId": "thread-root-1",
            "messageId": "reply-message-1",
        },
        body={
            "type": "message.send",
            "text": "Run tests",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(reply, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            1,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "running",
                "commandId": "message-demo",
            },
        ),
    )
    activity_platform = ActivityPlatform()
    activity = SessionTurnActivity(activity_platform)
    calls = []
    original_publish = activity.publish

    async def _capture(*args, **kwargs):
        calls.append(kwargs)
        return await original_publish(*args, **kwargs)

    monkeypatch.setattr(activity, "publish", _capture)
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        activity,
    )

    await publisher.publish_pending()

    assert len(activity_platform.posts) == 1
    _, _, thread = activity_platform.posts[0]
    assert thread == "thread-root-1"
    assert calls[0]["asked_on"] == "reply-message-1"


async def test_only_the_latest_turn_is_redrawn_by_a_freshly_started_publisher(
    session_factory,
):
    """`snapshot.turns` keeps every turn a session has ever had. A freshly
    started publisher's redraw guard remembers nothing, so without scoping
    to the latest turn, every one of them looks undrawn on the first cycle
    and gets reposted as a new message — replaying a session's whole history
    into the channel on every restart, not just the one still worth a
    duplicate.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
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
    second_message = command(
        epoch,
        "message-2",
        {
            "type": "message.send",
            "text": "Run them again",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(second_message, user_id="owner", bridge_id=None)
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

    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )
    await publisher.publish_pending()

    assert [content.turn.turn_id for _, content, _ in activity_platform.posts] == [
        "turn-2"
    ]


async def test_a_turn_skipped_on_the_first_sweep_stays_held_back_on_the_next(
    session_factory,
):
    """Skipping a non-latest turn on the first sweep must stick.

    `redraw_needed` only knows a turn exists once `redrawn` has told it so —
    skip a turn without that and it is new again on the very next sweep,
    which is unrestricted, so the whole history the first sweep held back
    would flood in one sweep later instead of never: on the user's next
    message, or a session re-checked for any other reason, not only a
    second restart.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
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
    second_message = command(
        epoch,
        "message-2",
        {
            "type": "message.send",
            "text": "Run them again",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(second_message, user_id="owner", bridge_id=None)
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
    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )

    await publisher.publish_pending()
    assert [c.turn.turn_id for _, c, _ in activity_platform.posts] == ["turn-2"]

    # Something else in the session changes, waking a second, unrestricted
    # sweep — a user's next message in the real system, a plain notice here.
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            5,
            {
                "type": "notice",
                "level": "info",
                "code": "TEST",
                "message": "still running",
            },
        ),
    )
    await publisher.publish_pending()

    assert "turn-demo" not in [c.turn.turn_id for _, c, _ in activity_platform.posts]


async def test_a_hold_back_survives_a_redraw_guard_far_smaller_than_the_history(
    session_factory, monkeypatch
):
    """`_TurnRedrawGuard` is bounded and shared across every session on the
    bridge, evicting whichever entry was least recently drawn — the right
    trade for turns actually being watched, where an eviction costs one
    needless redraw. A hold-back record for an old, ended turn is not that:
    evicting it costs a fresh repost of history. This drives three turns
    through a guard bounded at two to prove the hold-back does not share
    that bound at all.
    """
    monkeypatch.setattr(publication, "_MAX_TRACKED_TURNS", 2)
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
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
    second_message = command(
        epoch,
        "message-2",
        {
            "type": "message.send",
            "text": "Run them again",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(second_message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            4,
            {
                "type": "turn.upsert",
                "turnId": "turn-2",
                "status": "completed",
                "commandId": "message-2",
            },
        ),
    )
    third_message = command(
        epoch,
        "message-3",
        {
            "type": "message.send",
            "text": "Run them a third time",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(third_message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            5,
            {
                "type": "turn.upsert",
                "turnId": "turn-3",
                "status": "running",
                "commandId": "message-3",
            },
        ),
    )
    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )

    await publisher.publish_pending()
    assert [c.turn.turn_id for _, c, _ in activity_platform.posts] == ["turn-3"]

    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            6,
            {
                "type": "notice",
                "level": "info",
                "code": "TEST",
                "message": "still running",
            },
        ),
    )
    await publisher.publish_pending()

    posted_turns = [c.turn.turn_id for _, c, _ in activity_platform.posts]
    assert "turn-demo" not in posted_turns
    assert "turn-2" not in posted_turns


async def test_an_older_turn_queued_behind_the_latest_still_gets_its_final_draw(
    session_factory,
):
    """A real host publishes the next turn's "queued" while the current one
    is still running, so "not latest" cannot mean "already ended" — the
    turn that stopped being latest here is still working, and later still
    has to show that it finished.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )

    # First sweep: turn-demo is the only turn, and the one this publisher's
    # own first_sweep restriction would have kept anyway.
    await publisher.publish_pending()
    assert [c.turn.turn_id for _, c, _ in activity_platform.posts] == ["turn-demo"]

    # A follow-up arrives and is queued while turn-demo is still running.
    second_message = command(
        epoch,
        "message-2",
        {
            "type": "message.send",
            "text": "Run them again",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(second_message, user_id="owner", bridge_id=None)
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
    await publisher.publish_pending()

    # turn-demo completes after it has stopped being the latest turn.
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            4,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "completed",
                "commandId": "message-demo",
            },
        ),
    )
    await publisher.publish_pending()

    edited_turns = [content.turn.turn_id for _, _, content in activity_platform.edits]
    assert "turn-demo" in edited_turns
    completed_edit = next(
        content
        for _, _, content in activity_platform.edits
        if content.turn.turn_id == "turn-demo"
    )
    assert completed_edit.turn.status == "completed"


async def test_a_completed_turns_activity_carries_how_long_it_ran(session_factory):
    """Neither a turn nor an item carries a timestamp, so this comes from the
    session's own event log: the first and last `turn.upsert` for it.
    """
    service, epoch = await setup(session_factory)
    message = command(
        epoch,
        "message-demo",
        {
            "type": "message.send",
            "text": "Run tests",
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
            1,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "running",
                "commandId": "message-demo",
            },
        ),
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        HostEvent(
            contract_version=1,
            event_id="host-2",
            session_id="session-demo",
            epoch=epoch,
            host_sequence=2,
            occurred_at="2026-09-09T12:01:20Z",
            body={
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "completed",
                "commandId": "message-demo",
            },
        ),
    )
    activity_platform = ActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )

    await publisher.publish_pending()

    assert len(activity_platform.posts) == 1
    _, content, _ = activity_platform.posts[0]
    assert content.turn.status == "completed"
    assert content.elapsed_seconds == 80.0


async def test_a_recovery_interruption_does_not_claim_a_false_duration(
    session_factory,
):
    """Recovery ends every queued or running turn itself, stamped with the
    moment it noticed rather than anything the host said — outage time, not
    work. That must not be read as how long the turn ran.
    """
    service, epoch = await setup(session_factory)
    await opened(service, epoch)

    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    await service.recover(
        "agent-demo", "session-demo", "host-demo", epoch, "recovery", 2
    )

    async with session_factory() as db:
        elapsed = await _turn_elapsed_seconds(db, "session-demo", "turn-demo")

    assert elapsed is None


async def test_a_recovery_interruption_still_claims_nothing_after_it_reported_running(
    session_factory,
):
    """A real host reports "queued" the moment a command arrives and
    "running" once it actually starts, both genuine — so a turn recovered
    shortly after starting still has two host-reported stamps, both from
    before the outage. Anchoring at "queued" would read the outage itself as
    a few hundred milliseconds of work; there is nothing here to anchor a
    start on once "queued" no longer counts, so this reports nothing rather
    than that.
    """
    service, epoch = await setup(session_factory)
    message = command(
        epoch,
        "message-demo",
        {
            "type": "message.send",
            "text": "Run tests",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        HostEvent(
            contract_version=1,
            event_id="host-1",
            session_id="session-demo",
            epoch=epoch,
            host_sequence=1,
            occurred_at="2026-09-09T09:00:00Z",
            body={
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "queued",
                "commandId": "message-demo",
            },
        ),
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        HostEvent(
            contract_version=1,
            event_id="host-2",
            session_id="session-demo",
            epoch=epoch,
            host_sequence=2,
            occurred_at="2026-09-09T09:00:00.3Z",
            body={
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "running",
                "commandId": "message-demo",
            },
        ),
    )

    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    await service.recover(
        "agent-demo", "session-demo", "host-demo", epoch, "recovery", 2
    )

    async with session_factory() as db:
        elapsed = await _turn_elapsed_seconds(db, "session-demo", "turn-demo")

    assert elapsed is None


async def test_time_spent_queued_behind_another_turn_is_not_worked_time(
    session_factory,
):
    """Turns run one at a time. A turn can sit queued for as long as the one
    ahead of it takes, and that wait is not this turn's own work.
    """
    service, epoch = await setup(session_factory)
    message = command(
        epoch,
        "message-demo",
        {
            "type": "message.send",
            "text": "Run tests",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(message, user_id="owner", bridge_id=None)
    for sequence, occurred_at, status in (
        (1, "2026-09-09T09:00:30Z", "queued"),
        (2, "2026-09-09T09:04:00Z", "running"),
        (3, "2026-09-09T09:04:20Z", "completed"),
    ):
        await service.ingest(
            "agent-demo",
            "host-demo",
            HostEvent(
                contract_version=1,
                event_id=f"host-{sequence}",
                session_id="session-demo",
                epoch=epoch,
                host_sequence=sequence,
                occurred_at=occurred_at,
                body={
                    "type": "turn.upsert",
                    "turnId": "turn-demo",
                    "status": status,
                    "commandId": "message-demo",
                },
            ),
        )

    async with session_factory() as db:
        elapsed = await _turn_elapsed_seconds(db, "session-demo", "turn-demo")

    assert elapsed == 20.0


async def test_a_negative_delta_is_not_measured_either(session_factory):
    """A clock stepped, or a host's wall clock ran backward between the two
    events — reported as unmeasured, not as a lie in the other direction.
    """
    service, epoch = await setup(session_factory)
    message = command(
        epoch,
        "message-demo",
        {
            "type": "message.send",
            "text": "Run tests",
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
            1,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "running",
                "commandId": "message-demo",
            },
        ),
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        HostEvent(
            contract_version=1,
            event_id="host-2",
            session_id="session-demo",
            epoch=epoch,
            host_sequence=2,
            occurred_at="2026-09-09T11:58:00Z",
            body={
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "completed",
                "commandId": "message-demo",
            },
        ),
    )

    async with session_factory() as db:
        elapsed = await _turn_elapsed_seconds(db, "session-demo", "turn-demo")

    assert elapsed is None


async def test_a_naive_timestamp_from_a_nonconforming_host_does_not_crash_this(
    session_factory,
):
    """`_iso_datetime` accepts an offset-less string the TypeScript-side
    validator would not, so a non-conforming host can post one. Comparing it
    against an aware timestamp must not raise and take the session's whole
    publication cycle down with it.
    """
    service, epoch = await setup(session_factory)
    message = command(
        epoch,
        "message-demo",
        {
            "type": "message.send",
            "text": "Run tests",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        HostEvent(
            contract_version=1,
            event_id="host-1",
            session_id="session-demo",
            epoch=epoch,
            host_sequence=1,
            occurred_at="2026-09-09T12:00:00",
            body={
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "running",
                "commandId": "message-demo",
            },
        ),
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            2,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "completed",
                "commandId": "message-demo",
            },
        ),
    )

    async with session_factory() as db:
        elapsed = await _turn_elapsed_seconds(db, "session-demo", "turn-demo")

    assert elapsed == 0.0


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


class FlakyActivityPlatform(ActivityPlatform):
    """Refuses the first post, then behaves like `ActivityPlatform`."""

    def __init__(self):
        super().__init__()
        self._refused = False

    async def post_rich(self, channel, agent, content, thread):
        if not self._refused:
            self._refused = True
            raise RichContentFailed("nope", text="nope")
        return await super().post_rich(channel, agent, content, thread)


async def test_a_refused_post_is_retried_once_its_backoff_elapses(
    session_factory, monkeypatch
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    activity_platform = FlakyActivityPlatform()
    publisher = SessionPublisher(
        session_factory,
        "bridge",
        cards_for(session_factory, Platform()),
        SessionTurnActivity(activity_platform),
    )
    clock = 0.0
    monkeypatch.setattr(publication.time, "monotonic", lambda: clock)

    await publisher.publish_pending()
    assert activity_platform.posts == []

    # A cycle straight after the refusal is backed off, the same as a card's
    # own recovery search — nothing about the turn changed since the refusal
    # either, so a guard keyed only on its state would also have skipped it,
    # but this must not retry even if the guard would have let it.
    await publisher.publish_pending()
    assert activity_platform.posts == []

    clock += _RecoveryBackoff._MIN
    await publisher.publish_pending()

    assert len(activity_platform.posts) == 1
    assert activity_platform.posts[0][1].turn.turn_id == "turn-demo"


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

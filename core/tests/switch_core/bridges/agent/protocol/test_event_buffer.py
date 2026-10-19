"""Unit tests for the EventBuffer notification fan-out (CHOO-889).

The auto_session watcher consumes a separate, agent-scoped notification stream.
The critical invariant: fanning an event out to that stream must NOT remove it
from the per-room queue a live session poller drains — otherwise the watcher
would steal events from connected rooms.

The agent's own events (addressed messages, arrivals it listens for, tasks,
commands) are what the buffer keeps. The rest of a room's conversation stays in
the room's log, and the per-room and all-rooms polls read it from there.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol import event_buffer
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, Position
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    CommandPayload,
    MessagePayload,
    RoomJoinPayload,
    TaskDelegatePayload,
)
from switch_core.db.models import (
    AGENT_EVENT_BOOT_MAX,
    TENANT_ZERO_ID,
    TICKET_CEILING,
    TICKET_FLOOR,
    Agent,
    AgentPollPosition,
)
from switch_core.db.session_scope import tenant_session
from tests.db_buffer import db_buffer_on, forget_room, say, seed_agent, seed_member

AGENT = "agent-1"
ROOM = "room-1"


@pytest.fixture(autouse=True)
async def _agent_rows(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent every event here is queued for, a member of the rooms they are
    queued in, so its rows have one to belong to and the rooms' conversation is
    its to read."""
    await seed_agent(session_factory, AGENT)
    await seed_member(session_factory, AGENT, ROOM)
    await seed_member(session_factory, AGENT, "room-2")


def _message(
    addressed: bool, room_id: str = ROOM, *, message_id: str = "$m"
) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        payload=MessagePayload(
            addressed=addressed,
            sender="@u:s",
            sender_name="u",
            message_id=message_id,
            body="hi",
            timestamp=0,
        ),
    )


def _room_join(listening: bool) -> AgentEvent:
    return AgentEvent(
        type="room_join",
        room_id=ROOM,
        payload=RoomJoinPayload(
            member="@u:s", member_name="u", timestamp=0, listening=listening
        ),
    )


def _task_delegate() -> AgentEvent:
    return AgentEvent(
        type="task_delegate",
        room_id=ROOM,
        payload=TaskDelegatePayload(
            task_id="t1",
            requester_agent_id="r",
            performer_agent_id=AGENT,
            summary="s",
            description="d",
        ),
    )


def _command() -> AgentEvent:
    return AgentEvent(
        type="command",
        room_id=ROOM,
        payload=CommandPayload(command="reset", user_id="@u:s", user_name="u"),
    )


async def _keep(buffer: EventBuffer, event: AgentEvent) -> int:
    """Keep one of the agent's own events that stands for no room row here."""
    return await buffer.enqueue(
        TENANT_ZERO_ID, AGENT, event.room_id, event, room_seq=0, message_key=None
    )


async def _asked(
    buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
    room_id: str = ROOM,
) -> int:
    """A message addressed to the agent, as its consumer keeps it: the row in
    the room's log, and the agent's own event for that row."""
    row = await say(session_factory, room_id, "hi", sender="@u:s", sender_name="u")
    return await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        room_id,
        _message(True, room_id, message_id=row.transport_event_id),
        room_seq=row.seq,
        message_key=row.transport_event_id,
    )


async def _poll_position(
    session_factory: async_sessionmaker[AsyncSession], reader_id: str
) -> Position:
    """Where a legacy poller has got to. It sends no position of its own, so
    the server keeps one for it."""
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        position = await session.scalar(
            select(AgentPollPosition.position).where(
                AgentPollPosition.agent_id == AGENT,
                AgentPollPosition.reader_id == reader_id,
            )
        )
    assert position is not None, f"{reader_id} has not polled"
    return dict(position)


async def test_addressed_message_fans_out_without_draining_room_queue(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    q = db_buffer
    await _asked(q, session_factory)

    # The notification stream sees it...
    notifs = await q.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM})
    assert len(notifs) == 1
    assert notifs[0].type == "message"

    # ...and it is STILL waiting for the session poller in the room, once: the
    # room's row is the agent's own event, so it is not read again as chatter.
    room_events = await q.poll_room(TENANT_ZERO_ID, AGENT, ROOM, timeout=0)
    assert len(room_events) == 1
    assert room_events[0].payload.addressed is True


async def test_unaddressed_message_does_not_fan_out(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    q = db_buffer
    await say(session_factory, ROOM, "hi")

    assert (
        await q.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM}) == []
    )
    # Still delivered per room (unaddressed chatter is the room's conversation,
    # read from its log by the session poller, just not surfaced as a
    # notification).
    [chatter] = await q.poll_room(TENANT_ZERO_ID, AGENT, ROOM, timeout=0)
    assert chatter.payload.addressed is False


async def test_task_event_fans_out(db_buffer: EventBuffer) -> None:
    q = db_buffer
    await _keep(q, _task_delegate())
    notifs = await q.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM})
    assert len(notifs) == 1
    assert notifs[0].type == "task_delegate"


async def test_room_join_fans_out_only_when_listening(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """An arrival the agent does not listen for is left in the room's log, the
    conversation a session reads; one it listens for is its own event."""
    q = db_buffer
    await say(
        session_factory,
        ROOM,
        "",
        sender="@u:s",
        sender_name="u",
        event_type="m.room.member",
        content={"membership": "join"},
    )
    assert (
        await q.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM}) == []
    )
    [arrival] = await q.poll_room(TENANT_ZERO_ID, AGENT, ROOM, timeout=0)
    assert arrival.type == "room_join"
    assert arrival.payload.listening is False

    await _keep(q, _room_join(listening=True))
    notifs = await q.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM})
    assert len(notifs) == 1
    assert notifs[0].type == "room_join"


async def test_polling_everything_can_be_limited_to_the_rooms_given(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The buffer is keyed by agent and knows nothing about who is in what.

    An event queued while the agent was a member stays queued after it is
    removed, so the caller passes the rooms it is in now and that is what
    keeps the event from being handed over. The same rooms are the only ones
    whose conversation is read.
    """
    q = db_buffer
    await _asked(q, session_factory, ROOM)
    await _asked(q, session_factory, "room-2")
    await say(session_factory, ROOM, "chatter")

    polled = await q.poll(TENANT_ZERO_ID, AGENT, timeout=0, rooms={"room-2"})

    assert [event.room_id for event in polled] == ["room-2"]


async def test_polling_with_no_rooms_at_all_returns_nothing(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """An agent in no rooms is not a caller asking for every room."""
    q = db_buffer
    await _asked(q, session_factory)
    await say(session_factory, ROOM, "chatter")

    assert await q.poll(TENANT_ZERO_ID, AGENT, timeout=0, rooms=set()) == []


async def test_notifications_are_limited_to_the_rooms_given_too(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The notification stream is the one carrying addressed messages.

    Filtering the all-rooms poll and not this one would leave the leak open on
    the more sensitive of the two: an agent removed from a room would stop
    seeing its chatter and go on being handed everything said *to* it there.
    """
    q = db_buffer
    await _asked(q, session_factory, ROOM)
    await _asked(q, session_factory, "room-2")

    polled = await q.poll_notifications(
        TENANT_ZERO_ID, AGENT, timeout=0, rooms={"room-2"}
    )

    assert [event.room_id for event in polled] == ["room-2"]


async def test_dropping_a_room_forgets_what_it_still_held(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """What the transport stops reading, the buffer has to stop holding.

    Dropping the subscription only governs what has not been read yet. An
    event already in here is served to a long poll, to the notification stream
    and to an SSE reader resuming from an old cursor for the whole retention
    window.
    """
    q = db_buffer
    await _asked(q, session_factory, ROOM)
    await _asked(q, session_factory, "room-2")

    await forget_room(session_factory, q, AGENT, ROOM)

    # Gone from the low-level read every reader is built on, filter or no
    # filter — which is what closes it for the stream, the one reader with no
    # membership of its own to apply.
    assert [item.room_id for item in (await q.read_from(TENANT_ZERO_ID, AGENT, 0))] == [
        "room-2"
    ]


async def test_dropping_a_room_does_not_report_a_gap(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """A reader that skips the dropped events has missed nothing it was owed.

    Saying otherwise would send an agent off to re-read the context of a room
    it is no longer in.
    """
    q = db_buffer
    await _asked(q, session_factory, ROOM)
    await _asked(q, session_factory, "room-2")

    await forget_room(session_factory, q, AGENT, ROOM)

    assert await q.rooms_dropped_after(TENANT_ZERO_ID, AGENT, 0) == ()
    assert [item.seq for item in (await q.read_from(TENANT_ZERO_ID, AGENT, 0))] == [2]


async def test_the_cursor_advances_past_what_the_reader_can_never_want(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """A command is excluded on a property of the event, not on who the agent
    is, so the notification reader will never want it and its position is free
    to move past it. Left behind it, the position parks below the head until
    retention trims it and the next read reports a gap that never was.
    """
    q = db_buffer
    await _keep(q, _command())
    await _keep(q, _command())

    assert (
        await q.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM}) == []
    )
    assert (await _poll_position(session_factory, "legacy:notifications"))[
        OWN_EVENTS
    ] == 2


async def test_the_cursor_does_not_advance_past_a_room_joined_later(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Membership is not a property of the event, so it can change.

    A poll reads the agent's rooms once; anything arriving for a room it joins
    while that poll is parked is filtered against the older set. Confirming
    past it would put the position beyond an event the agent is entitled to,
    and no later poll would ever reach it again: it would sit in the buffer,
    retained and unreachable, until it aged out.
    """
    q = db_buffer
    await _asked(q, session_factory, "room-2")

    assert await q.poll(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM}) == []
    assert (await _poll_position(session_factory, "legacy:all"))[OWN_EVENTS] == 0

    polled = await q.poll(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM, "room-2"})
    assert [event.room_id for event in polled] == ["room-2"]


async def test_the_notification_stream_also_survives_a_room_joined_later(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The same rule on the stream carrying what was said *to* the agent."""
    q = db_buffer
    await _asked(q, session_factory, "room-2")

    assert (
        await q.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM}) == []
    )
    polled = await q.poll_notifications(
        TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM, "room-2"}
    )
    assert [event.room_id for event in polled] == ["room-2"]


async def test_a_room_reader_still_advances_past_other_rooms(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """`poll_room`'s filter is the reader's own scope, not a membership snapshot.

    `legacy:room:X` will never want room Y whatever the agent joins later, so
    parking its position behind Y's events would strand it for no gain.
    """
    q = db_buffer
    await _asked(q, session_factory, "room-2")
    await _asked(q, session_factory, ROOM)

    polled = await q.poll_room(TENANT_ZERO_ID, AGENT, ROOM, timeout=0)

    assert [event.room_id for event in polled] == [ROOM]
    assert (await _poll_position(session_factory, f"legacy:room:{ROOM}"))[
        OWN_EVENTS
    ] == 2


async def test_deleting_the_agent_clears_its_notifications(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The rows belong to the agent's own row, so they go when it does.

    `remove` only forgets what this process holds; the agent's events are its
    rows, and the foreign key is what takes them away.
    """
    q = db_buffer
    await _asked(q, session_factory)
    q.remove(AGENT)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(delete(Agent).where(Agent.id == AGENT))
        await session.commit()

    assert await q.read_from(TENANT_ZERO_ID, AGENT, 0) == []


async def test_removing_agent_does_not_reuse_event_sequences(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = db_buffer_on(session_factory, sequence_base=1 << 32)
    first = await _keep(buffer, _message(True))
    buffer.remove(AGENT)
    second = await _keep(buffer, _message(True))
    assert second > first
    assert second < 2**53


def test_ticket_ids_sit_above_every_own_event_number() -> None:
    """A client that holds one number sends back either an own event number or
    a ticket id, and the server tells them apart by size. The largest own event
    number, four billion events into the numbering of an agent first seen at
    the last boot the boot sequence allows, is below the first ticket id, and
    the last ticket id is still an integer a JavaScript client holds exactly."""
    largest_own_event = (AGENT_EVENT_BOOT_MAX << 32) + 2**32 - 1

    assert largest_own_event < TICKET_FLOOR
    assert TICKET_CEILING == 2**53 - 1


async def test_overlapping_polls_never_move_a_reader_back(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Two polls of the same reader can overlap, and the one that finishes
    last may have read less. Its save is refused, because the stored position
    is no longer the one it read from, so the reader is never moved back to
    events it was already sent."""
    room = f"r:{ROOM}"
    first = {OWN_EVENTS: 5, room: 7}
    assert await db_buffer._save_poll_position(
        TENANT_ZERO_ID, AGENT, "legacy:all", first, expected=None
    )
    assert not await db_buffer._save_poll_position(
        TENANT_ZERO_ID, AGENT, "legacy:all", {OWN_EVENTS: 3, room: 9}, expected=None
    )
    assert not await db_buffer._save_poll_position(
        TENANT_ZERO_ID,
        AGENT,
        "legacy:all",
        {OWN_EVENTS: 3, room: 9},
        expected={OWN_EVENTS: 2, room: 7},
    )
    assert await _poll_position(session_factory, "legacy:all") == first

    after = {OWN_EVENTS: 6, room: 8}
    assert await db_buffer._save_poll_position(
        TENANT_ZERO_ID, AGENT, "legacy:all", after, expected=first
    )
    assert await _poll_position(session_factory, "legacy:all") == after


async def test_overlapping_polls_return_each_event_once(
    db_buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two polls of the same reader that both read before either saves would
    both return what they read. The second to save reads again from where the
    first stopped instead."""
    await _asked(db_buffer, session_factory)
    both_read = asyncio.Barrier(2)
    read_from = db_buffer.read_from
    calls = [0]

    async def read_together(*args: Any, **kwargs: Any) -> Any:
        calls[0] += 1
        found = await read_from(*args, **kwargs)
        if calls[0] <= 2:
            await both_read.wait()
        return found

    monkeypatch.setattr(db_buffer, "read_from", read_together)

    polled = await asyncio.gather(
        db_buffer.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM}),
        db_buffer.poll_notifications(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM}),
    )

    assert sorted(len(events) for events in polled) == [0, 1]


async def test_a_write_that_fails_on_the_connection_is_retried(
    db_buffer: EventBuffer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The consumer has moved past the room row by the time it stores the
    agent's own event, so a write lost to a dropped connection or a pool
    timeout would never be made. It is retried, and stored once."""
    real = event_buffer.tenant_session
    failures = [OperationalError("INSERT", {}, ConnectionError("connection reset"))]

    @asynccontextmanager
    async def flaky(factory: object, tenant_id: str) -> AsyncIterator[AsyncSession]:
        if failures:
            raise failures.pop()
        async with real(factory, tenant_id) as session:
            yield session

    monkeypatch.setattr(event_buffer, "tenant_session", flaky)
    monkeypatch.setattr(event_buffer, "ENQUEUE_RETRY_DELAYS", (0.0, 0.0, 0.0))
    seq = await db_buffer.enqueue(
        TENANT_ZERO_ID, AGENT, ROOM, _message(True), room_seq=0, message_key=None
    )
    monkeypatch.undo()

    assert not failures
    assert [
        item.seq for item in await db_buffer.read_from(TENANT_ZERO_ID, AGENT, 0)
    ] == [seq]

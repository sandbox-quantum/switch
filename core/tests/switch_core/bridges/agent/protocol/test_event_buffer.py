"""Unit tests for the EventBuffer notification fan-out (CHOO-889).

The auto_session watcher consumes a separate, agent-scoped notification stream.
The critical invariant: fanning an event out to that stream must NOT remove it
from the per-room queue a live session poller drains — otherwise the watcher
would steal events from connected rooms.
"""

from __future__ import annotations

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    MessagePayload,
    RoomJoinPayload,
    TaskDelegatePayload,
)

AGENT = "agent-1"
ROOM = "room-1"


def _message(addressed: bool, room_id: str = ROOM) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        payload=MessagePayload(
            addressed=addressed,
            sender="@u:s",
            sender_name="u",
            message_id="$m",
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


async def test_addressed_message_fans_out_without_draining_room_queue() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=True))

    # The notification stream sees it...
    notifs = await q.poll_notifications(AGENT, timeout=0, rooms={ROOM})
    assert len(notifs) == 1
    assert notifs[0].type == "message"

    # ...and it is STILL waiting in the per-room queue for the session poller.
    room_events = await q.poll_room(AGENT, ROOM, timeout=0)
    assert len(room_events) == 1


async def test_unaddressed_message_does_not_fan_out() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=False))

    assert await q.poll_notifications(AGENT, timeout=0, rooms={ROOM}) == []
    # Still queued per-room (unaddressed chatter is delivered there, just not
    # surfaced as a notification).
    assert len(await q.poll_room(AGENT, ROOM, timeout=0)) == 1


async def test_task_event_fans_out() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _task_delegate())
    notifs = await q.poll_notifications(AGENT, timeout=0, rooms={ROOM})
    assert len(notifs) == 1
    assert notifs[0].type == "task_delegate"


async def test_room_join_fans_out_only_when_listening() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _room_join(listening=False))
    assert await q.poll_notifications(AGENT, timeout=0, rooms={ROOM}) == []

    q.enqueue(AGENT, ROOM, _room_join(listening=True))
    notifs = await q.poll_notifications(AGENT, timeout=0, rooms={ROOM})
    assert len(notifs) == 1
    assert notifs[0].type == "room_join"


async def test_polling_everything_can_be_limited_to_the_rooms_given() -> None:
    """The buffer is keyed by agent and knows nothing about who is in what.

    An event queued while the agent was a member stays queued after it is
    removed, so the caller passes the rooms it is in now and that is what
    keeps the event from being handed over.
    """
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=False))
    q.enqueue(AGENT, "room-2", _message(addressed=False, room_id="room-2"))

    polled = await q.poll(AGENT, timeout=0, rooms={"room-2"})

    assert [event.room_id for event in polled] == ["room-2"]


async def test_polling_with_no_rooms_at_all_returns_nothing() -> None:
    """An agent in no rooms is not a caller asking for every room."""
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=False))

    assert await q.poll(AGENT, timeout=0, rooms=set()) == []


async def test_notifications_are_limited_to_the_rooms_given_too() -> None:
    """The notification stream is the one carrying addressed messages.

    Filtering the all-rooms poll and not this one would leave the leak open on
    the more sensitive of the two: an agent removed from a room would stop
    seeing its chatter and go on being handed everything said *to* it there.
    """
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=True))
    q.enqueue(AGENT, "room-2", _message(addressed=True, room_id="room-2"))

    polled = await q.poll_notifications(AGENT, timeout=0, rooms={"room-2"})

    assert [event.room_id for event in polled] == ["room-2"]


async def test_dropping_a_room_forgets_what_it_still_held() -> None:
    """What the transport stops reading, the buffer has to stop holding.

    Dropping the subscription only governs what has not been read yet. An
    event already in here is served to a long poll, to the notification stream
    and to an SSE reader resuming from an old cursor for the whole retention
    window.
    """
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=True))
    q.enqueue(AGENT, "room-2", _message(addressed=True, room_id="room-2"))

    q.drop_room(AGENT, ROOM)

    # Gone from the low-level read every reader is built on, filter or no
    # filter — which is what closes it for the stream, the one reader with no
    # membership of its own to apply.
    assert [item.room_id for item in q.read_from(AGENT, 0)] == ["room-2"]


async def test_dropping_a_room_does_not_report_a_gap() -> None:
    """A reader that skips the dropped events has missed nothing it was owed.

    Saying otherwise would send an agent off to re-read the context of a room
    it is no longer in.
    """
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=True))
    q.enqueue(AGENT, "room-2", _message(addressed=True, room_id="room-2"))

    q.drop_room(AGENT, ROOM)

    assert not q.has_gap_before(AGENT, 0)
    assert [item.seq for item in q.read_from(AGENT, 0)] == [2]


async def test_the_cursor_advances_past_what_the_reader_can_never_want() -> None:
    """Unaddressed chatter is excluded on a property of the event, not on who
    the agent is, so the notification reader will never want it and the cursor
    is free to move past it. Left behind it, the cursor parks below the head
    until retention trims it and the next read reports a gap that never was.
    """
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=False))
    q.enqueue(AGENT, ROOM, _message(addressed=False))

    assert await q.poll_notifications(AGENT, timeout=0, rooms={ROOM}) == []
    assert q._cursors[AGENT]["legacy:notifications"] == 2


async def test_the_cursor_does_not_advance_past_a_room_joined_later() -> None:
    """Membership is not a property of the event, so it can change.

    A poll reads the agent's rooms once; anything arriving for a room it joins
    while that poll is parked is filtered against the older set. Confirming
    past it would put the cursor beyond an event the agent is entitled to, and
    no later poll would ever reach it again — it would sit in the buffer,
    retained and unreachable, until it aged out.
    """
    q = EventBuffer()
    q.enqueue(AGENT, "room-2", _message(addressed=True, room_id="room-2"))

    assert await q.poll(AGENT, timeout=0, rooms={ROOM}) == []
    assert q._cursors[AGENT]["legacy:all"] == 0

    polled = await q.poll(AGENT, timeout=0, rooms={ROOM, "room-2"})
    assert [event.room_id for event in polled] == ["room-2"]


async def test_the_notification_stream_also_survives_a_room_joined_later() -> None:
    """The same rule on the stream carrying what was said *to* the agent."""
    q = EventBuffer()
    q.enqueue(AGENT, "room-2", _message(addressed=True, room_id="room-2"))

    assert await q.poll_notifications(AGENT, timeout=0, rooms={ROOM}) == []
    polled = await q.poll_notifications(AGENT, timeout=0, rooms={ROOM, "room-2"})
    assert [event.room_id for event in polled] == ["room-2"]


async def test_a_room_reader_still_advances_past_other_rooms() -> None:
    """`poll_room`'s filter is the reader's own scope, not a membership snapshot.

    `legacy:room:X` will never want room Y whatever the agent joins later, so
    parking its cursor behind Y's events would strand it for no gain.
    """
    q = EventBuffer()
    q.enqueue(AGENT, "room-2", _message(addressed=True, room_id="room-2"))
    q.enqueue(AGENT, ROOM, _message(addressed=True))

    polled = await q.poll_room(AGENT, ROOM, timeout=0)

    assert [event.room_id for event in polled] == [ROOM]
    assert q._cursors[AGENT][f"legacy:room:{ROOM}"] == 2


async def test_remove_clears_notification_queue() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=True))
    q.remove(AGENT)
    assert await q.poll_notifications(AGENT, timeout=0, rooms={ROOM}) == []

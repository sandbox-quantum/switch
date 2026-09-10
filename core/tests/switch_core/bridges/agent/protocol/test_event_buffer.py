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
    notifs = await q.poll_notifications(AGENT, timeout=0)
    assert len(notifs) == 1
    assert notifs[0].type == "message"

    # ...and it is STILL waiting in the per-room queue for the session poller.
    room_events = await q.poll_room(AGENT, ROOM, timeout=0)
    assert len(room_events) == 1


async def test_unaddressed_message_does_not_fan_out() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=False))

    assert await q.poll_notifications(AGENT, timeout=0) == []
    # Still queued per-room (unaddressed chatter is delivered there, just not
    # surfaced as a notification).
    assert len(await q.poll_room(AGENT, ROOM, timeout=0)) == 1


async def test_task_event_fans_out() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _task_delegate())
    notifs = await q.poll_notifications(AGENT, timeout=0)
    assert len(notifs) == 1
    assert notifs[0].type == "task_delegate"


async def test_room_join_fans_out_only_when_listening() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _room_join(listening=False))
    assert await q.poll_notifications(AGENT, timeout=0) == []

    q.enqueue(AGENT, ROOM, _room_join(listening=True))
    notifs = await q.poll_notifications(AGENT, timeout=0)
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


async def test_remove_clears_notification_queue() -> None:
    q = EventBuffer()
    q.enqueue(AGENT, ROOM, _message(addressed=True))
    q.remove(AGENT)
    assert await q.poll_notifications(AGENT, timeout=0) == []

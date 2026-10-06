"""Unit tests for what the EventBuffer hands each kind of reader (CHOO-889).

A watcher reads only what notifies the agent (`filter=addressed`), a session
reads everything in its rooms, and both read the same buffer: reading never
removes, so one reader cannot take an event from another.
"""

from __future__ import annotations

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    MessagePayload,
    RoomJoinPayload,
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


def _types(items: list) -> list[str]:
    return [item.event.type for item in items]


async def test_an_addressed_message_reaches_both_kinds_of_reader() -> None:
    q = EventBuffer(sequence_base=0)
    q.enqueue(AGENT, ROOM, _message(addressed=True))

    assert _types(q.read_from(AGENT, 0, notifiable_only=True)) == ["message"]
    # Reading it for the watcher left it there for the session.
    assert _types(q.read_from(AGENT, 0, rooms={ROOM})) == ["message"]


async def test_an_unaddressed_message_does_not_notify() -> None:
    q = EventBuffer(sequence_base=0)
    q.enqueue(AGENT, ROOM, _message(addressed=False))

    assert q.read_from(AGENT, 0, notifiable_only=True) == []
    # Still delivered to a session in the room, just not surfaced as a
    # notification.
    assert len(q.read_from(AGENT, 0, rooms={ROOM})) == 1


async def test_a_room_join_notifies_only_when_listening() -> None:
    q = EventBuffer(sequence_base=0)
    q.enqueue(AGENT, ROOM, _room_join(listening=False))
    assert q.read_from(AGENT, 0, notifiable_only=True) == []

    q.enqueue(AGENT, ROOM, _room_join(listening=True))
    assert _types(q.read_from(AGENT, 0, notifiable_only=True)) == ["room_join"]


async def test_a_read_can_be_limited_to_the_rooms_given() -> None:
    q = EventBuffer(sequence_base=0)
    q.enqueue(AGENT, ROOM, _message(addressed=False))
    q.enqueue(AGENT, "room-2", _message(addressed=False, room_id="room-2"))

    read = q.read_from(AGENT, 0, rooms={"room-2"})

    assert [item.room_id for item in read] == ["room-2"]


async def test_dropping_a_room_forgets_what_it_still_held() -> None:
    """What the transport stops reading, the buffer has to stop holding.

    Dropping the subscription only governs what has not been read yet. An
    event already in here is served to an SSE reader resuming from an old
    cursor for the whole retention window.
    """
    q = EventBuffer(sequence_base=0)
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
    q = EventBuffer(sequence_base=0)
    q.enqueue(AGENT, ROOM, _message(addressed=True))
    q.enqueue(AGENT, "room-2", _message(addressed=True, room_id="room-2"))

    q.drop_room(AGENT, ROOM)

    assert not q.has_gap_before(AGENT, 0)
    assert [item.seq for item in q.read_from(AGENT, 0)] == [2]


async def test_remove_forgets_the_agents_events() -> None:
    q = EventBuffer(sequence_base=0)
    q.enqueue(AGENT, ROOM, _message(addressed=True))
    q.remove(AGENT)
    assert q.read_from(AGENT, 0) == []


def test_removing_agent_does_not_reuse_event_sequences():
    buffer = EventBuffer(sequence_base=1 << 32)
    first = buffer.enqueue(AGENT, ROOM, _message(True))
    buffer.remove(AGENT)
    second = buffer.enqueue(AGENT, ROOM, _message(True))
    assert second > first
    assert second < 2**53

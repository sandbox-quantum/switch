"""Per-room unread accounting held by the buffer rather than by each client.

The counts a reader is told are derived here, from events the buffer already
holds, and they are per room: catching up in one room says nothing about any
other. What a reader must never be handed is a confident zero it has no reason
to doubt, so the absence of a count is itself an answer.
"""

from __future__ import annotations

from switch_core.bridges.agent.protocol.event_buffer import (
    COUNTED_FROM_A_HOLE,
    NO_BASELINE,
    RESTARTED,
    EventBuffer,
    Unread,
)
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    CommandPayload,
    MessagePayload,
)

AGENT = "agent-1"
READER = "connection-1"
ROOM_A = "room-a"
ROOM_B = "room-b"


def _message(room: str, *, addressed: bool = False, body: str = "hi") -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=addressed,
            sender="@u:s",
            sender_name="u",
            message_id=f"$m-{body}",
            body=body,
            timestamp=0,
        ),
    )


def _chatter(buffer: EventBuffer, room: str, times: int = 1) -> int:
    seq = 0
    for index in range(times):
        seq = buffer.enqueue(AGENT, room, _message(room, body=f"{room}-{index}"))
    return seq


async def test_a_room_counts_only_its_own_chatter() -> None:
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    buffer.start_counting(AGENT, READER, ROOM_B, 0)

    _chatter(buffer, ROOM_A, times=3)
    head = buffer.head(AGENT)

    assert buffer.unread(AGENT, ROOM_A, head).count == 3
    assert buffer.unread(AGENT, ROOM_B, head).count == 0


async def test_catching_up_on_one_room_leaves_the_others_alone() -> None:
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    buffer.start_counting(AGENT, READER, ROOM_B, 0)
    _chatter(buffer, ROOM_A, times=2)
    _chatter(buffer, ROOM_B, times=1)

    head = buffer.head(AGENT)
    buffer.caught_up(AGENT, READER, ROOM_A, head)

    assert buffer.unread(AGENT, ROOM_A, head).count == 0
    assert buffer.unread(AGENT, ROOM_B, head).count == 1


async def test_a_second_connection_does_not_start_the_room_over() -> None:
    """A room has one count: the agent is behind by one amount there."""
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=2)
    buffer.start_counting(AGENT, "connection-2", ROOM_A, buffer.head(AGENT))

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2


async def test_a_read_by_the_session_that_lost_the_room_clears_nothing() -> None:
    """The reproduction: siblings share a connection, so it cannot say who read.

    A read is begun before its history arrives. Another session of the agent
    taking the room in between comes back to a count of its own — one it has
    not read a word of — and the displaced session's answer must not be
    credited to it.
    """
    buffer = EventBuffer()
    shared = "connection-shared"
    buffer.start_counting(AGENT, shared, ROOM_A, 0)
    buffer.hand_counting_to(AGENT, "session-a", ROOM_A)
    _chatter(buffer, ROOM_A, times=3)
    in_flight = buffer.head(AGENT)

    buffer.hand_counting_to(AGENT, "session-b", ROOM_A)
    _chatter(buffer, ROOM_A, times=2)
    buffer.caught_up(AGENT, "session-a", ROOM_A, in_flight)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 5


async def test_the_session_that_took_the_room_still_clears_it() -> None:
    """The fence is about who is in the room, not about refusing reads."""
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    buffer.hand_counting_to(AGENT, "session-a", ROOM_A)
    _chatter(buffer, ROOM_A, times=2)

    buffer.hand_counting_to(AGENT, "session-b", ROOM_A)
    buffer.caught_up(AGENT, "session-b", ROOM_A, buffer.head(AGENT))

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 0


async def test_taking_a_room_inherits_what_went_past_unread_in_it() -> None:
    """Chatter nobody read stays unread when the room changes hands."""
    buffer = EventBuffer()
    buffer.hand_counting_to(AGENT, "session-a", ROOM_A)
    _chatter(buffer, ROOM_A, times=4)

    buffer.hand_counting_to(AGENT, "session-b", ROOM_A)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 4


async def test_a_room_counted_for_the_first_time_counts_what_is_retained() -> None:
    """Arriving somewhere new, the most that can be said is what we still hold."""
    buffer = EventBuffer()
    _chatter(buffer, ROOM_A, times=2)

    buffer.hand_counting_to(AGENT, "session-a", ROOM_A)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2


async def test_a_room_nothing_recorded_a_baseline_for_has_no_count() -> None:
    buffer = EventBuffer()
    _chatter(buffer, ROOM_A, times=2)

    unread = buffer.unread(AGENT, ROOM_A, buffer.head(AGENT))

    assert unread.count is None
    assert unread.reason == NO_BASELINE


async def test_a_baseline_survives_a_second_claim_of_the_same_room() -> None:
    """Re-claiming must not quietly discard what the reader is behind by."""
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=2)
    buffer.start_counting(AGENT, READER, ROOM_A, buffer.head(AGENT))

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2


async def test_a_room_marked_unknown_says_so_rather_than_starting_at_zero() -> None:
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    buffer.mark_unknown(AGENT, READER, [ROOM_A])
    _chatter(buffer, ROOM_A, times=1)

    unread = buffer.unread(AGENT, ROOM_A, buffer.head(AGENT))

    assert unread.count is None
    assert unread.reason == RESTARTED

    # And it stays unknown until the reader actually catches up, rather than
    # being repaired by the next room claim.
    buffer.start_counting(AGENT, READER, ROOM_A, buffer.head(AGENT))
    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count is None


async def test_reading_context_repairs_an_unknown_count() -> None:
    buffer = EventBuffer()
    buffer.mark_unknown(AGENT, READER, [ROOM_A])
    buffer.caught_up(AGENT, READER, ROOM_A, buffer.head(AGENT))

    _chatter(buffer, ROOM_A, times=1)
    unread = buffer.unread(AGENT, ROOM_A, buffer.head(AGENT))

    assert unread == Unread(count=1, reason=None)


async def test_a_count_that_lost_history_is_a_floor_in_that_room_only() -> None:
    buffer = EventBuffer(max_events_per_agent=2)
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    buffer.start_counting(AGENT, READER, ROOM_B, 0)

    _chatter(buffer, ROOM_A, times=3)
    _chatter(buffer, ROOM_B, times=1)
    head = buffer.head(AGENT)

    lost = buffer.unread(AGENT, ROOM_A, head)
    assert lost.count == 1
    assert lost.reason == COUNTED_FROM_A_HOLE

    intact = buffer.unread(AGENT, ROOM_B, head)
    assert intact.count == 1
    assert intact.reason is None


async def test_catching_up_past_a_hole_makes_the_count_exact_again() -> None:
    buffer = EventBuffer(max_events_per_agent=2)
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=3)

    buffer.caught_up(AGENT, READER, ROOM_A, buffer.head(AGENT))
    _chatter(buffer, ROOM_A, times=1)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).reason is None


async def test_a_drop_names_the_rooms_that_lost_events() -> None:
    buffer = EventBuffer(max_events_per_agent=2)
    _chatter(buffer, ROOM_A, times=2)
    _chatter(buffer, ROOM_B, times=2)

    assert buffer.rooms_dropped_after(AGENT, 0) == (ROOM_A,)
    assert buffer.rooms_dropped_after(AGENT, buffer.head(AGENT)) == ()


async def test_only_unaddressed_messages_are_counted() -> None:
    """The count exists to say what the reader was not woken for."""
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)

    buffer.enqueue(AGENT, ROOM_A, _message(ROOM_A, addressed=True))
    buffer.enqueue(
        AGENT,
        ROOM_A,
        AgentEvent(
            type="command",
            room_id=ROOM_A,
            payload=CommandPayload(command="reset", user_id="@u:s", user_name="u"),
        ),
    )
    buffer.enqueue(AGENT, ROOM_A, _message(ROOM_A))

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 1


async def test_a_count_stops_at_the_event_it_is_reported_alongside() -> None:
    """Chatter that arrived after the woken-for event is not yet its business."""
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=2)
    addressed = buffer.enqueue(AGENT, ROOM_A, _message(ROOM_A, addressed=True))
    _chatter(buffer, ROOM_A, times=5)

    assert buffer.unread(AGENT, ROOM_A, addressed).count == 2


async def test_dropping_a_reader_leaves_the_room_behind_by_what_it_was() -> None:
    """A reader going away is not the conversation it missed being read."""
    buffer = EventBuffer()
    buffer.start_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=1)

    buffer.drop_reader(AGENT, READER)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 1

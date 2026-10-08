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
    Reader,
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


def _session(session_id: str) -> Reader:
    return Reader(id=session_id, is_session=True)


def _connection(connection_id: str) -> Reader:
    return Reader(id=connection_id, is_session=False)


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
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.ensure_counting(AGENT, READER, ROOM_B, 0)

    _chatter(buffer, ROOM_A, times=3)
    head = buffer.head(AGENT)

    assert buffer.unread(AGENT, ROOM_A, head).count == 3
    assert buffer.unread(AGENT, ROOM_B, head).count == 0


async def test_catching_up_on_one_room_leaves_the_others_alone() -> None:
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.ensure_counting(AGENT, READER, ROOM_B, 0)
    _chatter(buffer, ROOM_A, times=2)
    _chatter(buffer, ROOM_B, times=1)

    head = buffer.head(AGENT)
    buffer.caught_up(AGENT, _connection(READER), ROOM_A, head, READER)

    assert buffer.unread(AGENT, ROOM_A, head).count == 0
    assert buffer.unread(AGENT, ROOM_B, head).count == 1


async def test_a_second_connection_does_not_start_the_room_over() -> None:
    """A room has one count: the agent is behind by one amount there."""
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=2)
    buffer.ensure_counting(AGENT, "connection-2", ROOM_A, buffer.head(AGENT))

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2


async def test_the_connection_that_takes_a_room_over_can_clear_it() -> None:
    """A room slot changes hands on the stream and the subscribe door too.

    Connecting is not the only way in. A connection that takes the room from
    another is the one told how far behind it is, so it has to be the one whose
    reading clears it — otherwise it reads everything and is told nothing
    happened.
    """
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=3)

    buffer.take_counting(AGENT, "connection-2", ROOM_A, buffer.head(AGENT))
    buffer.caught_up(
        AGENT, _connection("connection-2"), ROOM_A, buffer.head(AGENT), "connection-2"
    )

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 0


async def test_delivering_a_room_does_not_take_it_from_a_session() -> None:
    """One connection carries every session, so it is not the caller in any room."""
    buffer = EventBuffer(sequence_base=0)
    buffer.hand_counting_to(AGENT, _session("session-a"), ROOM_A)
    _chatter(buffer, ROOM_A, times=2)

    buffer.ensure_counting(AGENT, "connection-shared", ROOM_A, buffer.head(AGENT))
    buffer.caught_up(
        AGENT,
        _connection("connection-shared"),
        ROOM_A,
        buffer.head(AGENT),
        "connection-shared",
    )
    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2

    buffer.caught_up(
        AGENT, _session("session-a"), ROOM_A, buffer.head(AGENT), "connection-shared"
    )
    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 0


async def test_taking_a_room_does_take_it_from_a_session() -> None:
    """A takeover is not coverage: the session it displaced is out of the room.

    A legacy client taking the slot is told how far behind the room is, so its
    reading has to clear it — being told 3 and reading all three and still
    being told 3 is the count losing its meaning.
    """
    buffer = EventBuffer(sequence_base=0)
    buffer.hand_counting_to(AGENT, _session("session-a"), ROOM_A)
    _chatter(buffer, ROOM_A, times=3)

    buffer.take_counting(AGENT, "connection-legacy", ROOM_A, buffer.head(AGENT))
    buffer.caught_up(
        AGENT,
        _connection("connection-legacy"),
        ROOM_A,
        buffer.head(AGENT),
        "connection-legacy",
    )

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 0


async def test_a_displaced_session_cannot_adopt_the_count_it_lost() -> None:
    """The other half of a takeover: the session that was there keeps reading.

    Its read was begun before it lost the room and lands afterwards. A session
    outranking whatever connection holds the count would hand the room straight
    back to it, and the client that actually holds the slot would be told it is
    caught up on messages it has never been shown.
    """
    buffer = EventBuffer(sequence_base=0)
    buffer.hand_counting_to(AGENT, _session("session-a"), ROOM_A)
    _chatter(buffer, ROOM_A, times=3)
    in_flight = buffer.head(AGENT)

    buffer.take_counting(AGENT, "connection-legacy", ROOM_A, in_flight)
    buffer.caught_up(
        AGENT, _connection("connection-legacy"), ROOM_A, in_flight, "connection-legacy"
    )
    _chatter(buffer, ROOM_A, times=2)

    buffer.caught_up(
        AGENT, _session("session-a"), ROOM_A, buffer.head(AGENT), "connection-a"
    )

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2


async def test_a_session_adopts_a_count_opened_in_its_connections_name() -> None:
    """A session recovering after a restart is not a stranger to its own room.

    The stream reopens before the session says anything, so what is recorded is
    the connection. The session reads, and its read has to land somewhere: held
    to the letter, it would clear nothing and the room would answer "unknown"
    for as long as the session lived.
    """
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.mark_restarted(AGENT)
    _chatter(buffer, ROOM_A, times=2)
    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).reason == RESTARTED

    buffer.caught_up(AGENT, _session("session-a"), ROOM_A, buffer.head(AGENT), READER)
    _chatter(buffer, ROOM_A, times=1)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)) == Unread(
        count=1, reason=None
    )


async def test_a_read_by_the_session_that_lost_the_room_clears_nothing() -> None:
    """The reproduction: siblings share a connection, so it cannot say who read.

    A read is begun before its history arrives. Another session of the agent
    taking the room in between comes back to a count of its own — one it has
    not read a word of — and the displaced session's answer must not be
    credited to it.
    """
    buffer = EventBuffer(sequence_base=0)
    shared = "connection-shared"
    buffer.ensure_counting(AGENT, shared, ROOM_A, 0)
    buffer.hand_counting_to(AGENT, _session("session-a"), ROOM_A)
    _chatter(buffer, ROOM_A, times=3)
    in_flight = buffer.head(AGENT)

    buffer.hand_counting_to(AGENT, _session("session-b"), ROOM_A)
    _chatter(buffer, ROOM_A, times=2)
    buffer.caught_up(AGENT, _session("session-a"), ROOM_A, in_flight, shared)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 5


async def test_the_session_that_took_the_room_still_clears_it() -> None:
    """The fence is about who is in the room, not about refusing reads."""
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.hand_counting_to(AGENT, _session("session-a"), ROOM_A)
    _chatter(buffer, ROOM_A, times=2)

    buffer.hand_counting_to(AGENT, _session("session-b"), ROOM_A)
    buffer.caught_up(AGENT, _session("session-b"), ROOM_A, buffer.head(AGENT), READER)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 0


async def test_taking_a_room_inherits_what_went_past_unread_in_it() -> None:
    """Chatter nobody read stays unread when the room changes hands."""
    buffer = EventBuffer(sequence_base=0)
    buffer.hand_counting_to(AGENT, _session("session-a"), ROOM_A)
    _chatter(buffer, ROOM_A, times=4)

    buffer.hand_counting_to(AGENT, _session("session-b"), ROOM_A)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 4


async def test_a_room_counted_for_the_first_time_counts_what_is_retained() -> None:
    """Arriving somewhere new, the most that can be said is what we still hold."""
    buffer = EventBuffer(sequence_base=0)
    _chatter(buffer, ROOM_A, times=2)

    buffer.hand_counting_to(AGENT, _session("session-a"), ROOM_A)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2


async def test_a_room_nothing_recorded_a_baseline_for_has_no_count() -> None:
    buffer = EventBuffer(sequence_base=0)
    _chatter(buffer, ROOM_A, times=2)

    unread = buffer.unread(AGENT, ROOM_A, buffer.head(AGENT))

    assert unread.count is None
    assert unread.reason == NO_BASELINE


async def test_a_baseline_survives_the_room_being_covered_or_taken_again() -> None:
    """Neither door may quietly discard what the reader is behind by."""
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=2)

    buffer.ensure_counting(AGENT, READER, ROOM_A, buffer.head(AGENT))
    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2

    buffer.take_counting(AGENT, "connection-2", ROOM_A, buffer.head(AGENT))
    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 2


async def test_a_restart_leaves_a_room_unknown_rather_than_at_zero() -> None:
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.mark_restarted(AGENT)
    _chatter(buffer, ROOM_A, times=1)

    unread = buffer.unread(AGENT, ROOM_A, buffer.head(AGENT))

    assert unread.count is None
    assert unread.reason == RESTARTED

    # And it stays unknown until the reader actually catches up, rather than
    # being repaired by the room changing hands.
    buffer.take_counting(AGENT, "connection-2", ROOM_A, buffer.head(AGENT))
    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count is None


async def test_a_restart_covers_rooms_it_could_not_have_named() -> None:
    """The loss is the whole buffer, not the rooms a connection had claimed.

    A connection watching every room claims none of them, and the rooms its
    sessions work in are claimed after it reconnects. Marking only what was
    named at the time would answer those rooms with a fresh zero — the exact
    confident zero the count exists not to hand out.
    """
    buffer = EventBuffer(sequence_base=0)
    buffer.mark_restarted(AGENT)
    _chatter(buffer, ROOM_A, times=2)
    _chatter(buffer, ROOM_B, times=1)

    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.hand_counting_to(AGENT, _session("session-b"), ROOM_B)

    for room in (ROOM_A, ROOM_B):
        unread = buffer.unread(AGENT, room, buffer.head(AGENT))
        assert unread.count is None
        assert unread.reason == RESTARTED


async def test_reading_a_room_after_a_restart_makes_it_countable_again() -> None:
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.mark_restarted(AGENT)
    buffer.caught_up(AGENT, _connection(READER), ROOM_A, buffer.head(AGENT), READER)

    _chatter(buffer, ROOM_A, times=1)
    unread = buffer.unread(AGENT, ROOM_A, buffer.head(AGENT))

    assert unread == Unread(count=1, reason=None)


async def test_a_count_that_lost_history_is_a_floor_in_that_room_only() -> None:
    buffer = EventBuffer(max_events_per_agent=2, sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    buffer.ensure_counting(AGENT, READER, ROOM_B, 0)

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
    buffer = EventBuffer(max_events_per_agent=2, sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=3)

    buffer.caught_up(AGENT, _connection(READER), ROOM_A, buffer.head(AGENT), READER)
    _chatter(buffer, ROOM_A, times=1)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).reason is None


async def test_a_drop_names_the_rooms_that_lost_events() -> None:
    buffer = EventBuffer(max_events_per_agent=2, sequence_base=0)
    _chatter(buffer, ROOM_A, times=2)
    _chatter(buffer, ROOM_B, times=2)

    assert buffer.rooms_dropped_after(AGENT, 0) == (ROOM_A,)
    assert buffer.rooms_dropped_after(AGENT, buffer.head(AGENT)) == ()


async def test_only_unaddressed_messages_are_counted() -> None:
    """The count exists to say what the reader was not woken for."""
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)

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
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=2)
    addressed = buffer.enqueue(AGENT, ROOM_A, _message(ROOM_A, addressed=True))
    _chatter(buffer, ROOM_A, times=5)

    assert buffer.unread(AGENT, ROOM_A, addressed).count == 2


async def test_dropping_a_reader_leaves_the_room_behind_by_what_it_was() -> None:
    """A reader going away is not the conversation it missed being read."""
    buffer = EventBuffer(sequence_base=0)
    buffer.ensure_counting(AGENT, READER, ROOM_A, 0)
    _chatter(buffer, ROOM_A, times=1)

    buffer.drop_reader(AGENT, READER)

    assert buffer.unread(AGENT, ROOM_A, buffer.head(AGENT)).count == 1

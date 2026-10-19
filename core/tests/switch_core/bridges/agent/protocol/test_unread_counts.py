"""Per-room unread accounting held by the buffer rather than by each client.

The counts a reader is told are derived here, from the room's own log
(`messages`), and they are per room: catching up in one room says nothing about
any other. Where a room was last caught up, and who is reading it, are rows, so
a count reads the same from every process. What a reader must never be handed
is a confident zero it has no reason to doubt, so the absence of a count is
itself an answer.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.agent.protocol.event_buffer import (
    COUNTED_FROM_WINDOW,
    NO_BASELINE,
    EventBuffer,
    Reader,
    Unread,
)
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    CommandPayload,
    MessagePayload,
)
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import (
    age_events,
    db_buffer_on,
    say,
    seed_agent,
    seed_room,
    sender_of,
)
from tests.switch_core.statement_counts import StatementCounts

AGENT = "agent-1"
READER = "connection-1"
ROOM_A = "room-a"
ROOM_B = "room-b"
ROOM_C = "room-c"

SessionFactory = async_sessionmaker[AsyncSession]


@pytest.fixture(autouse=True)
async def _rows(session_factory: SessionFactory) -> None:
    """The agent counted for and the rooms it is counted in: a room's count is
    kept against the room's own row."""
    await seed_agent(session_factory, AGENT)
    await seed_room(session_factory, ROOM_A)
    await seed_room(session_factory, ROOM_B)


async def _expire_everything_so_far(
    buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Age out every event queued so far, recording the drops a reader is told of."""
    await age_events(session_factory, AGENT, seconds=2 * 3600)
    await buffer.expire(TENANT_ZERO_ID)


def _session(session_id: str) -> Reader:
    return Reader(id=session_id, is_session=True)


def _connection(connection_id: str) -> Reader:
    return Reader(id=connection_id, is_session=False)


async def _chatter(session_factory: SessionFactory, room: str, times: int = 1) -> int:
    """Messages nobody addressed to the agent. The room position of the last."""
    seq = 0
    for index in range(times):
        seq = (await say(session_factory, room, f"{room}-{index}")).seq
    return seq


def _asked(room: str, message_id: str) -> AgentEvent:
    """The agent's own event for a message addressed to it."""
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=True,
            sender="@alice:test",
            sender_name="Alice",
            message_id=message_id,
            body="@agent over to you",
            timestamp=0,
        ),
    )


async def _addressed(
    buffer: EventBuffer, session_factory: SessionFactory, room: str
) -> int:
    """A message addressed to the agent, as its consumer keeps it: the row in
    the room's log, and the agent's own event for that row. The row's room
    position."""
    row = await say(session_factory, room, "@agent over to you")
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        room,
        _asked(room, row.transport_event_id),
        room_seq=row.seq,
        message_key=row.transport_event_id,
    )
    return row.seq


def _part(group: str, index: int, total: int) -> dict[str, object]:
    """The content of one of several files posted as one message."""
    return {ATTACHMENT_GROUP_KEY: {"id": group, "index": index, "total": total}}


async def _head(buffer: EventBuffer, room: str) -> int:
    return (await buffer.room_heads(TENANT_ZERO_ID, {room}))[room]


async def _unread(buffer: EventBuffer, room: str) -> Unread:
    """What the agent is behind by in `room`, through everything said there."""
    return await buffer.unread(TENANT_ZERO_ID, AGENT, room, await _head(buffer, room))


async def _caught_up(
    buffer: EventBuffer, reader: Reader, room: str, arrived_on: str | None
) -> None:
    """`reader` has read `room` through everything said there so far."""
    await buffer.caught_up(
        TENANT_ZERO_ID, AGENT, reader, room, await _head(buffer, room), arrived_on
    )


async def test_a_room_counts_only_its_own_chatter(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_B)

    await _chatter(session_factory, ROOM_A, times=3)

    assert (await _unread(buffer, ROOM_A)).count == 3
    assert (await _unread(buffer, ROOM_B)).count == 0


async def test_catching_up_on_one_room_leaves_the_others_alone(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_B)
    await _chatter(session_factory, ROOM_A, times=2)
    await _chatter(session_factory, ROOM_B, times=1)

    await _caught_up(buffer, _connection(READER), ROOM_A, READER)

    assert (await _unread(buffer, ROOM_A)).count == 0
    assert (await _unread(buffer, ROOM_B)).count == 1


async def test_a_second_connection_does_not_start_the_room_over(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A room has one count: the agent is behind by one amount there."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, "connection-2", ROOM_A)

    assert (await _unread(buffer, ROOM_A)).count == 2


async def test_the_connection_that_takes_a_room_over_can_clear_it(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A room slot changes hands on the stream and the subscribe door too.

    Connecting is not the only way in. A connection that takes the room from
    another is the one told how far behind it is, so it has to be the one whose
    reading clears it, otherwise it reads everything and is told nothing
    happened.
    """
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=3)

    await buffer.take_counting(TENANT_ZERO_ID, AGENT, "connection-2", ROOM_A)
    await _caught_up(buffer, _connection("connection-2"), ROOM_A, "connection-2")

    assert (await _unread(buffer, ROOM_A)).count == 0


async def test_delivering_a_room_does_not_take_it_from_a_session(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """One connection carries every session, so it is not the caller in any room."""
    buffer = db_buffer
    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)

    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, "connection-shared", ROOM_A)
    await _caught_up(
        buffer, _connection("connection-shared"), ROOM_A, "connection-shared"
    )
    assert (await _unread(buffer, ROOM_A)).count == 2

    await _caught_up(buffer, _session("session-a"), ROOM_A, "connection-shared")
    assert (await _unread(buffer, ROOM_A)).count == 0


async def test_taking_a_room_does_take_it_from_a_session(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A takeover is not coverage: the session it displaced is out of the room.

    A legacy client taking the slot is told how far behind the room is, so its
    reading has to clear it. Being told 3 and reading all three and still
    being told 3 is the count losing its meaning.
    """
    buffer = db_buffer
    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A)
    await _chatter(session_factory, ROOM_A, times=3)

    await buffer.take_counting(TENANT_ZERO_ID, AGENT, "connection-legacy", ROOM_A)
    await _caught_up(
        buffer, _connection("connection-legacy"), ROOM_A, "connection-legacy"
    )

    assert (await _unread(buffer, ROOM_A)).count == 0


async def test_a_displaced_session_cannot_adopt_the_count_it_lost(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """The other half of a takeover: the session that was there keeps reading.

    Its read was begun before it lost the room and lands afterwards. A session
    outranking whatever connection holds the count would hand the room straight
    back to it, and the client that actually holds the slot would be told it is
    caught up on messages it has never been shown.
    """
    buffer = db_buffer
    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A)
    in_flight = await _chatter(session_factory, ROOM_A, times=3)

    await buffer.take_counting(TENANT_ZERO_ID, AGENT, "connection-legacy", ROOM_A)
    await buffer.caught_up(
        TENANT_ZERO_ID,
        AGENT,
        _connection("connection-legacy"),
        ROOM_A,
        in_flight,
        "connection-legacy",
    )
    await _chatter(session_factory, ROOM_A, times=2)

    await _caught_up(buffer, _session("session-a"), ROOM_A, "connection-a")

    assert (await _unread(buffer, ROOM_A)).count == 2


async def test_a_session_adopts_a_count_opened_in_its_connections_name(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A session is not a stranger to a room its own connection is counting.

    The stream covers the room before the session says anything, so what is
    recorded is the connection. The session reads, and its read has to land
    somewhere: held to the letter, it would clear nothing, and the count would
    only grow for as long as the session lived.
    """
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)

    await _caught_up(buffer, _session("session-a"), ROOM_A, READER)
    await _chatter(session_factory, ROOM_A, times=1)

    assert await _unread(buffer, ROOM_A) == Unread(count=1, reason=None)


async def test_a_read_by_the_session_that_lost_the_room_clears_nothing(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """The reproduction: siblings share a connection, so it cannot say who read.

    A read is begun before its history arrives. Another session of the agent
    taking the room in between comes back to a count of its own, one it has
    not read a word of, and the displaced session's answer must not be
    credited to it.
    """
    buffer = db_buffer
    shared = "connection-shared"
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, shared, ROOM_A)
    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A)
    in_flight = await _chatter(session_factory, ROOM_A, times=3)

    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-b"), ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)
    await buffer.caught_up(
        TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A, in_flight, shared
    )

    assert (await _unread(buffer, ROOM_A)).count == 5


async def test_the_session_that_took_the_room_still_clears_it(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """The fence is about who is in the room, not about refusing reads."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)

    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-b"), ROOM_A)
    await _caught_up(buffer, _session("session-b"), ROOM_A, READER)

    assert (await _unread(buffer, ROOM_A)).count == 0


async def test_taking_a_room_inherits_what_went_past_unread_in_it(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Chatter nobody read stays unread when the room changes hands."""
    buffer = db_buffer
    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A)
    await _chatter(session_factory, ROOM_A, times=4)

    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-b"), ROOM_A)

    assert (await _unread(buffer, ROOM_A)).count == 4


async def test_a_room_counted_for_the_first_time_counts_what_is_retained(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Arriving somewhere new, the most that can be said is the retention
    window: the stretch of conversation the agent's own events are kept for."""
    buffer = db_buffer
    await say(
        session_factory,
        ROOM_A,
        "before the window",
        sent_at=datetime.now(UTC) - timedelta(hours=2),
    )
    await _chatter(session_factory, ROOM_A, times=2)

    await buffer.hand_counting_to(TENANT_ZERO_ID, AGENT, _session("session-a"), ROOM_A)

    assert (await _unread(buffer, ROOM_A)).count == 2


async def test_a_room_nothing_recorded_a_baseline_for_has_no_count(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    buffer = db_buffer
    await _chatter(session_factory, ROOM_A, times=2)

    unread = await _unread(buffer, ROOM_A)

    assert unread.count is None
    assert unread.reason == NO_BASELINE


async def test_a_baseline_survives_the_room_being_covered_or_taken_again(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Neither door may quietly discard what the reader is behind by."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)

    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    assert (await _unread(buffer, ROOM_A)).count == 2

    await buffer.take_counting(TENANT_ZERO_ID, AGENT, "connection-2", ROOM_A)
    assert (await _unread(buffer, ROOM_A)).count == 2


async def test_a_restart_keeps_what_a_room_is_behind_by(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Nothing about a room's count is held by the process that counted it.

    Where the room was last caught up is a row, so a restarted server reads
    the same count rather than an unknown or a zero, and the stream covering
    the room again when it reconnects does not start it over.
    """
    await db_buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)

    restarted = db_buffer_on(session_factory)
    await restarted.ensure_counting(TENANT_ZERO_ID, AGENT, "connection-2", ROOM_A)

    assert await _unread(restarted, ROOM_A) == Unread(count=2, reason=None)


async def test_catching_up_only_moves_forward(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A read is begun before its history arrives, so an older answer can land
    after a newer one. It must not hand back what the newer one cleared."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    older = await _chatter(session_factory, ROOM_A, times=2)
    newer = await _chatter(session_factory, ROOM_A, times=1)

    reader = _connection(READER)
    await buffer.caught_up(TENANT_ZERO_ID, AGENT, reader, ROOM_A, newer, READER)
    await buffer.caught_up(TENANT_ZERO_ID, AGENT, reader, ROOM_A, older, READER)
    await _chatter(session_factory, ROOM_A, times=1)

    assert await _unread(buffer, ROOM_A) == Unread(count=1, reason=None)


async def test_retention_never_takes_from_what_a_room_counts(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """The agent's own events age out; the conversation they are counted
    against does not. A room whose events were dropped is told of the gap on
    its stream, and its count is still the whole of what went past."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_B)

    await _chatter(session_factory, ROOM_A, times=2)
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM_A,
        AgentEvent(
            type="command",
            room_id=ROOM_A,
            payload=CommandPayload(command="reset", user_id="@u:s", user_name="u"),
        ),
        room_seq=0,
        message_key=None,
    )
    await _expire_everything_so_far(buffer, session_factory)
    await _chatter(session_factory, ROOM_A, times=1)
    await _chatter(session_factory, ROOM_B, times=1)

    assert await buffer.rooms_dropped_after(TENANT_ZERO_ID, AGENT, 0) == (ROOM_A,)
    assert await _unread(buffer, ROOM_A) == Unread(count=3, reason=None)
    assert await _unread(buffer, ROOM_B) == Unread(count=1, reason=None)


async def test_a_drop_names_the_rooms_that_lost_events(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    buffer = db_buffer
    await _addressed(buffer, session_factory, ROOM_A)
    await _addressed(buffer, session_factory, ROOM_A)
    await _expire_everything_so_far(buffer, session_factory)
    await _addressed(buffer, session_factory, ROOM_B)
    await _addressed(buffer, session_factory, ROOM_B)

    assert await buffer.rooms_dropped_after(TENANT_ZERO_ID, AGENT, 0) == (ROOM_A,)
    assert (
        await buffer.rooms_dropped_after(
            TENANT_ZERO_ID, AGENT, await buffer.head(TENANT_ZERO_ID, AGENT)
        )
        == ()
    )


async def test_only_unaddressed_messages_are_counted(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """The count exists to say what the reader was not woken for.

    A message addressed to the agent woke it, a command is not conversation,
    and what the agent said itself it cannot have missed.
    """
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)

    await _addressed(buffer, session_factory, ROOM_A)
    command = await say(
        session_factory,
        ROOM_A,
        "!reset",
        event_type="com.switch.command",
        content={"command": "reset", "args": ""},
    )
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM_A,
        AgentEvent(
            type="command",
            room_id=ROOM_A,
            payload=CommandPayload(command="reset", user_id="@u:s", user_name="u"),
        ),
        room_seq=command.seq,
        message_key=command.transport_event_id,
    )
    await say(
        session_factory,
        ROOM_A,
        "on it",
        sender=await sender_of(session_factory, AGENT),
    )
    await _chatter(session_factory, ROOM_A)

    assert (await _unread(buffer, ROOM_A)).count == 1


async def test_several_files_posted_as_one_message_count_once(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Files posted together are a row each in the room's log, and one message
    to whoever posted them, so they are one message missed. Addressed to the
    agent, they are not missed at all."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)

    for index in range(3):
        await say(session_factory, ROOM_A, "chart", content=_part("posted", index, 3))
    # The agent's consumer keeps a group addressed to it as one event, under
    # the group's id, once its last part is in.
    for index in range(2):
        last = await say(
            session_factory, ROOM_A, "brief", content=_part("asked", index, 2)
        )
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM_A,
        _asked(ROOM_A, "asked"),
        room_seq=last.seq,
        message_key="asked",
    )

    assert (await _unread(buffer, ROOM_A)).count == 1


async def test_a_count_stops_at_the_event_it_is_reported_alongside(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Chatter that arrived after the woken-for event is not yet its business."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)
    addressed = await _addressed(buffer, session_factory, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=5)

    assert (await buffer.unread(TENANT_ZERO_ID, AGENT, ROOM_A, addressed)).count == 2


async def test_a_room_not_caught_up_on_for_longer_than_the_window_counts_over_it(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Past the retention window the agent's own events are gone, so a message
    addressed to it there could no longer be told from chatter and would be
    counted as missed. The count stops at the window and says it is a floor."""
    buffer = db_buffer
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    long_ago = datetime.now(UTC) - timedelta(hours=2)
    await say(session_factory, ROOM_A, "@agent over to you", sent_at=long_ago)
    await say(session_factory, ROOM_A, "old chatter", sent_at=long_ago)
    await _chatter(session_factory, ROOM_A, times=2)

    assert await _unread(buffer, ROOM_A) == Unread(count=2, reason=COUNTED_FROM_WINDOW)


async def _history_for_a_catch_up(
    buffer: EventBuffer, session_factory: SessionFactory
) -> dict[str, list[int]]:
    """Rooms with every kind of row a count has to tell apart, as a stream
    catching up meets them. The positions in each room a count is asked at:
    every row in it, so that counts are asked in the middle of groups of files
    and right after the agent's own messages."""
    agent_sender = await sender_of(session_factory, AGENT)
    # Room A: counted from the start, with chatter, messages addressed to the
    # agent, what the agent said itself, files posted as one message, and
    # files addressed to the agent as one message.
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_A)
    await _chatter(session_factory, ROOM_A, times=2)
    await _addressed(buffer, session_factory, ROOM_A)
    await say(session_factory, ROOM_A, "on it", sender=agent_sender)
    for index in range(3):
        await say(session_factory, ROOM_A, "chart", content=_part("posted", index, 3))
        await _chatter(session_factory, ROOM_A)
    for index in range(2):
        last = await say(
            session_factory, ROOM_A, "brief", content=_part("asked", index, 2)
        )
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM_A,
        _asked(ROOM_A, "asked"),
        room_seq=last.seq,
        message_key="asked",
    )
    await _chatter(session_factory, ROOM_A, times=2)
    await _addressed(buffer, session_factory, ROOM_A)
    await _chatter(session_factory, ROOM_A)

    # Room B: last caught up before the retention window, so its counts start
    # at the window and say so.
    await buffer.ensure_counting(TENANT_ZERO_ID, AGENT, READER, ROOM_B)
    long_ago = datetime.now(UTC) - timedelta(hours=2)
    await say(session_factory, ROOM_B, "@agent over to you", sent_at=long_ago)
    await say(session_factory, ROOM_B, "old chatter", sent_at=long_ago)
    await _chatter(session_factory, ROOM_B, times=2)
    await _addressed(buffer, session_factory, ROOM_B)
    await say(session_factory, ROOM_B, "noted", sender=agent_sender)
    await _chatter(session_factory, ROOM_B)

    # Room C: nothing recorded a baseline, so it has no count at all.
    await seed_room(session_factory, ROOM_C)
    await _chatter(session_factory, ROOM_C, times=2)

    return {
        room: list(range(1, await _head(buffer, room) + 1))
        for room in (ROOM_A, ROOM_B, ROOM_C)
    }


async def test_a_batch_counts_what_counting_each_event_alone_counts(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A catch-up counts every event it is woken for in one batch, and must
    tell each event exactly what counting it on its own would have.

    The batch is counted by a second buffer on the same database, as another
    process would after the agent's stream moved there."""
    buffer = db_buffer
    rooms = await _history_for_a_catch_up(buffer, session_factory)
    # Part of room A caught up on, so some positions asked fall below the
    # baseline.
    await buffer.caught_up(TENANT_ZERO_ID, AGENT, _connection(READER), ROOM_A, 3, None)
    # Asked out of order and with repeats, as events from several rooms
    # interleave in a stream.
    positions = [
        (room, seq) for seq in range(30, 0, -1) for room in rooms if seq in rooms[room]
    ]
    positions += positions[:5]

    elsewhere = db_buffer_on(session_factory)
    batch = await elsewhere.unread_batch(TENANT_ZERO_ID, AGENT, positions)

    one_by_one = {
        (room, seq): await buffer.unread(TENANT_ZERO_ID, AGENT, room, seq)
        for room, seq in positions
    }
    assert batch == one_by_one
    # The mix covered every kind of answer, so the comparison means something.
    assert {unread.reason for unread in batch.values()} == {
        None,
        COUNTED_FROM_WINDOW,
        NO_BASELINE,
    }
    assert batch[(ROOM_A, rooms[ROOM_A][-1])] == Unread(count=7, reason=None)
    assert batch[(ROOM_B, rooms[ROOM_B][-1])] == Unread(
        count=3, reason=COUNTED_FROM_WINDOW
    )


async def test_a_batch_costs_the_same_statements_however_many_events_it_counts(
    db_buffer: EventBuffer,
    session_factory: SessionFactory,
    statement_counts: StatementCounts,
) -> None:
    """Counting each event on its own cost four statements an event, so a
    catch-up of two hundred events ran about eight hundred. A batch costs a
    fixed number per room, whatever the number of events in it."""
    buffer = db_buffer
    rooms = await _history_for_a_catch_up(buffer, session_factory)

    with statement_counts.scope("one event a room") as few:
        await buffer.unread_batch(
            TENANT_ZERO_ID, AGENT, [(room, seqs[-1]) for room, seqs in rooms.items()]
        )
    with statement_counts.scope("every event") as many:
        await buffer.unread_batch(
            TENANT_ZERO_ID,
            AGENT,
            [(room, seq) for room, seqs in rooms.items() for seq in seqs],
        )

    assert sum(len(seqs) for seqs in rooms.values()) > 3 * len(rooms)
    assert many.count == few.count

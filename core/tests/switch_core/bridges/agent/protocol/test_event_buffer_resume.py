"""Sequencing, resume and gap behaviour of the event buffer (CHOO-1857).

These cover the properties the push transport depends on: reads do not consume,
a reader can resume from a cursor across a disconnect, and a reader that has
fallen off the end of the buffer is told rather than quietly fast-forwarded.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import (
    BufferedEvent,
    CursorExpiredError,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    CommandPayload,
    MessagePayload,
)
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import age_events, db_buffer_on, say, seed_agent, seed_member

AGENT = "agent-1"
ROOM_A = "room-a"
ROOM_B = "room-b"


@pytest.fixture(autouse=True)
async def _agent_rows(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent every event here is queued for, so its rows have one to belong
    to, and a member of the room the legacy pollers read the conversation of."""
    await seed_agent(session_factory, AGENT)
    await seed_member(session_factory, AGENT, ROOM_A)


def _message(body: str, *, room: str = ROOM_A) -> AgentEvent:
    """A message addressed to the agent: the kind of message it keeps."""
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id=f"$evt-{body}",
            body=body,
            timestamp=0,
        ),
    )


def _command(name: str, *, room: str = ROOM_A) -> AgentEvent:
    """One of the agent's own events that is not a notification."""
    return AgentEvent(
        type="command",
        room_id=room,
        payload=CommandPayload(command=name, user_id="@u:s", user_name="u"),
    )


async def _keep(buf: EventBuffer, event: AgentEvent) -> int:
    """Keep one of the agent's own events. What is under test is the agent's
    sequence, so the room row it stands for is left out."""
    return await buf.enqueue(
        TENANT_ZERO_ID, AGENT, event.room_id, event, room_seq=0, message_key=None
    )


def _bodies(items: list[BufferedEvent]) -> list[str]:
    """What each event says: a message's body, or a command as it was typed."""
    return [
        f"!{item.event.payload.command}"
        if isinstance(item.event.payload, CommandPayload)
        else item.event.payload.body
        for item in items
    ]


async def test_sequence_numbers_are_monotonic_per_agent(db_buffer: EventBuffer) -> None:
    buf = db_buffer
    assert await _keep(buf, _message("one")) == 1
    assert await _keep(buf, _message("two", room=ROOM_B)) == 2
    assert await _keep(buf, _message("three")) == 3
    assert await buf.head(TENANT_ZERO_ID, AGENT) == 3


async def test_reading_does_not_consume(db_buffer: EventBuffer) -> None:
    buf = db_buffer
    await _keep(buf, _message("one"))

    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 0)) == ["one"]
    # The same event is still there for a second, independent reader — this is
    # what removes the need for DISABLE_POLL.
    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 0)) == ["one"]


async def test_resume_returns_only_events_after_the_cursor(
    db_buffer: EventBuffer,
) -> None:
    buf = db_buffer
    for body in ("one", "two", "three"):
        await _keep(buf, _message(body))

    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 1)) == ["two", "three"]
    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 3)) == []


async def test_events_missed_while_disconnected_are_replayed_on_resume(
    db_buffer: EventBuffer,
) -> None:
    buf = db_buffer
    await _keep(buf, _message("before"))
    seen = await buf.read_from(TENANT_ZERO_ID, AGENT, 0)
    cursor = seen[-1].seq

    # Client is gone; events keep arriving.
    await _keep(buf, _message("during-1"))
    await _keep(buf, _message("during-2"))

    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, cursor)) == [
        "during-1",
        "during-2",
    ]


async def test_room_and_notifiable_filters_are_independent(
    db_buffer: EventBuffer,
) -> None:
    buf = db_buffer
    await _keep(buf, _command("reset"))
    await _keep(buf, _message("a-addressed"))
    await _keep(buf, _message("b-addressed", room=ROOM_B))

    # A session: one room, everything in it.
    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 0, rooms={ROOM_A})) == [
        "!reset",
        "a-addressed",
    ]
    # A supervising connection: every room, addressed only.
    assert _bodies(
        await buf.read_from(TENANT_ZERO_ID, AGENT, 0, notifiable_only=True)
    ) == [
        "a-addressed",
        "b-addressed",
    ]
    # Both dials at once.
    assert _bodies(
        await buf.read_from(
            TENANT_ZERO_ID, AGENT, 0, rooms={ROOM_B}, notifiable_only=True
        )
    ) == ["b-addressed"]


async def test_expiry_drops_the_oldest_and_flags_a_gap(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    buf = db_buffer
    await _keep(buf, _message("one"))
    await age_events(session_factory, AGENT, seconds=2 * 3600)
    await buf.expire(TENANT_ZERO_ID)
    for body in ("two", "three", "four"):
        await _keep(buf, _message(body))

    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 1)) == [
        "two",
        "three",
        "four",
    ]
    assert await buf.rooms_dropped_after(TENANT_ZERO_ID, AGENT, 0) == (ROOM_A,)
    assert await buf.rooms_dropped_after(TENANT_ZERO_ID, AGENT, 1) == ()


async def test_resuming_from_an_expired_cursor_raises_rather_than_skipping(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    buf = db_buffer
    await _keep(buf, _message("one"))
    await age_events(session_factory, AGENT, seconds=2 * 3600)
    await buf.expire(TENANT_ZERO_ID)
    for body in ("two", "three"):
        await _keep(buf, _message(body))

    with pytest.raises(CursorExpiredError) as excinfo:
        await buf.read_from(TENANT_ZERO_ID, AGENT, 0)

    assert excinfo.value.requested == 0
    assert excinfo.value.oldest == 2
    assert excinfo.value.rooms == (ROOM_A,)


async def test_retention_window_expires_events_and_flags_a_gap(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Only what is older than the window goes: an event inside it survives
    the same sweep."""
    buf = db_buffer_on(session_factory, retention_seconds=60)
    await _keep(buf, _message("old"))
    await age_events(session_factory, AGENT, seconds=61)
    await _keep(buf, _message("new"))

    assert await buf.expire(TENANT_ZERO_ID) == 1

    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 1)) == ["new"]
    with pytest.raises(CursorExpiredError):
        await buf.read_from(TENANT_ZERO_ID, AGENT, 0)


async def test_a_quiet_agent_stops_serving_an_event_when_its_window_ends(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Expiry sweeps the tenant rather than riding on an append, so an agent
    nothing else is queued for loses its old events all the same."""
    buf = db_buffer_on(session_factory, retention_seconds=60)
    await _keep(buf, _message("only"))
    await age_events(session_factory, AGENT, seconds=61)

    await buf.expire(TENANT_ZERO_ID)

    assert await buf.read_from(TENANT_ZERO_ID, AGENT, 1) == []
    with pytest.raises(CursorExpiredError):
        await buf.read_from(TENANT_ZERO_ID, AGENT, 0)


async def test_a_reader_resumes_past_everything_expiry_deleted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """When retention has deleted all of the agent's own events, there is no
    oldest one to resume before. The error names a place past every deleted
    number, and a reader moved there reads nothing rather than being told
    about the same deletion again."""
    buf = db_buffer_on(session_factory, retention_seconds=60)
    first = await _keep(buf, _message("one"))
    last = await _keep(buf, _message("two"))
    await age_events(session_factory, AGENT, seconds=61)
    await buf.expire(TENANT_ZERO_ID)

    with pytest.raises(CursorExpiredError) as excinfo:
        await buf.read_from(TENANT_ZERO_ID, AGENT, first - 1)

    assert excinfo.value.oldest == 0
    assert excinfo.value.resume_after == last
    assert await buf.read_from(TENANT_ZERO_ID, AGENT, excinfo.value.resume_after) == []


async def test_a_long_poll_after_everything_expired_returns_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A long-polling client cannot be told about a gap. Once retention has
    deleted everything after its place, its poll moves past what was deleted
    and returns what is left, here nothing, instead of failing."""
    buf = db_buffer_on(session_factory, retention_seconds=60)
    assert await buf.poll(TENANT_ZERO_ID, AGENT, rooms={ROOM_A}, timeout=0) == []
    await _keep(buf, _message("only"))
    await age_events(session_factory, AGENT, seconds=61)
    await buf.expire(TENANT_ZERO_ID)

    assert await buf.poll(TENANT_ZERO_ID, AGENT, rooms={ROOM_A}, timeout=0) == []


async def test_processes_of_different_boots_number_an_agent_alike(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A process reads the head of an agent that has no own events yet, and a
    process started at an earlier boot then writes the agent's first one. The
    event is numbered after the head the first process reported, so a reader
    placed at that head still receives it."""
    newer = db_buffer_on(session_factory, sequence_base=11 << 32)
    older = db_buffer_on(session_factory, sequence_base=10 << 32)

    head = await newer.head(TENANT_ZERO_ID, AGENT)
    first = await _keep(older, _message("first"))

    assert first == head + 1
    assert _bodies(await newer.read_from(TENANT_ZERO_ID, AGENT, head)) == ["first"]


async def test_consuming_does_not_discard_events_for_other_readers(
    db_buffer: EventBuffer,
) -> None:
    buf = db_buffer
    await _keep(buf, _message("one"))

    # A legacy poller takes it, and the position kept for it moves past it.
    assert len(await buf.poll_room(TENANT_ZERO_ID, AGENT, ROOM_A, timeout=0)) == 1

    # A reader that arrives afterwards still sees it: retention is by age,
    # not by what someone else has consumed.
    assert _bodies(await buf.read_from(TENANT_ZERO_ID, AGENT, 0)) == ["one"]


async def test_legacy_pollers_no_longer_steal_from_each_other(
    db_buffer: EventBuffer,
) -> None:
    buf = db_buffer
    await _keep(buf, _message("hello"))

    room = await buf.poll_room(TENANT_ZERO_ID, AGENT, ROOM_A, timeout=0)
    notif = await buf.poll_notifications(
        TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM_A}
    )
    every = await buf.poll(TENANT_ZERO_ID, AGENT, timeout=0, rooms={ROOM_A})

    assert [e.payload.body for e in room] == ["hello"]
    assert [e.payload.body for e in notif] == ["hello"]
    assert [e.payload.body for e in every] == ["hello"]


async def test_legacy_poller_does_not_see_the_same_event_twice(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Neither the conversation nor the agent's own events: the position kept
    for the poller moves past both, and an addressed message, which is both a
    row in the room and the agent's own event, comes once."""
    buf = db_buffer
    await say(session_factory, ROOM_A, "one")

    assert len(await buf.poll_room(TENANT_ZERO_ID, AGENT, ROOM_A, timeout=0)) == 1
    assert await buf.poll_room(TENANT_ZERO_ID, AGENT, ROOM_A, timeout=0) == []

    row = await say(session_factory, ROOM_A, "two")
    await buf.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM_A,
        _message("two"),
        room_seq=row.seq,
        message_key=row.transport_event_id,
    )
    second = await buf.poll_room(TENANT_ZERO_ID, AGENT, ROOM_A, timeout=0)
    assert [e.payload.body for e in second] == ["two"]


async def test_legacy_poller_receives_events_queued_before_it_polled(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """A poller seen for the first time reads the room from the start of the
    retention window, not from now: what was said while nobody was polling is
    what its first poll is for."""
    buf = db_buffer
    await say(session_factory, ROOM_A, "queued-while-away")

    events = await buf.poll_room(TENANT_ZERO_ID, AGENT, ROOM_A, timeout=0)
    assert [e.payload.body for e in events] == ["queued-while-away"]

"""Sequencing, resume and gap behaviour of the event buffer (CHOO-1857).

These cover the properties the push transport depends on: reads do not consume,
a reader can resume from a cursor across a disconnect, and a reader that has
fallen off the end of the buffer is told rather than quietly fast-forwarded.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.protocol.event_buffer import (
    CursorExpiredError,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

AGENT = "agent-1"
ROOM_A = "room-a"
ROOM_B = "room-b"


def _message(body: str, *, addressed: bool = False, room: str = ROOM_A) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=addressed,
            sender="@u:s",
            sender_name="u",
            message_id=f"$evt-{body}",
            body=body,
            timestamp=0,
        ),
    )


def _bodies(items: list) -> list[str]:
    return [item.event.payload.body for item in items]


def test_sequence_numbers_are_monotonic_per_agent() -> None:
    buf = EventBuffer()
    assert buf.enqueue(AGENT, ROOM_A, _message("one")) == 1
    assert buf.enqueue(AGENT, ROOM_B, _message("two", room=ROOM_B)) == 2
    assert buf.enqueue(AGENT, ROOM_A, _message("three")) == 3
    assert buf.head(AGENT) == 3


def test_reading_does_not_consume() -> None:
    buf = EventBuffer()
    buf.enqueue(AGENT, ROOM_A, _message("one"))

    assert _bodies(buf.read_from(AGENT, 0)) == ["one"]
    # The same event is still there for a second, independent reader — this is
    # what removes the need for DISABLE_POLL.
    assert _bodies(buf.read_from(AGENT, 0)) == ["one"]


def test_resume_returns_only_events_after_the_cursor() -> None:
    buf = EventBuffer()
    for body in ("one", "two", "three"):
        buf.enqueue(AGENT, ROOM_A, _message(body))

    assert _bodies(buf.read_from(AGENT, 1)) == ["two", "three"]
    assert _bodies(buf.read_from(AGENT, 3)) == []


def test_events_missed_while_disconnected_are_replayed_on_resume() -> None:
    buf = EventBuffer()
    buf.enqueue(AGENT, ROOM_A, _message("before"))
    seen = buf.read_from(AGENT, 0)
    cursor = seen[-1].seq

    # Client is gone; events keep arriving.
    buf.enqueue(AGENT, ROOM_A, _message("during-1"))
    buf.enqueue(AGENT, ROOM_A, _message("during-2"))

    assert _bodies(buf.read_from(AGENT, cursor)) == ["during-1", "during-2"]


def test_room_and_notifiable_filters_are_independent() -> None:
    buf = EventBuffer()
    buf.enqueue(AGENT, ROOM_A, _message("a-chatter"))
    buf.enqueue(AGENT, ROOM_A, _message("a-addressed", addressed=True))
    buf.enqueue(AGENT, ROOM_B, _message("b-addressed", addressed=True, room=ROOM_B))

    # A session: one room, everything in it.
    assert _bodies(buf.read_from(AGENT, 0, rooms={ROOM_A})) == [
        "a-chatter",
        "a-addressed",
    ]
    # A supervising connection: every room, addressed only.
    assert _bodies(buf.read_from(AGENT, 0, notifiable_only=True)) == [
        "a-addressed",
        "b-addressed",
    ]
    # Both dials at once.
    assert _bodies(buf.read_from(AGENT, 0, rooms={ROOM_B}, notifiable_only=True)) == [
        "b-addressed"
    ]


def test_overflow_drops_oldest_and_flags_a_gap() -> None:
    buf = EventBuffer(max_events_per_agent=3)
    for body in ("one", "two", "three", "four"):
        buf.enqueue(AGENT, ROOM_A, _message(body))

    assert _bodies(buf.read_from(AGENT, 1)) == ["two", "three", "four"]
    assert buf.has_gap_before(AGENT, 0)
    assert not buf.has_gap_before(AGENT, 1)


def test_resuming_from_an_expired_cursor_raises_rather_than_skipping() -> None:
    buf = EventBuffer(max_events_per_agent=2)
    for body in ("one", "two", "three"):
        buf.enqueue(AGENT, ROOM_A, _message(body))

    with pytest.raises(CursorExpiredError) as excinfo:
        buf.read_from(AGENT, 0)

    assert excinfo.value.requested == 0
    assert excinfo.value.oldest == 2


def test_retention_window_expires_events_and_flags_a_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"now": 1000.0}
    monkeypatch.setattr(
        "switch_core.bridges.agent.protocol.event_buffer.time.monotonic",
        lambda: clock["now"],
    )

    buf = EventBuffer(retention_seconds=60)
    buf.enqueue(AGENT, ROOM_A, _message("old"))

    clock["now"] += 61
    buf.enqueue(AGENT, ROOM_A, _message("new"))

    assert _bodies(buf.read_from(AGENT, 1)) == ["new"]
    with pytest.raises(CursorExpiredError):
        buf.read_from(AGENT, 0)


def test_confirming_does_not_discard_events_for_other_readers() -> None:
    buf = EventBuffer()
    buf.enqueue(AGENT, ROOM_A, _message("one"))

    buf.confirm(AGENT, "reader-a", 1)

    # A reader that arrives afterwards still sees it: retention is by age and
    # cap, not by what someone else has consumed.
    assert _bodies(buf.read_from(AGENT, 0)) == ["one"]


def test_confirm_never_rewinds() -> None:
    buf = EventBuffer()
    buf.register_reader(AGENT, "reader-a", 0)
    buf.confirm(AGENT, "reader-a", 5)
    buf.confirm(AGENT, "reader-a", 2)
    assert buf._cursors[AGENT]["reader-a"] == 5


async def test_legacy_pollers_no_longer_steal_from_each_other() -> None:
    buf = EventBuffer()
    buf.enqueue(AGENT, ROOM_A, _message("hello", addressed=True))

    room = await buf.poll_room(AGENT, ROOM_A, timeout=0)
    notif = await buf.poll_notifications(AGENT, timeout=0)
    every = await buf.poll(AGENT, timeout=0)

    assert [e.payload.body for e in room] == ["hello"]
    assert [e.payload.body for e in notif] == ["hello"]
    assert [e.payload.body for e in every] == ["hello"]


async def test_legacy_poller_does_not_see_the_same_event_twice() -> None:
    buf = EventBuffer()
    buf.enqueue(AGENT, ROOM_A, _message("one"))

    assert len(await buf.poll_room(AGENT, ROOM_A, timeout=0)) == 1
    assert await buf.poll_room(AGENT, ROOM_A, timeout=0) == []

    buf.enqueue(AGENT, ROOM_A, _message("two"))
    second = await buf.poll_room(AGENT, ROOM_A, timeout=0)
    assert [e.payload.body for e in second] == ["two"]


async def test_legacy_poller_receives_events_queued_before_it_polled() -> None:
    buf = EventBuffer()
    buf.enqueue(AGENT, ROOM_A, _message("queued-while-away"))

    events = await buf.poll_room(AGENT, ROOM_A, timeout=0)
    assert [e.payload.body for e in events] == ["queued-while-away"]

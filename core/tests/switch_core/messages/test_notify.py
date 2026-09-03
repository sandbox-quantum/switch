"""New rows announce themselves, and the listener wakes whoever asked.

These run against real PostgreSQL because the thing under test is a trigger and
a `LISTEN`. Neither has a meaningful stand-in: a fake would prove the fan-out
works and say nothing about whether the database ever speaks.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import TYPE_CHECKING

import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.db.models import Message, Room
from switch_core.messages.notify import Announcement, MessageListener

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# Long enough that a slow container does not fail the test, short enough that a
# genuine hang does not hold the suite up.
DELIVERY_TIMEOUT = 10.0


class Woken:
    """Records which rooms were woken, and lets a test wait for one."""

    def __init__(self) -> None:
        self.rooms: list[str] = []
        self._anything = asyncio.Event()

    async def __call__(self, room_id: str) -> None:
        self.rooms.append(room_id)
        self._anything.set()

    async def wait(self) -> None:
        await asyncio.wait_for(self._anything.wait(), DELIVERY_TIMEOUT)
        self._anything.clear()


@pytest.fixture
async def listener(postgres_url: str) -> AsyncIterator[MessageListener]:
    listener = MessageListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )
    await listener.start()
    try:
        await asyncio.wait_for(listener.connected.wait(), DELIVERY_TIMEOUT)
        yield listener
    finally:
        await listener.stop()


async def _make_room(session: AsyncSession) -> str:
    room = Room(
        matrix_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
        name="a room",
        description="",
    )
    session.add(room)
    await session.flush()
    return room.id


async def _write(session: AsyncSession, room_id: str, seq: int) -> None:
    session.add(
        Message(
            seq=seq,
            room_id=room_id,
            transport_event_id=f"$e{uuid.uuid4().hex[:8]}",
            sender_matrix_id="@a:test",
            event_type="m.room.message",
            msgtype="m.text",
            body="hello",
            content={"body": "hello"},
        )
    )
    await session.commit()


class TestParsingAnnouncements:
    def test_a_payload_becomes_an_announcement(self) -> None:
        announcement = Announcement.parse('{"room_id": "r1", "seq": 4, "id": "m1"}')
        assert announcement == Announcement(room_id="r1", seq=4, message_id="m1")

    @pytest.mark.parametrize(
        "payload", ["not json", "{}", '{"room_id": "r1", "seq": "no"}', "[]"]
    )
    def test_an_unreadable_payload_is_dropped_not_raised(self, payload: str) -> None:
        """This runs inside the connection's read loop. Raising there would
        take delivery down for every room over one bad message."""
        assert Announcement.parse(payload) is None


class TestDelivery:
    async def test_writing_a_message_wakes_a_subscriber(
        self,
        listener: MessageListener,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        async with session_factory() as session:
            room_id = await _make_room(session)
            await session.commit()

        woken = Woken()
        listener.subscribe(room_id, woken)
        await woken.wait()  # subscribing wakes once by design
        woken.rooms.clear()

        async with session_factory() as session:
            await _write(session, room_id, 1)

        await woken.wait()
        assert woken.rooms == [room_id]

    async def test_a_room_nobody_subscribed_to_wakes_nobody(
        self,
        listener: MessageListener,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        async with session_factory() as session:
            mine = await _make_room(session)
            theirs = await _make_room(session)
            await session.commit()

        woken = Woken()
        listener.subscribe(mine, woken)
        await woken.wait()
        woken.rooms.clear()

        async with session_factory() as session:
            await _write(session, theirs, 1)
            await _write(session, mine, 1)

        await woken.wait()
        assert woken.rooms == [mine]

    async def test_a_burst_coalesces_into_one_wake_up(
        self,
        listener: MessageListener,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """The wake-up says a room moved, not what was said, so several rows
        arriving together are one thing to react to. The subscriber reads from
        its own cursor and sees all of them either way."""
        async with session_factory() as session:
            room_id = await _make_room(session)
            await session.commit()

        blocked = asyncio.Event()
        released = asyncio.Event()
        calls = 0

        async def slow(_room_id: str) -> None:
            nonlocal calls
            calls += 1
            blocked.set()
            await released.wait()

        listener.subscribe(room_id, slow)
        await asyncio.wait_for(blocked.wait(), DELIVERY_TIMEOUT)

        async with session_factory() as session:
            for seq in range(1, 6):
                await _write(session, room_id, seq)

        # Let the announcements land while the subscriber is still held.
        await asyncio.sleep(0.5)
        released.set()
        await asyncio.sleep(0.5)

        assert calls == 2, "the subscribe wake-up, then one for the whole burst"

    async def test_unsubscribing_stops_the_wake_ups(
        self,
        listener: MessageListener,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        async with session_factory() as session:
            room_id = await _make_room(session)
            await session.commit()

        woken = Woken()
        listener.subscribe(room_id, woken)
        await woken.wait()
        listener.unsubscribe(room_id, woken)
        woken.rooms.clear()

        async with session_factory() as session:
            await _write(session, room_id, 1)

        await asyncio.sleep(0.5)
        assert woken.rooms == []

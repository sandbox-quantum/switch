"""A consumer one process owns reads from its stored cursors.

Against real PostgreSQL, two "processes" on one database, each with its own
process lease and cursor writer (`tests/ownership.py`), reading for the same
client in turn: what the first finished, the second does not repeat, and what
was written while neither read, the second delivers. A process that was taken
over without knowing it is refused when it records progress.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Message, SwitchCoreProcess
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.process_lease import LEASE_TTL
from switch_core.transport import InboundMembership, InboundMessage
from switch_core.transport.cursors import BACKLOG_MAX_AGE
from switch_core.transport.postgres import PostgresTransport
from tests.ownership import Holder, start_holder
from tests.switch_core.statement_counts import StatementCounts
from tests.switch_core.transport.test_postgres_transport import (
    _FakeListener,
    _make_client,
    _make_room,
    _Received,
    _transport,
    _watched_room,
)


@pytest.fixture
async def two_processes(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[tuple[Holder, Holder]]:
    first = await start_holder(session_factory)
    second = await start_holder(session_factory)
    try:
        yield first, second
    finally:
        await first.stop()
        await second.stop()


async def _member_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, str]:
    """A room and a client that is a member of it, its cursor written with
    the membership. Returns (room id, transport room id, client id, client
    user id)."""
    async with session_factory() as session:
        room_id, transport_room_id, client_id, user_id = await _make_room(session)
        await RoomStore().add_client(session, client_id, room_id)
        await session.commit()
    return room_id, transport_room_id, client_id, user_id


async def _say(
    session_factory: async_sessionmaker[AsyncSession],
    transport_room_id: str,
    body: str,
) -> None:
    """Write a message into the room, as someone other than the client."""
    async with session_factory() as session:
        client_id, user_id = await _make_client(session, "speaker")
        await session.commit()
    writer = _transport(session_factory, client_id=client_id, user_id=user_id)
    await writer.send_message(transport_room_id, body, sender_name=body, metered=False)


def _bodies(received: _Received) -> list[str]:
    return [
        event.body for event in received.events if isinstance(event, InboundMessage)
    ]


async def _read(
    holder: Holder,
    session_factory: async_sessionmaker[AsyncSession],
    client_id: str,
    user_id: str,
) -> tuple[PostgresTransport, _FakeListener, _Received, asyncio.Task[None]]:
    listener = _FakeListener()
    received = _Received()
    transport = _transport(
        session_factory, client_id=client_id, user_id=user_id, listener=listener
    )
    transport.register_handlers(received.handlers())
    task = await holder.receiving(transport)
    await _watched_room(transport)
    # Watching starts with a claim; the room is read from once its start is
    # known and it is subscribed.
    for _ in range(500):
        if transport._cursors:
            break
        await asyncio.sleep(0.005)
    return transport, listener, received, task


async def _drained(transport: PostgresTransport) -> None:
    for _ in range(500):
        if not transport._pending and not transport._delivering:
            return
        await asyncio.sleep(0.005)
    raise AssertionError("the transport never finished delivering")


async def _stop(
    transport: PostgresTransport, task: asyncio.Task[None], holder: Holder
) -> None:
    """Stop reading as an owner hands a client over: after the row in hand,
    with its progress stored."""
    await transport.close()
    await task
    await holder.writer.flush()


class TestAHandOver:
    async def test_the_next_owner_resumes_with_no_repeat_and_no_gap(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[Holder, Holder],
    ) -> None:
        room_id, room, client_id, user_id = await _member_room(session_factory)
        first, second = two_processes

        reader, listener, before, task = await _read(
            first, session_factory, client_id, user_id
        )
        await _say(session_factory, room, "one")
        await _say(session_factory, room, "two")
        await listener.announce(room_id)
        await _stop(reader, task, first)
        async with session_factory() as session:
            await OwnershipLeaseStore().release_all(session, first.process_id)
            await session.commit()

        # Said while nobody read for the client.
        await _say(session_factory, room, "three")
        await _say(session_factory, room, "four")

        reader, listener, after, task = await _read(
            second, session_factory, client_id, user_id
        )
        await _drained(reader)
        await _say(session_factory, room, "five")
        await listener.announce(room_id)

        assert _bodies(before) == ["one", "two"]
        assert _bodies(after) == ["three", "four", "five"]
        await _stop(reader, task, second)

    async def test_a_reader_taken_over_unawares_is_refused_and_told(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[Holder, Holder],
    ) -> None:
        room_id, room, client_id, user_id = await _member_room(session_factory)
        first, second = two_processes
        stale, stale_listener, _, stale_task = await _read(
            first, session_factory, client_id, user_id
        )
        # The first process stops renewing, unawares, and the second takes the
        # client over.
        async with session_factory() as session:
            await session.execute(
                update(SwitchCoreProcess)
                .where(SwitchCoreProcess.id == first.process_id)
                .values(beat_at=func.now() - LEASE_TTL - timedelta(seconds=1))
            )
            await session.commit()
        fresh, listener, received, task = await _read(
            second, session_factory, client_id, user_id
        )

        await _say(session_factory, room, "hello")
        await stale_listener.announce(room_id)
        await listener.announce(room_id)
        await first.writer.flush()
        await second.writer.flush()

        assert [fence.process_id for fence in first.lost] == [first.process_id]
        assert second.lost == []
        async with session_factory() as session:
            places = await DeliveryCursorStore().positions(
                session, client_id, [room_id]
            )
            head = await session.scalar(
                select(func.max(Message.seq)).where(Message.room_id == room_id)
            )
        assert places == {room_id: head}
        assert _bodies(received) == ["hello"]
        stale_task.cancel()
        await _stop(fresh, task, second)


class TestResuming:
    async def test_rows_too_old_to_act_on_are_stepped_over_and_counted(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[Holder, Holder],
    ) -> None:
        room_id, room, client_id, user_id = await _member_room(session_factory)
        await _say(session_factory, room, "an hour ago")
        await _say(session_factory, room, "just now")
        async with session_factory() as session:
            await session.execute(
                update(Message)
                .where(Message.room_id == room_id, Message.body == "an hour ago")
                .values(sent_at=func.now() - BACKLOG_MAX_AGE - timedelta(hours=1))
            )
            await session.commit()
        registry = MetricsRegistry()
        install(registry)
        try:
            reader, _, received, task = await _read(
                two_processes[0], session_factory, client_id, user_id
            )
            await _drained(reader)
            counted = sum(
                number.value
                for payload in registry.collect()
                if payload.name == "switch.messages.backlog_skipped"
                for number in payload.numbers
            )
        finally:
            uninstall()

        assert _bodies(received) == ["just now"]
        assert counted == 1
        await _stop(reader, task, two_processes[0])

    async def test_a_client_that_joins_hears_its_own_arrival(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[Holder, Holder],
    ) -> None:
        async with session_factory() as session:
            room_id, room, client_id, user_id = await _make_room(session)
            other_room, other, _, _ = await _make_room(session)
            # Reading somewhere already, so the join is to a room it is
            # watching for the first time.
            await RoomStore().add_client(session, client_id, other_room)
            await session.commit()
        reader, listener, received, task = await _read(
            two_processes[0], session_factory, client_id, user_id
        )

        await reader.join_room(room)
        await _drained(reader)

        arrivals = [
            event
            for event in received.events
            if isinstance(event, InboundMembership) and event.state_key == user_id
        ]
        assert [event.room_id for event in arrivals] == [room]
        await _stop(reader, task, two_processes[0])

    async def test_a_room_left_is_not_taken_for_a_lost_lease(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[Holder, Holder],
    ) -> None:
        room_id, room, client_id, user_id = await _member_room(session_factory)
        holder = two_processes[0]
        cursors = await holder.cursors(client_id)
        async with session_factory() as session:
            await RoomStore().remove_client(session, client_id, room_id)
            await session.commit()

        cursors.advance(room_id, 5)
        await holder.writer.flush()

        assert holder.lost == []


class TestTheWriter:
    async def test_many_rooms_are_written_in_as_few_statements_as_one(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        statement_counts: StatementCounts,
        two_processes: tuple[Holder, Holder],
    ) -> None:
        holder = two_processes[0]

        async def rooms_of_a_client(count: int) -> tuple[str, list[str]]:
            async with session_factory() as session:
                client_id, _ = await _make_client(session, f"many-{count}")
                rooms = []
                for _ in range(count):
                    room_id, _, _, _ = await _make_room(session)
                    await RoomStore().add_client(session, client_id, room_id)
                    rooms.append(room_id)
                await session.commit()
            return client_id, rooms

        async def write(count: int) -> int:
            client_id, rooms = await rooms_of_a_client(count)
            cursors = await holder.cursors(client_id)
            # The loop would race this test for the batch; it is stopped and
            # the batch flushed by hand.
            holder.task.cancel()
            for room_id in rooms:
                cursors.advance(room_id, 1)
            with statement_counts.scope(f"write {count}") as scope:
                await holder.writer.flush()
            return scope.count

        one = await write(1)
        five = await write(5)

        assert five == one

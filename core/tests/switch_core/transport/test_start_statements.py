"""A client starting up reads its rooms in a fixed number of statements.

At boot every client starts in all its rooms at once. Reading each room's id,
membership and head one at a time was over a thousand short sessions in a few
seconds on pilot, enough to drain the pool. The count must not grow with the
number of rooms, whether the client reads from each room's head or resumes
from cursors it stores, writing the ones it has none for.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ClientRoom, Room
from switch_core.db.stores.message_store import MessageStore
from switch_core.transport.cursors import DeliveryProgress, FromHead
from switch_core.transport.postgres import logger as transport_logger
from tests.ownership import start_holder
from tests.switch_core.statement_counts import StatementCounts
from tests.switch_core.transport.test_postgres_transport import (
    _make_client,
    _transport,
)

Progress = Callable[[str], Awaitable[DeliveryProgress]]


@pytest.fixture(params=["from head", "stored cursors"])
async def progress_for(
    request: pytest.FixtureRequest,
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[Progress]:
    """How a client is given its progress: read from each room's head, or
    owned by this test's process and resumed from stored cursors."""
    if request.param == "from head":

        async def from_head(client_id: str) -> DeliveryProgress:
            return FromHead(MessageStore())

        yield from_head
        return
    holder = await start_holder(session_factory)
    try:
        yield holder.cursors
    finally:
        await holder.stop()


async def _client_in_rooms(
    session_factory: async_sessionmaker[AsyncSession], rooms: int
) -> tuple[str, str, list[str]]:
    async with session_factory() as session:
        client_id, user_id = await _make_client(session, f"in-{rooms}")
        room_ids = []
        for n in range(rooms):
            room = Room(
                transport_room_id=f"!r{rooms}-{n}-{client_id[:8]}:test",
                name="r",
                description="",
            )
            session.add(room)
            await session.flush()
            session.add(ClientRoom(client_id=client_id, room_id=room.id))
            room_ids.append(room.id)
        await session.commit()
    return client_id, user_id, room_ids


async def _start(
    session_factory: async_sessionmaker[AsyncSession],
    counts: StatementCounts,
    progress_for: Progress,
    client_id: str,
    user_id: str,
    rooms: int,
) -> tuple[int, set[str]]:
    transport = _transport(session_factory, client_id=client_id, user_id=user_id)
    progress = await progress_for(client_id)
    with counts.scope(f"start in {rooms}") as scope:
        task = asyncio.create_task(transport.receive_forever(progress))
        for _ in range(300):
            if len(transport._cursors) == rooms:
                break
            await asyncio.sleep(0.01)
    watched = set(transport._cursors)
    await transport.close()
    task.cancel()
    return scope.count, watched


async def test_starting_in_six_rooms_runs_as_many_statements_as_in_one(
    session_factory: async_sessionmaker[AsyncSession],
    statement_counts: StatementCounts,
    progress_for: Progress,
) -> None:
    one = await _client_in_rooms(session_factory, 1)
    six = await _client_in_rooms(session_factory, 6)

    count_one, watched_one = await _start(
        session_factory, statement_counts, progress_for, *one[:2], 1
    )
    count_six, watched_six = await _start(
        session_factory, statement_counts, progress_for, *six[:2], 6
    )

    assert watched_one == set(one[2])
    assert watched_six == set(six[2])
    assert count_six == count_one


async def test_a_room_left_before_its_membership_is_read_is_not_watched(
    session_factory: async_sessionmaker[AsyncSession],
    statement_counts: StatementCounts,
    progress_for: Progress,
) -> None:
    """`_watch`'s guard, for the batch: the room list said member, the read
    after the claim says not, so the claim is released."""
    client_id, user_id, room_ids = await _client_in_rooms(session_factory, 3)
    gone = room_ids[0]
    transport = _transport(session_factory, client_id=client_id, user_id=user_id)
    real = transport._room_store.member_room_ids

    async def _left_one(session, client, ids):  # type: ignore[no-untyped-def]
        members = await real(session, client, ids)
        return {room: joined for room, joined in members.items() if room != gone}

    transport._room_store.member_room_ids = _left_one  # type: ignore[method-assign]
    task = asyncio.create_task(transport.receive_forever(await progress_for(client_id)))
    for _ in range(300):
        if len(transport._cursors) == 2:
            break
        await asyncio.sleep(0.01)

    assert set(transport._cursors) == set(room_ids[1:])
    assert gone not in transport._watching
    await transport.close()
    task.cancel()


async def test_a_failed_batch_read_releases_every_claim(
    session_factory: async_sessionmaker[AsyncSession],
    progress_for: Progress,
) -> None:
    """If the membership and head read fails, no room is left claimed with
    nothing subscribed, so a retry starts from a clean slate."""
    client_id, user_id, _ = await _client_in_rooms(session_factory, 3)
    transport = _transport(session_factory, client_id=client_id, user_id=user_id)
    transport._progress = await progress_for(client_id)

    async def _fail(*_args: object) -> dict[str, object]:
        raise OSError("connection lost")

    transport._room_store.member_room_ids = _fail  # type: ignore[method-assign]
    rooms = await transport.joined_rooms()
    try:
        await transport._watch_joined(rooms)
    except OSError:
        pass
    else:
        raise AssertionError("the read error should propagate to the caller")

    assert transport._watching == {}
    assert transport._cursors == {}


async def test_starting_in_no_room_is_not_reported_as_a_problem(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A new workspace's admin client, or an agent not placed anywhere yet,
    starts in no room. That is a state, not a fault, and must not reach the
    warning or error log that alerting and the end-to-end harness read."""
    client_id, user_id, _ = await _client_in_rooms(session_factory, 0)
    transport = _transport(session_factory, client_id=client_id, user_id=user_id)
    with caplog.at_level(logging.INFO, logger=transport_logger.name):
        task = asyncio.create_task(transport.receive_forever(FromHead(MessageStore())))
        for _ in range(300):
            if any(user_id in record.getMessage() for record in caplog.records):
                break
            await asyncio.sleep(0.01)
        await transport.close()
        task.cancel()

    about_it = [record for record in caplog.records if user_id in record.getMessage()]
    assert [record.levelno for record in about_it] == [logging.INFO]

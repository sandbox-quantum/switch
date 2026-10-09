"""A client starting up reads its rooms in a fixed number of statements.

At boot every client starts in all its rooms at once. Reading each room's id,
membership and head one at a time was over a thousand short sessions in a few
seconds on pilot, enough to drain the pool. The count must not grow with the
number of rooms.
"""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ClientRoom, Room
from tests.switch_core.statement_counts import StatementCounts
from tests.switch_core.transport.test_postgres_transport import (
    _make_client,
    _transport,
)


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
    client_id: str,
    user_id: str,
    rooms: int,
) -> tuple[int, set[str]]:
    transport = _transport(session_factory, client_id=client_id, user_id=user_id)
    with counts.scope(f"start in {rooms}") as scope:
        task = asyncio.create_task(transport.receive_forever())
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
) -> None:
    one = await _client_in_rooms(session_factory, 1)
    six = await _client_in_rooms(session_factory, 6)

    count_one, watched_one = await _start(
        session_factory, statement_counts, *one[:2], 1
    )
    count_six, watched_six = await _start(
        session_factory, statement_counts, *six[:2], 6
    )

    assert watched_one == set(one[2])
    assert watched_six == set(six[2])
    assert count_six == count_one


async def test_a_room_left_before_its_membership_is_read_is_not_watched(
    session_factory: async_sessionmaker[AsyncSession],
    statement_counts: StatementCounts,
) -> None:
    """`_watch`'s guard, for the batch: the room list said member, the read
    after the claim says not, so the claim is released."""
    client_id, user_id, room_ids = await _client_in_rooms(session_factory, 3)
    gone = room_ids[0]
    transport = _transport(session_factory, client_id=client_id, user_id=user_id)
    real = transport._room_store.member_room_ids

    async def _left_one(session, client, ids):  # type: ignore[no-untyped-def]
        return (await real(session, client, ids)) - {gone}

    transport._room_store.member_room_ids = _left_one  # type: ignore[method-assign]
    task = asyncio.create_task(transport.receive_forever())
    for _ in range(300):
        if len(transport._cursors) == 2:
            break
        await asyncio.sleep(0.01)

    assert set(transport._cursors) == set(room_ids[1:])
    assert gone not in transport._watching
    await transport.close()
    task.cancel()

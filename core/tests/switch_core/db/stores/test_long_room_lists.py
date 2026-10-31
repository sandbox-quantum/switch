"""A client in more rooms than one statement takes parameters still starts.

Postgres refuses a statement with more than 32,767 bind parameters, and the
reads a client makes as it starts receiving matched its rooms with one
parameter each. Switch's own client is in every room of its workspace,
archived ones included, so past that many rooms its reader failed to start,
retried, and failed again, for as long as the process ran.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Room
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore

_MORE_THAN_A_STATEMENT_TAKES = 40_000


async def test_the_start_reads_take_any_number_of_rooms(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@many-{uuid.uuid4().hex[:8]}:test",
            display_name="in every room",
            type="admin",
        )
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
            name="the one that exists",
            description="",
        )
        session.add_all([client, room])
        await session.flush()
        await RoomStore().add_client(session, client.id, room.id)
        await session.commit()
    rooms = [f"room-{n}" for n in range(_MORE_THAN_A_STATEMENT_TAKES)] + [room.id]

    async with session_factory() as session:
        members = await RoomStore().member_room_ids(session, client.id, rooms)
        heads = await MessageStore().head_seqs(session, rooms)
        places = await DeliveryCursorStore().positions(session, client.id, rooms)

    assert list(members) == [room.id]
    assert len(heads) == len(rooms) and heads[room.id] == 0
    assert set(places) <= {room.id}

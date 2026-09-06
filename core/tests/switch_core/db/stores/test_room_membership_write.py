"""Recording a membership twice is success, not a failed transaction.

Over Matrix an invitation was accepted later, over sync, so `room_service` was
effectively the only writer of `client_rooms`. On the Postgres transport the
invitation *is* the join: the client writes the row synchronously, and the
inviting caller then writes it again in a transaction that also creates the
room's agents. A plain insert turned that into an IntegrityError, rolled the
whole thing back, and left an agent a client member of a room but not one of
its agents — receiving messages while `!list-agents` reported nobody.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Room
from switch_core.db.stores.room_store import RoomStore


async def _client_and_room(session: AsyncSession) -> tuple[str, str]:
    client = Client(
        matrix_user_id=f"@someone-{uuid.uuid4().hex[:8]}:test",
        display_name="someone",
        type="agent",
    )
    room = Room(
        matrix_room_id=f"!{uuid.uuid4().hex[:8]}:test",
        name="a room",
        description="",
    )
    session.add_all([client, room])
    await session.flush()
    return client.id, room.id


class TestAddClient:
    async def test_recording_the_same_membership_twice_succeeds(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await session.commit()

        async with session_factory() as session:
            await RoomStore().add_client(session, client_id, room_id)
            await session.commit()

        async with session_factory() as session:
            await RoomStore().add_client(session, client_id, room_id)
            # Whatever else the caller is doing in this transaction has to
            # survive: the second write is the case that broke /invite-agent.
            await session.commit()

        async with session_factory() as session:
            assert await RoomStore().get_client_ids(session, room_id) == [client_id]

    async def test_a_second_write_does_not_poison_the_caller_s_transaction(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The failure that mattered was not the duplicate — it was the work
        alongside it being rolled back."""
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await RoomStore().add_client(session, client_id, room_id)
            await session.commit()

        async with session_factory() as session:
            await RoomStore().add_client(session, client_id, room_id)
            await RoomStore().add_agents(session, room_id, [])
            room = await RoomStore().get(session, room_id)
            assert room is not None
            room.description = "written alongside the duplicate"
            await session.commit()

        async with session_factory() as session:
            room = await RoomStore().get(session, room_id)
            assert room is not None
            assert room.description == "written alongside the duplicate"

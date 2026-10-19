"""A client's delivery cursor in a room: written with the membership, moved
only forward, only by the process holding the client's lease, and deleted
with the membership."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Client,
    ClientRoom,
    DeliveryCursor,
    Message,
    Room,
    SwitchCoreProcess,
)
from switch_core.db.stores.delivery_cursor_store import (
    CursorAdvance,
    DeliveryCursorStore,
)
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.process_lease import LEASE_TTL

KIND = "client"


async def _client_and_room(session: AsyncSession) -> tuple[str, str]:
    client = Client(
        transport_user_id=f"@c-{uuid.uuid4().hex[:8]}:test",
        display_name="client",
        type="agent",
    )
    room = Room(
        transport_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
        name="a room",
        description="",
    )
    session.add_all([client, room])
    await session.flush()
    return client.id, room.id


async def _say(session: AsyncSession, room_id: str, body: str = "hi") -> int:
    message = await MessageStore().create(
        session,
        Message(
            room_id=room_id,
            transport_event_id=f"$e-{uuid.uuid4().hex}",
            sender_id="@someone:test",
            sender_name="someone",
            event_type="m.room.message",
            msgtype="m.text",
            body=body,
            formatted_body=None,
            content={"body": body},
        ),
        [],
    )
    return message.seq


async def _hold(session: AsyncSession, key: str, process_id: str) -> int:
    """Claim `key`'s lease for `process_id`, as its ownership would, and
    return the token."""
    await SwitchCoreProcessStore().renew(session, process_id, key_ids=[])
    claimed = await OwnershipLeaseStore().claim(
        session, kind=KIND, keys=[key], process_id=process_id, lease_ttl=LEASE_TTL
    )
    return claimed[key]


def _advance(client_id: str, room_id: str, seq: int, token: int) -> CursorAdvance:
    return CursorAdvance(
        client_id=client_id,
        room_id=room_id,
        seq=seq,
        kind=KIND,
        key=client_id,
        token=token,
    )


class TestWrittenWithTheMembership:
    async def test_a_membership_starts_its_cursor_at_the_room_head(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """So a consumer that learns of the membership later, in another
        process, still starts reading where the client joined."""
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await _say(session, room_id)
            head = await _say(session, room_id)
            await RoomStore().add_client(session, client_id, room_id)
            await session.commit()

            places = await DeliveryCursorStore().positions(
                session, client_id, [room_id]
            )

        assert places == {room_id: head}

    async def test_an_existing_membership_keeps_its_cursor(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await RoomStore().add_client(session, client_id, room_id)
            await _say(session, room_id)
            await RoomStore().add_client(session, client_id, room_id)
            await session.commit()

            places = await DeliveryCursorStore().positions(
                session, client_id, [room_id]
            )

        assert places == {room_id: 0}

    async def test_leaving_the_room_deletes_the_cursor(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A client added back starts from its new arrival, never from where
        it had got to before it left."""
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await RoomStore().add_client(session, client_id, room_id)
            await RoomStore().remove_client(session, client_id, room_id)
            await session.commit()

            places = await DeliveryCursorStore().positions(
                session, client_id, [room_id]
            )

        assert places == {}

    async def test_memberships_without_a_cursor_are_seeded_in_one_statement(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Memberships written before cursors were get one at their room's
        head; a room the client is not in gets none."""
        async with session_factory() as session:
            client_id, member_of = await _client_and_room(session)
            _, not_in = await _client_and_room(session)
            # Written the way memberships were before cursors were: no cursor.
            session.add(ClientRoom(client_id=client_id, room_id=member_of))
            head = await _say(session, member_of)
            await session.flush()

            store = DeliveryCursorStore()
            await store.seed_memberships(session, client_id, [member_of, not_in])
            await session.commit()

            places = await store.positions(session, client_id, [member_of, not_in])

        assert places == {member_of: head}


class TestAdvancing:
    async def test_the_holder_moves_the_cursor_forward_and_never_back(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await RoomStore().add_client(session, client_id, room_id)
            token = await _hold(session, client_id, "process-a")
            store = DeliveryCursorStore()

            written = await store.advance(
                session,
                process_id="process-a",
                advances=[_advance(client_id, room_id, 9, token)],
            )
            await store.advance(
                session,
                process_id="process-a",
                advances=[_advance(client_id, room_id, 4, token)],
            )
            await session.commit()

            places = await store.positions(session, client_id, [room_id])

        assert written == {(client_id, room_id)}
        assert places == {room_id: 9}

    async def test_a_process_that_was_taken_over_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Its hold lapsed and another process claimed the client: whatever
        it still tries to record is refused, so the new holder's progress is
        the only one."""
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await RoomStore().add_client(session, client_id, room_id)
            stale = await _hold(session, client_id, "process-a")
            # Process a stops renewing; process b takes the client over.
            await session.execute(
                update(SwitchCoreProcess)
                .where(SwitchCoreProcess.id == "process-a")
                .values(beat_at=func.now() - timedelta(minutes=1))
            )
            fresh = await _hold(session, client_id, "process-b")
            store = DeliveryCursorStore()

            refused = await store.advance(
                session,
                process_id="process-a",
                advances=[_advance(client_id, room_id, 7, stale)],
            )
            written = await store.advance(
                session,
                process_id="process-b",
                advances=[_advance(client_id, room_id, 3, fresh)],
            )
            await session.commit()

            places = await store.positions(session, client_id, [room_id])

        assert fresh == stale + 1
        assert refused == set()
        assert written == {(client_id, room_id)}
        assert places == {room_id: 3}

    async def test_a_room_the_client_has_left_is_not_written(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            await RoomStore().add_client(session, client_id, room_id)
            token = await _hold(session, client_id, "process-a")
            await RoomStore().remove_client(session, client_id, room_id)

            written = await DeliveryCursorStore().advance(
                session,
                process_id="process-a",
                advances=[_advance(client_id, room_id, 5, token)],
            )
            await session.commit()
            rows = (await session.scalars(select(DeliveryCursor))).all()

        assert written == set()
        assert rows == []


class TestBacklog:
    async def test_the_end_of_what_is_too_old_to_replay(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id, room_id = await _client_and_room(session)
            old_one = await _say(session, room_id, "old")
            old_two = await _say(session, room_id, "old too")
            await _say(session, room_id, "new")
            await session.execute(
                update(Message)
                .where(Message.room_id == room_id, Message.seq <= old_two)
                .values(sent_at=func.now() - timedelta(hours=1))
            )
            await session.commit()

            store = DeliveryCursorStore()
            ends = await store.backlog_ends(
                session, {room_id: old_one - 1}, timedelta(minutes=10)
            )
            none_past = await store.backlog_ends(
                session, {room_id: old_two}, timedelta(minutes=10)
            )

        assert ends == {room_id: old_two}
        assert none_past == {}

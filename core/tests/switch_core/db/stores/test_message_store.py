"""`MessageStore` against real Postgres.

Catches the mistakes a mock or SQLite cannot: an attachment order that only
holds by accident of insertion, a `seq` that is not a gap-free total order to
page on, a `transport_event_id` that admits a duplicate, and FK actions
(`ON DELETE CASCADE` / `SET NULL`) that are declared but not enforced.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Message, MessageAttachment, Room
from switch_core.db.stores.message_store import MessageStore


async def _make_room(session: AsyncSession, name: str) -> Room:
    room = Room(
        matrix_room_id=f"!{name}-{uuid.uuid4().hex[:8]}:test",
        name=name,
        description=f"{name} desc",
    )
    session.add(room)
    await session.flush()
    return room


async def _make_client(session: AsyncSession, name: str) -> Client:
    client = Client(
        matrix_user_id=f"@{name}-{uuid.uuid4().hex[:8]}:test",
        display_name=name,
        type="agent",
        password="x",
    )
    session.add(client)
    await session.flush()
    return client


def _message(room_id: str, event_id: str, **overrides: object) -> Message:
    fields: dict[str, object] = {
        "room_id": room_id,
        "transport_event_id": event_id,
        "sender_matrix_id": "@sender:test",
        "event_type": "m.room.message",
        "msgtype": "m.text",
        "body": f"body of {event_id}",
        "content": {"msgtype": "m.text", "body": f"body of {event_id}"},
    }
    fields.update(overrides)
    return Message(**fields)


class TestCreate:
    async def test_create_and_read_back_by_transport_event_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            await store.create(session, _message(room.id, "$evt1"), [])
            await session.commit()

            found = await store.get_by_transport_event_id(session, "$evt1")

        assert found is not None
        assert found.room_id == room.id
        assert found.body == "body of $evt1"
        assert found.content == {"msgtype": "m.text", "body": "body of $evt1"}
        assert found.sent_at is not None

    async def test_miss_returns_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            assert await store.get_by_transport_event_id(session, "$nope") is None

    async def test_duplicate_transport_event_id_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The same send recorded twice must not produce two rows."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            await store.create(session, _message(room.id, "$dup"), [])
            await session.commit()

            with pytest.raises(IntegrityError):
                await store.create(session, _message(room.id, "$dup"), [])


class TestAttachments:
    async def test_attachments_numbered_and_returned_in_send_order(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            message = await store.create(
                session,
                _message(room.id, "$files"),
                [
                    MessageAttachment(uri="mxc://a", filename="a.txt"),
                    MessageAttachment(uri="mxc://b", filename="b.txt"),
                    MessageAttachment(uri="mxc://c", filename="c.txt"),
                ],
            )
            await session.commit()

            attachments = await store.get_attachments(session, message.id)

        assert [a.position for a in attachments] == [0, 1, 2]
        assert [a.filename for a in attachments] == ["a.txt", "b.txt", "c.txt"]

    async def test_get_attachments_orders_by_position_not_insertion(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Rows written out of order still read back in send order."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            message = await store.create(session, _message(room.id, "$files"), [])
            await session.commit()

            for position, name in ((2, "c.txt"), (0, "a.txt"), (1, "b.txt")):
                session.add(
                    MessageAttachment(
                        message_id=message.id,
                        position=position,
                        uri=f"mxc://{name}",
                        filename=name,
                    )
                )
            await session.commit()

            attachments = await store.get_attachments(session, message.id)

        assert [a.filename for a in attachments] == ["a.txt", "b.txt", "c.txt"]

    async def test_attachments_scoped_to_their_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            first = await store.create(
                session,
                _message(room.id, "$one"),
                [MessageAttachment(uri="mxc://a", filename="a.txt")],
            )
            second = await store.create(
                session,
                _message(room.id, "$two"),
                [MessageAttachment(uri="mxc://b", filename="b.txt")],
            )
            await session.commit()

            assert [
                a.filename for a in await store.get_attachments(session, first.id)
            ] == ["a.txt"]
            assert [
                a.filename for a in await store.get_attachments(session, second.id)
            ] == ["b.txt"]


class TestSeq:
    async def test_seq_is_database_assigned_and_strictly_increasing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            messages = [
                await store.create(session, _message(room.id, f"$evt{i}"), [])
                for i in range(5)
            ]
            await session.commit()
            seqs = [m.seq for m in messages]

        assert all(seq is not None for seq in seqs)
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)

    async def test_seq_cannot_be_supplied_by_the_caller(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`Identity(always=True)` means the sequence, not the writer, owns the
        cursor — otherwise a caller could reuse a value a reader has passed."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            with pytest.raises(ProgrammingError, match="GENERATED ALWAYS"):
                await store.create(session, _message(room.id, "$forced", seq=1), [])

    async def test_seq_is_a_total_order_across_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room_a = await _make_room(session, "alpha")
            room_b = await _make_room(session, "beta")
            first = await store.create(session, _message(room_a.id, "$a1"), [])
            second = await store.create(session, _message(room_b.id, "$b1"), [])
            third = await store.create(session, _message(room_a.id, "$a2"), [])
            await session.commit()

        assert first.seq < second.seq < third.seq


class TestListForRoom:
    async def test_pages_on_after_seq_without_gap_or_repeat(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            for i in range(10):
                await store.create(session, _message(room.id, f"$evt{i}"), [])
            await session.commit()

            first_page = await store.list_for_room(
                session, room.id, after_seq=0, limit=4
            )
            second_page = await store.list_for_room(
                session, room.id, after_seq=first_page[-1].seq, limit=4
            )
            third_page = await store.list_for_room(
                session, room.id, after_seq=second_page[-1].seq, limit=4
            )
            past_the_end = await store.list_for_room(
                session, room.id, after_seq=third_page[-1].seq, limit=4
            )

        assert [m.transport_event_id for m in first_page] == [
            f"$evt{i}" for i in range(4)
        ]
        assert [m.transport_event_id for m in second_page] == [
            f"$evt{i}" for i in range(4, 8)
        ]
        assert [m.transport_event_id for m in third_page] == ["$evt8", "$evt9"]
        assert past_the_end == []

        seen = [m.seq for m in first_page + second_page + third_page]
        assert seen == sorted(seen)
        assert len(set(seen)) == 10

    async def test_scoped_to_one_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room_a = await _make_room(session, "alpha")
            room_b = await _make_room(session, "beta")
            for i in range(3):
                await store.create(session, _message(room_a.id, f"$a{i}"), [])
                await store.create(session, _message(room_b.id, f"$b{i}"), [])
            await session.commit()

            in_a = await store.list_for_room(session, room_a.id, after_seq=0, limit=50)
            in_b = await store.list_for_room(session, room_b.id, after_seq=0, limit=50)

        assert [m.transport_event_id for m in in_a] == ["$a0", "$a1", "$a2"]
        assert [m.transport_event_id for m in in_b] == ["$b0", "$b1", "$b2"]

    async def test_after_seq_from_another_room_does_not_skip_rows(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`seq` is global, so a cursor is only meaningful within its own room;
        rows interleaved from another room must not consume the page."""
        store = MessageStore()
        async with session_factory() as session:
            room_a = await _make_room(session, "alpha")
            room_b = await _make_room(session, "beta")
            await store.create(session, _message(room_a.id, "$a0"), [])
            for i in range(5):
                await store.create(session, _message(room_b.id, f"$b{i}"), [])
            await store.create(session, _message(room_a.id, "$a1"), [])
            await session.commit()

            page = await store.list_for_room(session, room_a.id, after_seq=0, limit=1)
            following = await store.list_for_room(
                session, room_a.id, after_seq=page[-1].seq, limit=10
            )

        assert [m.transport_event_id for m in page] == ["$a0"]
        assert [m.transport_event_id for m in following] == ["$a1"]


class TestForeignKeyBehaviour:
    async def test_deleting_the_room_cascades_its_messages(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            keeper = await _make_room(session, "beta")
            await store.create(session, _message(room.id, "$gone"), [])
            await store.create(session, _message(keeper.id, "$kept"), [])
            await session.commit()

            await session.execute(delete(Room).where(Room.id == room.id))
            await session.commit()

            assert await store.get_by_transport_event_id(session, "$gone") is None
            assert await store.get_by_transport_event_id(session, "$kept") is not None

    async def test_deleting_the_message_cascades_its_attachments(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            message = await store.create(
                session,
                _message(room.id, "$files"),
                [
                    MessageAttachment(uri="mxc://a", filename="a.txt"),
                    MessageAttachment(uri="mxc://b", filename="b.txt"),
                ],
            )
            await session.commit()
            message_id = message.id

            await session.execute(delete(Message).where(Message.id == message_id))
            await session.commit()

            assert await store.get_attachments(session, message_id) == []

    async def test_deleting_the_sender_client_nulls_the_reference(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """History outlives the client that wrote it: the row stays, the link
        goes."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session, "alpha")
            client = await _make_client(session, "writer")
            await store.create(
                session,
                _message(room.id, "$byclient", sender_client_id=client.id),
                [],
            )
            await session.commit()

            await session.execute(delete(Client).where(Client.id == client.id))
            await session.commit()
            session.expire_all()

            found = await store.get_by_transport_event_id(session, "$byclient")

        assert found is not None
        assert found.sender_client_id is None
        assert found.sender_matrix_id == "@sender:test"

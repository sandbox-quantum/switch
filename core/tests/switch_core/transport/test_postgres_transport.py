"""Sending over Postgres: what lands, and what refuses to pretend.

These run against a real database because the whole point of the transport is
what the table ends up holding — the seq allocation, the denormalised columns
and the attachment row are the behaviour, not an implementation detail behind
it.

The unimplemented halves are tested too. A transport that quietly returns
nothing from `receive_forever` would look like a working deployment with a
silent room, which is the one failure this codebase refuses to ship.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Room
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.transport import MessageTransport, TransportError
from switch_core.transport.postgres import PostgresTransport


async def _make_room(session: AsyncSession) -> tuple[str, str, str, str]:
    """Insert the Room and Client a send depends on.

    Returns (room uuid, transport room id, client id, client mxid).
    """
    suffix = uuid.uuid4().hex[:8]
    client = Client(
        matrix_user_id=f"@agent-{suffix}:test",
        display_name="agent one",
        type="agent",
        password="x",
    )
    session.add(client)
    await session.flush()
    room = Room(matrix_room_id=f"!room-{suffix}:test", name="a room", description="")
    session.add(room)
    await session.flush()
    return room.id, room.matrix_room_id, client.id, client.matrix_user_id


def _transport(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    client_id: str,
    user_id: str,
) -> PostgresTransport:
    return PostgresTransport(
        user_id=user_id,
        client_id=client_id,
        display_name="agent one",
        session_factory=session_factory,
        room_store=RoomStore(),
        message_store=MessageStore(),
    )


class TestConformsToThePort:
    def test_it_is_a_message_transport(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport = _transport(session_factory, client_id="c", user_id="@a:test")
        assert isinstance(transport, MessageTransport)


class TestSending:
    async def test_a_message_becomes_a_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        result = await transport.send_message(
            transport_room_id, "hello", sender_name="agent one"
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(
                session, result.event_id
            )

        assert message is not None
        assert message.room_id == room_id
        assert message.body == "hello"
        assert message.msgtype == "m.text"
        assert message.event_type == "m.room.message"
        assert message.sender_client_id == client_id
        assert message.sender_matrix_id == user_id
        # The id the caller got back is the row's, so a caller that quotes it
        # in a reply or a thread is naming something that exists.
        assert message.transport_event_id == result.event_id
        assert result.content["body"] == "hello"

    async def test_the_room_orders_its_sends(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        first = await transport.send_message(
            transport_room_id, "one", sender_name="agent one"
        )
        second = await transport.send_message(
            transport_room_id, "two", sender_name="agent one"
        )

        async with session_factory() as session:
            store = MessageStore()
            a = await store.get_by_transport_event_id(session, first.event_id)
            b = await store.get_by_transport_event_id(session, second.event_id)

        assert a is not None and b is not None
        assert b.seq > a.seq

    async def test_a_threaded_reply_records_its_root(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        result = await transport.send_message(
            transport_room_id,
            "in the thread",
            sender_name="agent one",
            thread_root_id="root-1",
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(
                session, result.event_id
            )

        assert message is not None
        assert message.thread_root_event_id == "root-1"

    async def test_media_records_the_file_beside_the_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        result = await transport.send_media(
            transport_room_id,
            "blob://1",
            "report.pdf",
            "application/pdf",
            2048,
            sender_name="agent one",
            msgtype="m.file",
            caption="the report",
        )

        async with session_factory() as session:
            store = MessageStore()
            message = await store.get_by_transport_event_id(session, result.event_id)
            assert message is not None
            attachments = await store.get_attachments(session, message.id)

        # The caption is the body, per the rich-media-caption convention, and
        # the real filename travels on the attachment.
        assert message.body == "the report"
        assert len(attachments) == 1
        assert attachments[0].uri == "blob://1"
        assert attachments[0].filename == "report.pdf"
        assert attachments[0].mimetype == "application/pdf"
        assert attachments[0].size == 2048

    async def test_a_custom_event_is_stored_whole(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A task event is not conversation, but it still has to reach its
        handler, and here the row is the only way it can."""
        async with session_factory() as session:
            _, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        result = await transport.send_event(
            transport_room_id, "com.switch.task.accept", {"task_id": "t-1"}
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(
                session, result.event_id
            )

        assert message is not None
        assert message.event_type == "com.switch.task.accept"
        assert message.content == {"task_id": "t-1"}
        assert message.body is None

    async def test_ephemeral_state_is_announced_and_not_stored(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Presence has no history worth keeping: the next value replaces it,
        and a row would put it in the room's order for nobody to read."""
        async with session_factory() as session:
            _, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        result = await transport.send_event(
            transport_room_id, "com.switch.agent.runtime_state", {"state": "working"}
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(
                session, result.event_id
            )

        assert message is None
        assert result.event_id

    async def test_sending_to_a_room_switch_does_not_know_fails(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport = _transport(session_factory, client_id="c", user_id="@a:test")
        with pytest.raises(TransportError):
            await transport.send_message(
                "!nowhere:test", "hello", sender_name="agent one"
            )


class TestRooms:
    async def test_joining_is_a_membership_row_and_is_idempotent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        assert await transport.join_room(transport_room_id) is True
        assert await transport.join_room(transport_room_id) is True
        assert await transport.joined_rooms() == [transport_room_id]

    async def test_a_client_in_no_rooms_is_in_no_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, _, client_id, user_id = await _make_room(session)
            await session.commit()

        transport = _transport(session_factory, client_id=client_id, user_id=user_id)
        assert await transport.joined_rooms() == []


class TestWhatIsNotBuiltYet:
    async def test_receiving_refuses_rather_than_going_quiet(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport = _transport(session_factory, client_id="c", user_id="@a:test")
        with pytest.raises(NotImplementedError):
            await transport.receive_forever(since=None)

    async def test_media_storage_refuses_rather_than_losing_the_bytes(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport = _transport(session_factory, client_id="c", user_id="@a:test")
        with pytest.raises(NotImplementedError):
            await transport.upload_media(b"x", "text/plain", "a.txt")
        with pytest.raises(NotImplementedError):
            await transport.download_media("blob://1")

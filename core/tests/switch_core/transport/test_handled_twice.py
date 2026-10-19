"""A row handled twice gets its replies written once.

A consumer may be handed the same row twice: its owner stopped between acting
on the row and recording that it had, or every process runs a copy of it.
What the client writes while handling a row is numbered from the row, so the
second handling finds the first one's writes and writes nothing new.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Message
from switch_core.db.stores.message_store import MessageStore
from switch_core.transport import InboundMessage, RoomRef, TransportHandlers
from switch_core.transport.cursors import FromHead
from switch_core.transport.derived_ids import derived_event_id, writes_derived_from
from switch_core.transport.postgres import PostgresTransport
from tests.switch_core.transport.test_postgres_transport import (
    _FakeListener,
    _make_client,
    _make_room,
    _settled,
    _transport,
    _watched_room,
)


def _replying(transport: PostgresTransport, replies: int) -> TransportHandlers:
    """Handlers that answer every message from someone else with `replies`
    messages of the client's own."""

    async def on_message(room: RoomRef, event: InboundMessage) -> None:
        if event.sender == transport.user_id:
            return
        for n in range(replies):
            await transport.send_message(
                room.room_id, f"reply {n}", sender_name="agent one", metered=False
            )

    return TransportHandlers(on_message=on_message)


async def _bodies(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[str | None]:
    async with session_factory() as session:
        rows = (
            await session.scalars(
                select(Message).where(Message.room_id == room_id).order_by(Message.seq)
            )
        ).all()
    return [row.body for row in rows if row.event_type == "m.room.message"]


class TestTwoCopiesOfOneClient:
    async def test_both_handle_the_row_and_each_reply_is_written_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """As when every process runs a copy of the client's consumer, each
        reading the room for itself."""
        async with session_factory() as session:
            room_id, room, client_id, user_id = await _make_room(session)
            speaker_id, speaker = await _make_client(session, "speaker")
            await session.commit()

        listener = _FakeListener()
        copies = [
            _transport(
                session_factory, client_id=client_id, user_id=user_id, listener=listener
            )
            for _ in range(2)
        ]
        await copies[0].join_room(room)
        tasks = []
        for copy in copies:
            copy.register_handlers(_replying(copy, replies=2))
            tasks.append(
                asyncio.create_task(copy.receive_forever(FromHead(MessageStore())))
            )
            await _watched_room(copy)
        speaking = _transport(session_factory, client_id=speaker_id, user_id=speaker)

        await speaking.send_message(room, "hello", sender_name="speaker", metered=False)
        await listener.announce(room_id)
        for copy in copies:
            await _settled(copy)

        assert await _bodies(session_factory, room_id) == [
            "hello",
            "reply 0",
            "reply 1",
        ]
        for task in tasks:
            task.cancel()

    async def test_a_write_outside_any_row_is_a_fresh_one_each_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, room, client_id, user_id = await _make_room(session)
            await session.commit()
        transport = _transport(session_factory, client_id=client_id, user_id=user_id)

        first = await transport.send_message(
            room, "same words", sender_name="a", metered=False
        )
        second = await transport.send_message(
            room, "same words", sender_name="a", metered=False
        )

        assert first.event_id != second.event_id
        assert await _bodies(session_factory, room_id) == ["same words"] * 2


class TestWritesOnBehalfOfSomethingOutside:
    async def test_a_post_delivered_twice_is_written_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A messaging platform delivering one post again: what the post's
        author writes for it is numbered from the post."""
        async with session_factory() as session:
            room_id, room, client_id, user_id = await _make_room(session)
            await session.commit()
        author = _transport(session_factory, client_id=client_id, user_id=user_id)

        for _ in range(2):
            with writes_derived_from(client_id, "bridge\x1fchannel\x1fpost-1"):
                await author.send_message(
                    room, "from the platform", sender_name="a", metered=False
                )

        assert await _bodies(session_factory, room_id) == ["from the platform"]

    async def test_another_client_writing_meanwhile_is_not_numbered(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, room, client_id, user_id = await _make_room(session)
            other_id, other = await _make_client(session, "other")
            await session.commit()
        writer = _transport(session_factory, client_id=other_id, user_id=other)

        for _ in range(2):
            with writes_derived_from(client_id, "bridge\x1fchannel\x1fpost-1"):
                await writer.send_message(
                    room, "a notice", sender_name="b", metered=False
                )

        assert await _bodies(session_factory, room_id) == ["a notice"] * 2


def test_the_id_depends_on_client_row_and_position() -> None:
    one = derived_event_id("client", "$row", 0)

    assert one == derived_event_id("client", "$row", 0)
    assert one.startswith("sw_") and len(one) == len("sw_") + 32
    assert (
        len(
            {
                one,
                derived_event_id("client", "$row", 1),
                derived_event_id("client", "$other", 0),
                derived_event_id("another client", "$row", 0),
            }
        )
        == 4
    )

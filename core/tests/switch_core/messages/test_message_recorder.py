"""What the recorder writes for a send, and what it does when it cannot.

The recorder reads the content dict the transport reports back rather than
being told separately what was sent, so these tests feed it the shapes the
Matrix transport really produces — a plain message, a markdown one, a threaded
reply, a media event, a custom `com.switch.*` event — and check what lands.

The failure tests matter as much as the success ones. Recording runs after
delivery and must never turn a delivered message into a raised exception at
the caller.
"""

from __future__ import annotations

import logging
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Room
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.messages import MessageRecorder
from switch_core.transport import SendResult


async def _make_room(session: AsyncSession) -> tuple[str, str, str]:
    """Insert the Room and Client a recorded message depends on.

    Returns (room uuid, matrix room id, client id).
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
    room = Room(
        matrix_room_id=f"!room-{suffix}:test",
        name="a room",
        description="",
    )
    session.add(room)
    await session.flush()
    return room.id, room.matrix_room_id, client.id


def _recorder(session_factory: async_sessionmaker[AsyncSession]) -> MessageRecorder:
    return MessageRecorder(
        session_factory=session_factory,
        room_store=RoomStore(),
        message_store=MessageStore(),
    )


async def _record(
    session_factory: async_sessionmaker[AsyncSession],
    matrix_room_id: str,
    client_id: str,
    result: SendResult,
) -> None:
    await _recorder(session_factory).record(
        transport_room_id=matrix_room_id,
        result=result,
        sender_matrix_id="@agent:test",
        sender_client_id=client_id,
        sender_name="agent one",
    )


class TestRecordsWhatWasSent:
    async def test_a_plain_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt1",
                event_type="m.room.message",
                content={
                    "msgtype": "m.text",
                    "body": "hello",
                    "sender_name": "agent one",
                },
            ),
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(session, "$evt1")

        assert message is not None
        assert message.room_id == room_id
        assert message.body == "hello"
        assert message.msgtype == "m.text"
        assert message.event_type == "m.room.message"
        assert message.sender_client_id == client_id
        assert message.sender_matrix_id == "@agent:test"
        assert message.thread_root_event_id is None
        # The whole event body is kept, not just the columns beside it.
        assert message.content["sender_name"] == "agent one"

    async def test_a_markdown_message_keeps_the_rendered_html(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt2",
                event_type="m.room.message",
                content={
                    "msgtype": "m.text",
                    "body": "**bold**",
                    "format": "org.matrix.custom.html",
                    "formatted_body": "<p><strong>bold</strong></p>",
                },
            ),
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(session, "$evt2")

        assert message is not None
        assert message.formatted_body == "<p><strong>bold</strong></p>"

    async def test_a_threaded_reply_records_its_root(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt3",
                event_type="m.room.message",
                content={
                    "msgtype": "m.text",
                    "body": "in thread",
                    "m.relates_to": {
                        "rel_type": "m.thread",
                        "event_id": "$root",
                    },
                },
            ),
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(session, "$evt3")

        assert message is not None
        assert message.thread_root_event_id == "$root"

    async def test_a_non_thread_relation_is_not_read_as_a_thread(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An edit or a reaction relates to an event without being in a thread."""
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt4",
                event_type="m.room.message",
                content={
                    "msgtype": "m.text",
                    "body": "an edit",
                    "m.relates_to": {
                        "rel_type": "m.replace",
                        "event_id": "$original",
                    },
                },
            ),
        )

        async with session_factory() as session:
            message = await MessageStore().get_by_transport_event_id(session, "$evt4")

        assert message is not None
        assert message.thread_root_event_id is None

    async def test_a_media_event_records_its_file(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt5",
                event_type="m.room.message",
                content={
                    "msgtype": "m.image",
                    "body": "a caption",
                    "filename": "chart.png",
                    "url": "mxc://test/abc",
                    "info": {"mimetype": "image/png", "size": 4096},
                },
            ),
        )

        async with session_factory() as session:
            store = MessageStore()
            message = await store.get_by_transport_event_id(session, "$evt5")
            assert message is not None
            attachments = await store.get_attachments(session, message.id)

        assert len(attachments) == 1
        assert attachments[0].uri == "mxc://test/abc"
        # The caption is the body; the real filename is carried separately.
        assert attachments[0].filename == "chart.png"
        assert attachments[0].mimetype == "image/png"
        assert attachments[0].size == 4096

    async def test_an_uncaptioned_file_falls_back_to_the_body_for_its_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Without a caption the transport puts the filename in `body` and
        sends no `filename` field at all."""
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt6",
                event_type="m.room.message",
                content={
                    "msgtype": "m.file",
                    "body": "report.csv",
                    "url": "mxc://test/def",
                    "info": {"mimetype": "text/csv", "size": 12},
                },
            ),
        )

        async with session_factory() as session:
            store = MessageStore()
            message = await store.get_by_transport_event_id(session, "$evt6")
            assert message is not None
            attachments = await store.get_attachments(session, message.id)

        assert [a.filename for a in attachments] == ["report.csv"]

    async def test_a_custom_event_records_its_whole_content(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A `com.switch.*` event has no body or msgtype — the payload is all
        there is, so losing it would lose the event."""
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt7",
                event_type="com.switch.command",
                content={"command": "reset", "args": ["--hard"], "request_id": "r1"},
            ),
        )

        async with session_factory() as session:
            store = MessageStore()
            message = await store.get_by_transport_event_id(session, "$evt7")
            assert message is not None
            attachments = await store.get_attachments(session, message.id)

        assert message.event_type == "com.switch.command"
        assert message.body is None
        assert message.msgtype is None
        assert message.content == {
            "command": "reset",
            "args": ["--hard"],
            "request_id": "r1",
        }
        assert attachments == []

    async def test_bus_traffic_is_not_recorded_at_all(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The log is the conversation. A runtime-state ping is not part of it,
        and it is the highest-volume thing on the bus."""
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        await _record(
            session_factory,
            matrix_room_id,
            client_id,
            SendResult(
                event_id="$evt8",
                event_type="com.switch.agent.runtime_state",
                content={"state": "busy"},
            ),
        )

        async with session_factory() as session:
            found = await MessageStore().get_by_transport_event_id(session, "$evt8")

        assert found is None


class TestFailingToRecordNeverReachesTheCaller:
    async def test_an_unknown_room_is_warned_about_not_raised(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Not every room a client sends to is a Switch room."""
        with caplog.at_level(logging.WARNING):
            await _record(
                session_factory,
                "!nobody-knows-this:test",
                None,  # type: ignore[arg-type]
                SendResult(
                    event_id="$evt8",
                    event_type="m.room.message",
                    content={"body": "hi"},
                ),
            )

        assert "not a Switch room" in caplog.text

        async with session_factory() as session:
            assert (
                await MessageStore().get_by_transport_event_id(session, "$evt8") is None
            )

    async def test_a_database_failure_is_logged_at_error_and_swallowed(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The message was delivered. Raising here would tell the caller a
        successful send failed, which is worse than a missing row."""
        async with session_factory() as session:
            _, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        recorder = _recorder(session_factory)
        result = SendResult(
            event_id="$evt9",
            event_type="m.room.message",
            content={"msgtype": "m.text", "body": "once"},
        )
        await recorder.record(
            transport_room_id=matrix_room_id,
            result=result,
            sender_matrix_id="@agent:test",
            sender_client_id=client_id,
            sender_name="agent one",
        )

        # The same event id a second time violates the unique constraint, which
        # is a stand-in for any database failure after a successful send.
        with caplog.at_level(logging.ERROR):
            await recorder.record(
                transport_room_id=matrix_room_id,
                result=result,
                sender_matrix_id="@agent:test",
                sender_client_id=client_id,
                sender_name="agent one",
            )

        assert "failed to record" in caplog.text
        assert "$evt9" in caplog.text


class TestRoomResolution:
    async def test_the_room_lookup_is_cached_across_sends(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A send is on the hot path, so the room id is resolved once."""
        async with session_factory() as session:
            room_id, matrix_room_id, client_id = await _make_room(session)
            await session.commit()

        lookups = 0
        real_lookup = RoomStore.get_by_matrix_room_id

        async def counting_lookup(
            self: RoomStore, session: AsyncSession, matrix_room_id: str
        ) -> Room | None:
            nonlocal lookups
            lookups += 1
            return await real_lookup(self, session, matrix_room_id)

        room_store = RoomStore()
        room_store.get_by_matrix_room_id = counting_lookup.__get__(room_store)  # type: ignore[method-assign]
        recorder = MessageRecorder(
            session_factory=session_factory,
            room_store=room_store,
            message_store=MessageStore(),
        )

        for n in range(3):
            await recorder.record(
                transport_room_id=matrix_room_id,
                result=SendResult(
                    event_id=f"$cached{n}",
                    event_type="m.room.message",
                    content={"body": "x"},
                ),
                sender_matrix_id="@agent:test",
                sender_client_id=client_id,
                sender_name="agent one",
            )

        assert lookups == 1

        async with session_factory() as session:
            for n in range(3):
                message = await MessageStore().get_by_transport_event_id(
                    session, f"$cached{n}"
                )
                assert message is not None
                assert message.room_id == room_id

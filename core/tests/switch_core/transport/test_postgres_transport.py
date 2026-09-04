"""Sending and receiving over Postgres.

These run against a real database because the whole point of the transport is
what the table ends up holding — the seq allocation, the denormalised columns
and the attachment row are the behaviour, not an implementation detail behind
it.

What is deliberately not implemented is tested too: a transport that quietly
returns nothing would look like a working deployment with a silent room, which
is the one failure this codebase refuses to ship.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Room
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.transport import (
    InboundCustomEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
    MessageTransport,
    TransportError,
    TransportHandlers,
)
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
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


async def _watched_room(transport: PostgresTransport) -> str:
    """Wait until the transport is watching a room, and name it.

    `receive_forever` resolves memberships against the database before it
    subscribes, so a test that sends immediately after starting it would race
    the subscription rather than test anything.
    """
    for _ in range(200):
        if transport._watching:
            return next(iter(transport._watching))
        await asyncio.sleep(0.01)
    raise AssertionError("the transport never started watching a room")


async def _settled(transport: PostgresTransport) -> None:
    """Wait until a transport has nothing left to read."""
    for _ in range(500):
        if not transport._pending and not transport._delivering:
            return
        await asyncio.sleep(0.005)
    raise AssertionError("the transport never finished delivering")


class _FakeListener:
    """Stands in for the notify listener, so a test can say "the room moved".

    The real listener is a trigger and a LISTEN, covered by its own tests
    against a live database. What matters here is what the transport does when
    it is woken, which is a question about cursors and conversion.
    """

    def __init__(self) -> None:
        self.wakers: dict[str, set] = {}

    def subscribe(self, room_id: str, waker) -> None:
        self.wakers.setdefault(room_id, set()).add(waker)

    def unsubscribe(self, room_id: str, waker) -> None:
        self.wakers.get(room_id, set()).discard(waker)

    async def announce(self, room_id: str) -> None:
        """Say the room moved, and wait for the reading it provokes.

        A waker only notes the room now — each transport reads on its own
        loop, so that a client whose handler is slow cannot hold up anyone
        else's delivery. Waiting for those loops to go idle is what makes a
        test assert on what was delivered rather than on the timing.
        """
        woken = []
        for waker in list(self.wakers.get(room_id, ())):
            await waker(room_id)
            woken.append(waker.__self__)
        for transport in woken:
            await _settled(transport)


class _Received:
    """Collects what the transport handed to each handler."""

    def __init__(self) -> None:
        self.events: list[object] = []

    def handlers(self) -> TransportHandlers:
        return TransportHandlers(
            on_message=self._take,
            on_media=self._take,
            on_member_event=self._take,
            on_custom_event=self._take,
        )

    async def _take(self, _room, event) -> None:
        self.events.append(event)


def _transport(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    client_id: str,
    user_id: str,
    listener: _FakeListener | None = None,
    ephemeral: EphemeralBus | None = None,
) -> PostgresTransport:
    return PostgresTransport(
        user_id=user_id,
        client_id=client_id,
        display_name="agent one",
        session_factory=session_factory,
        room_store=RoomStore(),
        message_store=MessageStore(),
        media_store=MediaStore(),
        listener=listener or _FakeListener(),
        invites=InviteBus(),
        ephemeral=ephemeral or EphemeralBus(),
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


class TestMedia:
    async def test_bytes_go_in_and_come_back(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport = _transport(session_factory, client_id="c", user_id="@a:test")

        uploaded = await transport.upload_media(b"file contents", "text/plain", "a.txt")
        downloaded = await transport.download_media(uploaded.uri)

        assert downloaded.body == b"file contents"
        assert downloaded.content_type == "text/plain"
        assert downloaded.filename == "a.txt"

    async def test_two_uploads_of_the_same_bytes_are_two_handles(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Deduplicating would make one sender's delete another's data loss."""
        transport = _transport(session_factory, client_id="c", user_id="@a:test")

        first = await transport.upload_media(b"same", "text/plain", "a.txt")
        second = await transport.upload_media(b"same", "text/plain", "a.txt")

        assert first.uri != second.uri

    async def test_a_handle_with_nothing_behind_it_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An empty file is a worse answer than an error: the reader cannot
        tell it apart from a file that was genuinely empty."""
        transport = _transport(session_factory, client_id="c", user_id="@a:test")

        with pytest.raises(TransportError):
            await transport.download_media("switch-media://nothing")


class TestWhatIsNotBuiltYet:
    async def test_history_refuses_rather_than_answering_from_the_wrong_place(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The read path queries these rows directly; the only callers of this
        method are the walkers that compare a bus against them."""
        transport = _transport(session_factory, client_id="c", user_id="@a:test")
        with pytest.raises(NotImplementedError):
            await transport.read_history("!r:test", start=None, limit=10)


class TestReceiving:
    """What a woken transport hands to its handlers.

    Delivery is driven by the announcement the database makes on every insert;
    a fake listener stands in for it so these tests are about the cursor and
    the conversion rather than about the trigger, which has its own.
    """

    async def _receiving(
        self,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> tuple[PostgresTransport, _FakeListener, _Received, str, str]:
        async with session_factory() as session:
            _, transport_room_id, client_id, user_id = await _make_room(session)
            await session.commit()

        listener = _FakeListener()
        received = _Received()
        transport = _transport(
            session_factory, client_id=client_id, user_id=user_id, listener=listener
        )
        transport.register_handlers(received.handlers())
        await transport.join_room(transport_room_id)
        task = asyncio.create_task(transport.receive_forever(since=None))
        self._tasks.append((task, transport))
        await _watched_room(transport)
        return transport, listener, received, transport_room_id, user_id

    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Iterator[None]:
        self._tasks: list[tuple[asyncio.Task, PostgresTransport]] = []
        yield
        for task, _ in self._tasks:
            task.cancel()

    async def test_a_message_arrives_as_a_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport, listener, received, room, _ = await self._receiving(session_factory)

        sent = await transport.send_message(room, "hello", sender_name="agent one")
        await listener.announce(await _watched_room(transport))

        assert len(received.events) == 1
        event = received.events[0]
        assert isinstance(event, InboundMessage)
        assert event.event_id == sent.event_id
        assert event.body == "hello"
        # The room a handler is given is the transport-side id it knows, not
        # the internal one the listener announces.
        assert event.room_id == room

    async def test_the_cursor_starts_at_the_head_and_does_not_repeat(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A restart is not a replay.

        Everything before this transport started receiving is already someone
        else's problem — a delivery cursor's — and redelivering it would be
        indistinguishable to a reader from it being said again.
        """
        async with session_factory() as session:
            _, room, client_id, user_id = await _make_room(session)
            await session.commit()

        listener = _FakeListener()
        writer = _transport(session_factory, client_id=client_id, user_id=user_id)
        await writer.send_message(room, "said before anyone listened", sender_name="a")

        received = _Received()
        reader = _transport(
            session_factory, client_id=client_id, user_id=user_id, listener=listener
        )
        reader.register_handlers(received.handlers())
        await reader.join_room(room)
        task = asyncio.create_task(reader.receive_forever(since=None))
        self._tasks.append((task, reader))
        switch_room_id = await _watched_room(reader)
        await listener.announce(switch_room_id)
        assert received.events == []

        await writer.send_message(room, "said after", sender_name="a")
        await listener.announce(switch_room_id)
        await listener.announce(switch_room_id)

        bodies = [event.body for event in received.events]
        assert bodies == ["said after"]

    async def test_a_file_arrives_as_media(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport, listener, received, room, _ = await self._receiving(session_factory)

        await transport.send_media(
            room,
            "blob://7",
            "notes.txt",
            "text/plain",
            12,
            sender_name="agent one",
            msgtype="m.file",
        )
        await listener.announce(await _watched_room(transport))

        event = received.events[0]
        assert isinstance(event, InboundMedia)
        assert event.uri == "blob://7"
        assert event.filename == "notes.txt"
        assert event.mimetype == "text/plain"
        assert event.size == 12

    async def test_a_custom_event_arrives_as_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        transport, listener, received, room, _ = await self._receiving(session_factory)

        await transport.send_event(room, "com.switch.command", {"command": "roles"})
        await listener.announce(await _watched_room(transport))

        event = received.events[0]
        assert isinstance(event, InboundCustomEvent)
        assert event.event_type == "com.switch.command"
        assert event.content == {"command": "roles"}

    async def test_an_arrival_is_delivered_to_the_members_watching(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Joining writes the arrival, so the room learns about it the same way
        it learns about anything else: a row it has not read yet."""
        transport, listener, received, room, _ = await self._receiving(session_factory)

        async with session_factory() as session:
            newcomer = Client(
                matrix_user_id=f"@later-{uuid.uuid4().hex[:8]}:test",
                display_name="the newcomer",
                type="agent",
                password="x",
            )
            session.add(newcomer)
            await session.commit()
            newcomer_id, newcomer_mxid = newcomer.id, newcomer.matrix_user_id

        joiner = _transport(
            session_factory, client_id=newcomer_id, user_id=newcomer_mxid
        )
        joiner.display_name = "the newcomer"
        await joiner.join_room(room)
        await listener.announce(await _watched_room(transport))

        event = received.events[0]
        assert isinstance(event, InboundMembership)
        assert event.state_key == newcomer_mxid
        assert event.membership == "join"
        assert event.display_name == "the newcomer"


class TestPresence:
    """Events that are announced and never stored still have to arrive.

    Dropping the row dropped the delivery with it: runtime state was recorded
    in its own table and reached nobody, so an agent going busy stopped showing
    up on a bridged channel. The value travels on the announcement, because
    there is no row for a reader to go and fetch.
    """

    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Iterator[None]:
        self._tasks: list[asyncio.Task] = []
        yield
        for task in self._tasks:
            task.cancel()

    async def test_presence_reaches_the_other_clients_watching_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, room, client_id, user_id = await _make_room(session)
            await session.commit()

        ephemeral = EphemeralBus()
        received = _Received()
        watcher = _transport(
            session_factory, client_id=client_id, user_id=user_id, ephemeral=ephemeral
        )
        watcher.register_handlers(received.handlers())
        await watcher.join_room(room)
        self._tasks.append(asyncio.create_task(watcher.receive_forever(since=None)))
        await _watched_room(watcher)

        sender = _transport(
            session_factory, client_id=client_id, user_id=user_id, ephemeral=ephemeral
        )
        await sender.send_event(
            room, "com.switch.agent.runtime_state", {"state": "working"}
        )

        assert len(received.events) == 1
        event = received.events[0]
        assert isinstance(event, InboundCustomEvent)
        assert event.event_type == "com.switch.agent.runtime_state"
        assert event.content == {"state": "working"}
        # The room a handler is given is the transport-side id, as for a row.
        assert event.room_id == room

    async def test_presence_in_another_room_is_not_delivered(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, room, client_id, user_id = await _make_room(session)
            _, elsewhere, other_client_id, other_user_id = await _make_room(session)
            await session.commit()

        ephemeral = EphemeralBus()
        received = _Received()
        watcher = _transport(
            session_factory, client_id=client_id, user_id=user_id, ephemeral=ephemeral
        )
        watcher.register_handlers(received.handlers())
        await watcher.join_room(room)
        self._tasks.append(asyncio.create_task(watcher.receive_forever(since=None)))
        await _watched_room(watcher)

        sender = _transport(
            session_factory,
            client_id=other_client_id,
            user_id=other_user_id,
            ephemeral=ephemeral,
        )
        await sender.send_event(
            elsewhere, "com.switch.agent.runtime_state", {"state": "idle"}
        )

        assert received.events == []

    async def test_a_client_that_stopped_receiving_is_no_longer_told(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Presence is delivered live, so a closed client must leave the bus —
        otherwise it holds a handler for a room nobody is reading."""
        async with session_factory() as session:
            _, room, client_id, user_id = await _make_room(session)
            await session.commit()

        ephemeral = EphemeralBus()
        received = _Received()
        watcher = _transport(
            session_factory, client_id=client_id, user_id=user_id, ephemeral=ephemeral
        )
        watcher.register_handlers(received.handlers())
        await watcher.join_room(room)
        task = asyncio.create_task(watcher.receive_forever(since=None))
        self._tasks.append(task)
        await _watched_room(watcher)
        await watcher.close()
        await task

        await watcher.send_event(
            room, "com.switch.agent.runtime_state", {"state": "idle"}
        )

        assert received.events == []


class TestOneClientCannotStallAnother:
    """The listener fans out to every subscriber from a single task.

    So whatever a waker awaits, every other client in the process waits for
    too — and a handler can be a bridge posting to Slack, which is a network
    call that sits in a rate limit for seconds. Under Matrix each client had
    its own sync loop and got this isolation for free; here it is built.
    """

    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Iterator[None]:
        self._tasks: list[asyncio.Task] = []
        yield
        for task in self._tasks:
            task.cancel()

    async def test_being_woken_does_not_deliver_on_the_caller_s_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            _, room, client_id, user_id = await _make_room(session)
            await session.commit()

        listener = _FakeListener()
        received = _Received()
        transport = _transport(
            session_factory, client_id=client_id, user_id=user_id, listener=listener
        )
        transport.register_handlers(received.handlers())
        await transport.join_room(room)
        self._tasks.append(asyncio.create_task(transport.receive_forever(since=None)))
        switch_room_id = await _watched_room(transport)

        await transport.send_message(room, "hello", sender_name="agent one")
        # The waker itself, rather than the fake's announce, which waits for
        # the reading it provokes.
        await transport._on_room_advanced(switch_room_id)

        assert received.events == []
        assert transport._pending == {switch_room_id}

        await _settled(transport)
        assert [event.body for event in received.events] == ["hello"]

    async def test_rooms_that_moved_while_it_was_busy_are_read_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Coalescing is what keeps the loop serial without falling behind:
        a room announced three times is still one read, and running those
        concurrently would deliver the same rows three times."""
        async with session_factory() as session:
            _, room, client_id, user_id = await _make_room(session)
            await session.commit()

        listener = _FakeListener()
        received = _Received()
        transport = _transport(
            session_factory, client_id=client_id, user_id=user_id, listener=listener
        )
        transport.register_handlers(received.handlers())
        await transport.join_room(room)
        self._tasks.append(asyncio.create_task(transport.receive_forever(since=None)))
        switch_room_id = await _watched_room(transport)

        await transport.send_message(room, "hello", sender_name="agent one")
        await transport._on_room_advanced(switch_room_id)
        await transport._on_room_advanced(switch_room_id)
        await transport._on_room_advanced(switch_room_id)
        await _settled(transport)

        assert [event.body for event in received.events] == ["hello"]


class TestJoiningARoomAlreadyRecorded:
    """Membership and subscription are two facts now.

    The homeserver's join *was* what a sync loop delivered, so one implied the
    other. A `client_rooms` row can be written by something other than this
    client, and a join that returned early on finding one would leave a
    running client a member of a room it never reads.
    """

    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Iterator[None]:
        self._tasks: list[asyncio.Task] = []
        yield
        for task in self._tasks:
            task.cancel()

    async def test_it_starts_watching_and_writes_no_second_arrival(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            switch_room_id, room, client_id, user_id = await _make_room(session)
            elsewhere_id, elsewhere, _, _ = await _make_room(session)
            await session.commit()

        listener = _FakeListener()
        received = _Received()
        transport = _transport(
            session_factory, client_id=client_id, user_id=user_id, listener=listener
        )
        transport.register_handlers(received.handlers())
        await transport.join_room(room)
        self._tasks.append(asyncio.create_task(transport.receive_forever(since=None)))
        await _watched_room(transport)

        # Somebody else records the membership — what a moderation invite does
        # when nothing is listening for this client.
        async with session_factory() as session:
            await RoomStore().add_client(session, client_id, elsewhere_id)
            await session.commit()

        assert await transport.join_room(elsewhere) is True
        # Joining again must not announce a second arrival to the room.
        assert await transport.join_room(elsewhere) is True

        assert elsewhere_id in transport._watching
        async with session_factory() as session:
            rows = await MessageStore().list_for_room(
                session, elsewhere_id, after_seq=0, limit=10
            )
        assert rows == []

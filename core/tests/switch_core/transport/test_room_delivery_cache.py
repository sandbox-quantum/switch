"""The room delivery cache through `PostgresTransport`, against Postgres.

`test_room_cache.py` pins the cache's rules with a store a test can stop
half-way. These prove the same guarantees where they matter: real transports,
real rows, real row-level security, and in one case the real LISTEN.

`test_postgres_transport.py` runs every existing transport test on the cache
too.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.db.models import Client, ClientRoom, Message, Room, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.messages.notify import MessageListener
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.transport import InboundMedia, InboundMessage
from switch_core.transport.invites import InviteBus
from switch_core.transport.postgres import DELIVERY_PAGE, PostgresTransport
from switch_core.transport.room_cache import RoomCacheLimits, RoomDeliveryCache
from tests.conftest import RLSHarness
from tests.switch_core.transport.test_postgres_transport import (
    _FakeListener,
    _make_client,
    _make_room,
    _Received,
    _settled,
    _transport,
    _watched_room,
)

DELIVERY_TIMEOUT = 10.0


def _cache(
    session_factory: async_sessionmaker[AsyncSession], **limits: Any
) -> RoomDeliveryCache:
    values: dict[str, Any] = {
        "max_bytes": 64 * 1024 * 1024,
        "max_rooms": 1000,
        "max_rows_per_room": 1000,
        "max_age_seconds": 300.0,
    }
    values.update(limits)
    return RoomDeliveryCache(
        session_factory=session_factory,
        message_store=MessageStore(),
        limits=RoomCacheLimits(**values),
        page=DELIVERY_PAGE,
    )


def _with(transport: PostgresTransport, cache: RoomDeliveryCache) -> PostgresTransport:
    """The transport `_transport` built, on the cache this test chose.

    `_transport` hands out that module's shared cache; these tests each decide
    for themselves which cache, and its limits.
    """
    transport._room_cache = cache
    return transport


class _Room:
    """One room with `size` members, each a receiving transport."""

    def __init__(self) -> None:
        self.room_id = ""
        self.transport_room_id = ""
        self.members: list[PostgresTransport] = []
        self.received: list[_Received] = []
        self.tasks: list[asyncio.Task[None]] = []

    @classmethod
    async def open(
        cls,
        session_factory: async_sessionmaker[AsyncSession],
        size: int,
        *,
        cache: RoomDeliveryCache,
        listener: Any,
        invites: InviteBus | None = None,
    ) -> _Room:
        room = cls()
        async with session_factory() as session:
            room_id, transport_room_id, first_id, first_user = await _make_room(session)
            clients = [(first_id, first_user)]
            for n in range(size - 1):
                clients.append(await _make_client(session, f"member{n}"))
            for client_id, _ in clients:
                # Recorded directly, so no arrival row is in the way.
                await RoomStore().add_client(session, client_id, room_id)
            await session.commit()
        room.room_id, room.transport_room_id = room_id, transport_room_id
        for client_id, user_id in clients:
            transport = _with(
                _transport(
                    session_factory,
                    client_id=client_id,
                    user_id=user_id,
                    listener=listener,
                    invites=invites,
                ),
                cache,
            )
            received = _Received()
            transport.register_handlers(received.handlers())
            room.members.append(transport)
            room.received.append(received)
            room.tasks.append(asyncio.create_task(transport.receive_forever()))
        for transport in room.members:
            await _watched_room(transport)
        return room

    def close(self) -> None:
        for task in self.tasks:
            task.cancel()

    async def settled(self) -> None:
        for transport in self.members:
            await _settled(transport)


class _ReadCounter:
    """Counts `list_for_room` calls, which is what a delivery read costs."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls = 0
        original = MessageStore.list_for_room

        async def _counting(store, session, room_id, **kwargs):  # type: ignore[no-untyped-def]
            self.calls += 1
            return await original(store, session, room_id, **kwargs)

        monkeypatch.setattr(MessageStore, "list_for_room", _counting)


async def _event_ids_in_order(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[str]:
    async with session_factory() as session:
        rows = await session.execute(
            select(Message.transport_event_id)
            .where(Message.room_id == room_id, Message.seq > 0)
            .order_by(Message.seq)
        )
        return list(rows.scalars())


def _ids(received: _Received) -> list[str]:
    return [event.event_id for event in received.events]  # type: ignore[attr-defined]


@pytest.fixture
def rooms() -> Iterator[list[_Room]]:
    opened: list[_Room] = []
    yield opened
    for room in opened:
        room.close()


class TestEveryMemberGetsEveryRowOnce:
    async def test_a_room_of_six_reads_each_new_message_once(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        rooms: list[_Room],
    ) -> None:
        """The case the cache exists for, and the numbers for the PR.

        Six members, twenty messages, each announced as it is sent. Every
        member must get every message once and in order, and the room is read
        once per message instead of once per member.
        """
        cache = _cache(session_factory)
        listener = _FakeListener()
        room = await _Room.open(session_factory, 6, cache=cache, listener=listener)
        rooms.append(room)
        reads = _ReadCounter(monkeypatch)

        messages = 20
        for n in range(messages):
            await room.members[n % 6].send_message(
                room.transport_room_id, f"m{n}", sender_name="a", metered=False
            )
            await listener.announce(room.room_id)

        expected = await _event_ids_in_order(session_factory, room.room_id)
        assert len(expected) == messages
        for received in room.received:
            assert _ids(received) == expected
        per_message = reads.calls / messages
        print(  # noqa: T201 - the figure the PR quotes, read with -s
            f"\nroom of 6, {messages} messages: {reads.calls} list_for_room "
            f"calls, {per_message:.2f} per message"
        )
        assert reads.calls == messages

    async def test_a_burst_over_the_real_listener_arrives_once_in_order(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        postgres_schema: str,
        monkeypatch: pytest.MonkeyPatch,
        rooms: list[_Room],
    ) -> None:
        """The real LISTEN, the real fan-out, three writers at once.

        Announcements coalesce and land mid-read here, the way they do in
        production; nothing is stepping the transports one at a time.
        """
        listener = MessageListener(
            lambda: create_async_engine(postgres_schema, poolclass=NullPool)
        )
        await listener.start()
        try:
            await asyncio.wait_for(listener.connected.wait(), DELIVERY_TIMEOUT)
            cache = _cache(session_factory)
            room = await _Room.open(session_factory, 6, cache=cache, listener=listener)
            rooms.append(room)
            await room.settled()
            reads = _ReadCounter(monkeypatch)

            async def write(member: int, count: int) -> None:
                for n in range(count):
                    await room.members[member].send_message(
                        room.transport_room_id,
                        f"{member}-{n}",
                        sender_name="a",
                        metered=False,
                    )

            await asyncio.gather(write(0, 25), write(1, 25), write(2, 25))
            expected = await _event_ids_in_order(session_factory, room.room_id)
            assert len(expected) == 75

            async def all_arrived() -> None:
                while any(len(r.events) < 75 for r in room.received):
                    await asyncio.sleep(0.02)

            await asyncio.wait_for(all_arrived(), DELIVERY_TIMEOUT)
            await asyncio.sleep(0.2)  # long enough for a duplicate to show
            for received in room.received:
                assert _ids(received) == expected
            print(  # noqa: T201 - the figure the PR quotes, read with -s
                f"\nburst over LISTEN, room of 6, 75 messages from 3 writers: "
                f"{reads.calls} list_for_room calls"
            )
        finally:
            await listener.stop()

    async def test_members_at_different_cursors_each_get_their_own_sequence(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        rooms: list[_Room],
    ) -> None:
        """One member far behind, one in the middle, one at the head.

        Whoever reads first decides where the held range starts; the others
        are below it (their own read until they reach it) or above it (the
        range is extended up to them). Each gets exactly what follows its own
        cursor.
        """
        cache = _cache(session_factory)
        listener = _FakeListener()
        room = await _Room.open(session_factory, 3, cache=cache, listener=listener)
        rooms.append(room)
        for n in range(12):
            await room.members[0].send_message(
                room.transport_room_id, f"m{n}", sender_name="a", metered=False
            )
        expected = await _event_ids_in_order(session_factory, room.room_id)

        for start in ([0, 5, 11], [11, 0, 5], [5, 11, 0]):
            cache.invalidate(room.members[0].tenant_id, room.room_id)
            for member, received in zip(room.members, room.received, strict=True):
                received.events.clear()
            for member, cursor in zip(room.members, start, strict=True):
                member._cursors[room.room_id] = cursor
            await listener.announce(room.room_id)
            for received, cursor in zip(room.received, start, strict=True):
                assert _ids(received) == expected[cursor:], start

    async def test_evictions_mid_stream_lose_and_repeat_nothing(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        rooms: list[_Room],
    ) -> None:
        """A byte limit smaller than one row, and invalidations as it runs.

        Every fill is thrown away the moment it lands, so every read falls
        back to the transport's own. Slower, and still exactly once.
        """
        cache = _cache(session_factory, max_bytes=1)
        listener = _FakeListener()
        room = await _Room.open(session_factory, 4, cache=cache, listener=listener)
        rooms.append(room)

        for n in range(15):
            await room.members[n % 4].send_message(
                room.transport_room_id, f"m{n}", sender_name="a", metered=False
            )
            if n % 5 == 0:
                cache.invalidate(room.members[0].tenant_id, room.room_id)
            await listener.announce(room.room_id)

        expected = await _event_ids_in_order(session_factory, room.room_id)
        for received in room.received:
            assert _ids(received) == expected
        assert cache.stats().bytes <= 1


class TestWhatAMemberIsHanded:
    async def test_files_arrive_with_their_rows(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        rooms: list[_Room],
    ) -> None:
        cache = _cache(session_factory)
        listener = _FakeListener()
        room = await _Room.open(session_factory, 3, cache=cache, listener=listener)
        rooms.append(room)

        await room.members[0].send_media(
            room.transport_room_id,
            "switch-media://abc",
            "notes.txt",
            "text/plain",
            12,
            sender_name="a",
            msgtype="m.file",
            metered=False,
        )
        await listener.announce(room.room_id)

        for received in room.received:
            (event,) = received.events
            assert isinstance(event, InboundMedia)
            assert (event.uri, event.filename, event.mimetype, event.size) == (
                "switch-media://abc",
                "notes.txt",
                "text/plain",
                12,
            )

    async def test_changing_a_delivered_message_changes_nobody_elses(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        rooms: list[_Room],
    ) -> None:
        cache = _cache(session_factory)
        listener = _FakeListener()
        room = await _Room.open(session_factory, 3, cache=cache, listener=listener)
        rooms.append(room)

        async def vandal(_room: object, event: InboundMessage) -> None:
            event.content["body"] = "vandalised"
            event.content["nested"]["n"] = -1  # type: ignore[index]
            room.received[0].events.append(event)

        room.members[0].register_handlers(room.received[0].handlers(on_message=vandal))
        for _ in range(2):  # twice, so a later reader follows an earlier vandal
            await room.members[1].send_message(
                room.transport_room_id,
                "original",
                sender_name="a",
                metered=False,
                extra_content={"nested": {"n": 1}},
            )
            await listener.announce(room.room_id)

        for received in room.received[1:]:
            assert [e.content["body"] for e in received.events] == ["original"] * 2  # type: ignore[attr-defined]
            assert [e.content["nested"] for e in received.events] == [{"n": 1}] * 2  # type: ignore[attr-defined]


class TestMembershipIsStillEachClients:
    async def test_a_removed_member_gets_nothing_after_removal(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        rooms: list[_Room],
    ) -> None:
        """Removed while the room's shared read was in flight.

        The read completes and the remaining member is handed the row; the
        removed one was waiting on the same read and gets nothing from it.
        """
        cache = _cache(session_factory)
        listener = _FakeListener()
        invites = InviteBus()
        room = await _Room.open(
            session_factory, 2, cache=cache, listener=listener, invites=invites
        )
        rooms.append(room)
        leaving, staying = room.members

        await staying.send_message(
            room.transport_room_id, "held", sender_name="a", metered=False
        )
        gate = asyncio.Event()
        original = MessageStore.list_for_room

        async def held(store, session, room_id, **kwargs):  # type: ignore[no-untyped-def]
            await gate.wait()
            return await original(store, session, room_id, **kwargs)

        monkeypatch.setattr(MessageStore, "list_for_room", held)
        for waker in list(listener.wakers[room.room_id]):
            await waker(room.room_id)
        for _ in range(20):
            await asyncio.sleep(0)
        assert leaving._delivering and staying._delivering

        provisioning = PostgresProvisioning(
            session_factory=session_factory,
            room_store=RoomStore(),
            client_store=ClientStore(),
            message_store=MessageStore(),
            invites=invites,
        )
        await provisioning.kick_user(room.transport_room_id, leaving.user_id)
        gate.set()
        await room.settled()

        assert room.received[0].events == []
        assert [e.body for e in room.received[1].events] == ["held"]  # type: ignore[attr-defined]

        # And nothing after it, while the room is still cached for the other.
        await staying.send_message(
            room.transport_room_id, "after", sender_name="a", metered=False
        )
        await listener.announce(room.room_id)
        assert room.received[0].events == []
        assert [e.body for e in room.received[1].events] == ["held", "after"]  # type: ignore[attr-defined]

    async def test_a_room_everyone_has_left_is_not_held(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        rooms: list[_Room],
    ) -> None:
        """Deleting a room removes its members first, so this is also what
        deleting one leaves behind: nothing."""
        cache = _cache(session_factory)
        listener = _FakeListener()
        invites = InviteBus()
        room = await _Room.open(
            session_factory, 2, cache=cache, listener=listener, invites=invites
        )
        rooms.append(room)
        await room.members[0].send_message(
            room.transport_room_id, "hello", sender_name="a", metered=False
        )
        await listener.announce(room.room_id)
        assert cache.stats().rooms == 1

        provisioning = PostgresProvisioning(
            session_factory=session_factory,
            room_store=RoomStore(),
            client_store=ClientStore(),
            message_store=MessageStore(),
            invites=invites,
        )
        for member in room.members:
            await provisioning.kick_user(room.transport_room_id, member.user_id)

        assert cache.stats().rooms == 0
        assert cache.stats().bytes == 0

    async def test_another_tenants_rows_are_never_served(
        self, rls_harness: RLSHarness
    ) -> None:
        """A transport of tenant B pointed at tenant A's room, by force.

        The schema makes this impossible to reach honestly (a client cannot be
        a member of another tenant's room), so the subscription is written
        straight into the transport, standing in for some future bug that
        reaches it. A's rows are already in the cache under A's key. B's read
        is keyed by B and filled under B's tenant, so row-level security
        answers it, and the answer is nothing.
        """
        owner, restricted = rls_harness.owner, rls_harness.restricted
        tenant_a, tenant_b = (f"tenant-{uuid.uuid4().hex[:8]}" for _ in range(2))
        async with owner() as session:
            session.add_all(
                [Tenant(id=t, slug=t, name=t) for t in (tenant_a, tenant_b)]
            )
            await session.flush()
            suffix = uuid.uuid4().hex[:8]
            a_client = Client(
                tenant_id=tenant_a,
                transport_user_id=f"@a-{suffix}:test",
                display_name="a",
                type="agent",
            )
            b_client = Client(
                tenant_id=tenant_b,
                transport_user_id=f"@b-{suffix}:test",
                display_name="b",
                type="agent",
            )
            room = Room(
                tenant_id=tenant_a,
                transport_room_id=f"!room-{suffix}:test",
                name="a's room",
                description="",
            )
            session.add_all([a_client, b_client, room])
            await session.flush()
            session.add(
                ClientRoom(tenant_id=tenant_a, client_id=a_client.id, room_id=room.id)
            )
            await session.commit()
            room_id, transport_room_id = room.id, room.transport_room_id
            a_ids = (a_client.id, a_client.transport_user_id)
            b_ids = (b_client.id, b_client.transport_user_id)

        cache = _cache(restricted)
        listener = _FakeListener()
        a = _with(
            _transport(
                restricted,
                client_id=a_ids[0],
                user_id=a_ids[1],
                tenant_id=tenant_a,
                listener=listener,
            ),
            cache,
        )
        b = _with(
            _transport(
                restricted,
                client_id=b_ids[0],
                user_id=b_ids[1],
                tenant_id=tenant_b,
                listener=listener,
            ),
            cache,
        )
        a_got, b_got = _Received(), _Received()
        a.register_handlers(a_got.handlers())
        b.register_handlers(b_got.handlers())
        tasks = [
            asyncio.create_task(a.receive_forever()),
            asyncio.create_task(b.receive_forever()),
        ]
        try:
            await _watched_room(a)
            await a.send_message(
                transport_room_id, "for tenant a", sender_name="a", metered=False
            )
            await listener.announce(room_id)
            assert [e.body for e in a_got.events] == ["for tenant a"]  # type: ignore[attr-defined]
            assert cache.stats().rooms == 1

            # The forced subscription: what `_watch` would record, from 0.
            b._room_ids[transport_room_id] = room_id
            b._watching[room_id] = transport_room_id
            b._cursors[room_id] = 0
            cache.attach(tenant_b, room_id, b)
            b._mark_pending(room_id)
            await _settled(b)

            assert b_got.events == []
            assert cache.stats().rooms == 2, "B shared A's entry"
            async with tenant_session(restricted, tenant_a) as session:
                rows = await MessageStore().list_for_room(
                    session, room_id, after_seq=0, limit=10
                )
            assert [row.body for row in rows] == ["for tenant a"]
        finally:
            for task in tasks:
                task.cancel()


class TestTheListenerIsNeverHeldUp:
    async def test_the_fan_out_finishes_while_a_fill_is_blocked(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The single fan-out task wakes every room; a fill must not be in it.

        The room's read is held. The fan-out still wakes both members, moves
        on to the next room, and drains its queue.
        """
        listener = MessageListener(lambda: None)  # type: ignore[arg-type,return-value]
        listener._running = True
        fan_out = asyncio.create_task(listener._fan_out_forever())
        cache = _cache(session_factory)
        tasks: list[asyncio.Task[None]] = []
        try:
            async with session_factory() as session:
                room_id, room, first_id, first_user = await _make_room(session)
                second_id, second_user = await _make_client(session, "second")
                for client_id in (first_id, second_id):
                    await RoomStore().add_client(session, client_id, room_id)
                await session.commit()
            members = [
                _with(
                    _transport(
                        session_factory,
                        client_id=client_id,
                        user_id=user_id,
                        listener=listener,  # type: ignore[arg-type]
                    ),
                    cache,
                )
                for client_id, user_id in (
                    (first_id, first_user),
                    (second_id, second_user),
                )
            ]
            for member in members:
                member.register_handlers(_Received().handlers())
                tasks.append(asyncio.create_task(member.receive_forever()))
            for member in members:
                await _watched_room(member)
            for member in members:
                await _settled(member)

            gate = asyncio.Event()
            fills = 0
            original = MessageStore.list_for_room

            async def held(store, session, room, **kwargs):  # type: ignore[no-untyped-def]
                nonlocal fills
                fills += 1
                await gate.wait()
                return await original(store, session, room, **kwargs)

            monkeypatch.setattr(MessageStore, "list_for_room", held)
            other_room_woken = asyncio.Event()

            async def other_room(_room_id: str) -> None:
                other_room_woken.set()

            listener.subscribe("some-other-room", other_room)
            await asyncio.wait_for(other_room_woken.wait(), DELIVERY_TIMEOUT)
            other_room_woken.clear()

            # Wake the room; its one shared read starts and is held.
            listener._mark(room_id, 1)
            for _ in range(500):
                if fills and all(m._delivering for m in members):
                    break
                await asyncio.sleep(0.002)
            assert fills == 1, "both members should be waiting on one read"

            # With that read still held, the fan-out goes on waking rooms.
            listener._mark("some-other-room", 1)
            await asyncio.wait_for(other_room_woken.wait(), DELIVERY_TIMEOUT)
            assert not gate.is_set()
            assert fills == 1
            assert listener._pending == {}
            assert all(m._delivering for m in members)
            assert not fan_out.done()
            gate.set()
            for member in members:
                await _settled(member)
        finally:
            for task in tasks:
                task.cancel()
            fan_out.cancel()

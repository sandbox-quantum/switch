"""Room membership changes reach the copy of a client in every process.

Against real PostgreSQL, two "processes" on one database: each with its own
signal bus, invitation bus and transport for the same client, as every
switch-core process runs its own copy of each client. A membership written
through one must start or stop the room's delivery in the other, by way of the
trigger on `client_rooms` and the signal it sends, which no stand-in can show.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.db.models import TENANT_ZERO_ID, Client, ClientRoom, Message, Room
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.signals import SignalBus
from switch_core.transport import InboundMessage, TransportHandlers
from switch_core.transport.cursors import FromHead
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.membership_signals import MembershipSignals
from switch_core.transport.observer import IgnoreParticipantMessages
from switch_core.transport.postgres import DELIVERY_PAGE, PostgresTransport
from switch_core.transport.room_cache import RoomCacheLimits, RoomDeliveryCache
from tests.routing import router_on

DELIVERY_TIMEOUT = 10.0


class _Listener:
    """Stands in for the message listener, so a test can say "the room
    moved" to one process."""

    def __init__(self) -> None:
        self.wakers: dict[str, set[Any]] = {}

    def subscribe(
        self, room_id: str, waker: Any, *, types: frozenset[str] | None = None
    ) -> None:
        self.wakers.setdefault(room_id, set()).add(waker)

    def unsubscribe(self, room_id: str, waker: Any) -> None:
        self.wakers.get(room_id, set()).discard(waker)

    async def announce(self, room_id: str) -> None:
        for waker in list(self.wakers.get(room_id, ())):
            await waker(room_id)


@dataclass
class _Process:
    """One switch-core process's copy of the client, and what it was handed."""

    transport: PostgresTransport
    listener: _Listener
    invites: InviteBus
    membership: MembershipSignals
    bus: SignalBus
    bodies: list[str] = field(default_factory=list)
    invited_at: list[int] = field(default_factory=list)
    removed_from: list[str] = field(default_factory=list)


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(DELIVERY_TIMEOUT):
        while not check():
            await asyncio.sleep(0.02)


async def _settled(transport: PostgresTransport) -> None:
    await _eventually(lambda: not transport._pending and not transport._delivering)


@pytest.fixture
async def room_and_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, str, str]:
    """A room, an agent client that is a member of it, and a second client
    that is not, which speaks in it. Returns (room id, transport room id,
    client id, client user id, speaker id)."""
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@agent-{suffix}:test",
            display_name="agent one",
            type="agent",
        )
        speaker = Client(
            transport_user_id=f"@speaker-{suffix}:test",
            display_name="speaker",
            type="agent",
        )
        room = Room(
            transport_room_id=f"!room-{suffix}:test", name="a room", description=""
        )
        session.add_all([client, speaker, room])
        await session.flush()
        await RoomStore().add_client(session, client.id, room.id)
        await RoomStore().add_client(session, speaker.id, room.id)
        await session.commit()
        return (
            room.id,
            room.transport_room_id,
            client.id,
            client.transport_user_id,
            speaker.id,
        )


@pytest.fixture
async def two_processes(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    room_and_client: tuple[str, str, str, str, str],
) -> AsyncIterator[tuple[_Process, _Process]]:
    _, _, client_id, user_id, _ = room_and_client
    processes = [
        _process(postgres_url, session_factory, client_id, user_id) for _ in range(2)
    ]
    tasks = [
        asyncio.create_task(process.transport.receive_forever(FromHead(MessageStore())))
        for process in processes
    ]
    for process in processes:
        await process.bus.start()
    for process in processes:
        await asyncio.wait_for(process.bus.connected.wait(), DELIVERY_TIMEOUT)
        await _eventually(lambda p=process: bool(p.transport._watching))  # type: ignore[misc]
    yield processes[0], processes[1]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    for process in processes:
        await process.bus.stop()


def _process(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    client_id: str,
    user_id: str,
) -> _Process:
    listener = _Listener()
    invites = InviteBus()
    bus = SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=str(uuid.uuid4()),
    )
    transport = PostgresTransport(
        user_id=user_id,
        client_id=client_id,
        tenant_id=TENANT_ZERO_ID,
        display_name="agent one",
        actor_role="agent",
        session_factory=session_factory,
        room_store=RoomStore(),
        message_store=MessageStore(),
        usage_store=UsageStore(),
        media_store=MediaStore(),
        listener=listener,  # type: ignore[arg-type]
        invites=invites,
        ephemeral=EphemeralBus(),
        room_cache=RoomDeliveryCache(
            session_factory=session_factory,
            message_store=MessageStore(),
            limits=RoomCacheLimits(
                max_bytes=1024 * 1024,
                max_rooms=10,
                max_rows_per_room=DELIVERY_PAGE,
                max_age_seconds=60.0,
            ),
            page=DELIVERY_PAGE,
        ),
        message_observer=IgnoreParticipantMessages(),
        router=router_on(session_factory),
    )
    process = _Process(
        transport=transport,
        listener=listener,
        invites=invites,
        membership=MembershipSignals(
            invites=invites, bus=bus, router=router_on(session_factory)
        ),
        bus=bus,
    )

    async def _on_message(_room: Any, event: InboundMessage) -> None:
        process.bodies.append(event.body)

    async def _on_invite(room: Any, event: Any) -> None:
        # What a consumer does with an invitation: join, which watches.
        process.invited_at.append(event.timestamp)
        await transport.join_room(room.room_id)

    async def _on_removed(room: Any, _event: Any) -> None:
        process.removed_from.append(room.room_id)

    async def _ignore(*_args: Any) -> None:
        return None

    transport.register_handlers(
        TransportHandlers(
            on_message=_on_message,
            on_media=_ignore,
            on_member_event=_ignore,
            on_custom_event=_ignore,
            on_invite=_on_invite,
            on_removed=_on_removed,
        )
    )
    return process


def _provisioning(
    session_factory: async_sessionmaker[AsyncSession], invites: InviteBus
) -> PostgresProvisioning:
    return PostgresProvisioning(
        session_factory=session_factory,
        room_store=RoomStore(),
        client_store=ClientStore(),
        router=router_on(session_factory),
        invites=invites,
    )


async def _is_member(
    session_factory: async_sessionmaker[AsyncSession], client_id: str, room_id: str
) -> bool:
    async with session_factory() as session:
        row = await session.get(
            ClientRoom, {"client_id": client_id, "room_id": room_id}
        )
        return row is not None


async def _arrivals(
    session_factory: async_sessionmaker[AsyncSession], room_id: str, user_id: str
) -> int:
    async with session_factory() as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(Message)
                .where(
                    Message.room_id == room_id,
                    Message.sender_id == user_id,
                    Message.event_type == "m.room.member",
                )
            )
            or 0
        )


def _kick_after_read(
    transport: PostgresTransport,
    kick: Callable[[], Any],
    room_id: str,
    kicked: list[bool],
) -> None:
    """Make the transport's next membership read that includes `room_id`
    return what it read only after `kick` has committed."""
    store = transport._room_store
    real = store.memberships_of

    async def read_then_kick(session: Any, client_id: str) -> Any:
        memberships = await real(session, client_id)
        if not kicked and any(m.room_id == room_id for m in memberships):
            await kick()
            kicked.append(True)
        return memberships

    store.memberships_of = read_then_kick  # type: ignore[method-assign]


async def _say(
    session_factory: async_sessionmaker[AsyncSession],
    speaker: PostgresTransport,
    transport_room_id: str,
    body: str,
    *processes: _Process,
    room_id: str,
) -> None:
    await speaker.send_message(transport_room_id, body, sender_name="s", metered=False)
    for process in processes:
        await process.listener.announce(room_id)
        await _settled(process.transport)


def _speaker(
    session_factory: async_sessionmaker[AsyncSession], speaker_id: str
) -> PostgresTransport:
    return PostgresTransport(
        user_id="@speaker:test",
        client_id=speaker_id,
        tenant_id=TENANT_ZERO_ID,
        display_name="speaker",
        actor_role="agent",
        session_factory=session_factory,
        room_store=RoomStore(),
        message_store=MessageStore(),
        usage_store=UsageStore(),
        media_store=MediaStore(),
        listener=_Listener(),  # type: ignore[arg-type]
        invites=InviteBus(),
        ephemeral=EphemeralBus(),
        room_cache=RoomDeliveryCache(
            session_factory=session_factory,
            message_store=MessageStore(),
            limits=RoomCacheLimits(
                max_bytes=1024 * 1024,
                max_rooms=10,
                max_rows_per_room=DELIVERY_PAGE,
                max_age_seconds=60.0,
            ),
            page=DELIVERY_PAGE,
        ),
        message_observer=IgnoreParticipantMessages(),
        router=router_on(session_factory),
    )


class TestAcrossProcesses:
    async def test_a_member_removed_through_one_process_stops_hearing_the_room_in_the_other(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
        two_processes: tuple[_Process, _Process],
    ) -> None:
        room_id, transport_room_id, _, user_id, speaker_id = room_and_client
        here, there = two_processes
        speaker = _speaker(session_factory, speaker_id)
        await _say(
            session_factory,
            speaker,
            transport_room_id,
            "while a member",
            there,
            room_id=room_id,
        )
        assert there.bodies == ["while a member"]

        await _provisioning(session_factory, here.invites).kick_user(
            transport_room_id, user_id
        )
        await _eventually(lambda: room_id not in there.transport._watching)
        await _say(
            session_factory,
            speaker,
            transport_room_id,
            "after removal",
            there,
            room_id=room_id,
        )

        assert room_id not in here.transport._watching
        assert there.bodies == ["while a member"]

    async def test_a_member_added_through_one_process_hears_the_room_in_the_other(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
        two_processes: tuple[_Process, _Process],
    ) -> None:
        _, _, client_id, user_id, speaker_id = room_and_client
        here, there = two_processes
        async with session_factory() as session:
            room = Room(
                transport_room_id=f"!second-{uuid.uuid4().hex[:8]}:test",
                name="another room",
                description="",
            )
            session.add(room)
            await session.flush()
            await RoomStore().add_client(session, speaker_id, room.id)
            await session.commit()
            second_id, second_transport_id = room.id, room.transport_room_id

        await _provisioning(session_factory, here.invites).invite_to_room(
            second_transport_id, user_id
        )
        # The copy in the process that served the change joined itself.
        assert second_id in here.transport._watching
        await _eventually(lambda: second_id in there.transport._watching)
        async with session_factory() as session:
            membership = await session.get(
                ClientRoom, {"client_id": client_id, "room_id": second_id}
            )
            assert membership is not None
            joined_at_ms = int(membership.joined_at.timestamp() * 1000)  # type: ignore[attr-defined]

        await _say(
            session_factory,
            _speaker(session_factory, speaker_id),
            second_transport_id,
            "said after the join",
            there,
            room_id=second_id,
        )

        assert there.bodies == ["said after the join"]
        # The other process filters the room from the row's own time, not
        # from whenever its own clock heard of it.
        assert there.invited_at == [joined_at_ms]

    async def test_a_kick_during_the_other_process_recheck_sticks(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
        two_processes: tuple[_Process, _Process],
    ) -> None:
        """Added through one process and kicked through it while the other
        is re-reading for the add. The other's join must not write back the
        membership its read saw."""
        _, _, client_id, user_id, speaker_id = room_and_client
        here, there = two_processes
        async with session_factory() as session:
            room = Room(
                transport_room_id=f"!second-{uuid.uuid4().hex[:8]}:test",
                name="another room",
                description="",
            )
            session.add(room)
            await session.flush()
            await RoomStore().add_client(session, speaker_id, room.id)
            await session.commit()
            second_id, second_transport_id = room.id, room.transport_room_id
        kicked: list[bool] = []

        async def kick() -> None:
            await _provisioning(session_factory, here.invites).kick_user(
                second_transport_id, user_id
            )

        _kick_after_read(there.transport, kick, second_id, kicked)

        await _provisioning(session_factory, here.invites).invite_to_room(
            second_transport_id, user_id
        )
        await _eventually(lambda: bool(kicked))
        # Long enough for both processes to act on the signals that follow.
        await asyncio.sleep(1.5)

        assert not await _is_member(session_factory, client_id, second_id)
        assert await _arrivals(session_factory, second_id, user_id) == 1
        assert second_id not in there.transport._watching

    async def test_a_member_put_back_before_the_other_process_re_reads_is_not_handed_what_was_said_while_out(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
        two_processes: tuple[_Process, _Process],
    ) -> None:
        """Removed and added back, both committed before the other process
        re-reads, so its re-read finds a row for the room either way. The row
        is a new membership: that process is told the client was removed, and
        reads the room again as a new member rather than from where it had
        got to, which would hand it what was said while the client was out."""
        room_id, transport_room_id, client_id, _, speaker_id = room_and_client
        _, there = two_processes
        speaker = _speaker(session_factory, speaker_id)

        # The other process re-reads under this lock, so holding it keeps
        # both changes' signals waiting until both have committed.
        async with there.transport._reading_rooms:
            async with session_factory() as session:
                await session.execute(
                    delete(ClientRoom).where(
                        ClientRoom.client_id == client_id,
                        ClientRoom.room_id == room_id,
                    )
                )
                await session.commit()
            await _say(
                session_factory,
                speaker,
                transport_room_id,
                "said while out",
                room_id=room_id,
            )
            async with session_factory() as session:
                await RoomStore().add_client(session, client_id, room_id)
                await session.commit()
        await there.membership.reconcile_all()
        await _say(
            session_factory,
            speaker,
            transport_room_id,
            "said after being put back",
            there,
            room_id=room_id,
        )

        assert there.removed_from == [transport_room_id]
        assert there.bodies == ["said after being put back"]


class TestRecheck:
    async def test_a_removal_whose_signal_was_missed_is_caught_by_the_recheck(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
    ) -> None:
        room_id, _, client_id, user_id, _ = room_and_client
        # The bus is never started, so no signal reaches this process.
        process = _process(postgres_url, session_factory, client_id, user_id)
        task = asyncio.create_task(
            process.transport.receive_forever(FromHead(MessageStore()))
        )
        try:
            await _eventually(lambda: room_id in process.transport._watching)
            async with session_factory() as session:
                await session.execute(
                    delete(ClientRoom).where(ClientRoom.client_id == client_id)
                )
                await session.commit()

            await process.membership.reconcile_all()

            assert room_id not in process.transport._watching
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_a_room_being_joined_is_left_to_the_join(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
    ) -> None:
        """The join watches from just before the client's own arrival. A
        re-check that read the new row first and watched from the head would
        make the client miss hearing itself join."""
        room_id, _, client_id, user_id, _ = room_and_client
        process = _process(postgres_url, session_factory, client_id, user_id)
        task = asyncio.create_task(
            process.transport.receive_forever(FromHead(MessageStore()))
        )
        try:
            await _eventually(lambda: room_id in process.transport._watching)
            process.transport._unwatch(next(iter(process.transport._watching.values())))
            process.transport._joining.add(room_id)

            await process.membership.reconcile_all()

            assert process.invited_at == []
            assert room_id not in process.transport._watching
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_a_recheck_during_the_first_read_hands_on_no_room_already_joined(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The signal connection comes up, or a re-check runs, while the
        client is still reading the rooms it is in. Until that read is done it
        watches none of them, and a re-read in between would hand each one to
        `on_invite` as if someone had just added the client to it."""
        room_id, _, client_id, user_id, _ = room_and_client
        process = _process(postgres_url, session_factory, client_id, user_id)
        read = asyncio.Event()
        finish = asyncio.Event()
        joined_rooms = PostgresTransport.joined_rooms

        async def held_open(transport: PostgresTransport) -> list[str]:
            rooms = await joined_rooms(transport)
            read.set()
            await finish.wait()
            return rooms

        monkeypatch.setattr(PostgresTransport, "joined_rooms", held_open)
        task = asyncio.create_task(
            process.transport.receive_forever(FromHead(MessageStore()))
        )
        try:
            await asyncio.wait_for(read.wait(), DELIVERY_TIMEOUT)
            recheck = asyncio.create_task(process.membership.reconcile_all())
            # Long enough for a re-read that does not wait for the first one
            # to read the rows and hand the room on.
            await asyncio.sleep(0.3)
            finish.set()
            await asyncio.wait_for(recheck, DELIVERY_TIMEOUT)
            await _eventually(lambda: room_id in process.transport._watching)

            assert process.invited_at == []
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_a_kick_during_a_recheck_sticks(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        room_and_client: tuple[str, str, str, str, str],
    ) -> None:
        """The periodic re-check reads the rows, then a kick in the same
        process commits and drops the room. The re-check finds the room it
        read unwatched, and must not join it back."""
        room_id, transport_room_id, client_id, user_id, _ = room_and_client
        process = _process(postgres_url, session_factory, client_id, user_id)
        task = asyncio.create_task(
            process.transport.receive_forever(FromHead(MessageStore()))
        )
        try:
            await _eventually(lambda: room_id in process.transport._watching)
            kicked: list[bool] = []

            async def kick() -> None:
                await _provisioning(session_factory, process.invites).kick_user(
                    transport_room_id, user_id
                )

            _kick_after_read(process.transport, kick, room_id, kicked)

            await process.membership.reconcile_all()

            assert kicked
            assert not await _is_member(session_factory, client_id, room_id)
            assert await _arrivals(session_factory, room_id, user_id) == 0
            assert room_id not in process.transport._watching
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

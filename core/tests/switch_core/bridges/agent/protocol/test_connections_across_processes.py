"""Agent connections seen, fenced and served by every switch-core process.

Two processes on one database: each has its own connection registry, its own
signal bus listening on the real `NOTIFY` channel, and its own lease. A
connection's socket is held by one of them (A); its other requests, presence
questions and old-client heartbeats may reach the other (B). Nothing here is a
stand-in for the database or the bus, because what is under test is exactly
what crosses between the two.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.api.handlers import (
    connection_beat,
    connection_placements,
    connection_subscribe,
)
from switch_core.bridges.agent.api.operations import resolve_caller
from switch_core.bridges.agent.api.schemas import (
    ConnectionBeatRequest,
    ConnectionPlacementsRequest,
    ConnectionSubscribeRequest,
)
from switch_core.bridges.agent.protocol.agent_connections import (
    HEARTBEAT_TTL_SECONDS,
    PROTOCOL_VERSION,
    AgentConnection,
    AgentConnectionRegistry,
    ClientDeclaration,
    Closure,
    SupersededReattachError,
    UnknownConnectionError,
)
from switch_core.bridges.agent.protocol.connection_rows import SharedConnections
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.agent.protocol.presence import (
    agents_present_in,
    rooms_occupied,
)
from switch_core.bridges.agent.protocol.stream import KEEPALIVE, event_frames
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentConnectionRecord,
    AgentConnectionRoom,
    AgentRoomRead,
    AgentSessionPlacement,
    SwitchCoreProcess,
    Tenant,
)
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.delivery.recipient import AgentRecipient
from switch_core.process_identity import new_process_id
from switch_core.process_lease import LEASE_TTL, ProcessLease
from switch_core.signals import SignalBus
from switch_core.tenant_context import tenant_scope
from tests.conftest import TEST_KEYRING
from tests.db_buffer import db_buffer_on, seed_agent, seed_room
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
    said_by,
)

AGENT = "agent-1"
ROOM = "room-1"
OTHER_ROOM = "room-2"
CONN = "conn-1"

SessionFactory = async_sessionmaker[AsyncSession]

WAIT_SECONDS = 10.0


@dataclass
class Process:
    """One switch-core process, as far as agent connections reach."""

    registry: AgentConnectionRegistry
    shared: SharedConnections
    bus: SignalBus
    lease: ProcessLease
    buffer: EventBuffer
    run: asyncio.Task[None] | None = None

    @property
    def protocol(self) -> Any:
        """Enough of `AgentCore` for the connection handlers."""

        async def require_room_member(agent_id: str, room_id: str) -> Any:
            return SimpleNamespace(id=room_id)

        return SimpleNamespace(
            connections=self.registry,
            event_buffer=self.buffer,
            require_room_member=require_room_member,
        )


class _Agent:
    id = AGENT
    tenant_id = TENANT_ZERO_ID
    metadata_ = None


async def _start_process(postgres_url: str, session_factory: SessionFactory) -> Process:
    process_id = new_process_id("test-pod")
    bus = SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=process_id,
    )
    lease = ProcessLease(
        process_id=process_id,
        session_factory=session_factory,
        processes=SwitchCoreProcessStore(),
        key_ids=[key.id for key in TEST_KEYRING.keys],
    )
    registry = AgentConnectionRegistry()
    shared = SharedConnections(
        registry=registry,
        session_factory=session_factory,
        store=AgentConnectionStore(),
        bus=bus,
        lease=lease,
    )
    await lease.renew()
    await shared.start()
    await bus.start()
    await asyncio.wait_for(bus.connected.wait(), WAIT_SECONDS)
    process = Process(
        registry=registry,
        shared=shared,
        bus=bus,
        lease=lease,
        buffer=db_buffer_on(session_factory),
    )
    process.run = asyncio.create_task(shared.run())
    return process


async def _stop_process(process: Process) -> None:
    # The bus first, so no signal starts work after the process stopped
    # running; then the run, which waits for the work it started.
    await process.bus.stop()
    if process.run is not None:
        process.run.cancel()
        await asyncio.gather(process.run, return_exceptions=True)


@pytest.fixture
async def processes(
    postgres_url: str, session_factory: SessionFactory
) -> AsyncIterator[tuple[Process, Process]]:
    await seed_agent(session_factory, AGENT)
    await seed_room(session_factory, ROOM)
    await seed_room(session_factory, OTHER_ROOM)
    first = await _start_process(postgres_url, session_factory)
    second = await _start_process(postgres_url, session_factory)
    try:
        yield first, second
    finally:
        await _stop_process(first)
        await _stop_process(second)


class _NoHeartbeatRows:
    """The heartbeat-row arm of presence, for clients that still poll: none
    here, so only the connection can make the agent available."""

    async def get_live_agent_ids(
        self, _session: Any, _agent_ids: list[str], _room_id: str | None
    ) -> set[str]:
        return set()


def _recipient_on(process: Process) -> Any:
    """Enough of the agent's recipient, the router's side of the agent on this
    process, to ask whether the agent is available."""
    recipient = SimpleNamespace(
        agent=SimpleNamespace(id=AGENT),
        _connections=process.registry,
        _agent_session_store=_NoHeartbeatRows(),
    )
    recipient._is_available = AgentRecipient._is_available.__get__(recipient)
    return recipient


async def _eventually(check: Callable[[], bool]) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("the other process never caught up")
        await asyncio.sleep(0.02)


async def _open(
    process: Process,
    *,
    agent_id: str = AGENT,
    connection_id: str = CONN,
    scope: str = "single",
    expected_generation: int | None = None,
    speaks: int = PROTOCOL_VERSION,
) -> AgentConnection:
    """Open a connection as the stream and socket handlers do."""
    with tenant_scope(TENANT_ZERO_ID):
        async with process.registry.slots(agent_id):
            async with process.registry.recorded(agent_id):
                return process.registry.open(
                    agent_id=agent_id,
                    connection_id=connection_id,
                    scope=scope,  # type: ignore[arg-type]
                    delivery_filter="addressed",
                    spawn_capable=scope == "all",
                    position={OWN_EVENTS: 0},
                    declaration=ClientDeclaration(speaks=speaks),
                    expected_generation=expected_generation,
                )


async def _subscribe(
    process: Process, room_id: str, generation: int | None
) -> dict[str, Any]:
    return await connection_subscribe(
        AGENT,
        ConnectionSubscribeRequest(
            connection_id=CONN, room_id=room_id, generation=generation
        ),
        agent=_Agent(),  # type: ignore[arg-type]
        protocol=process.protocol,
    )


async def _place(
    process: Process, generation: int, placements: dict[str, str]
) -> dict[str, Any]:
    return await connection_placements(
        AGENT,
        ConnectionPlacementsRequest(
            connection_id=CONN, placements=placements, generation=generation
        ),
        agent=_Agent(),  # type: ignore[arg-type]
        protocol=process.protocol,
    )


class TestPresence:
    async def test_an_agent_connected_to_one_process_reads_online_from_the_other(
        self, processes: tuple[Process, Process]
    ) -> None:
        a, b = processes
        conn = await _open(a)
        await _subscribe(a, ROOM, conn.stream_generation)

        await _eventually(lambda: b.registry.live_in_room(AGENT, ROOM))

        assert b.registry.is_live(AGENT)
        assert agents_present_in([AGENT], ROOM, b.registry) == {AGENT}
        assert CONN in b.registry.live_connection_ids()
        # The copy is not counted in this process's own gauge: each process
        # reports the connections it holds.
        assert b.registry.live_agents_by_transport() == {}

    async def test_a_router_on_the_other_process_owes_no_offline_reply(
        self, processes: tuple[Process, Process]
    ) -> None:
        """The process that writes an addressed message decides whether the
        agent is available, and need not be the one holding its connection.
        It must still find the agent available, or it answers the message
        with "not online" while the agent is answering it."""
        a, b = processes
        conn = await _open(a, scope="all")
        await _subscribe(a, ROOM, conn.stream_generation)
        await _eventually(lambda: b.registry.claimant_of(AGENT, ROOM) is not None)

        for model in ("always_on", "auto_session", "session_addressable"):
            recipient = _recipient_on(b)
            agent = SimpleNamespace(
                id=AGENT, integration_profile={"connection_model": model}
            )
            assert await recipient._is_available(object(), agent, ROOM), model

    async def test_a_lapse_on_one_process_is_seen_by_the_other(
        self, processes: tuple[Process, Process]
    ) -> None:
        a, b = processes
        conn = await _open(a)
        await _eventually(lambda: b.registry.is_live(AGENT))

        conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
        assert [closed.id for closed in a.registry.sweep()] == [CONN]

        await _eventually(lambda: not b.registry.is_live(AGENT))

    async def test_a_process_whose_lease_lapses_stops_counting(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """A process that died wrote no closing: its lease going stale is what
        takes its connections offline everywhere else."""
        a, b = processes
        await _open(a)
        await _eventually(lambda: b.registry.is_live(AGENT))
        a.run.cancel()  # type: ignore[union-attr]
        async with session_factory() as session:
            await session.execute(
                update(SwitchCoreProcess)
                .where(SwitchCoreProcess.id == a.lease.process_id)
                .values(
                    beat_at=SwitchCoreProcess.beat_at - LEASE_TTL - timedelta(seconds=1)
                )
            )
            await session.commit()

        await b.shared.reload_all()

        assert not b.registry.is_live(AGENT)

    async def test_the_runtime_state_sweep_sees_a_session_placed_elsewhere(
        self, processes: tuple[Process, Process]
    ) -> None:
        """A "working" row owned by a session on another process must read as
        occupied, or the sweep there clears it every pass."""
        a, b = processes
        conn = await _open(a, scope="all")
        await connection_placements(
            AGENT,
            ConnectionPlacementsRequest(
                connection_id=CONN,
                placements={"session-1": ROOM},
                generation=conn.stream_generation,
            ),
            agent=_Agent(),  # type: ignore[arg-type]
            protocol=a.protocol,
        )

        await _eventually(lambda: ROOM in rooms_occupied(AGENT, b.registry))

        assert b.registry.session_room(AGENT, "session-1") == ROOM


class TestRoutedAnywhere:
    """A row is decided by the process that writes it, which need not be the
    one holding the connection of the agent the row is for."""

    async def test_a_message_written_through_the_other_process_finds_the_agent_online(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        a, b = processes
        writer = process_on(session_factory, connections=b.registry)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        helper, helper_client = await make_agent(session_factory, "helper")
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, helper_client, agent=helper)
        await _open(a, agent_id=helper.id, connection_id="conn-helper", scope="all")
        await _eventually(lambda: b.registry.is_live(helper.id))

        await writer.say(room, "@helper can you look at this", sender=alice)
        await writer.idle()

        assert len(await own_events(session_factory, helper.id)) == 1
        # No "not online" notice from the writer, which holds no connection.
        assert await said_by(session_factory, room, helper_client) == []

    async def test_a_removal_written_through_the_other_process_releases_the_claim(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """The process that removes the agent from a room takes the room off
        the connection claiming it, through the recorded claims, and the
        process holding that connection is told."""
        a, b = processes
        writer = process_on(session_factory, connections=b.registry)
        room = await make_room(session_factory)
        helper, helper_client = await make_agent(session_factory, "helper")
        await add_member(session_factory, room, helper_client, agent=helper)
        conn = await _open(a, agent_id=helper.id, connection_id="conn-helper")
        await connection_subscribe(
            helper.id,
            ConnectionSubscribeRequest(
                connection_id="conn-helper",
                room_id=room.id,
                generation=conn.stream_generation,
            ),
            agent=SimpleNamespace(  # type: ignore[arg-type]
                id=helper.id, tenant_id=TENANT_ZERO_ID, metadata_=None
            ),
            protocol=a.protocol,
        )
        assert conn.rooms == {room.id}

        await writer.provisioning.kick_user(
            room.transport_room_id, helper_client.transport_user_id
        )

        await _eventually(lambda: room.id not in conn.rooms)
        async with session_factory() as session:
            claimant = await session.scalar(
                select(AgentConnectionRoom.connection_id).where(
                    AgentConnectionRoom.agent_id == helper.id,
                    AgentConnectionRoom.room_id == room.id,
                )
            )
        assert claimant is None


class TestServedAnywhere:
    async def test_a_tool_call_on_the_process_without_the_socket_succeeds(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """Asked before the other process has heard of the connection: the
        row is read rather than the caller refused."""
        a, b = processes
        await _open(a)

        with tenant_scope(TENANT_ZERO_ID):
            bound, caller = await resolve_caller(
                agent_id=AGENT,
                protocol=b.protocol,
                factory=session_factory,
                connection_id=CONN,
                session_id=None,
                host_id=None,
                epoch=None,
            )

        assert bound == CONN
        assert caller is None

    async def test_a_session_selector_resolves_its_room_on_the_other_process(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        a, b = processes
        conn = await _open(a, scope="all")
        await connection_placements(
            AGENT,
            ConnectionPlacementsRequest(
                connection_id=CONN,
                placements={"session-1": ROOM},
                generation=conn.stream_generation,
            ),
            agent=_Agent(),  # type: ignore[arg-type]
            protocol=a.protocol,
        )

        with tenant_scope(TENANT_ZERO_ID):
            _, caller = await resolve_caller(
                agent_id=AGENT,
                protocol=b.protocol,
                factory=session_factory,
                connection_id=CONN,
                session_id="session-1",
                host_id="host",
                epoch="1",
            )

        assert caller is not None
        assert caller.room_id == ROOM

    async def test_a_session_moved_through_one_process_calls_from_its_new_room(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """The move is answered before the other process has read it, and
        the session's next call may land there: it must post where the
        session is now, not where that process last saw it."""
        a, b = processes
        conn = await _open(a, scope="all")
        await _place(a, conn.stream_generation, {"session-1": ROOM})
        await _eventually(lambda: b.registry.session_room(AGENT, "session-1") == ROOM)
        await b.bus.stop()  # `b` hears nothing more from `a`

        await _place(a, conn.stream_generation, {"session-1": OTHER_ROOM})
        with tenant_scope(TENANT_ZERO_ID):
            _, caller = await resolve_caller(
                agent_id=AGENT,
                protocol=b.protocol,
                factory=session_factory,
                connection_id=CONN,
                session_id="session-1",
                host_id="host",
                epoch="1",
            )

        assert caller is not None
        assert caller.room_id == OTHER_ROOM

    async def test_a_claim_made_on_the_other_process_wakes_the_parked_stream(
        self, processes: tuple[Process, Process]
    ) -> None:
        """The session's stream is parked until its first room is claimed;
        the claim arriving at the other process must still reach it."""
        a, b = processes
        conn = await _open(a)
        with tenant_scope(TENANT_ZERO_ID):
            stream = event_frames(
                conn=conn, registry=a.registry, buffer=a.buffer, approvals=None
            )
            first = await anext(stream)
            assert first is not KEEPALIVE
            assert first.event == "connection_state"
            pending = asyncio.ensure_future(anext(stream))
            await asyncio.sleep(0.2)
            assert not pending.done(), "the stream should be parked with no room"

            answer = await _subscribe(b, ROOM, conn.stream_generation)
            frame = await asyncio.wait_for(pending, WAIT_SECONDS)
            await stream.aclose()

        assert answer["rooms"] == [ROOM]
        assert frame is not KEEPALIVE
        assert frame.event == "subscription_changed"
        assert frame.data["rooms"] == [ROOM]
        assert conn.rooms == {ROOM}

    async def test_a_claim_on_the_other_process_releases_the_room_here(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """One connection of an agent acts in a room: a second connection
        taking it through another process takes it off the first, which is
        told with `room_released`."""
        a, b = processes
        first = await _open(a)
        await _subscribe(a, ROOM, first.stream_generation)
        second = await _open(b, connection_id="conn-2")

        await connection_subscribe(
            AGENT,
            ConnectionSubscribeRequest(
                connection_id="conn-2",
                room_id=ROOM,
                generation=second.stream_generation,
                takeover=True,
            ),
            agent=_Agent(),  # type: ignore[arg-type]
            protocol=b.protocol,
        )

        await _eventually(lambda: ROOM not in first.rooms)
        await _eventually(lambda: ROOM in first.released_rooms)
        async with session_factory() as session:
            claimant = await session.scalar(
                select(AgentConnectionRoom.connection_id).where(
                    AgentConnectionRoom.agent_id == AGENT,
                    AgentConnectionRoom.room_id == ROOM,
                )
            )
        assert claimant == "conn-2"

    async def test_an_old_clients_beat_on_the_other_process_reaches_the_holder(
        self, processes: tuple[Process, Process]
    ) -> None:
        a, b = processes
        conn = await _open(a)
        conn.last_beat = time.monotonic() - 4
        stale = conn.last_beat

        with tenant_scope(TENANT_ZERO_ID):
            answer = await connection_beat(
                AGENT,
                ConnectionBeatRequest(
                    connection_id=CONN, generation=conn.stream_generation
                ),
                agent=_Agent(),  # type: ignore[arg-type]
                protocol=b.protocol,
            )

        assert answer["ok"] is True
        await _eventually(lambda: conn.last_beat > stale)
        assert conn.beats == 1

    async def test_a_session_command_relayed_on_the_other_process_reaches_the_watcher(
        self, processes: tuple[Process, Process]
    ) -> None:
        a, b = processes
        watcher = await _open(a, scope="all")
        await _eventually(lambda: b.registry.is_live(AGENT))
        frame = {"command": "interrupt", "origin": {"roomId": ROOM}}

        assert b.registry.relay_session_command(AGENT, frame)

        await _eventually(lambda: watcher.session_commands == [frame])


class TestTakeover:
    async def test_a_takeover_through_the_other_process_fences_the_loser(
        self, processes: tuple[Process, Process]
    ) -> None:
        a, b = processes
        loser = await _open(a)
        held = loser.stream_generation

        winner = await _open(b, expected_generation=held)

        assert winner.stream_generation != held
        await _eventually(lambda: loser.closure is not None)
        assert loser.closure is not None
        assert loser.closure.code == "taken_over"
        # The loser's late beat on the process it was on is refused as taken
        # over, on the recorded row rather than on that process's memory.
        with tenant_scope(TENANT_ZERO_ID), pytest.raises(HTTPException) as refused:
            await connection_beat(
                AGENT,
                ConnectionBeatRequest(connection_id=CONN, generation=held),
                agent=_Agent(),  # type: ignore[arg-type]
                protocol=a.protocol,
            )
        assert refused.value.status_code == 409
        assert refused.value.detail["code"] == "taken_over"
        # And its reattach naming what it held is refused without moving
        # anything, wherever it lands.
        with pytest.raises(SupersededReattachError):
            await _open(a, expected_generation=held)
        assert b.registry.get(CONN) is winner
        assert winner.closure is None

    async def test_a_room_request_from_the_loser_is_refused_on_either_process(
        self, processes: tuple[Process, Process]
    ) -> None:
        a, b = processes
        loser = await _open(a)
        held = loser.stream_generation
        await _open(b, expected_generation=held)

        for process in (a, b):
            with pytest.raises(HTTPException) as refused:
                await _subscribe(process, ROOM, held)
            assert refused.value.status_code == 409
            assert refused.value.detail["code"] == "taken_over"

    async def test_incarnations_from_two_processes_never_collide(
        self, processes: tuple[Process, Process]
    ) -> None:
        a, b = processes
        first = await _open(a, connection_id="conn-a")
        second = await _open(b, connection_id="conn-b")

        assert first.stream_generation != second.stream_generation
        assert min(first.stream_generation, second.stream_generation) >= 2**33

    async def test_a_reattach_elsewhere_draws_a_later_incarnation(
        self, processes: tuple[Process, Process]
    ) -> None:
        """Each process draws incarnations in batches, so one drawn from an
        earlier batch is not later than the one recorded. A reattach must
        still move the connection's incarnation forward: a process that sees
        a later one presented knows its own copy is the stale one."""
        a, b = processes
        await _open(b, connection_id="conn-b")  # b draws its batch first
        held = (await _open(a)).stream_generation

        winner = await _open(b, expected_generation=held)

        assert winner.stream_generation > held

    async def test_the_previous_holder_admits_the_current_incarnation(
        self, processes: tuple[Process, Process]
    ) -> None:
        """The client reattached through the other process and its next
        requests reach the process it left, before that one has read the
        reattach: they are served, not refused as taken over."""
        a, b = processes
        first = await _open(a)
        a.registry.detach_stream(first, first.stream_generation)
        await a.bus.stop()  # `a` hears nothing from `b`
        second = await _open(b, expected_generation=first.stream_generation)

        answer = await connection_placements(
            AGENT,
            ConnectionPlacementsRequest(
                connection_id=CONN,
                placements={"session-1": ROOM},
                generation=second.stream_generation,
            ),
            agent=_Agent(),  # type: ignore[arg-type]
            protocol=a.protocol,
        )
        with tenant_scope(TENANT_ZERO_ID):
            beat = await connection_beat(
                AGENT,
                ConnectionBeatRequest(
                    connection_id=CONN, generation=second.stream_generation
                ),
                agent=_Agent(),  # type: ignore[arg-type]
                protocol=a.protocol,
            )

        assert answer["placements"] == {"session-1": ROOM}
        assert beat["ok"] is True
        assert first.closure is not None
        assert first.closure.code == "taken_over"
        assert second.closure is None
        # The client it took the connection from is still refused.
        with pytest.raises(HTTPException) as refused:
            await _subscribe(a, ROOM, first.stream_generation)
        assert refused.value.detail["code"] == "taken_over"

    async def test_another_agent_cannot_take_a_connection_id_on_the_other_process(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """The other process has no copy of the connection yet, so only the
        row can refuse the second agent; it keeps the first agent's."""
        a, b = processes
        await b.bus.stop()  # `b` never hears of the first agent's connection
        held = await _open(a)
        intruder = "agent-2"
        await seed_agent(session_factory, intruder)

        with tenant_scope(TENANT_ZERO_ID), pytest.raises(UnknownConnectionError):
            async with b.registry.slots(intruder), b.registry.recorded(intruder):
                b.registry.open(
                    agent_id=intruder,
                    connection_id=CONN,
                    scope="single",
                    delivery_filter="addressed",
                    spawn_capable=False,
                    position={OWN_EVENTS: 0},
                    declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
                    expected_generation=None,
                )

        async with session_factory() as session:
            row = await session.get(AgentConnectionRecord, CONN)
        assert row is not None
        assert (row.agent_id, row.process_id, row.incarnation) == (
            AGENT,
            a.lease.process_id,
            held.stream_generation,
        )
        assert b.registry.get(CONN) is None


class TestOneProcess:
    async def test_an_open_and_a_close_are_recorded_once_each(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        a, _ = processes
        conn = await _open(a)

        async with session_factory() as session:
            row = await session.get(AgentConnectionRecord, CONN)
        assert row is not None
        assert row.process_id == a.lease.process_id
        assert row.incarnation == conn.stream_generation
        assert row.closed_at is None

        a.registry.close(
            conn.id, Closure(code="closed", message="closed by the test", room_id=None)
        )
        await a.shared.flush()

        async with session_factory() as session:
            row = await session.get(AgentConnectionRecord, CONN)
        assert row is not None
        assert row.closed_at is not None
        assert row.close_reason == "closed"

    async def test_a_beat_writes_nothing(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        a, _ = processes
        conn = await _open(a)
        async with session_factory() as session:
            before = await session.get(AgentConnectionRecord, CONN)
        assert before is not None

        for _ in range(3):
            a.registry.beat(AGENT, CONN, conn.stream_generation)

        async with session_factory() as session:
            after = await session.get(
                AgentConnectionRecord, CONN, populate_existing=True
            )
        assert after is not None
        assert after.attached_at == before.attached_at

    async def test_reopening_before_the_close_is_written_starts_without_rooms(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """A connection that lapsed and opens again on the same id is a fresh
        open, as it was in memory alone, even while its closing is still
        queued and its row still names the room it had."""
        a, _ = processes
        assert a.run is not None
        a.run.cancel()
        await asyncio.gather(a.run, return_exceptions=True)
        conn = await _open(a)
        await _subscribe(a, ROOM, conn.stream_generation)
        conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
        a.registry.sweep()

        reopened = await _open(a)
        with tenant_scope(TENANT_ZERO_ID):
            await a.registry.refresh(AGENT)

        assert reopened is not conn
        assert reopened.rooms == set()
        async with session_factory() as session:
            claimant = await session.scalar(
                select(AgentConnectionRoom.connection_id).where(
                    AgentConnectionRoom.agent_id == AGENT
                )
            )
        assert claimant is None

    async def test_a_reopen_after_a_restart_is_a_fresh_open(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """A process that stopped takes its connections with it: a client
        reattaching naming the old incarnation opens afresh, as it did when
        connections were in memory alone."""
        a, b = processes
        old = await _open(a)
        await _subscribe(a, ROOM, old.stream_generation)
        await a.lease.stop()
        await b.shared.reload_all()

        reopened = await _open(b, expected_generation=old.stream_generation)

        assert reopened.stream_generation != old.stream_generation
        assert reopened.rooms == set()


async def _closing_written(session_factory: SessionFactory, connection_id: str) -> None:
    """Wait for the connection's closing to reach its row."""
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        async with session_factory() as session:
            closed_at = await session.scalar(
                select(AgentConnectionRecord.closed_at).where(
                    AgentConnectionRecord.id == connection_id
                )
            )
        if closed_at is not None:
            return
        if time.monotonic() > deadline:
            raise AssertionError("the closing was never written")
        await asyncio.sleep(0.02)


class TestSignalsStayUnderThePayloadLimit:
    """Postgres refuses a `NOTIFY` payload of 8000 bytes or more, and a
    signal carries ids the client chose."""

    async def test_a_beat_too_large_to_forward_is_dropped_and_the_rest_go_on(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """A connection recorded with an id too long for one signal, by a
        process that does not bound ids, has its forwarded beat refused by
        the bus. That beat is dropped; the next is still forwarded, and the
        process still writes its closings."""
        a, b = processes
        oversized = await _open(a, connection_id="c" * 8000)
        conn = await _open(a)
        own = await _open(b, connection_id="conn-b")
        await _eventually(
            lambda: (
                b.registry.get(oversized.id) is not None
                and b.registry.get(CONN) is not None
            )
        )

        b.registry.beat(AGENT, oversized.id, oversized.stream_generation)
        b.registry.beat(AGENT, CONN, conn.stream_generation)

        await _eventually(lambda: conn.beats == 1)
        assert oversized.beats == 0
        b.registry.close(
            own.id, Closure(code="closed", message="closed by the test", room_id=None)
        )
        await _closing_written(session_factory, own.id)

    async def test_a_move_releasing_many_rooms_tells_their_holder_of_each(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """A session id is bounded in characters, and JSON writes some
        characters in twelve bytes: the rooms one move releases are split over
        as many signals as they take."""
        a, b = processes
        rooms = [ROOM, OTHER_ROOM] + [
            await seed_room(session_factory, f"room-{n}") for n in range(3, 13)
        ]
        holder = await _open(a, scope="all")
        await _place(
            a,
            holder.stream_generation,
            {
                "\U0001f600" * 63 + chr(ord("a") + n): room
                for n, room in enumerate(rooms)
            },
        )
        taker = await _open(b, connection_id="conn-2", scope="all")

        await connection_placements(
            AGENT,
            ConnectionPlacementsRequest(
                connection_id="conn-2",
                placements={f"session-{n}": room for n, room in enumerate(rooms)},
                generation=taker.stream_generation,
            ),
            agent=_Agent(),  # type: ignore[arg-type]
            protocol=b.protocol,
        )

        await _eventually(lambda: set(holder.released_rooms) == set(rooms))


async def _occupant(session_factory: SessionFactory, room_id: str) -> tuple[str, bool]:
    """Who the room's unread count belongs to: a session, or a connection."""
    async with session_factory() as session:
        row = (
            await session.execute(
                select(
                    AgentRoomRead.occupant_id, AgentRoomRead.occupant_is_session
                ).where(
                    AgentRoomRead.agent_id == AGENT, AgentRoomRead.room_id == room_id
                )
            )
        ).one()
    return row[0], row[1]


async def _unrecordable(*args: Any, **kwargs: Any) -> None:
    raise RuntimeError("the database went away")


class TestUnreadCountsFollowOnlyRecordedMoves:
    """A room's unread count belongs to whoever is in the room, and moves
    with it only once the move is recorded: a move that fails, and so is set
    back, leaves the count with the reader still there. The failure reaches
    the caller, which FastAPI answers with a 500."""

    async def test_a_placement_that_cannot_be_recorded_moves_no_count(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        a, _ = processes
        conn = await _open(a, scope="all")
        await _place(a, conn.stream_generation, {"session-1": ROOM})
        assert await _occupant(session_factory, ROOM) == ("session-1", True)
        monkeypatch.setattr(AgentConnectionStore, "replace_slots", _unrecordable)

        with pytest.raises(RuntimeError):
            await _place(a, conn.stream_generation, {"session-2": ROOM})

        assert a.registry.placements(AGENT) == {"session-1": ROOM}
        async with session_factory() as session:
            placed = (
                await session.execute(
                    select(
                        AgentSessionPlacement.session_id, AgentSessionPlacement.room_id
                    ).where(AgentSessionPlacement.agent_id == AGENT)
                )
            ).all()
        assert [tuple(row) for row in placed] == [("session-1", ROOM)]
        assert await _occupant(session_factory, ROOM) == ("session-1", True)

    async def test_a_claim_that_cannot_be_recorded_moves_no_count(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        a, _ = processes
        first = await _open(a)
        await _subscribe(a, ROOM, first.stream_generation)
        second = await _open(a, connection_id="conn-2")
        assert await _occupant(session_factory, ROOM) == (CONN, False)
        monkeypatch.setattr(AgentConnectionStore, "replace_slots", _unrecordable)

        with pytest.raises(RuntimeError):
            await connection_subscribe(
                AGENT,
                ConnectionSubscribeRequest(
                    connection_id="conn-2",
                    room_id=ROOM,
                    generation=second.stream_generation,
                    takeover=True,
                ),
                agent=_Agent(),  # type: ignore[arg-type]
                protocol=a.protocol,
            )

        assert first.rooms == {ROOM}
        assert second.rooms == set()
        assert await _occupant(session_factory, ROOM) == (CONN, False)


class TestStartingUp:
    async def test_a_tenant_that_cannot_be_read_fails_the_start_not_a_reread(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
        postgres_url: str,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """A process that served before reading every tenant would answer for
        the agents connected elsewhere in the one it missed as offline. Once
        serving, a tenant that cannot be read again is logged and the others
        are still read."""
        a, _ = processes
        await _open(a)
        async with session_factory() as session:
            session.add(Tenant(id="unreadable", slug="unreadable", name="Unreadable"))
            await session.commit()
        read_tenant = AgentConnectionStore.read_tenant

        async def failing(
            store: AgentConnectionStore,
            session: AsyncSession,
            tenant_id: str,
            **kwargs: Any,
        ) -> Any:
            if tenant_id == "unreadable":
                raise RuntimeError("the tenant's rows could not be read")
            return await read_tenant(store, session, tenant_id, **kwargs)

        monkeypatch.setattr(AgentConnectionStore, "read_tenant", failing)
        process_id = new_process_id("test-pod")
        registry = AgentConnectionRegistry()
        starting = SharedConnections(
            registry=registry,
            session_factory=session_factory,
            store=AgentConnectionStore(),
            bus=SignalBus(
                session_factory,
                lambda: create_async_engine(postgres_url, poolclass=NullPool),
                process_id=process_id,
            ),
            lease=ProcessLease(
                process_id=process_id,
                session_factory=session_factory,
                processes=SwitchCoreProcessStore(),
                key_ids=[key.id for key in TEST_KEYRING.keys],
            ),
        )

        with pytest.raises(RuntimeError):
            await starting.start()
        await starting.reload_all()

        assert registry.is_live(AGENT)
        assert "unreadable" in caplog.text


async def _delete_agent_row(session_factory: SessionFactory) -> None:
    """Delete the agent's row, which takes its connections' rows with it."""
    async with session_factory() as session:
        await session.execute(delete(Agent).where(Agent.id == AGENT))
        await session.commit()


class TestADeletedAgent:
    """Deleting an agent deletes its connections' rows. Its connections end
    wherever their sockets are held, not only in the process deleting it."""

    async def test_deleted_through_the_other_process_its_connection_closes(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """As `AgentCore.delete_agent` deletes it through the process that
        does not hold its socket: the row goes, then the others are told."""
        a, b = processes
        conn = await _open(a)
        await _eventually(lambda: b.registry.is_live(AGENT))

        await _delete_agent_row(session_factory)
        with tenant_scope(TENANT_ZERO_ID):
            await b.registry.agent_deleted(AGENT)

        await _eventually(lambda: conn.closure is not None)
        assert conn.closure is not None
        assert conn.closure.code == "closed"
        assert not a.registry.is_live(AGENT)
        assert not b.registry.is_live(AGENT)

    async def test_a_holder_never_told_closes_it_on_its_next_pass(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
    ) -> None:
        """Deleted by a process that told no one, or whose signal never
        arrived: the holder finds the rows gone when it next reads them all."""
        a, _ = processes
        conn = await _open(a)

        await _delete_agent_row(session_factory)
        await a.shared.reload_all()

        assert conn.closure is not None
        assert conn.closure.code == "closed"
        assert not a.registry.is_live(AGENT)

    async def test_a_pass_that_read_before_an_open_was_recorded_leaves_it_open(
        self,
        processes: tuple[Process, Process],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The pass read the tenant's rows just before the connection's row
        was written: finding no row for it then says nothing about its agent."""
        a, b = processes
        for process in (a, b):
            await process.bus.stop()  # no pass reads the rows but this one
        read_tenant = AgentConnectionStore.read_tenant
        opened: list[AgentConnection] = []

        async def opened_meanwhile(
            store: AgentConnectionStore,
            session: AsyncSession,
            tenant_id: str,
            **kwargs: Any,
        ) -> Any:
            found = await read_tenant(store, session, tenant_id, **kwargs)
            opened.append(await _open(a))
            return found

        monkeypatch.setattr(AgentConnectionStore, "read_tenant", opened_meanwhile)

        await a.shared.reload_all()

        (conn,) = opened
        assert conn.closure is None
        assert a.registry.get(CONN) is conn


class TestIncarnationsDrawnAtOnce:
    async def test_two_agents_opening_while_a_batch_is_drawn_both_get_one(
        self,
        processes: tuple[Process, Process],
        session_factory: SessionFactory,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Two agents connecting at once on a fresh process: the second
        reaches the draw while the first's batch is still being fetched. Both
        open, each on a number of its own."""
        a, _ = processes
        await seed_agent(session_factory, "agent-2")
        draw = AgentConnectionStore.incarnations
        read_agent = AgentConnectionStore.read_agent
        drawing = asyncio.Event()
        release = asyncio.Event()
        second_read = asyncio.Event()

        async def held_draw(
            store: AgentConnectionStore, session: AsyncSession, count: int
        ) -> list[int]:
            drawing.set()
            await release.wait()
            return await draw(store, session, count)

        async def noting_read(
            store: AgentConnectionStore,
            session: AsyncSession,
            agent_id: str,
            **kwargs: Any,
        ) -> Any:
            rows = await read_agent(store, session, agent_id, **kwargs)
            if agent_id == "agent-2":
                second_read.set()
            return rows

        monkeypatch.setattr(AgentConnectionStore, "incarnations", held_draw)
        monkeypatch.setattr(AgentConnectionStore, "read_agent", noting_read)

        first = asyncio.create_task(_open(a))
        await asyncio.wait_for(drawing.wait(), WAIT_SECONDS)
        second = asyncio.create_task(
            _open(a, agent_id="agent-2", connection_id="conn-2")
        )
        await asyncio.wait_for(second_read.wait(), WAIT_SECONDS)
        release.set()
        opened = await asyncio.wait_for(asyncio.gather(first, second), WAIT_SECONDS)

        generations = [conn.stream_generation for conn in opened]
        assert len(set(generations)) == 2

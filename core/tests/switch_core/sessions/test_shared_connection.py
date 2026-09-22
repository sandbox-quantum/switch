"""Several sessions of one agent behind a single inbound connection.

An agent gets one connection and runs many sessions over it, so the connection
stops being able to identify a caller: its rooms are the union of its sessions'
rooms, and a room-scoped question answered from it matches all of them at once.
What answers instead is the session's own binding, behind the host-and-epoch
fence — and where a session cannot be told apart, the ambiguity is raised
rather than guessed at.

That connection is agent-wide, since it is not opened for a room and holds
whatever rooms its sessions have taken. Except where a test says otherwise
these run against one, so they exercise the topology the hosts are moving to
rather than a room-scoped connection standing in for it.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_TTL_SECONDS,
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.statuses import compute_agent_statuses
from switch_core.bridges.agent.protocol.types import AgentStatus
from switch_core.db.models import ClientRoom, Room, SdkSession, require_tenant_id
from switch_core.sessions.contract import HostEvent, Session
from switch_core.sessions.service import (
    SessionAuthority,
    SessionError,
    agents_present_in,
    rooms_occupied,
)

from .test_authority import EXAMPLES, setup

AGENT = "agent-demo"
OWNER = "@owner:example.test"
FIRST = ("session-demo", "host-demo")
SECOND = ("session-other", "host-other")
ROOM = "room-demo"
OTHER_ROOM = "room-other"


async def _second_room(session_factory) -> None:
    """A second room the agent is also a member of."""
    async with session_factory() as db, db.begin():
        db.add(
            Room(
                id=OTHER_ROOM,
                matrix_room_id="!other:example.test",
                name="Other room",
                description="test",
                bridge_id="bridge",
                external_channel_id="channel-other",
            )
        )
        await db.flush()
        db.add_all(
            [
                ClientRoom(client_id=client, room_id=OTHER_ROOM)
                for client in ("agent-client", "actor-client")
            ]
        )


async def _second_session(service: SessionAuthority) -> str:
    """Acquire a second session of the same agent, and return its epoch."""
    session = Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": SECOND[0], "host_id": SECOND[1]}
    )
    return (await service.acquire(AGENT, session)).session.epoch


def _controller(connections: ConnectionRegistry, rooms: list[str]) -> Connection:
    """The agent's one inbound connection, carrying every room it is in.

    Agent-wide, which is the shape a connection shared by several sessions has
    to take: it is not in one room, and every room it holds arrived from a
    different session. Binding a session to it is what a room-scoped connection
    check used to refuse.
    """
    connection = connections.open(
        agent_id=AGENT,
        connection_id="connection-demo",
        scope="all",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    for room in rooms:
        connections.claim_room(connection, room)
    return connection


def _room_connection(connections: ConnectionRegistry, room: str) -> Connection:
    """A connection opened for one room, as a host predating the controller has."""
    connection = connections.open(
        agent_id=AGENT,
        connection_id="connection-demo",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    connections.claim_room(connection, room)
    return connection


async def _ready(
    service: SessionAuthority, session_id: str, host_id: str, epoch: str
) -> None:
    """Put a session in a state that accepts a reset command."""
    snapshot = await service.snapshot(session_id, "owner")
    ready = snapshot.session.model_copy(
        update={
            "status": "ready",
            "capabilities": snapshot.session.capabilities.model_copy(
                update={"reset": True, "compact": True}
            ),
        }
    )
    await service.ingest(
        AGENT,
        host_id,
        HostEvent(
            contract_version=1,
            event_id=f"host-ready-{session_id}",
            session_id=session_id,
            epoch=epoch,
            host_sequence=1,
            occurred_at="2026-09-09T12:00:00Z",
            body={"type": "session.upsert", "session": ready.model_dump(by_alias=True)},
        ),
    )


async def _stop_host(session_factory, session_id: str) -> None:
    """Let a session's host lease lapse, as a crashed host's does.

    Not a retirement: a host that dies leaves the row exactly as it was, still
    naming the controller connection — which its siblings keep alive.
    """
    async with session_factory() as db, db.begin():
        row = await db.scalar(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.id == session_id,
            )
        )
        row.lease_expires_at = datetime.now(UTC) - timedelta(minutes=1)


async def _quiesce_host(session_factory, session_id: str) -> None:
    """Stand a session's host down without letting its lease lapse.

    `quiesce` writes both together, so the two facts normally agree. They are
    still two facts, and a host that has said it stopped has stopped whatever
    its lease says — the alternative is a session that keeps its room for the
    rest of a lease it will never renew.
    """
    async with session_factory() as db, db.begin():
        row = await db.scalar(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.id == session_id,
            )
        )
        row.recovery = {**row.recovery, "quiesced": True}


@pytest.mark.asyncio
async def test_two_sessions_bind_the_same_connection(session_factory) -> None:
    """The refusal this removes, and what each caller gets back.

    Binding used to raise rather than let a second session name a connection
    another already held. The rooms returned are the caller's own, so neither
    session is told it is in the other's room.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM, OTHER_ROOM])

    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await service.bind_room(AGENT, *SECOND, second, OTHER_ROOM)

    assert await service.bind_connection(
        AGENT, *FIRST, first, connection.id, connections
    ) == [ROOM]
    assert await service.bind_connection(
        AGENT, *SECOND, second, connection.id, connections
    ) == [OTHER_ROOM]


@pytest.mark.asyncio
async def test_room_control_reaches_the_session_bound_to_that_room(
    session_factory,
) -> None:
    """The routing the shared connection would otherwise make impossible.

    Both sessions are reachable over the one connection and the connection
    holds both rooms, so the connection alone matches both for either room.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM, OTHER_ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await service.bind_room(AGENT, *SECOND, second, OTHER_ROOM)
    await _ready(service, *FIRST, first)
    await _ready(service, *SECOND, second)

    receipt = await service.submit_room_control(
        AGENT, OTHER_ROOM, "reset", OWNER, "reset-message", None, connections
    )

    assert receipt.status == "accepted"
    assert await service.pending(AGENT, *FIRST, first) == []
    assert len(await service.pending(AGENT, *SECOND, second)) == 1


@pytest.mark.asyncio
async def test_two_sessions_claiming_one_room_is_raised_not_guessed(
    session_factory,
) -> None:
    """Sessions that named no room are indistinguishable behind one connection.

    A caller that identifies itself only by its connection never reaches
    `bind_room`, so over a connection opened for one room the two of them share
    it. There is no fact left to choose between them, and picking one would
    silently send a reset to the wrong session.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    connections = ConnectionRegistry()
    connection = _room_connection(connections, ROOM)
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await _ready(service, *FIRST, first)
    await _ready(service, *SECOND, second)

    with pytest.raises(SessionError) as caught:
        await service.submit_room_control(
            AGENT, ROOM, "reset", OWNER, "reset-message", None, connections
        )

    assert caught.value.code == "FENCING_REQUIRED"


@pytest.mark.asyncio
async def test_a_session_that_named_no_room_attends_none_of_the_controllers(
    session_factory,
) -> None:
    """The same two sessions behind the agent-wide connection, in no room at all.

    The room-scoped connection above at least said which room its callers might
    be in. This one covers every room the agent belongs to, so reading a
    session's room off it would put both of them in all of them — and the
    ambiguity above would follow the agent into rooms neither session has ever
    been near. A session that has not said where it is, is nowhere.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await _ready(service, *FIRST, first)
    await _ready(service, *SECOND, second)

    with pytest.raises(SessionError) as caught:
        await service.submit_room_control(
            AGENT, ROOM, "reset", OWNER, "reset-message", None, connections
        )

    assert caught.value.code == "HOST_OFFLINE"


@pytest.mark.asyncio
async def test_an_evicted_session_attends_neither_its_old_room_nor_any_other(
    session_factory,
) -> None:
    """Losing a room leaves a session in no room, not in every room.

    The eviction empties its bound rooms while its host goes on running over
    the shared connection — and that connection covers the whole agent. The
    command for the room it lost belongs to the session that took it, and the
    command for a room it was never in belongs to nobody.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM, OTHER_ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await service.bind_room(AGENT, *SECOND, second, ROOM)
    await _ready(service, *FIRST, first)
    await _ready(service, *SECOND, second)

    receipt = await service.submit_room_control(
        AGENT, ROOM, "reset", OWNER, "reset-message", None, connections
    )

    assert receipt.status == "accepted"
    assert await service.pending(AGENT, *FIRST, first) == []
    assert len(await service.pending(AGENT, *SECOND, second)) == 1

    with pytest.raises(SessionError) as caught:
        await service.submit_room_control(
            AGENT, OTHER_ROOM, "reset", OWNER, "other-message", None, connections
        )

    assert caught.value.code == "HOST_OFFLINE"


@pytest.mark.asyncio
async def test_a_session_is_unreachable_once_its_controller_stops_beating(
    session_factory,
) -> None:
    """A live session with nothing left to deliver to it is not attending.

    Its binding and its lease both still say it is working in the room, and
    under a shared connection the one that lapsed was carrying every session
    the agent has. Queuing the reset here would report a command accepted for a
    session that will not hear of it until its host reconnects.
    """
    service, first = await setup(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await _ready(service, *FIRST, first)
    connection.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1

    with pytest.raises(SessionError) as caught:
        await service.submit_room_control(
            AGENT, ROOM, "reset", OWNER, "reset-message", None, connections
        )

    assert caught.value.code == "HOST_OFFLINE"
    assert await service.pending(AGENT, *FIRST, first) == []


@pytest.mark.asyncio
async def test_a_stopped_session_stops_claiming_its_room(session_factory) -> None:
    """A dead session used to be dead by association with its connection.

    Its `connection_id` outlives it, and under a controller connection so does
    the connection: the siblings still running keep it up. Its binding outlives
    it too — a host that stopped is left the room it was in rather than being
    announced out of it — so the session's own lease is what says whether
    anyone is there to receive the command.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await _stop_host(session_factory, FIRST[0])
    await service.bind_room(AGENT, *SECOND, second, ROOM)
    await _ready(service, *SECOND, second)
    assert (await service.snapshot(FIRST[0], "owner")).session.room_ids == [ROOM]

    receipt = await service.submit_room_control(
        AGENT, ROOM, "reset", OWNER, "reset-message", None, connections
    )

    assert receipt.status == "accepted"
    assert len(await service.pending(AGENT, *SECOND, second)) == 1


@pytest.mark.asyncio
async def test_a_quiesced_session_stops_claiming_its_room(session_factory) -> None:
    """A host that stood down has stood down, whatever its lease still says.

    The lease runs for its full term after the last renewal, so a session that
    has said it stopped would otherwise go on claiming the room for the rest of
    a term nobody is renewing — and its sibling's command would be refused as
    ambiguous the whole time.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await _quiesce_host(session_factory, FIRST[0])
    await service.bind_room(AGENT, *SECOND, second, ROOM)
    await _ready(service, *SECOND, second)
    assert (await service.snapshot(FIRST[0], "owner")).session.room_ids == [ROOM]

    receipt = await service.submit_room_control(
        AGENT, ROOM, "reset", OWNER, "reset-message", None, connections
    )

    assert receipt.status == "accepted"
    assert len(await service.pending(AGENT, *SECOND, second)) == 1


@pytest.mark.asyncio
async def test_presence_reads_the_rooms_its_sessions_are_in(session_factory) -> None:
    """What the room reports as present, once the connection cannot say.

    Presence asked the connection which rooms an agent had a session in. The
    shared one answers with the union of its sessions' rooms for every session
    at once, and with every room the agent belongs to for a session that has
    taken none — so the rooms come from the sessions themselves.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)

    async with session_factory() as db:
        assert await agents_present_in(db, [AGENT], ROOM, connections) == {AGENT}
        assert await agents_present_in(db, [AGENT], OTHER_ROOM, connections) == set()
        assert await rooms_occupied(db, AGENT, connections) == {ROOM}


@pytest.mark.asyncio
async def test_presence_drops_a_session_whose_host_stopped(session_factory) -> None:
    """The agent goes absent from the room even though its connection is up.

    The connection is the agent's, not the session's, and it is kept alive by
    whatever else the agent is running. Left to answer this, it would report a
    session in the room for as long as the agent had any connection at all.
    """
    service, first = await setup(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await _stop_host(session_factory, FIRST[0])

    async with session_factory() as db:
        assert await agents_present_in(db, [AGENT], ROOM, connections) == set()
        assert await rooms_occupied(db, AGENT, connections) == set()
    assert connections.get(connection.id) is not None


class _NoHeartbeats:
    """An agent_sessions store with nothing in it.

    The rows are the arm the pre-connection clients maintain, and a managed
    session maintains none of them — so leaving them empty is what a room
    holding only managed sessions actually looks like.
    """

    async def get_live_agent_ids(
        self, _db: AsyncSession, agent_ids: list[str], _room_id: str | None
    ) -> set[str]:
        return set()


async def _status_in_room(
    db: AsyncSession, connections: ConnectionRegistry, connection_model: str
) -> AgentStatus:
    """What the room reports about the agent — the reader everything else reads."""
    statuses = await compute_agent_statuses(
        db,
        [
            SimpleNamespace(
                id=AGENT,
                integration_profile={"connection_model": connection_model},
            )
        ],
        ROOM,
        _NoHeartbeats(),
        connections,
    )
    return statuses[AGENT]


@pytest.mark.asyncio
async def test_the_room_stops_reporting_a_session_whose_host_stopped(
    session_factory,
) -> None:
    """The same absence, asked the way a room asks it.

    Presence is composed from several arms, and the claim arm is there for the
    clients that leave nothing else behind. A managed session leaves a claim
    too — on a connection that outlives it — so reading that claim as presence
    in its own right would put the session's liveness to a vote it always wins,
    and the room would go on offering a session that has gone.
    """
    service, first = await setup(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)

    async with session_factory() as db:
        assert (
            await _status_in_room(db, connections, "session_addressable")
            == AgentStatus.LIVE
        )

    await _stop_host(session_factory, FIRST[0])

    async with session_factory() as db:
        assert (
            await _status_in_room(db, connections, "session_addressable")
            == AgentStatus.NO_SESSION
        )
    assert connections.claimant_of(AGENT, ROOM) is connection


@pytest.mark.asyncio
async def test_the_room_still_reports_a_client_that_only_ever_claimed(
    session_factory,
) -> None:
    """A claim no session accounts for is the only presence some clients leave.

    Standalone and MCP clients never write a session row, so discounting the
    claim arm wholesale would report them absent from a room they are sitting
    in.
    """
    await setup(session_factory)
    connections = ConnectionRegistry()
    _controller(connections, [ROOM])

    async with session_factory() as db:
        assert (
            await _status_in_room(db, connections, "session_addressable")
            == AgentStatus.LIVE
        )
        assert await rooms_occupied(db, AGENT, connections) == {ROOM}


@pytest.mark.asyncio
async def test_a_connected_agent_that_will_start_nothing_reports_no_session(
    session_factory,
) -> None:
    """Reachable, with nothing here and nothing coming — not away.

    An agent whose controller is up with automatic starts off is answerable:
    address it and something will say there is no session. Reporting it
    disconnected says the opposite, and the room believes the status until the
    reply contradicts it.
    """
    await setup(session_factory)
    connections = ConnectionRegistry()
    _controller(connections, [])

    async with session_factory() as db:
        assert (
            await _status_in_room(db, connections, "auto_session")
            == AgentStatus.NO_SESSION
        )
        # And with nothing connected at all, the agent really is away.
        assert (
            await _status_in_room(db, ConnectionRegistry(), "auto_session")
            == AgentStatus.DISCONNECTED
        )


@pytest.mark.asyncio
async def test_binding_a_room_displaces_the_sibling_already_in_it(
    session_factory,
) -> None:
    """Room exclusivity survives the connection no longer enforcing it.

    The registry evicts by connection, so two sessions arriving over the same
    one look to it like the room being re-claimed by its existing holder. The
    displaced session is named so the caller can say whose work it interrupted.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)

    assert (await service.bind_room(AGENT, *SECOND, second, ROOM)).displaced == FIRST[0]

    assert (await service.snapshot(FIRST[0], "owner")).session.room_ids == []
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [ROOM]


@pytest.mark.asyncio
async def test_a_bind_reports_the_room_the_caller_actually_left(
    session_factory,
) -> None:
    """The room to stop routing, read where it is still true.

    Its caller cannot supply it: what it believed on the way in may be a room a
    sibling has taken since, and releasing that from the shared connection
    would cut the sibling off. A first bind and a rebind each leave nothing
    behind, so neither releases a room somebody is in.
    """
    service, first = await setup(session_factory)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM, OTHER_ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)

    assert (await service.bind_room(AGENT, *FIRST, first, ROOM)).vacated == ()
    assert (await service.bind_room(AGENT, *FIRST, first, ROOM)).vacated == ()
    assert (await service.bind_room(AGENT, *FIRST, first, OTHER_ROOM)).vacated == (
        ROOM,
    )


@pytest.mark.asyncio
async def test_a_displaced_session_leaves_nothing_for_its_next_bind_to_vacate(
    session_factory,
) -> None:
    """What the interleaving looks like from the displaced session's side.

    Its room was taken while it was mid-request, so its own next bind finds it
    holding nothing — and reports nothing to release, which is what keeps the
    shared connection subscribed for the sibling that took it.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM, OTHER_ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    await service.bind_room(AGENT, *SECOND, second, ROOM)

    assert (await service.bind_room(AGENT, *FIRST, first, OTHER_ROOM)).vacated == ()


@pytest.mark.asyncio
async def test_a_stopped_sibling_is_not_reported_as_displaced(session_factory) -> None:
    """Nothing was interrupted, so nothing is announced.

    Every session an agent has ever run in a room still lists it. Evicting
    those would append a `session.upsert` to each of their logs and tell the
    caller it took the room off a host that stopped days ago.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    connections = ConnectionRegistry()
    connection = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, connection.id, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, connection.id, connections)
    through = (await service.snapshot(FIRST[0], "owner")).through_sequence
    await _stop_host(session_factory, FIRST[0])

    assert (await service.bind_room(AGENT, *SECOND, second, ROOM)).displaced is None

    stale = await service.snapshot(FIRST[0], "owner")
    assert stale.session.room_ids == [ROOM]
    assert stale.through_sequence == through

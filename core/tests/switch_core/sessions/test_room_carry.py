"""Carrying a room across from a build that never claimed it on the server.

A session started by the build this topology replaces served its room over a
connection of its own. Nothing was written against the session, so when it is
restarted by a build whose controller holds the agent's only connection it
comes up holding nothing and the room's next message is answered by a stranger.

What decides the carry is the server's own routing rather than anything the
caller says it was doing: the session row names a connection, that connection
is in the live registry, and the rooms it is subscribed to are the ones being
delivered to that session right now. So the evidence lasts exactly as long as
the old worker does, which is why this runs before anything replaces it — and
why a session whose connection cannot be seen is reported rather than given
rooms on the strength of an empty claim.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from switch_core.bridges.agent.api.handlers import (
    _open_event_stream,
    connection_subscribe,
    connection_unsubscribe,
)
from switch_core.bridges.agent.api.schemas import ConnectionSubscribeRequest
from switch_core.bridges.agent.api.session_routes import (
    ConnectionCarryRequest,
    carry_connection_rooms,
)
from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_TTL_SECONDS,
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import SdkSessionEvent, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.sessions.service import (
    CarriedSession,
    ConnectionCarry,
    RoomAdmission,
    SessionAuthority,
    SessionError,
    require_recorded_rooms_unmoved,
)

from .test_authority import setup
from .test_shared_connection import (
    AGENT,
    OTHER_ROOM,
    ROOM,
    SECOND,
    _finish_session,
    _second_room,
    _second_session,
)

FIRST_SESSION, FIRST_HOST = "session-demo", "host-demo"
CONTROLLER = "connection-controller"


class _Doors:
    """What the room-control handlers reach on the server, with the real rule.

    Membership and the declaration are stubbed because neither decides anything
    here; the slot rule is the real one, read against this test's own database.
    """

    def __init__(self, session_factory, connections: ConnectionRegistry) -> None:
        self.connections = connections
        self.event_buffer = EventBuffer()
        self._sessions = session_factory

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        return None

    async def record_client_declaration(
        self, agent_id: str, connection_id: str, declaration: ClientDeclaration
    ) -> None:
        return None

    async def require_recorded_rooms_unmoved(
        self,
        agent_id: str,
        connection: Connection,
        claiming: frozenset[str],
        dropping: frozenset[str],
    ) -> None:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            await require_recorded_rooms_unmoved(
                db, agent_id, connection, claiming, dropping
            )


async def _subscribe(doors: _Doors, connection: Connection, room_id: str) -> None:
    await connection_subscribe(
        AGENT,
        ConnectionSubscribeRequest(
            connection_id=connection.id,
            room_id=room_id,
            takeover=True,
            generation=connection.stream_generation,
        ),
        agent=SimpleNamespace(id=AGENT),  # type: ignore[arg-type]
        protocol=doors,  # type: ignore[arg-type]
    )


async def _second_worker(
    service: SessionAuthority, connections: ConnectionRegistry
) -> Connection:
    """A second session of the older build, serving itself over its own connection."""
    epoch = await _second_session(service)
    connection = _serving(connections, SECOND[0], [])
    await service.bind_connection(
        AGENT, SECOND[0], SECOND[1], epoch, connection.id, connections
    )
    return connection


async def _next_admission(service: SessionAuthority, message_id: str) -> RoomAdmission:
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _room_event(ROOM, message_id))
    return await service.admit_room(AGENT, ROOM, message_id, sequence, True, buffer)


def _serving(
    connections: ConnectionRegistry, session_id: str, rooms: list[str]
) -> Connection:
    """The connection a session of the older build opened for itself.

    Room-scoped, opened by the worker rather than by a controller, and
    subscribed to what that worker is serving. Being subscribed is the server's
    own decision — it is where the events for those rooms are being sent.
    """
    connection = connections.open(
        agent_id=AGENT,
        connection_id=f"connection-{session_id}",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    for room in rooms:
        connections.claim_room(connection, room)
    return connection


async def _legacy(
    session_factory, rooms: list[str]
) -> tuple[SessionAuthority, ConnectionRegistry]:
    """An agent whose one session serves its rooms over a connection of its own.

    `setup` acquires without a grant, which is the shape the old build left
    behind: a session row with an empty room set, because the room it was
    serving was only ever on its connection.
    """
    service, epoch = await setup(session_factory)
    connections = ConnectionRegistry()
    _serving(connections, FIRST_SESSION, rooms)
    bound = await service.bind_connection(
        AGENT,
        FIRST_SESSION,
        FIRST_HOST,
        epoch,
        f"connection-{FIRST_SESSION}",
        connections,
    )
    assert bound == []
    return service, connections


async def _notices(session_factory, session_id: str) -> list[tuple[str, str]]:
    """The notices written into a session's own log, in order."""
    async with session_factory() as db:
        events = list(
            await db.scalars(
                select(SdkSessionEvent.event)
                .where(
                    SdkSessionEvent.tenant_id == require_tenant_id(),
                    SdkSessionEvent.session_id == session_id,
                )
                .order_by(SdkSessionEvent.sequence)
            )
        )
    return [
        (event["body"]["code"], event["body"]["message"])
        for event in events
        if event["body"]["type"] == "notice"
    ]


def _room_event(room: str, message_id: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room,
        bridge_id="bridge",
        payload=MessagePayload(
            addressed=True,
            sender="@owner:example.test",
            sender_name="Owner",
            message_id=message_id,
            body=f"Please look at {message_id}",
            timestamp=1,
        ),
    )


async def test_a_session_keeps_the_room_its_connection_is_serving(session_factory):
    service, connections = await _legacy(session_factory, [ROOM])

    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert carry == ConnectionCarry(
        sessions=(CarriedSession(FIRST_SESSION, (ROOM,), ()),), unverifiable=()
    )
    # The same session, now holding the room: the identity the room was talking
    # to is the one that answers it next, which is the whole point.
    snapshot = await service.snapshot(FIRST_SESSION, "owner")
    assert snapshot.session.session_id == FIRST_SESSION
    assert snapshot.session.room_ids == [ROOM]
    codes = [code for code, _ in await _notices(session_factory, FIRST_SESSION)]
    assert codes == ["ROOMS_CARRIED"]


async def test_a_room_one_session_moved_on_from_goes_to_the_one_serving_it_now(
    session_factory,
):
    """Two sessions whose local history both name the same room.

    The room moved between them before the upgrade, so a room set read off
    either disk would have both claiming it and nothing to choose between them.
    What separates them is where the server is sending the room's events, which
    is one connection and not the other.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    await _second_room(session_factory)
    second_epoch = await _second_session(service)
    _serving(connections, SECOND[0], [])
    await service.bind_connection(
        AGENT,
        SECOND[0],
        SECOND[1],
        second_epoch,
        f"connection-{SECOND[0]}",
        connections,
    )
    moved = connections.get(f"connection-{FIRST_SESSION}")
    connections.release_room(moved, ROOM)
    connections.claim_room(moved, OTHER_ROOM)
    connections.claim_room(connections.get(f"connection-{SECOND[0]}"), ROOM)

    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert {session.session_id: session.adopted for session in carry.sessions} == {
        FIRST_SESSION: (OTHER_ROOM,),
        SECOND[0]: (ROOM,),
    }
    assert [session.refused for session in carry.sessions] == [(), ()]


async def test_a_session_whose_connection_cannot_be_seen_is_reported(session_factory):
    """Neither carried nor written off: the answer says it is not known.

    This server holds the live connections it can decide from. One it cannot
    see — because the worker stopped beating, or because the connection belongs
    to another server of the same deployment — is not evidence that the session
    was serving nothing, and inventing an empty answer for it is how a room is
    lost with nobody saying so.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    connections.get(f"connection-{FIRST_SESSION}").last_beat = (
        time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
    )

    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert carry == ConnectionCarry(sessions=(), unverifiable=(FIRST_SESSION,))
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []
    # Said in the session's own transcript as well as in the answer: an upgrade
    # that could not establish what a session was doing reads exactly like one
    # that found nothing to do.
    code, message = (await _notices(session_factory, FIRST_SESSION))[0]
    assert code == "ROOMS_UNDECIDED"
    assert "could not be established" in message


async def test_a_session_that_cannot_be_decided_is_told_once_an_episode(
    session_factory,
):
    """The disclosure is the first answer, not every attempt at it.

    A carry that cannot decide a session leaves it exactly as it was, so the
    same question is asked again on the next attempt and on every start after
    it. Repeating the answer each time would bury the transcript it is written
    into; saying it again once something else has been said is a new episode.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    connection = connections.get(f"connection-{FIRST_SESSION}")
    beating = connection.last_beat
    connection.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1

    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert [code for code, _ in await _notices(session_factory, FIRST_SESSION)] == [
        "ROOMS_UNDECIDED"
    ]

    connection.last_beat = beating
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    connection.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert [code for code, _ in await _notices(session_factory, FIRST_SESSION)] == [
        "ROOMS_UNDECIDED",
        "ROOMS_NOT_CARRIED",
        "ROOMS_UNDECIDED",
    ]


async def test_a_session_already_on_the_controllers_connection_is_left_alone(
    session_factory,
):
    """This build's own sessions have nothing to carry and are not asked about.

    A session of this build records its rooms as it claims them, so an empty
    set is an empty set. The controller's connection holds whatever its
    sessions have taken and is in no room on its own behalf, so it could not
    say which session a room belonged to even if it were asked.
    """
    service, epoch = await setup(session_factory)
    connections = ConnectionRegistry()
    controller = connections.open(
        agent_id=AGENT,
        connection_id=CONTROLLER,
        scope="all",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    connections.claim_room(controller, ROOM)
    await service.bind_connection(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, CONTROLLER, connections
    )

    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert carry == ConnectionCarry(sessions=(), unverifiable=())
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []


async def test_a_room_another_session_holds_is_refused_and_said_so(session_factory):
    """A transfer that happened while the upgrade was in flight keeps its winner."""
    service, connections = await _legacy(session_factory, [ROOM])
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)

    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert carry.sessions[0].adopted == ()
    assert [(room.room_id, room.reason) for room in carry.sessions[0].refused] == [
        (ROOM, "ROOM_HELD")
    ]
    # Kept by the session that holds it rather than evicted to make room.
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [ROOM]
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []
    # Named in the session's own transcript, because the conversation it was in
    # the middle of continues somewhere the reader of this one cannot see.
    code, message = (await _notices(session_factory, FIRST_SESSION))[0]
    assert code == "ROOMS_NOT_CARRIED"
    assert ROOM in message and "ROOM_HELD" in message


async def test_a_room_the_agent_has_left_is_refused(session_factory):
    service, connections = await _legacy(session_factory, ["room-elsewhere"])

    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert [(room.room_id, room.reason) for room in carry.sessions[0].refused] == [
        ("room-elsewhere", "NOT_A_MEMBER")
    ]


async def test_a_session_evicted_from_a_room_cannot_take_it_back(session_factory):
    """Its own history says it held the room and lost it, so `[]` is not legacy.

    The distinction an empty room set cannot make on its own: a session that
    never claimed a room and one a sibling took it from look identical in the
    session's current state and are opposites in what should happen next.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    second_epoch = await _second_session(service)
    binding = await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    assert binding.displaced == FIRST_SESSION
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []
    await _finish_session(service, SECOND[0], SECOND[1], second_epoch)

    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert carry.sessions[0].adopted == ()
    assert [(room.room_id, room.reason) for room in carry.sessions[0].refused] == [
        (ROOM, "PRIOR_CLAIM_RECORDED")
    ]


async def test_a_message_admitted_before_the_carry_takes_the_room(session_factory):
    """The limit of the carry, and why it runs before the controller's stream.

    A delivery admitted for a room nothing claims is answered with the right to
    start a session for it. That right is outstanding against the room, so the
    carry cannot also give the room to the session that was serving it —
    redeeming the grant afterwards would leave the room with two owners. The
    room is lost to a new session, and the loss is stated rather than absorbed.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _room_event(ROOM, "during"))

    admission = await service.admit_room(AGENT, ROOM, "during", sequence, True, buffer)
    carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert admission.status == "none"
    assert [(room.room_id, room.reason) for room in carry.sessions[0].refused] == [
        (ROOM, "GRANT_OUTSTANDING")
    ]
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []


async def test_the_next_message_is_answered_by_the_session_that_was_serving_it(
    session_factory,
):
    """What the carry buys, at the point the old worker is already gone.

    Admission reads the session rows and nothing else, so before the carry the
    room belongs to nobody and its next message starts a session that knows
    none of the conversation. Afterwards it is the same session's, and stays so
    once the connection that was the only evidence has closed.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    connections.get(f"connection-{FIRST_SESSION}").last_beat = (
        time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
    )
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _room_event(ROOM, "after"))

    admission = await service.admit_room(AGENT, ROOM, "after", sequence, True, buffer)

    assert (admission.status, admission.session_id) == ("owner", FIRST_SESSION)


async def test_a_retry_after_a_lost_response_changes_nothing(session_factory):
    """The idempotency a controller that never saw the answer needs.

    The second call finds the room already recorded against the session, which
    is the answer it was waiting for, and writes neither a claim nor a second
    notice for a carry that has already happened.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    before = await service.snapshot(FIRST_SESSION, "owner")

    retry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)

    assert retry == ConnectionCarry(sessions=(), unverifiable=())
    after = await service.snapshot(FIRST_SESSION, "owner")
    assert after.through_sequence == before.through_sequence
    assert after.session.room_ids == [ROOM]


async def test_a_room_cannot_change_hands_while_the_carry_is_being_written(
    session_factory,
):
    """The window a re-read cannot close: the commit's own wait.

    The decision is taken from the registry and recorded in the database, and
    between the last look and the record landing there is a suspension no
    further look happens after. A claim moving in it would be a room this
    server had stopped delivering to the session, recorded against it anyway.
    So whoever moves a room slot waits for the carry to be written — and, having
    waited, finds the room recorded to the session it was carried to and is
    refused rather than moving it afterwards.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    elsewhere = await _second_worker(service, connections)
    doors = _Doors(session_factory, connections)
    deciding = asyncio.Event()
    order: list[str] = []
    ever_held = service._ever_held

    async def suspended(db, session_id: str, room_id: str) -> bool:
        deciding.set()
        await asyncio.sleep(0.05)
        return await ever_held(db, session_id, room_id)

    async def repoint() -> None:
        await deciding.wait()
        with pytest.raises(SessionError) as refused:
            await _subscribe(doors, elsewhere, ROOM)
        order.append("repointed")
        assert refused.value.code == "ROOM_MIGRATED"

    service._ever_held = suspended  # type: ignore[method-assign]
    moving = asyncio.create_task(repoint())
    try:
        carry = await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
        order.append("carried")
        await moving
    finally:
        service._ever_held = ever_held  # type: ignore[method-assign]

    # Not CLAIM_MOVED: the move could not happen inside the decision at all.
    assert carry.sessions[0].adopted == (ROOM,)
    assert order == ["carried", "repointed"]
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == [ROOM]
    # The two answers to who the room belongs to still agree, which is what the
    # ordering is for: the slot is where the record says, and the next delivery
    # goes to the session the room was carried to.
    assert connections.claimant_of(AGENT, ROOM) is connections.get(
        f"connection-{FIRST_SESSION}"
    )
    admission = await _next_admission(service, "after-the-carry")
    assert (admission.status, admission.session_id) == ("owner", FIRST_SESSION)


async def test_a_connection_that_moves_while_the_carry_is_decided_commits_nothing(
    session_factory,
):
    """The evidence has to still say what it said when the carry is written.

    A connection can be reattached, repointed or closed at any moment, and the
    decision was taken against one reading of it. Committing against a reading
    that has since moved would record a room this server had already stopped
    delivering there, so the whole carry is refused and the caller asks again
    against what is true now.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    reads = 0
    read = connections.get

    def reattached(connection_id: str) -> Connection | None:
        nonlocal reads
        reads += 1
        connection = read(connection_id)
        if connection is not None and reads > 1:
            connection.stream_generation += 1
        return connection

    connections.get = reattached  # type: ignore[method-assign]

    try:
        await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
        raise AssertionError("the carry was committed against a connection that moved")
    except SessionError as error:
        assert error.code == "CLAIM_MOVED"
    connections.get = read  # type: ignore[method-assign]

    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []
    assert await _notices(session_factory, FIRST_SESSION) == []


async def test_the_answer_the_controller_reads_names_the_session_and_its_rooms(
    session_factory,
):
    """The carry has to leave the server, and the route is where its shape is set.

    The decision is committed before the reply is built, so a reply that cannot
    be built is a carry that happened and an account of it the caller never
    gets: the controller sees a failure, asks again, and is told there was
    nothing to carry.
    """
    _, connections = await _legacy(session_factory, [ROOM, "room-elsewhere"])

    answer = await carry_connection_rooms(
        ConnectionCarryRequest(connection_id=CONTROLLER),
        SimpleNamespace(id=AGENT),  # type: ignore[arg-type]
        session_factory,
        SimpleNamespace(connections=connections),  # type: ignore[arg-type]
    )

    assert answer.model_dump(by_alias=True) == {
        "sessions": [
            {
                "sessionId": FIRST_SESSION,
                "adopted": [ROOM],
                "refused": [{"roomId": "room-elsewhere", "reason": "NOT_A_MEMBER"}],
            }
        ],
        "unverifiable": [],
    }


async def test_the_session_a_room_was_carried_to_keeps_it_against_a_sibling(
    session_factory,
):
    """A worker of the old build cannot take a room the record has given away.

    Its stream is still up and its claims are still answered, so nothing stops
    it asking. But the room is now recorded to the session that was serving it,
    and admission reads the record: letting the slot move would route the next
    message to a session the events no longer reach, and answer the mover as
    though the transfer had happened.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    sibling = await _second_worker(service, connections)
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    doors = _Doors(session_factory, connections)

    with pytest.raises(SessionError) as refused:
        await _subscribe(doors, sibling, ROOM)

    assert refused.value.code == "ROOM_MIGRATED"
    assert FIRST_SESSION in str(refused.value)
    assert sibling.rooms == set()
    admission = await _next_admission(service, "to-the-holder")
    assert (admission.status, admission.session_id) == ("owner", FIRST_SESSION)


async def test_the_session_a_room_was_carried_to_cannot_move_off_it(session_factory):
    """The same refusal on the connection that holds the room.

    A `single`-scope connection replaces its room rather than adding to it, so
    a worker subscribing somewhere else drops the one it was carried. That drop
    is the same disagreement seen from the other side: the record would go on
    naming a session with nothing delivering to it.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    await _second_room(session_factory)
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    serving = connections.get(f"connection-{FIRST_SESSION}")
    doors = _Doors(session_factory, connections)

    with pytest.raises(SessionError) as refused:
        await _subscribe(doors, serving, OTHER_ROOM)

    assert refused.value.code == "ROOM_MIGRATED"
    assert serving.rooms == {ROOM}


async def test_a_carried_room_cannot_be_unsubscribed_either(session_factory):
    """Releasing is a move too: the room would be recorded to nobody's reach."""
    service, connections = await _legacy(session_factory, [ROOM])
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    serving = connections.get(f"connection-{FIRST_SESSION}")
    doors = _Doors(session_factory, connections)

    with pytest.raises(SessionError) as refused:
        await connection_unsubscribe(
            AGENT,
            ConnectionSubscribeRequest(
                connection_id=serving.id,
                room_id=ROOM,
                generation=serving.stream_generation,
            ),
            agent=SimpleNamespace(id=AGENT),  # type: ignore[arg-type]
            protocol=doors,  # type: ignore[arg-type]
        )

    assert refused.value.code == "ROOM_MIGRATED"
    assert serving.rooms == {ROOM}


async def test_a_stream_reopened_on_the_room_is_refused_and_says_which_refusal(
    session_factory,
):
    """The third door, and the one a worker reaches without asking for a room.

    Rooms named on the stream URL are taken over, not requested, so a sibling
    reconnecting with the room still on its URL would walk through the other
    two refusals. It is told which refusal this is, rather than being answered
    as though it had been thrown out of the room's membership.
    """
    service, connections = await _legacy(session_factory, [ROOM])
    sibling = await _second_worker(service, connections)
    await service.carry_connection_rooms(AGENT, CONTROLLER, connections)
    doors = _Doors(session_factory, connections)

    with pytest.raises(HTTPException) as refused:
        await _open_event_stream(
            agent=SimpleNamespace(id=AGENT),  # type: ignore[arg-type]
            protocol=doors,  # type: ignore[arg-type]
            connection_id=sibling.id,
            scope="single",
            event_filter="all",
            start_from="head",
            spawn_capable=False,
            declaration=ClientDeclaration(),
            rooms=ROOM,
            last_event_id=None,
            expected_generation=None,
        )

    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "ROOM_MIGRATED"
    assert connections.claimant_of(AGENT, ROOM) is connections.get(
        f"connection-{FIRST_SESSION}"
    )
    admission = await _next_admission(service, "after-the-reopen")
    assert (admission.status, admission.session_id) == ("owner", FIRST_SESSION)


async def test_host_restores_legacy_room_after_server_restart(session_factory):
    service, _ = await _legacy(session_factory, [ROOM])
    restarted = ConnectionRegistry()
    snapshot = await service.snapshot(FIRST_SESSION, "owner")
    epoch = snapshot.session.epoch
    await service.quiesce(AGENT, FIRST_SESSION, FIRST_HOST, epoch)
    recovered = await service.recover(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, "recover-after-restart", 0
    )
    epoch = recovered.session.epoch
    assert (
        await service.carry_connection_rooms(AGENT, CONTROLLER, restarted)
    ).unverifiable == (FIRST_SESSION,)

    assert await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, restarted
    )
    assert await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, restarted
    )
    assert (
        await service.carry_connection_rooms(AGENT, CONTROLLER, restarted)
    ).unverifiable == ()
    admission = await _next_admission(service, "after-restart")
    assert admission.session_id == FIRST_SESSION


async def test_legacy_restore_does_not_take_a_siblings_room(session_factory):
    service, _ = await _legacy(session_factory, [ROOM])
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, ConnectionRegistry()
    )
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [ROOM]


async def test_legacy_restore_does_not_undo_an_eviction(session_factory):
    service, _ = await _legacy(session_factory, [ROOM])
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    await service.bind_room(AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM)
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    await _finish_session(service, SECOND[0], SECOND[1], second_epoch)
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, ConnectionRegistry()
    )


async def test_legacy_restore_respects_pending_start(session_factory):
    service, _ = await _legacy(session_factory, [ROOM])
    await _next_admission(service, "pending-start")
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, ConnectionRegistry()
    )


async def test_legacy_restore_requires_current_host(session_factory):
    service, _ = await _legacy(session_factory, [ROOM])
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    with pytest.raises(SessionError):
        await service.restore_legacy_room(
            AGENT, FIRST_SESSION, "other-host", epoch, ROOM, ConnectionRegistry()
        )
    with pytest.raises(SessionError):
        await service.restore_legacy_room(
            AGENT, FIRST_SESSION, FIRST_HOST, "old-epoch", ROOM, ConnectionRegistry()
        )


async def test_legacy_restore_respects_live_legacy_claim(session_factory):
    service, connections = await _legacy(session_factory, [])
    _serving(connections, "other-session", [ROOM])
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, connections
    )


async def test_legacy_restore_checks_membership(session_factory):
    service, _ = await _legacy(session_factory, [ROOM])
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, "not-a-room", ConnectionRegistry()
    )


async def test_legacy_restore_route_uses_the_host_fence(session_factory):
    from switch_core.bridges.agent.api.session_routes import (
        RestoreLegacyRoom,
        restore_legacy_room,
    )

    service, _ = await _legacy(session_factory, [ROOM])
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    response = await restore_legacy_room(
        FIRST_SESSION,
        RestoreLegacyRoom(host_id=FIRST_HOST, epoch=epoch, room_id=ROOM),
        agent=SimpleNamespace(id=AGENT),
        factory=session_factory,
        protocol=SimpleNamespace(connections=ConnectionRegistry()),
    )
    assert response == {"restored": True}
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == [ROOM]


async def test_legacy_restore_does_not_override_a_live_room_move(session_factory):
    service, connections = await _legacy(session_factory, [])
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, connections
    )


async def test_legacy_restore_after_binding_to_a_shared_controller(session_factory):
    service, connections = await _legacy(session_factory, [])
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    connections.open(
        agent_id=AGENT,
        connection_id=CONTROLLER,
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    await service.bind_connection(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, CONTROLLER, connections
    )
    assert await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, connections
    )


async def test_refused_saved_room_does_not_block_the_agents_controller(session_factory):
    service, _ = await _legacy(session_factory, [ROOM])
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    epoch = (await service.snapshot(FIRST_SESSION, "owner")).session.epoch
    restarted = ConnectionRegistry()
    assert (
        await service.carry_connection_rooms(AGENT, CONTROLLER, restarted)
    ).unverifiable == (FIRST_SESSION,)
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, restarted
    )
    assert (
        await service.carry_connection_rooms(AGENT, CONTROLLER, restarted)
    ).unverifiable == ()
    assert (await _notices(session_factory, FIRST_SESSION))[-1][
        0
    ] == "ROOM_RESTORE_REFUSED"
    assert (
        await _next_admission(service, "after-refused-restore")
    ).session_id == SECOND[0]
    # A retry and a second server restart cannot erase the refusal or steal it.
    assert not await service.restore_legacy_room(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ROOM, ConnectionRegistry()
    )
    assert (
        await service.carry_connection_rooms(AGENT, CONTROLLER, ConnectionRegistry())
    ).unverifiable == ()
    assert len(await _notices(session_factory, FIRST_SESSION)) == 2

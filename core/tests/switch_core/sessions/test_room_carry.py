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

import time

from sqlalchemy import select

from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_TTL_SECONDS,
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import SdkSessionEvent, require_tenant_id
from switch_core.sessions.service import (
    CarriedSession,
    ConnectionCarry,
    SessionAuthority,
    SessionError,
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
    assert await _notices(session_factory, FIRST_SESSION) == []


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

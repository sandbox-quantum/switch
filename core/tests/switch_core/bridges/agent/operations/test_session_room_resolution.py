"""Which room an operation acts on, once a connection can carry several.

Every implicit-room operation — `post_message`, `assume_role`, `read_context`
and twenty others — funnels through `bound_rooms`, so this is the only place
the rule is written and the only place it needs proving. A caller that named
its session is answered from that session; everything else keeps resolving
from its connection exactly as before.

The distinction has no visible effect while each connection carries one
session, which is why it is worth pinning now: the moment two sessions share
one, resolving from the connection would hand each of them both rooms and turn
every room-scoped call into "several rooms, pick one".
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.operations import definitions
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    CallerSession,
    call_context,
)
from switch_core.bridges.agent.operations.context import (
    bound_rooms,
    init_operations_protocol,
    require_connected_room,
)
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer, Reader
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

AGENT = "agent-1"
CONNECTION = "connection-1"
ROOM_A = "room-a"
ROOM_B = "room-b"
HOST = "host-1"
EPOCH = "epoch-1"


def _caller(session_id: str, room_id: str | None) -> CallContext:
    return CallContext(
        agent_id=AGENT,
        session_key=CONNECTION,
        session=CallerSession(
            id=session_id, host_id=HOST, epoch=EPOCH, room_id=room_id
        ),
    )


class _AbsentSessionStore:
    """The table a pre-connection caller falls back to, holding nothing.

    Reaching it at all is the failure this file guards against: a caller with a
    session has already been answered, and one with a live connection covering
    a room is answered by the connection.
    """

    async def get_connected_room(self, *_a: Any, **_kw: Any) -> None:
        raise AssertionError("resolution fell through to the agent_sessions table")


@pytest.fixture
def registry():
    @asynccontextmanager
    async def session_factory():
        yield SimpleNamespace()

    registry = ConnectionRegistry()
    init_operations_protocol(
        SimpleNamespace(
            connections=registry,
            agent_session_store=_AbsentSessionStore(),
            session_factory=session_factory,
        )
    )
    yield registry
    init_operations_protocol(None)  # type: ignore[arg-type]


def _open(registry: ConnectionRegistry) -> Any:
    return registry.open(
        agent_id=AGENT,
        connection_id=CONNECTION,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )


@pytest.mark.asyncio
async def test_two_sessions_on_one_connection_resolve_different_rooms(
    registry,
) -> None:
    """The whole reason the binding moved off the connection.

    One connection, two sessions, two rooms — and each call resolves the room
    of the session that made it. Read from the connection, both would see both
    rooms and neither could act.
    """
    connection = _open(registry)
    registry.claim_room(connection, ROOM_A)
    registry.claim_room(connection, ROOM_B)
    assert connection.rooms == {ROOM_A, ROOM_B}

    with call_context(_caller("session-a", ROOM_A)):
        assert await require_connected_room() == ROOM_A
    with call_context(_caller("session-b", ROOM_B)):
        assert await require_connected_room() == ROOM_B


@pytest.mark.asyncio
async def test_a_sessions_room_wins_over_what_its_connection_covers(registry) -> None:
    """Not a fallback — the session is the answer, and is asked first.

    A connection that has drifted from the session's binding (a takeover, a
    reattach that claimed nothing yet) must not quietly redirect the caller's
    next `post_message` into the wrong room.
    """
    connection = _open(registry)
    registry.claim_room(connection, ROOM_B)

    with call_context(_caller("session-a", ROOM_A)):
        assert await bound_rooms() == {ROOM_A}


@pytest.mark.asyncio
async def test_a_session_bound_to_no_room_is_connected_to_nothing(registry) -> None:
    """Said plainly, rather than borrowed from the connection."""
    connection = _open(registry)
    registry.claim_room(connection, ROOM_A)

    with call_context(_caller("session-a", None)):
        assert await bound_rooms() == set()
        with pytest.raises(ValueError, match="Not connected to a room"):
            await require_connected_room()


@pytest.mark.asyncio
async def test_a_caller_with_no_session_still_reads_its_connection(registry) -> None:
    """Unchanged for every caller that has not moved to the session selector."""
    connection = _open(registry)
    registry.claim_room(connection, ROOM_A)

    with call_context(
        CallContext(agent_id=AGENT, session_key=CONNECTION, session=None)
    ):
        assert await require_connected_room() == ROOM_A


# ── moving a session between rooms ───────────────────────────────────────────


def _chatter(room_id: str, index: int) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        payload=MessagePayload(
            addressed=False,
            sender="@u:s",
            sender_name="u",
            message_id=f"$m-{index}",
            body="chatter",
            timestamp=0,
        ),
    )


@pytest.mark.asyncio
async def test_connecting_vacates_only_the_callers_own_room(
    registry, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Moving one session must not unsubscribe its siblings.

    `claim_room` no longer clears the connection, so something has to drop the
    room the caller left — and it has to drop that one only. Dropping the
    connection's whole set would silently take every other session on it out of
    its room.
    """
    connection = _open(registry)
    registry.claim_room(connection, ROOM_A)
    registry.claim_room(connection, ROOM_B)

    registry.place_session(AGENT, "session-a", ROOM_A, CONNECTION)
    registry.place_session(AGENT, "session-b", ROOM_B, CONNECTION)
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol_for(registry, "room-c"))

    with call_context(_caller("session-a", ROOM_A)):
        await definitions.connect_to_room("room-c", include_general_instructions=False)

    assert registry.session_room(AGENT, "session-a") == "room-c"
    # ROOM_A vacated because this caller was in it; ROOM_B untouched because
    # its session did not move.
    assert connection.rooms == {ROOM_B, "room-c"}


@pytest.mark.asyncio
async def test_a_room_a_sibling_has_taken_is_not_vacated(
    registry, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The caller's room is what the bind found, not what the caller arrived with.

    `CallerSession.room_id` is read when the request enters. A sibling taking
    the same room in that window keeps the connection's claim on it, so acting
    on the stale value would release a room this caller no longer holds —
    silently cutting the sibling off from the events it was just given.
    """
    connection = _open(registry)
    registry.claim_room(connection, ROOM_A)
    # The sibling took ROOM_A after this caller's request came in.
    registry.place_session(AGENT, "session-b", ROOM_A, CONNECTION)
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol_for(registry, "room-c"))

    with call_context(_caller("session-a", ROOM_A)):
        await definitions.connect_to_room("room-c", include_general_instructions=False)

    assert connection.rooms == {ROOM_A, "room-c"}


@pytest.mark.asyncio
async def test_displacing_a_sibling_names_it_in_the_warning(
    registry, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The eviction the connection registry can no longer see.

    Both sessions are on the one connection, so claiming the room looks to the
    registry like its existing holder re-claiming it and nothing is evicted.
    Saying nothing would leave the displaced session's operator watching it go
    quiet with no explanation.
    """
    connection = _open(registry)
    registry.claim_room(connection, "room-c")
    registry.place_session(AGENT, "session-b", "room-c", CONNECTION)
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol_for(registry, "room-c"))

    with call_context(_caller("session-a", None)):
        result = await definitions.connect_to_room(
            "room-c", include_general_instructions=False
        )

    assert "session session-b" in result["warning"]


@pytest.mark.asyncio
async def test_connecting_takes_the_rooms_unread_count(
    registry, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Whose reading clears a room follows who is in it.

    Both sessions are on the one connection, so nothing underneath can tell
    them apart. Unless connecting records who took the room, a read begun by
    the session that left would clear a count the arrival has not read.
    """
    _open(registry)
    registry.place_session(AGENT, "session-b", "room-c", CONNECTION)
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    protocol = _protocol_for(registry, "room-c")
    init_operations_protocol(protocol)
    buffer = protocol.event_buffer
    buffer.hand_counting_to(AGENT, Reader(id="session-b", is_session=True), "room-c")
    for index in range(2):
        buffer.enqueue(AGENT, "room-c", _chatter("room-c", index))

    with call_context(_caller("session-a", None)):
        await definitions.connect_to_room("room-c", include_general_instructions=False)

    buffer.caught_up(
        AGENT,
        Reader(id="session-b", is_session=True),
        "room-c",
        buffer.head(AGENT),
        CONNECTION,
    )

    assert buffer.unread(AGENT, "room-c", buffer.head(AGENT)).count == 2


@pytest.mark.asyncio
async def test_displacing_nobody_warns_about_nothing(
    registry, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An ordinary connect is not dressed up as a takeover."""
    _open(registry)
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol_for(registry, "room-c"))

    with call_context(_caller("session-a", None)):
        result = await definitions.connect_to_room(
            "room-c", include_general_instructions=False
        )

    assert result["warning"] is None


@pytest.mark.asyncio
async def test_one_eviction_is_reported_once_and_names_the_session(
    registry, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both doors fire on the same takeover, and the session is the better name.

    Displacing a sibling that is on its own connection evicts that connection
    too, so the registry and the session authority each report the eviction they
    saw. They are one event, and `session-b` tells the caller what it
    interrupted where a connection id only tells it which socket carried it.
    """
    incumbent = registry.open(
        agent_id=AGENT,
        connection_id="connection-old",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    registry.claim_room(incumbent, "room-c")
    _open(registry)
    registry.place_session(AGENT, "session-b", "room-c", "connection-old")
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol_for(registry, "room-c"))

    with call_context(_caller("session-a", None)):
        result = await definitions.connect_to_room(
            "room-c", include_general_instructions=False
        )

    assert "session session-b" in result["warning"]
    assert "connection-old" not in result["warning"]


@pytest.mark.asyncio
async def test_evicting_another_connection_still_names_the_connection(
    registry, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The older eviction, for a holder that is not identified as a session.

    A client that predates the selector has no session to name, so the
    connection its events were travelling over is the only thing the warning
    can point the reader at.
    """
    incumbent = registry.open(
        agent_id=AGENT,
        connection_id="connection-old",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    registry.claim_room(incumbent, "room-c")
    _open(registry)
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol_for(registry, "room-c"))

    with call_context(_caller("session-a", None)):
        result = await definitions.connect_to_room(
            "room-c", include_general_instructions=False
        )

    assert "connection connection-old" in result["warning"]


def _protocol_for(registry: ConnectionRegistry, room_id: str) -> Any:
    room = SimpleNamespace(id=room_id, name="Room C", description="A room")
    profile = {
        "connection_model": "session_addressable",
        "message_exchange": True,
        "pre_invocation_mediation": [],
        "post_invocation_mediation": [],
        "event_reporting": [],
        "task_protocol": {"can_delegate": False, "can_accept": False},
    }

    @asynccontextmanager
    async def session_factory():
        yield SimpleNamespace(commit=_nothing, get=_nothing)

    async def _nothing(*_a: Any, **_kw: Any) -> None:
        return None

    def _returning(value: Any):
        async def _get(*_a: Any, **_kw: Any) -> Any:
            return value

        return _get

    return SimpleNamespace(
        connections=registry,
        event_buffer=EventBuffer(sequence_base=0),
        agent_session_store=_AbsentSessionStore(),
        session_factory=session_factory,
        agent_store=SimpleNamespace(
            get=_returning(
                SimpleNamespace(id=AGENT, name="agent-1", integration_profile=profile)
            )
        ),
        room_store=SimpleNamespace(
            get=_returning(SimpleNamespace(id=room_id, name="Room C", bridge_id=None))
        ),
        require_room_member=_returning(room),
        list_participants=_returning([]),
        list_room_resources=_returning(
            {
                "reference_types": {},
                "references": [],
                "documents": [],
                "packages": [],
                "linked_rooms": [],
            }
        ),
        list_room_roles=_returning([]),
    )

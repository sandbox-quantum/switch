"""`POST /agents/{agent_id}/connection/placements`: the watcher states its placements."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import connection_placements
from switch_core.bridges.agent.api.schemas import ConnectionPlacementsRequest
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnection,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import TENANT_ZERO_ID

AGENT_ID = "agent-1"
OTHER_AGENT_ID = "agent-2"
ROOM_A = "room-a"
ROOM_B = "room-b"
FOREIGN_ROOM = "room-foreign"


class _Protocol:
    def __init__(self, event_buffer: EventBuffer) -> None:
        self.connections = AgentConnectionRegistry()
        self.event_buffer = event_buffer
        # Shares `check_shares` refuses, (session, room) -> why; empty lets
        # every share through.
        self.share_refusals: dict[tuple[str, str], str] = {}

    async def check_shares(
        self, agent_id: str, placements: dict[str, str], shares: dict[str, list[str]]
    ) -> dict[tuple[str, str], str]:
        return {
            key: reason
            for key, reason in self.share_refusals.items()
            if key[1] in shares.get(key[0], [])
        }

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        if room_id == FOREIGN_ROOM:
            raise PermissionError(f"agent {agent_id} is not a member of {room_id}")


class _Agent:
    def __init__(self, agent_id: str) -> None:
        self.id = agent_id
        self.tenant_id = TENANT_ZERO_ID
        self.metadata_: dict[str, str] | None = None


def _open(
    protocol: _Protocol, connection_id: str, agent_id: str = AGENT_ID
) -> AgentConnection:
    return protocol.connections.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope="all",
        delivery_filter="all",
        spawn_capable=True,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )


async def _place(
    protocol: _Protocol,
    conn: AgentConnection,
    placements: dict[str, str],
    *,
    shares: dict[str, list[str]] | None = None,
    path_agent: str = AGENT_ID,
    caller: str = AGENT_ID,
    generation: int | None = None,
) -> dict[str, Any]:
    return await connection_placements(
        path_agent,
        ConnectionPlacementsRequest(
            connection_id=conn.id,
            placements=placements,
            shares=shares or {},
            generation=conn.stream_generation if generation is None else generation,
        ),
        agent=_Agent(caller),  # type: ignore[arg-type]
        protocol=protocol,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_placements_replace_what_the_connection_had(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A, "session-2": ROOM_B})

    result = await _place(protocol, conn, {"session-1": ROOM_B})

    assert result == {
        "ok": True,
        "placements": {"session-1": ROOM_B},
        "shares": {},
        "rooms": [ROOM_B],
        "released": [],
        "refused": [],
    }
    assert protocol.connections.session_in_room(AGENT_ID, ROOM_A) is None


@pytest.mark.asyncio
async def test_an_empty_set_unplaces_every_session(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A})

    result = await _place(protocol, conn, {})

    assert result["placements"] == {}
    assert result["rooms"] == []
    assert protocol.connections.placements(AGENT_ID) == {}


@pytest.mark.asyncio
async def test_a_room_another_connection_holds_is_taken_over(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    theirs = _open(protocol, "theirs")
    mine = _open(protocol, "mine")
    await _place(protocol, theirs, {"session-t": ROOM_A})

    result = await _place(protocol, mine, {"session-m": ROOM_A})

    assert result["released"] == [
        {"connection_id": "theirs", "room_id": ROOM_A, "session_id": "session-t"}
    ]
    assert protocol.connections.session_in_room(AGENT_ID, ROOM_A) == "session-m"
    assert theirs.rooms == set()
    assert theirs.released_rooms == {ROOM_A: "session-t"}


@pytest.mark.asyncio
async def test_a_room_the_agent_is_not_in_is_left_out_and_named_and_the_rest_placed(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A})

    answer = await _place(
        protocol, conn, {"session-1": ROOM_B, "session-2": FOREIGN_ROOM}
    )

    assert answer["placements"] == {"session-1": ROOM_B}
    assert [(each["session_id"], each["room_id"]) for each in answer["refused"]] == [
        ("session-2", FOREIGN_ROOM)
    ]
    assert protocol.connections.connection_placements(conn) == {"session-1": ROOM_B}
    assert conn.rooms == {ROOM_B}


@pytest.mark.asyncio
async def test_a_room_that_is_gone_is_left_out_every_time_it_is_stated(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)

    async def gone(agent_id: str, room_id: str) -> None:
        if room_id == "room-deleted":
            raise ValueError(f"Room not found: {room_id}")

    protocol.require_room_member = gone  # type: ignore[method-assign]
    conn = _open(protocol, "watcher")
    for _ in range(2):
        answer = await _place(
            protocol, conn, {"session-1": ROOM_A, "stale": "room-deleted"}
        )
        assert answer["placements"] == {"session-1": ROOM_A}
        assert [each["room_id"] for each in answer["refused"]] == ["room-deleted"]


@pytest.mark.asyncio
async def test_an_over_long_session_id_refuses_the_whole_request(
    db_buffer: EventBuffer,
) -> None:
    """A session id travels in the signals switch-core processes send each
    other when its room is taken, which Postgres caps at 8000 bytes."""
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A})

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {"session-1": ROOM_B, "s" * 7900: ROOM_A})

    assert refused.value.status_code == 400
    assert protocol.connections.connection_placements(conn) == {"session-1": ROOM_A}
    assert conn.rooms == {ROOM_A}


@pytest.mark.asyncio
async def test_two_sessions_in_one_room_are_refused(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {"session-1": ROOM_A, "session-2": ROOM_A})

    assert refused.value.status_code == 400
    assert protocol.connections.placements(AGENT_ID) == {}


@pytest.mark.asyncio
async def test_another_agents_connection_is_refused(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    foreign = _open(protocol, "foreign", agent_id=OTHER_AGENT_ID)

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, foreign, {"session-1": ROOM_A})

    assert refused.value.status_code == 404
    assert protocol.connections.placements(AGENT_ID) == {}
    assert protocol.connections.placements(OTHER_AGENT_ID) == {}


@pytest.mark.asyncio
async def test_a_path_naming_another_agent_is_refused(db_buffer: EventBuffer) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {"session-1": ROOM_A}, path_agent=OTHER_AGENT_ID)

    assert refused.value.status_code == 403
    assert protocol.connections.placements(AGENT_ID) == {}


@pytest.mark.asyncio
async def test_a_displaced_client_cannot_rewrite_the_holders_placements(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")
    stale = conn.stream_generation
    _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A})

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {}, generation=stale)

    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "taken_over"  # type: ignore[index]
    assert protocol.connections.connection_placements(conn) == {"session-1": ROOM_A}


HOME = "room-home"


@pytest.mark.asyncio
async def test_a_home_session_answers_for_its_shared_rooms(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")

    result = await _place(
        protocol, conn, {"lead": HOME}, shares={"lead": [ROOM_A, ROOM_B]}
    )

    assert result["placements"] == {"lead": HOME}
    assert result["shares"] == {"lead": [ROOM_A, ROOM_B]}
    assert result["rooms"] == sorted([HOME, ROOM_A, ROOM_B])
    registry = protocol.connections
    assert registry.session_in_room(AGENT_ID, ROOM_A) == "lead"
    assert registry.session_room(AGENT_ID, "lead") == HOME
    assert registry.placed_rooms(AGENT_ID) == {HOME, ROOM_A, ROOM_B}
    assert registry.shared_rooms(AGENT_ID, "lead") == {ROOM_A, ROOM_B}

    # Restated without a share: the room is no longer answered for.
    result = await _place(protocol, conn, {"lead": HOME}, shares={"lead": [ROOM_A]})
    assert result["rooms"] == sorted([HOME, ROOM_A])
    assert registry.session_in_room(AGENT_ID, ROOM_B) is None

    # The home session gone, its shares go with it.
    await _place(protocol, conn, {})
    assert registry.placed_rooms(AGENT_ID) == set()


@pytest.mark.asyncio
async def test_a_share_that_no_longer_holds_is_left_out_not_the_whole_set(
    db_buffer: EventBuffer,
) -> None:
    """A share the settings no longer allow (a room isolated since), or in a
    room the agent left, is left out and named back with `share: true`; every
    other placement and share is made. Refusing the whole set would leave every
    session of the agent unplaced, each time the watcher stated it."""
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")
    protocol.share_refusals = {
        ("lead", ROOM_A): "room room-a does not share this agent's session"
    }

    result = await _place(
        protocol,
        conn,
        {"lead": HOME, "other": "room-other"},
        shares={"lead": [ROOM_A, ROOM_B, FOREIGN_ROOM]},
    )

    assert result["placements"] == {"lead": HOME, "other": "room-other"}
    assert result["shares"] == {"lead": [ROOM_B]}
    assert sorted(
        (each["room_id"], each.get("share", False)) for each in result["refused"]
    ) == [(ROOM_A, True), (FOREIGN_ROOM, True)]
    registry = protocol.connections
    assert registry.session_in_room(AGENT_ID, ROOM_B) == "lead"
    assert registry.session_in_room(AGENT_ID, ROOM_A) is None
    assert registry.session_in_room(AGENT_ID, FOREIGN_ROOM) is None


@pytest.mark.asyncio
async def test_a_home_room_the_agent_left_drops_its_shares_and_keeps_the_rest(
    db_buffer: EventBuffer,
) -> None:
    """The home room gone (deleted, or the agent taken out): its session is
    left out, and so are the shares it held, which `check_shares` judges on
    the placements that remain."""
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")

    async def check_shares(
        agent_id: str, placements: dict[str, str], shares: dict[str, list[str]]
    ) -> dict[tuple[str, str], str]:
        return {
            (session_id, room_id): "not placed in the home room"
            for session_id, rooms in shares.items()
            for room_id in rooms
            if placements.get(session_id) != FOREIGN_ROOM
        }

    protocol.check_shares = check_shares  # type: ignore[method-assign]

    result = await _place(
        protocol,
        conn,
        {"lead": FOREIGN_ROOM, "other": "room-other"},
        shares={"lead": [ROOM_A]},
    )

    assert result["placements"] == {"other": "room-other"}
    assert result["shares"] == {}
    assert {each["room_id"] for each in result["refused"]} == {FOREIGN_ROOM, ROOM_A}


@pytest.mark.asyncio
async def test_a_room_placed_and_shared_at_once_is_refused(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    conn = _open(protocol, "watcher")

    with pytest.raises(HTTPException) as refused:
        await _place(
            protocol, conn, {"lead": HOME, "other": ROOM_A}, shares={"lead": [ROOM_A]}
        )

    assert refused.value.status_code == 400
    assert protocol.connections.placements(AGENT_ID) == {}


@pytest.mark.asyncio
async def test_sharing_a_room_takes_it_from_the_session_placed_there(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    theirs = _open(protocol, "theirs")
    mine = _open(protocol, "mine")
    await _place(protocol, theirs, {"isolated": ROOM_A})

    result = await _place(protocol, mine, {"lead": HOME}, shares={"lead": [ROOM_A]})

    assert result["released"] == [
        {"connection_id": "theirs", "room_id": ROOM_A, "session_id": "isolated"}
    ]
    assert protocol.connections.session_in_room(AGENT_ID, ROOM_A) == "lead"

    # And a session placed in a shared room takes it back.
    result = await _place(protocol, theirs, {"isolated": ROOM_A})
    assert result["released"] == [
        {"connection_id": "mine", "room_id": ROOM_A, "session_id": "lead"}
    ]
    assert protocol.connections.session_in_room(AGENT_ID, ROOM_A) == "isolated"
    assert protocol.connections.shared_rooms(AGENT_ID, "lead") == set()

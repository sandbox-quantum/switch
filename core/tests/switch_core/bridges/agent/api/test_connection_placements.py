"""`POST /agents/{agent_id}/connection/placements`: the watcher states its placements."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import connection_placements
from switch_core.bridges.agent.api.schemas import ConnectionPlacementsRequest
from switch_core.bridges.agent.protocol.connections import (
    ROOM_RELEASED_PROTOCOL_REVISION,
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer

AGENT_ID = "agent-1"
OTHER_AGENT_ID = "agent-2"
ROOM_A = "room-a"
ROOM_B = "room-b"
FOREIGN_ROOM = "room-foreign"


class _Protocol:
    def __init__(self) -> None:
        self.connections = ConnectionRegistry()
        self.event_buffer = EventBuffer(sequence_base=0)

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        if room_id == FOREIGN_ROOM:
            raise PermissionError(f"agent {agent_id} is not a member of {room_id}")


class _Agent:
    def __init__(self, agent_id: str) -> None:
        self.id = agent_id
        self.metadata_: dict[str, str] | None = None


def _open(
    protocol: _Protocol, connection_id: str, agent_id: str = AGENT_ID
) -> Connection:
    return protocol.connections.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope="all",
        delivery_filter="all",
        spawn_capable=True,
        cursor=0,
        declaration=ClientDeclaration(speaks=ROOM_RELEASED_PROTOCOL_REVISION),
        expected_generation=None,
    )


async def _place(
    protocol: _Protocol,
    conn: Connection,
    placements: dict[str, str],
    *,
    path_agent: str = AGENT_ID,
    caller: str = AGENT_ID,
    generation: int | None = None,
) -> dict[str, Any]:
    return await connection_placements(
        path_agent,
        ConnectionPlacementsRequest(
            connection_id=conn.id,
            placements=placements,
            generation=conn.stream_generation if generation is None else generation,
        ),
        agent=_Agent(caller),  # type: ignore[arg-type]
        protocol=protocol,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_placements_replace_what_the_connection_had() -> None:
    protocol = _Protocol()
    conn = _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A, "session-2": ROOM_B})

    result = await _place(protocol, conn, {"session-1": ROOM_B})

    assert result == {
        "ok": True,
        "placements": {"session-1": ROOM_B},
        "rooms": [ROOM_B],
        "released": [],
    }
    assert protocol.connections.session_in_room(AGENT_ID, ROOM_A) is None


@pytest.mark.asyncio
async def test_an_empty_set_unplaces_every_session() -> None:
    protocol = _Protocol()
    conn = _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A})

    result = await _place(protocol, conn, {})

    assert result["placements"] == {}
    assert result["rooms"] == []
    assert protocol.connections.placements(AGENT_ID) == {}


@pytest.mark.asyncio
async def test_a_room_another_connection_holds_is_taken_over() -> None:
    protocol = _Protocol()
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
async def test_a_room_the_agent_is_not_in_refuses_the_whole_request() -> None:
    protocol = _Protocol()
    conn = _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A})

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {"session-1": ROOM_B, "session-2": FOREIGN_ROOM})

    assert refused.value.status_code == 403
    assert FOREIGN_ROOM in str(refused.value.detail)
    assert protocol.connections.connection_placements(conn) == {"session-1": ROOM_A}
    assert conn.rooms == {ROOM_A}


@pytest.mark.asyncio
async def test_two_sessions_in_one_room_are_refused() -> None:
    protocol = _Protocol()
    conn = _open(protocol, "watcher")

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {"session-1": ROOM_A, "session-2": ROOM_A})

    assert refused.value.status_code == 400
    assert protocol.connections.placements(AGENT_ID) == {}


@pytest.mark.asyncio
async def test_another_agents_connection_is_refused() -> None:
    protocol = _Protocol()
    foreign = _open(protocol, "foreign", agent_id=OTHER_AGENT_ID)

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, foreign, {"session-1": ROOM_A})

    assert refused.value.status_code == 404
    assert protocol.connections.placements(AGENT_ID) == {}
    assert protocol.connections.placements(OTHER_AGENT_ID) == {}


@pytest.mark.asyncio
async def test_a_path_naming_another_agent_is_refused() -> None:
    protocol = _Protocol()
    conn = _open(protocol, "watcher")

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {"session-1": ROOM_A}, path_agent=OTHER_AGENT_ID)

    assert refused.value.status_code == 403
    assert protocol.connections.placements(AGENT_ID) == {}


@pytest.mark.asyncio
async def test_a_displaced_client_cannot_rewrite_the_holders_placements() -> None:
    protocol = _Protocol()
    conn = _open(protocol, "watcher")
    stale = conn.stream_generation
    _open(protocol, "watcher")
    await _place(protocol, conn, {"session-1": ROOM_A})

    with pytest.raises(HTTPException) as refused:
        await _place(protocol, conn, {}, generation=stale)

    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "taken_over"  # type: ignore[index]
    assert protocol.connections.connection_placements(conn) == {"session-1": ROOM_A}

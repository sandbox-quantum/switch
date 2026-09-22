"""What a `single`-scope connection holds after subscribing at the HTTP door.

One room at a time, replacing rather than accumulating — the promise this
endpoint has always made, and the one `SwitchEventStream.repoint` is built on:
it claims the new room and never releases the old one, because subscribing was
the release.

The registry stopped doing it. A connection's rooms became the union of its
sessions' rooms, so `claim_room` cannot drop a room without knowing whose it
was, and a caller here names no session. Which leaves the replacement to this
door, where the caller *is* the connection.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.api.handlers import connection_subscribe
from switch_core.bridges.agent.api.schemas import ConnectionSubscribeRequest
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT_ID = "agent-1"
CONN_ID = "conn-1"
ROOM_A = "!room-a"
ROOM_B = "!room-b"


class _Protocol:
    def __init__(self) -> None:
        self.connections = ConnectionRegistry()

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        return None


class _Agent:
    id = AGENT_ID


def _open(protocol: _Protocol, scope: str) -> Any:
    return protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope=scope,
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )


async def _subscribe(protocol: _Protocol, room_id: str, generation: int) -> Any:
    return await connection_subscribe(
        AGENT_ID,
        ConnectionSubscribeRequest(
            connection_id=CONN_ID, room_id=room_id, generation=generation
        ),
        agent=_Agent(),
        protocol=protocol,
    )


@pytest.mark.asyncio
async def test_a_single_scope_subscribe_replaces_the_room_it_held() -> None:
    """A→B leaves the connection in B alone.

    Staying in A as well would go on delivering a room the client has left,
    and leave the agent's slot in it occupied by a client that is not there.
    """
    protocol = _Protocol()
    conn = _open(protocol, "single")

    await _subscribe(protocol, ROOM_A, conn.stream_generation)
    result = await _subscribe(protocol, ROOM_B, conn.stream_generation)

    assert conn.rooms == {ROOM_B}
    assert result["rooms"] == [ROOM_B]


@pytest.mark.asyncio
async def test_resubscribing_to_the_same_room_keeps_it() -> None:
    """The replacement must not release what the claim just took."""
    protocol = _Protocol()
    conn = _open(protocol, "single")

    await _subscribe(protocol, ROOM_A, conn.stream_generation)
    await _subscribe(protocol, ROOM_A, conn.stream_generation)

    assert conn.rooms == {ROOM_A}


@pytest.mark.asyncio
async def test_an_all_scope_subscribe_accumulates() -> None:
    """A supervising connection watches many rooms; one room at a time is not its rule."""
    protocol = _Protocol()
    conn = _open(protocol, "all")

    await _subscribe(protocol, ROOM_A, conn.stream_generation)
    await _subscribe(protocol, ROOM_B, conn.stream_generation)

    assert conn.rooms == {ROOM_A, ROOM_B}

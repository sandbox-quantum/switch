"""Claiming and releasing a room are fenced on the incarnation too.

Fencing the open is not enough on its own, because the room surface is reached
*before* it. `repoint` claims the room and only then reopens, so a client that
has already been displaced gets one unchecked write to the winner's connection
— enough to take the winner's room away and evict whoever holds it — and the
open being refused a moment later does not give any of it back.

A connection id is the wrong thing to authorise on: it survives a takeover, so
it names the connection rather than the client on it. Naming the incarnation as
well turns the lookup into a claim, and the claim is checked before the
membership check and before anything is written.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import (
    connection_subscribe,
    connection_unsubscribe,
)
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
    """Enough of ProtocolService for the two room-control handlers."""

    def __init__(self) -> None:
        self.connections = ConnectionRegistry()
        self.membership_checks: list[str] = []

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        self.membership_checks.append(room_id)


def _attach(protocol: _Protocol) -> Any:
    return protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )


def _request(room_id: str, generation: int | None) -> ConnectionSubscribeRequest:
    return ConnectionSubscribeRequest(
        connection_id=CONN_ID, room_id=room_id, generation=generation
    )


class _Agent:
    id = AGENT_ID


async def _call(
    handler: Any, protocol: _Protocol, room_id: str, gen: int | None
) -> Any:
    return await handler(
        AGENT_ID,
        _request(room_id, gen),
        agent=_Agent(),
        protocol=protocol,
    )


@pytest.mark.asyncio
async def test_a_displaced_client_cannot_claim_a_room_on_the_winners_connection() -> (
    None
):
    """The reviewer's trigger: A owns N, B takes N+1, A claims with N."""
    protocol = _Protocol()
    _attach(protocol)  # A, incarnation 0
    conn = _attach(protocol)  # B takes over, incarnation 1
    await _call(connection_subscribe, protocol, ROOM_B, 1)
    before = set(conn.rooms)

    with pytest.raises(HTTPException) as caught:
        await _call(connection_subscribe, protocol, ROOM_A, 0)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "taken_over"
    # Nothing moved, and the winner is still on the incarnation it attached on.
    assert conn.rooms == before
    assert conn.stream_generation == 1


@pytest.mark.asyncio
async def test_the_refusal_comes_before_the_membership_check() -> None:
    """A refused caller must not reach anything, not merely fail to write.

    The membership check is a database read on a room the caller named. A
    displaced client should not be able to drive it at all.
    """
    protocol = _Protocol()
    _attach(protocol)
    _attach(protocol)

    with pytest.raises(HTTPException):
        await _call(connection_subscribe, protocol, ROOM_A, 0)

    assert protocol.membership_checks == []


@pytest.mark.asyncio
async def test_a_displaced_client_cannot_release_the_winners_room() -> None:
    protocol = _Protocol()
    _attach(protocol)
    conn = _attach(protocol)
    await _call(connection_subscribe, protocol, ROOM_B, 1)

    with pytest.raises(HTTPException) as caught:
        await _call(connection_unsubscribe, protocol, ROOM_B, 0)

    assert caught.value.detail["code"] == "taken_over"
    assert conn.rooms == {ROOM_B}


@pytest.mark.asyncio
async def test_no_room_holder_is_evicted_by_a_refused_claim() -> None:
    """The sharpest edge: claiming is what evicts, so a refusal must not.

    A second connection of the same agent holds the room. A displaced client
    asking for it with takeover would otherwise throw that holder off.
    """
    protocol = _Protocol()
    holder = protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id="conn-holder",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    protocol.connections.claim_room(holder, ROOM_A, takeover=False)
    _attach(protocol)
    _attach(protocol)

    request = ConnectionSubscribeRequest(
        connection_id=CONN_ID, room_id=ROOM_A, generation=0, takeover=True
    )
    with pytest.raises(HTTPException):
        await connection_subscribe(AGENT_ID, request, agent=_Agent(), protocol=protocol)

    assert holder.rooms == {ROOM_A}
    assert holder.closure is None


@pytest.mark.asyncio
async def test_the_current_client_is_admitted() -> None:
    protocol = _Protocol()
    conn = _attach(protocol)

    result = await _call(connection_subscribe, protocol, ROOM_A, 0)

    assert result["ok"] is True
    assert conn.rooms == {ROOM_A}


@pytest.mark.asyncio
async def test_a_client_claiming_nothing_is_still_admitted() -> None:
    """Old clients send no incarnation and keep the unchecked behaviour."""
    protocol = _Protocol()
    _attach(protocol)
    conn = _attach(protocol)

    result = await _call(connection_subscribe, protocol, ROOM_A, None)

    assert result["ok"] is True
    assert conn.rooms == {ROOM_A}

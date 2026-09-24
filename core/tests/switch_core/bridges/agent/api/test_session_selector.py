"""A caller may name its session as well as its connection.

Several sessions of one agent share the agent's connection, so the connection
cannot say which room a call means. The session selector can: Switch keeps, in
memory, which room each session last connected to.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.operations import resolve_caller
from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_LAPSED,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT = "agent-demo"
CONNECTION = "connection-demo"


class _Protocol:
    def __init__(self, connections: ConnectionRegistry) -> None:
        self.connections = connections


def _protocol() -> _Protocol:
    connections = ConnectionRegistry()
    connections.open(
        agent_id=AGENT,
        connection_id=CONNECTION,
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    return _Protocol(connections)


async def _resolve(protocol: _Protocol, **selector: str | None):
    values = {"connection_id": None, "session_id": None, "host_id": None, "epoch": None}
    values.update(selector)
    return await resolve_caller(
        agent_id=AGENT,
        protocol=protocol,  # type: ignore[arg-type]
        factory=None,  # type: ignore[arg-type]
        **values,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_two_sessions_on_one_connection_resolve_their_own_rooms() -> None:
    protocol = _protocol()
    protocol.connections.place_session(AGENT, "first", "room-a")
    protocol.connections.place_session(AGENT, "second", "room-b")

    key, first = await _resolve(protocol, connection_id=CONNECTION, session_id="first")
    _, second = await _resolve(protocol, connection_id=CONNECTION, session_id="second")

    assert key == CONNECTION
    assert first is not None and first.room_id == "room-a"
    assert second is not None and second.room_id == "room-b"


@pytest.mark.asyncio
async def test_a_session_that_connected_to_nothing_is_in_no_room() -> None:
    _, caller = await _resolve(
        _protocol(), connection_id=CONNECTION, session_id="fresh"
    )
    assert caller is not None and caller.room_id is None


@pytest.mark.asyncio
async def test_host_and_epoch_are_accepted_and_not_needed() -> None:
    protocol = _protocol()
    protocol.connections.place_session(AGENT, "first", "room-a")
    _, caller = await _resolve(
        protocol, connection_id=CONNECTION, session_id="first", host_id="h", epoch="e"
    )
    assert caller is not None and (caller.host_id, caller.epoch) == ("h", "e")


@pytest.mark.asyncio
async def test_a_session_selector_needs_its_connection() -> None:
    with pytest.raises(HTTPException) as refused:
        await _resolve(_protocol(), session_id="first")
    assert refused.value.status_code == 400


@pytest.mark.asyncio
async def test_a_dead_or_foreign_connection_is_refused() -> None:
    protocol = _protocol()
    with pytest.raises(HTTPException) as foreign:
        await _resolve(protocol, connection_id="someone-elses", session_id="first")
    assert foreign.value.status_code == 409

    protocol.connections.close(CONNECTION, HEARTBEAT_LAPSED)
    with pytest.raises(HTTPException) as dead:
        await _resolve(protocol, connection_id=CONNECTION, session_id="first")
    assert dead.value.status_code == 409


def test_one_session_per_room_and_one_room_per_session() -> None:
    connections = ConnectionRegistry()
    assert connections.place_session(AGENT, "first", "room-a") == (set(), None)
    # Moving leaves the room it was in.
    assert connections.place_session(AGENT, "first", "room-b") == ({"room-a"}, None)
    # Taking an occupied room displaces the session in it.
    assert connections.place_session(AGENT, "second", "room-b") == (set(), "first")
    assert connections.session_in_room(AGENT, "room-b") == "second"
    assert connections.session_room(AGENT, "first") is None
    assert connections.session_in_room("another-agent", "room-b") is None

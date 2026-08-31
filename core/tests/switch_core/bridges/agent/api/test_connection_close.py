"""Closing a connection releases its room slot at once (CHOO-2497).

Deleting a session used to tell switch-core nothing. The session's connection
kept its room claim until the heartbeat sweep collected it, and for those
seconds the agent's all-scope watcher stayed dark on the room — so a message
arriving in the gap spawned no replacement session and the user saw a delay.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.api.handlers import connection_close
from switch_core.bridges.agent.api.schemas import ConnectionCloseRequest
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT_ID = "agent-1"
OTHER_AGENT_ID = "agent-2"
SESSION_CONN = "session-conn"
WATCHER_CONN = "watcher-conn"
ROOM_ID = "room-1"


class _Protocol:
    def __init__(self) -> None:
        self.connections = ConnectionRegistry()


def _open(
    protocol: _Protocol, connection_id: str, scope: str, agent_id: str = AGENT_ID
) -> Any:
    conn = protocol.connections.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope=scope,  # type: ignore[arg-type]
        delivery_filter="all",
        spawn_capable=scope == "all",
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )
    conn.stream_attached = True
    return conn


async def _close(
    protocol: _Protocol, connection_id: str, agent_id: str = AGENT_ID
) -> Any:
    return await connection_close(
        agent_id,
        ConnectionCloseRequest(connection_id=connection_id, reason="session stopped"),
        SimpleNamespace(id=agent_id),  # type: ignore[arg-type]
        protocol,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_closing_a_session_hands_the_room_back_to_the_watcher() -> None:
    protocol = _Protocol()
    watcher = _open(protocol, WATCHER_CONN, "all")
    session = _open(protocol, SESSION_CONN, "single")
    protocol.connections.claim_room(session, ROOM_ID)
    assert not protocol.connections.covers(watcher, ROOM_ID)

    result = await _close(protocol, SESSION_CONN)

    assert result == {"ok": True, "closed": True}
    # No sweep, no waiting on the heartbeat TTL: the watcher covers the room
    # again immediately, so the next message spawns a session.
    assert protocol.connections.covers(watcher, ROOM_ID)
    assert protocol.connections.holder_of(AGENT_ID, ROOM_ID) is watcher
    assert not protocol.connections.has_session_in(AGENT_ID, ROOM_ID)


@pytest.mark.asyncio
async def test_closing_an_unknown_connection_is_the_outcome_the_caller_wanted() -> None:
    protocol = _Protocol()

    result = await _close(protocol, SESSION_CONN)

    assert result == {"ok": True, "closed": False}


@pytest.mark.asyncio
async def test_closing_twice_is_harmless() -> None:
    protocol = _Protocol()
    _open(protocol, SESSION_CONN, "single")

    assert await _close(protocol, SESSION_CONN) == {"ok": True, "closed": True}
    assert await _close(protocol, SESSION_CONN) == {"ok": True, "closed": False}


@pytest.mark.asyncio
async def test_one_agent_cannot_close_another_agents_connection() -> None:
    protocol = _Protocol()
    _open(protocol, SESSION_CONN, "single")

    result = await _close(protocol, SESSION_CONN, agent_id=OTHER_AGENT_ID)

    assert result == {"ok": True, "closed": False}
    assert protocol.connections.require(AGENT_ID, SESSION_CONN) is not None

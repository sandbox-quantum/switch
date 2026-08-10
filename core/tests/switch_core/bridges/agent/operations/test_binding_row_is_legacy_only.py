"""The room binding row is written only for callers with no connection.

A connection carries its own rooms, so a row written for one records a binding
nothing reads. It matters because that row has no liveness check and no expiry:
it outlives the connection it was written for and keeps answering room-scoped
calls. A connection that reopens without re-claiming its room then looks
connected to the send path while delivery, which reads the connection, has
nothing — the agent posts into a room it is no longer receiving from, and
neither side can see the discrepancy.

MCP transport sessions have no connection and the row is the only thing holding
them to a room, so it is still written for them.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.operations.definitions import (
    bind_room_for_connectionless_caller,
)
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT = "agent-1"
ROOM = "room-1"
CONN = "conn-1"


class _RecordingSessionStore:
    """Captures binding-row writes without a database."""

    def __init__(self) -> None:
        self.writes: list[dict[str, Any]] = []

    async def set_connected_room(self, _db: Any, **kwargs: Any) -> None:
        self.writes.append(kwargs)


def _open(registry: ConnectionRegistry, connection_id: str) -> Any:
    return registry.open(
        agent_id=AGENT,
        connection_id=connection_id,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )


async def _write_binding_row_if_needed(protocol: Any, key: str) -> bool:
    return await bind_room_for_connectionless_caller(
        protocol,
        agent_id=AGENT,
        connection_id=key,
        room_id=ROOM,
        connection_model="session_addressable",
    )


def _protocol(registry: ConnectionRegistry, store: _RecordingSessionStore) -> Any:
    class _Db:
        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *_exc: Any) -> None:
            return None

        async def commit(self) -> None:
            return None

    return SimpleNamespace(
        connections=registry,
        agent_session_store=store,
        session_factory=lambda: _Db(),
    )


async def test_no_row_is_written_for_a_connection_backed_caller() -> None:
    registry = ConnectionRegistry()
    _open(registry, CONN)
    store = _RecordingSessionStore()

    await _write_binding_row_if_needed(_protocol(registry, store), CONN)

    assert store.writes == []


async def test_the_row_is_still_written_for_an_mcp_transport_session() -> None:
    # No connection was ever opened for this key, so the row is the only thing
    # that can resolve the caller's room.
    registry = ConnectionRegistry()
    store = _RecordingSessionStore()

    await _write_binding_row_if_needed(_protocol(registry, store), "mcp-session-1")

    assert len(store.writes) == 1
    assert store.writes[0]["transport_session_id"] == "mcp-session-1"
    assert store.writes[0]["room_id"] == ROOM


async def test_a_closed_connection_falls_back_to_writing_the_row() -> None:
    # A runtime reusing a key whose connection has expired is indistinguishable
    # from an MCP transport session, and resolves the same way.
    registry = ConnectionRegistry()
    _open(registry, CONN)
    registry.close(CONN, "gone")
    store = _RecordingSessionStore()

    await _write_binding_row_if_needed(_protocol(registry, store), CONN)

    assert len(store.writes) == 1
    assert store.writes[0]["transport_session_id"] == CONN

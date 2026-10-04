"""A refused heartbeat says which refusal it is, not just that it was refused.

Three different faults answered one status with prose, and the client could
only act on the status: every refusal meant reopen. One of the three must never
be answered that way. Being superseded means another client holds the
connection, and reopening is itself a takeover — so the client that was fenced
out reopens, takes it straight back off the winner, and the pair trade it for
as long as both run. The fence stops the loser's cursor from moving the
winner's; it did not stop the loser from coming back.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.api.handlers import _record_beat
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
    NoStreamAttachedError,
    SupersededConnectionError,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer

AGENT_ID = "agent-1"
CONN_ID = "conn-1"


class _Protocol:
    def __init__(self) -> None:
        self.event_buffer = EventBuffer()
        self.connections = AgentConnectionRegistry()


def _open(protocol: _Protocol, *, speaks: int | None = PROTOCOL_VERSION) -> Any:
    return protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=speaks),
        expected_generation=None,
    )


def _beat(protocol: _Protocol, generation: int | None) -> Any:
    return _record_beat(protocol, AGENT_ID, CONN_ID, 0, generation)  # type: ignore[arg-type]


def test_a_superseded_tick_is_refused_as_a_takeover() -> None:
    protocol = _Protocol()
    displaced = _open(protocol).stream_generation
    _open(protocol)  # the winner attaches; the incarnation bumps

    with pytest.raises(SupersededConnectionError) as caught:
        _beat(protocol, displaced)

    # The same code the displaced stream is evicted with: one ending reaching
    # the client by whichever door is still open to it.
    assert caught.value.code == "taken_over"
    # The prose still names both incarnations for whoever reads it.
    assert str(displaced) in str(caught.value)
    assert str(displaced + 1) in str(caught.value)


def test_a_tick_with_no_stream_is_refused_as_something_to_reopen() -> None:
    protocol = _Protocol()
    conn = _open(protocol)
    protocol.connections.detach_stream(conn, conn.stream_generation)

    with pytest.raises(NoStreamAttachedError) as caught:
        _beat(protocol, conn.stream_generation)

    # Recoverable, and distinct from the takeover: this client still holds the
    # connection and only has to reconnect.
    assert caught.value.code == "no_stream"

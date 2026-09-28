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

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import connection_beat
from switch_core.bridges.agent.api.schemas import ConnectionBeatRequest
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer

AGENT_ID = "agent-1"
CONN_ID = "conn-1"


class _Protocol:
    def __init__(self) -> None:
        self.event_buffer = EventBuffer()
        self.connections = ConnectionRegistry()


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


async def _beat(protocol: _Protocol, generation: int | None) -> Any:
    return await connection_beat(
        AGENT_ID,
        ConnectionBeatRequest(connection_id=CONN_ID, cursor=0, generation=generation),
        SimpleNamespace(id=AGENT_ID),  # type: ignore[arg-type]
        protocol,  # type: ignore[arg-type]
    )


async def test_a_superseded_tick_is_refused_as_a_takeover() -> None:
    protocol = _Protocol()
    displaced = _open(protocol).stream_generation
    _open(protocol)  # the winner attaches; the incarnation bumps

    with pytest.raises(HTTPException) as caught:
        await _beat(protocol, displaced)

    # The same code the displaced stream is evicted with: one ending reaching
    # the client by whichever door is still open to it.
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "taken_over"  # type: ignore[index]
    # The prose stays, and still names both incarnations for whoever reads it.
    message = caught.value.detail["message"]  # type: ignore[index]
    assert str(displaced) in message and str(displaced + 1) in message


async def test_a_tick_with_no_stream_is_refused_as_something_to_reopen() -> None:
    protocol = _Protocol()
    conn = _open(protocol)
    protocol.connections.detach_stream(conn, conn.stream_generation)

    with pytest.raises(HTTPException) as caught:
        await _beat(protocol, conn.stream_generation)

    # Recoverable, and distinct from the takeover: this client still holds the
    # connection and only has to reopen the stream.
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "no_stream"  # type: ignore[index]


async def test_an_unfenced_tick_from_a_fenced_holder_is_refused_on_its_own_code() -> (
    None
):
    protocol = _Protocol()
    _open(protocol)

    with pytest.raises(HTTPException) as caught:
        await _beat(protocol, None)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "unfenced"  # type: ignore[index]


async def test_a_client_that_cannot_be_fenced_still_beats() -> None:
    protocol = _Protocol()
    _open(protocol, speaks=None)

    assert (await _beat(protocol, None))["ok"] is True

"""A reattach can be refused, and says so the way a refused heartbeat does.

The heartbeat fence stops a displaced client keeping the winner's connection
alive. It does not stop it coming back: opening the stream is a takeover, so a
client that never learned it had been displaced — its socket died before the
eviction frame, its beat's refusal never arrived — reopens and takes the
connection off the winner, who is then evicted in turn. Naming the incarnation
on the way in is what closes that, and the refusal has to carry the same code
the other two doors do, because it is the same ending.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import poll_events
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
        self.event_buffer = EventBuffer(sequence_base=0)
        self.connections = ConnectionRegistry()
        # No approval outcomes: these tests are about opening the stream.
        self.approval_outcomes = None
        self.declarations: list[ClientDeclaration] = []

    async def record_client_declaration(
        self, agent_id: str, connection_id: str, declaration: ClientDeclaration
    ) -> None:
        self.declarations.append(declaration)


def _attach(protocol: _Protocol) -> Any:
    """Attach the way the registry does for a client already in the room."""
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


async def _reopen(protocol: _Protocol, expected_generation: int | None) -> Any:
    return await poll_events(
        AGENT_ID,
        SimpleNamespace(id=AGENT_ID),  # type: ignore[arg-type]
        protocol,  # type: ignore[arg-type]
        accept="text/event-stream",
        connection_id=CONN_ID,
        protocol_version=PROTOCOL_VERSION,
        expected_generation=expected_generation,
    )


async def test_a_reattach_claiming_a_superseded_incarnation_is_refused() -> None:
    protocol = _Protocol()
    displaced = _attach(protocol).stream_generation
    _attach(protocol)  # the winner attaches; the incarnation bumps

    with pytest.raises(HTTPException) as caught:
        await _reopen(protocol, displaced)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "taken_over"  # type: ignore[index]


async def test_the_refused_reattach_leaves_the_winner_attached() -> None:
    """Refusing must cost the holder nothing, or it is a way to disrupt it."""
    protocol = _Protocol()
    displaced = _attach(protocol).stream_generation
    winner = _attach(protocol)
    held = winner.stream_generation

    with pytest.raises(HTTPException):
        await _reopen(protocol, displaced)

    assert winner.stream_generation == held
    assert winner.stream_attached
    # The refusal happens before any bookkeeping, so nothing was recorded for a
    # client that never connected.
    assert protocol.declarations == []


async def test_the_holders_own_reattach_is_admitted() -> None:
    protocol = _Protocol()
    conn = _attach(protocol)
    before = conn.stream_generation

    await _reopen(protocol, before)

    # Admitted, and it is a fresh incarnation: the reattach replaced the
    # stream, so the number the client came in on is spent.
    assert conn.stream_generation != before
    assert protocol.declarations != []


async def test_a_client_that_claims_nothing_still_takes_over() -> None:
    """Old clients, and deliberate takeovers, are unconditional as before."""
    protocol = _Protocol()
    conn = _attach(protocol)
    before = conn.stream_generation

    await _reopen(protocol, None)

    assert conn.stream_generation != before

"""Connecting to a room claims the caller's room slot (CHOO-1857).

`connect_to_room` arrives tagged with a connection id, so the room is bound to
that connection rather than left to a follow-up subscribe the client has to
remember. Two consequences, and the second is the point:

- one step instead of two, so there is no window in which the agent is "in" a
  room its own connection does not cover;
- the claim lands on that connection's stream as `subscription_changed`, so a
  supervisor holding the connection learns the room **from Switch** instead of
  reading the agent's tool result. Reading the tool result is what switchdash
  did, and it broke silently the moment the result's shape changed.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.operations.definitions import (
    claim_room_on_caller_connection,
)
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ConnectionRegistry,
)

AGENT = "agent-1"
ROOM = "room-1"
CONN = "conn-1"


def _protocol(registry: ConnectionRegistry) -> Any:
    return SimpleNamespace(connections=registry)


def _open(registry: ConnectionRegistry, connection_id: str, agent_id: str = AGENT):
    return registry.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        protocol_version=PROTOCOL_VERSION,
    )


def test_the_calling_connection_ends_up_holding_the_room() -> None:
    registry = ConnectionRegistry()
    _open(registry, CONN)

    claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    claimant = registry.claimant_of(AGENT, ROOM)
    assert claimant is not None
    assert claimant.id == CONN


def test_the_claim_wakes_the_stream_so_its_holder_is_told() -> None:
    """The wake is what carries the room to whoever holds the stream.

    Without it the supervisor stays blocked on its read and learns nothing
    until the next event happens along.
    """
    registry = ConnectionRegistry()
    conn = _open(registry, CONN)
    conn.wake.clear()

    claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert conn.wake.is_set()


def test_a_dead_sibling_does_not_lock_the_agent_out() -> None:
    """The same agent returning after a restart must be able to re-enter.

    Its previous connection is usually still registered but no longer beating.
    That is not a claimant — `claimant_of` filters on liveness — so there is
    nothing to take over and the claim simply succeeds.
    """
    import time as _time

    registry = ConnectionRegistry()
    dead = _open(registry, "previous-life")
    registry.claim_room(dead, ROOM)
    dead.last_beat = _time.monotonic() - 3600
    _open(registry, CONN)

    claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    claimant = registry.claimant_of(AGENT, ROOM)
    assert claimant is not None
    assert claimant.id == CONN


def test_a_live_sibling_keeps_the_room() -> None:
    """A tool call does not take a room off a connection that is delivering.

    The only thing a takeover here could ever win against is a live connection
    covering the room — typically a supervisor feeding this very session. Taking
    the slot from it stops delivery *silently*: the call succeeds, the agent
    believes it is in the room, and nothing reaches it again.

    Ownership goes the other way: a supervisor declaring a room when it opens
    its stream takes over; a `connect_to_room` yields.
    """
    registry = ConnectionRegistry()
    supervisor = _open(registry, "supervisor")
    registry.claim_room(supervisor, ROOM)
    _open(registry, CONN)

    claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    claimant = registry.claimant_of(AGENT, ROOM)
    assert claimant is not None
    assert claimant.id == "supervisor"
    assert ROOM in supervisor.rooms


def test_an_unknown_connection_is_not_an_error() -> None:
    """An MCP transport session has no connection; the binding row covers it."""
    registry = ConnectionRegistry()

    claim_room_on_caller_connection(_protocol(registry), AGENT, "no-such", ROOM)

    assert registry.claimant_of(AGENT, ROOM) is None


def test_another_agents_connection_is_never_claimed_on() -> None:
    """The key comes off the caller's own header, but never trust it blindly."""
    registry = ConnectionRegistry()
    _open(registry, CONN, agent_id="someone-else")

    claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert registry.claimant_of("someone-else", ROOM) is None
    assert registry.claimant_of(AGENT, ROOM) is None


def test_a_failure_to_claim_is_logged_and_not_raised(
    caplog: Any,
) -> None:
    """Membership is already written; only routing is affected.

    Raising here would fail a `connect_to_room` that genuinely succeeded.
    """
    registry = ConnectionRegistry()
    conn = _open(registry, CONN)

    def _explode(*_a: Any, **_kw: Any) -> None:
        from switch_core.bridges.agent.protocol.connections import RoomOccupiedError

        raise RoomOccupiedError(ROOM, "other")

    registry.claim_room = _explode  # type: ignore[method-assign]

    with caplog.at_level(logging.WARNING):
        claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert any("could not claim room" in r.getMessage() for r in caplog.records)
    assert conn.closed_reason is None

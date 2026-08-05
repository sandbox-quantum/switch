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

The claim is also what resolves a second session (CHOO-1419): a live claimant is
another session of this agent already in the room, so the newcomer displaces it
rather than the two coexisting — and the eviction is reported back, because a
takeover nobody mentions looks exactly like the bug it resolves.
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
    NoStreamAttachedError,
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


def test_a_live_sibling_is_evicted_and_the_eviction_is_reported() -> None:
    """A second session takes the room, and is told what it cost (CHOO-1419).

    A live claimant is another session of this same agent already acting in the
    room. Only one of them may, so the newcomer displaces it rather than the two
    coexisting — refusing instead would strand a session that was started to
    work here and has nowhere else to go.

    The eviction is returned, not merely logged. An unannounced takeover is
    indistinguishable from the duplicate-session bug it resolves: a session
    stops receiving a room and nothing says why.
    """
    registry = ConnectionRegistry()
    incumbent = _open(registry, "first-session")
    registry.claim_room(incumbent, ROOM)
    _open(registry, CONN)

    evicted = claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert evicted == "first-session"
    claimant = registry.claimant_of(AGENT, ROOM)
    assert claimant is not None
    assert claimant.id == CONN
    assert ROOM not in incumbent.rooms


def test_the_evicted_session_is_woken_so_it_learns_it_lost_the_room() -> None:
    """The loser has to find out, and its stream is the only way it can.

    Without the wake it stays blocked on its read, still believing it holds the
    room, and switchdash keeps showing it under that room.
    """
    registry = ConnectionRegistry()
    incumbent = _open(registry, "first-session")
    registry.claim_room(incumbent, ROOM)
    incumbent.wake.clear()
    _open(registry, CONN)

    claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert incumbent.wake.is_set()


def test_taking_an_unheld_room_reports_no_eviction() -> None:
    """The warning must not fire on the ordinary case of an empty room."""
    registry = ConnectionRegistry()
    _open(registry, CONN)

    evicted = claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert evicted is None


def test_a_dead_predecessor_is_not_reported_as_an_eviction() -> None:
    """Nothing was displaced, so nothing should be announced.

    A restart meets its own dead connection constantly. Reporting that as "you
    evicted a session" would cry wolf on the most routine event there is.
    """
    import time as _time

    registry = ConnectionRegistry()
    dead = _open(registry, "previous-life")
    registry.claim_room(dead, ROOM)
    dead.last_beat = _time.monotonic() - 3600
    _open(registry, CONN)

    evicted = claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert evicted is None


def test_the_same_connection_reconnecting_is_not_a_duplicate() -> None:
    """One session returning is not two sessions arriving.

    A session keeps its connection id across reconnects, so it meets its own
    claim. That must stay idempotent or every restart would lock itself out.
    """
    registry = ConnectionRegistry()
    conn = _open(registry, CONN)
    registry.claim_room(conn, ROOM)

    evicted = claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert evicted is None
    claimant = registry.claimant_of(AGENT, ROOM)
    assert claimant is not None
    assert claimant.id == CONN


def test_another_agent_holding_the_room_is_not_a_conflict() -> None:
    """The rule is one session per agent per room, not one agent per room."""
    registry = ConnectionRegistry()
    theirs = _open(registry, "their-session", agent_id="agent-2")
    registry.claim_room(theirs, ROOM)
    _open(registry, CONN)

    claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    ours = registry.claimant_of(AGENT, ROOM)
    assert ours is not None
    assert ours.id == CONN
    assert ROOM in theirs.rooms


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


def test_a_fault_that_is_not_occupancy_is_logged_and_not_raised(
    caplog: Any,
) -> None:
    """Only occupancy is fatal; other faults cost routing, not membership.

    Occupancy means someone else is in the agent's seat, which changes what the
    caller may do. Any other connection fault leaves the room the caller's to
    have, so failing the whole connect over it would be the harsher answer.
    """
    registry = ConnectionRegistry()
    conn = _open(registry, CONN)

    def _explode(*_a: Any, **_kw: Any) -> None:
        raise NoStreamAttachedError(CONN)

    registry.claim_room = _explode  # type: ignore[method-assign]

    with caplog.at_level(logging.WARNING):
        claim_room_on_caller_connection(_protocol(registry), AGENT, CONN, ROOM)

    assert any("could not claim room" in r.getMessage() for r in caplog.records)
    assert conn.closed_reason is None

"""`multi` scope — a connection that works across a declared set of rooms.

`single` is a session in one room and `all` is a supervisor watching everything
it has not been shut out of. Neither says "I act in these three rooms", which is
what an agent reachable on several surfaces at once needs: a Slack channel and
an email correspondent are two rooms, and one context has to cover both.

The point of making it a *claiming* scope rather than a second flavour of `all`
is that the existing room-slot invariant then does all the coordination. A
`multi` connection claims each of its rooms, so:

- the auto-session watcher's `all` connection goes dark on exactly those rooms
  and keeps covering the rest — no new concept, the same rule that already
  hands a room to a session and takes it back;
- `claimant_of` returns exactly one connection per room, so `holder_of` is
  deterministic. Two `all` connections on one agent would both cover everything
  and the holder would be whichever the iteration reached first.

Unlike `all`, coverage is exactly the claimed set: an unclaimed room is not
covered. That is deliberate — an agent's context should be the surfaces it was
given, not every room anyone has ever added it to.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
    RoomOccupiedError,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

AGENT = "agent-1"
ROOM_A = "room-a"
ROOM_B = "room-b"
ROOM_C = "room-c"


def _open(
    registry: ConnectionRegistry,
    connection_id: str,
    *,
    agent_id: str = AGENT,
    scope: str = "multi",
    delivery_filter: str = "all",
    spawn_capable: bool = False,
):
    return registry.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope=scope,  # type: ignore[arg-type]
        delivery_filter=delivery_filter,  # type: ignore[arg-type]
        spawn_capable=spawn_capable,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )


# ── Holding several rooms ────────────────────────────────────────────────────


def test_claiming_a_second_room_keeps_the_first() -> None:
    """The whole difference from `single`, which clears on every claim."""
    registry = ConnectionRegistry()
    conn = _open(registry, "worker")

    registry.claim_room(conn, ROOM_A)
    registry.claim_room(conn, ROOM_B)

    assert conn.rooms == {ROOM_A, ROOM_B}


def test_coverage_is_exactly_the_claimed_set() -> None:
    """Unclaimed rooms are not covered — this is not `all` with extra steps.

    An agent's surfaces are the ones it was given. Covering everything would
    put every room it has ever been added to into one context window.
    """
    registry = ConnectionRegistry()
    conn = _open(registry, "worker")
    registry.claim_room(conn, ROOM_A)
    registry.claim_room(conn, ROOM_B)

    assert registry.covers(conn, ROOM_A)
    assert registry.covers(conn, ROOM_B)
    assert not registry.covers(conn, ROOM_C)


def test_releasing_one_room_leaves_the_others() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "worker")
    registry.claim_room(conn, ROOM_A)
    registry.claim_room(conn, ROOM_B)

    registry.release_room(conn, ROOM_A)

    assert conn.rooms == {ROOM_B}
    assert not registry.covers(conn, ROOM_A)


# ── Claiming, so the slot invariant does the coordination ────────────────────


def test_every_claimed_room_has_this_connection_as_its_claimant() -> None:
    """Claiming is what makes the rest of the design work.

    A connection that merely *covered* its rooms would not displace anything,
    and the watcher would keep delivering the same events to a session it spawns
    alongside.
    """
    registry = ConnectionRegistry()
    conn = _open(registry, "worker")
    registry.claim_room(conn, ROOM_A)
    registry.claim_room(conn, ROOM_B)

    for room in (ROOM_A, ROOM_B):
        claimant = registry.claimant_of(AGENT, room)
        assert claimant is not None
        assert claimant.id == "worker"


def test_an_all_sibling_goes_dark_on_the_claimed_rooms_only() -> None:
    """The auto-session watcher keeps its job everywhere else.

    This is the existing slot rule applied unchanged: `all` covers what no
    sibling has claimed. Without `multi` claiming, the watcher would spawn a
    session on the first addressed message and take the room away from the
    connection holding the context.
    """
    registry = ConnectionRegistry()
    watcher = _open(registry, "watcher", scope="all", delivery_filter="addressed")
    worker = _open(registry, "worker")

    registry.claim_room(worker, ROOM_A)
    registry.claim_room(worker, ROOM_B)

    assert not registry.covers(watcher, ROOM_A)
    assert not registry.covers(watcher, ROOM_B)
    assert registry.covers(watcher, ROOM_C)


def test_the_holder_of_a_claimed_room_is_the_multi_connection() -> None:
    """Deterministic, unlike two `all` connections racing on iteration order."""
    registry = ConnectionRegistry()
    _open(registry, "watcher", scope="all")
    worker = _open(registry, "worker")
    registry.claim_room(worker, ROOM_A)

    assert registry.holder_of(AGENT, ROOM_A) is worker


def test_a_session_cannot_take_a_room_a_multi_connection_holds() -> None:
    """A live claimant is a live claimant whatever scope it has."""
    registry = ConnectionRegistry()
    worker = _open(registry, "worker")
    registry.claim_room(worker, ROOM_A)
    session = _open(registry, "session", scope="single")

    with pytest.raises(RoomOccupiedError):
        registry.claim_room(session, ROOM_A)


def test_a_takeover_removes_only_the_room_taken() -> None:
    """The rest of the working set survives someone else claiming one room.

    Eviction is per-room. A takeover that emptied the whole set would silence
    the agent on surfaces nobody contested.
    """
    registry = ConnectionRegistry()
    worker = _open(registry, "worker")
    registry.claim_room(worker, ROOM_A)
    registry.claim_room(worker, ROOM_B)
    session = _open(registry, "session", scope="single")

    evicted = registry.claim_room(session, ROOM_A, takeover=True)

    assert evicted is worker
    assert worker.rooms == {ROOM_B}
    assert registry.covers(worker, ROOM_B)
    assert not registry.covers(worker, ROOM_A)


def test_a_dead_multi_connection_claims_nothing() -> None:
    """A restart must not be locked out by its own previous life."""
    registry = ConnectionRegistry()
    dead = _open(registry, "previous-life")
    registry.claim_room(dead, ROOM_A)
    dead.last_beat = time.monotonic() - 3600

    assert registry.claimant_of(AGENT, ROOM_A) is None

    fresh = _open(registry, "worker")
    registry.claim_room(fresh, ROOM_A)

    claimant = registry.claimant_of(AGENT, ROOM_A)
    assert claimant is not None
    assert claimant.id == "worker"


def test_another_agents_multi_connection_is_not_a_conflict() -> None:
    """One connection per (agent, room) — not one per room."""
    registry = ConnectionRegistry()
    mine = _open(registry, "mine")
    theirs = _open(registry, "theirs", agent_id="agent-2")

    registry.claim_room(mine, ROOM_A)
    registry.claim_room(theirs, ROOM_A)

    assert registry.holder_of(AGENT, ROOM_A) is mine
    assert registry.holder_of("agent-2", ROOM_A) is theirs


# ── The other scopes keep their behaviour ────────────────────────────────────


def test_single_still_holds_one_room_at_a_time() -> None:
    """Regression guard: `covers` grows a branch, `single` must not change."""
    registry = ConnectionRegistry()
    conn = _open(registry, "session", scope="single")

    registry.claim_room(conn, ROOM_A)
    registry.claim_room(conn, ROOM_B)

    assert conn.rooms == {ROOM_B}


def test_all_still_covers_what_nobody_claimed() -> None:
    """Regression guard for the other side of the same branch."""
    registry = ConnectionRegistry()
    watcher = _open(registry, "watcher", scope="all")

    assert registry.covers(watcher, ROOM_A)
    assert registry.covers(watcher, ROOM_C)


def test_an_unrecognised_scope_is_refused_at_open() -> None:
    """A typo must not silently become a connection that covers nothing.

    `Scope` is a type annotation, so nothing at runtime rejects a bad value
    today — the HTTP layer takes `scope` as a bare `str`. Once `covers` reads
    "anything that is not `all` covers only what it claimed", a misspelled
    `all` becomes a connection that claims nothing, covers nothing, and reports
    no error: the agent goes quiet everywhere and the logs say it connected.
    """
    registry = ConnectionRegistry()

    with pytest.raises(ValueError) as excinfo:
        _open(registry, "typo", scope="al")

    assert "unknown scope" in str(excinfo.value)


# ── Delivery: the predicate is not the point, the stream is ──────────────────


def _message(body: str, room: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=False,
            sender="@u:s",
            sender_name="u",
            message_id=f"$evt-{body}",
            body=body,
            timestamp=0,
        ),
    )


def _parse(frame: bytes) -> tuple[str, dict[str, Any]]:
    name, data = "", "{}"
    for line in frame.decode().strip().splitlines():
        if line.startswith("event: "):
            name = line[len("event: ") :]
        elif line.startswith("data: "):
            data = line[len("data: ") :]
    return name, json.loads(data)


async def _take(stream, count: int, timeout: float = 2.0) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []

    async def pump() -> None:
        async for frame in stream:
            if frame.startswith(b":"):
                continue
            out.append(_parse(frame))
            if len(out) >= count:
                return

    await asyncio.wait_for(pump(), timeout=timeout)
    return out


async def test_traffic_from_every_claimed_room_arrives_on_one_stream() -> None:
    """The story, at the transport: two surfaces, one ordered sequence.

    The buffer is per-agent with one sequence space, so a single connection
    reading it sees email and chat interleaved in the order they happened. That
    ordering is the concrete reason to prefer one multi-room connection over
    one connection per surface — several sockets re-merged by arrival time do
    not have it.
    """
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry, "worker")
    registry.claim_room(conn, ROOM_A)
    registry.claim_room(conn, ROOM_B)

    buffer.enqueue(AGENT, ROOM_A, _message("first", ROOM_A))
    buffer.enqueue(AGENT, ROOM_B, _message("second", ROOM_B))
    buffer.enqueue(AGENT, ROOM_A, _message("third", ROOM_A))

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 4)

    assert frames[0][0] == "connection_state"
    bodies = [data["payload"]["body"] for _, data in frames[1:]]
    rooms = [data["room_id"] for _, data in frames[1:]]
    assert bodies == ["first", "second", "third"]
    assert rooms == [ROOM_A, ROOM_B, ROOM_A]


async def test_an_unclaimed_rooms_traffic_never_arrives() -> None:
    """Coverage is the claimed set, enforced where it counts — at delivery."""
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry, "worker")
    registry.claim_room(conn, ROOM_A)

    buffer.enqueue(AGENT, ROOM_C, _message("not for you", ROOM_C))
    buffer.enqueue(AGENT, ROOM_A, _message("yours", ROOM_A))

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    bodies = [data["payload"]["body"] for _, data in frames[1:]]
    assert bodies == ["yours"]


async def test_a_room_less_connection_does_not_consume_its_own_buffer() -> None:
    """Covering nothing must mean *parking*, not skipping past everything.

    The skip path advances the cursor, so a connection that covers nothing and
    still reads walks itself to head. `single` has always parked for exactly
    this reason — a session's connection opens before the session boots and
    claims its room. `multi` has the same window, twice over: it can open with
    no rooms and claim them afterwards, and it drops back to none if its last
    room is taken over.

    Nothing self-corrects afterwards. `connect_to_room` claims server-side
    without reopening the socket, so the cursor is never rewound and everything
    buffered before the claim is gone with no gap reported.
    """
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry, "worker")

    buffer.enqueue(AGENT, ROOM_A, _message("before the claim", ROOM_A))
    buffer.enqueue(AGENT, ROOM_B, _message("also before", ROOM_B))

    # Drained in the background rather than with `_take`: the generator is lazy,
    # so pulling a fixed number of frames suspends it before the read loop runs
    # and the assertion passes without the behaviour ever being exercised.
    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    seen: list[tuple[str, dict]] = []

    async def drain() -> None:
        async for frame in stream:
            if not frame.startswith(b":"):
                seen.append(_parse(frame))

    task = asyncio.create_task(drain())
    await asyncio.sleep(0.1)
    task.cancel()

    assert [name for name, _ in seen] == ["connection_state"]
    assert conn.cursor == 0


def test_a_multi_connection_that_has_claimed_nothing_covers_nothing() -> None:
    """The dangerous edge: an empty set must not read as "everything".

    A `multi` connection between opening and its first claim holds no rooms. If
    that fell through to the `all` branch it would briefly receive every room
    the agent belongs to — the exact unbounded context the scope exists to
    avoid, and invisible because it self-corrects a moment later.
    """
    registry = ConnectionRegistry()
    conn = _open(registry, "worker")

    assert conn.rooms == set()
    assert not registry.covers(conn, ROOM_A)
    assert not registry.covers(conn, ROOM_C)

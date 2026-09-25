"""`room_released`: telling a connection that another one took its room."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import (
    ROOM_RELEASED_PROTOCOL_REVISION,
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
    Released,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.stream import event_stream

AGENT = "agent-1"
ROOM_A = "room-a"
ROOM_B = "room-b"
ROOM_C = "room-c"


def _open(
    registry: ConnectionRegistry, connection_id: str, *, speaks: int | None, scope: str
) -> Connection:
    return registry.open(
        agent_id=AGENT,
        connection_id=connection_id,
        scope=scope,  # type: ignore[arg-type]
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=speaks),
        expected_generation=None,
    )


async def _frames_until_quiet(
    stream: Any, timeout: float = 0.3
) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []

    async def pump() -> None:
        async for frame in stream:
            if frame.startswith(b":"):
                continue
            name, data = "", "{}"
            for line in frame.decode().strip().splitlines():
                if line.startswith("event: "):
                    name = line[len("event: ") :]
                elif line.startswith("data: "):
                    data = line[len("data: ") :]
            out.append((name, json.loads(data)))

    try:
        await asyncio.wait_for(pump(), timeout=timeout)
    except TimeoutError:
        pass
    return out


def test_a_claim_taken_over_is_released_to_its_holder_with_its_session() -> None:
    registry = ConnectionRegistry()
    loser = _open(
        registry, "loser", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    winner = _open(
        registry, "winner", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.claim_room(loser, ROOM_A)
    registry.place_session(AGENT, "session-1", ROOM_A, loser.id)

    registry.claim_room(winner, ROOM_A, takeover=True)

    assert loser.released_rooms == {ROOM_A: "session-1"}
    assert winner.released_rooms == {}


def test_connect_to_room_placement_releases_the_other_connections_session() -> None:
    """`connect_to_room` places before it claims; the frame names the session once."""
    registry = ConnectionRegistry()
    loser = _open(
        registry, "loser", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    winner = _open(
        registry, "winner", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.claim_room(loser, ROOM_A)
    registry.place_session(AGENT, "session-old", ROOM_A, loser.id)

    registry.place_session(AGENT, "session-new", ROOM_A, winner.id)
    registry.claim_room(winner, ROOM_A, takeover=True)

    assert loser.released_rooms == {ROOM_A: "session-old"}


def test_displacing_a_sibling_on_the_same_connection_releases_nothing() -> None:
    registry = ConnectionRegistry()
    conn = _open(
        registry, "watcher", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.place_session(AGENT, "session-old", ROOM_A, conn.id)

    registry.place_session(AGENT, "session-new", ROOM_A, conn.id)

    assert conn.released_rooms == {}


@pytest.mark.parametrize("speaks", [ROOM_RELEASED_PROTOCOL_REVISION - 1, None])
def test_a_client_that_cannot_take_the_frame_is_not_sent_it(speaks: int | None) -> None:
    registry = ConnectionRegistry()
    loser = _open(registry, "loser", speaks=speaks, scope="single")
    winner = _open(
        registry, "winner", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.claim_room(loser, ROOM_A)

    registry.claim_room(winner, ROOM_A, takeover=True)

    assert loser.released_rooms == {}
    assert ROOM_A not in loser.rooms


def test_taking_the_room_back_withdraws_the_unsent_release() -> None:
    registry = ConnectionRegistry()
    first = _open(
        registry, "first", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    second = _open(
        registry, "second", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.claim_room(first, ROOM_A)
    registry.claim_room(second, ROOM_A, takeover=True)

    registry.claim_room(first, ROOM_A, takeover=True)

    assert first.released_rooms == {}
    assert second.released_rooms == {ROOM_A: None}


def test_replacing_placements_is_a_full_replacement() -> None:
    registry = ConnectionRegistry()
    conn = _open(
        registry, "watcher", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.replace_placements(conn, {"session-1": ROOM_A, "session-2": ROOM_B})

    released = registry.replace_placements(conn, {"session-2": ROOM_C})

    assert released == []
    assert registry.connection_placements(conn) == {"session-2": ROOM_C}
    assert registry.placements(AGENT) == {"session-2": ROOM_C}
    assert conn.rooms == {ROOM_C}


def test_replacing_placements_leaves_other_connections_alone() -> None:
    registry = ConnectionRegistry()
    mine = _open(registry, "mine", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all")
    theirs = _open(
        registry, "theirs", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.replace_placements(theirs, {"session-t": ROOM_B})

    registry.replace_placements(mine, {"session-m": ROOM_A})
    registry.replace_placements(mine, {})

    assert registry.placements(AGENT) == {"session-t": ROOM_B}
    assert theirs.rooms == {ROOM_B}
    assert mine.rooms == set()
    assert theirs.released_rooms == {}


def test_replacing_placements_takes_a_room_over_and_releases_it() -> None:
    registry = ConnectionRegistry()
    mine = _open(registry, "mine", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all")
    theirs = _open(
        registry, "theirs", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.replace_placements(theirs, {"session-t": ROOM_A, "session-u": ROOM_B})

    released = registry.replace_placements(mine, {"session-m": ROOM_A})

    assert released == [
        Released(connection_id="theirs", room_id=ROOM_A, session_id="session-t")
    ]
    assert registry.placements(AGENT) == {"session-u": ROOM_B, "session-m": ROOM_A}
    assert theirs.rooms == {ROOM_B}
    assert mine.rooms == {ROOM_A}
    assert theirs.released_rooms == {ROOM_A: "session-t"}


def test_a_room_claimed_without_a_placement_is_released_with_no_session() -> None:
    registry = ConnectionRegistry()
    mine = _open(registry, "mine", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all")
    theirs = _open(
        registry, "theirs", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="single"
    )
    registry.claim_room(theirs, ROOM_A)

    released = registry.replace_placements(mine, {"session-m": ROOM_A})

    assert released == [
        Released(connection_id="theirs", room_id=ROOM_A, session_id=None)
    ]
    assert theirs.released_rooms == {ROOM_A: None}


def test_two_sessions_in_one_room_are_refused_without_change() -> None:
    registry = ConnectionRegistry()
    conn = _open(
        registry, "watcher", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.replace_placements(conn, {"session-1": ROOM_B})

    with pytest.raises(ValueError, match=ROOM_A):
        registry.replace_placements(conn, {"session-1": ROOM_A, "session-2": ROOM_A})

    assert registry.connection_placements(conn) == {"session-1": ROOM_B}
    assert conn.rooms == {ROOM_B}


async def test_the_displaced_stream_is_sent_room_released() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer(sequence_base=0)
    loser = _open(
        registry, "loser", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    winner = _open(
        registry, "winner", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.replace_placements(loser, {"session-1": ROOM_A})
    stream = event_stream(conn=loser, registry=registry, buffer=buffer, approvals=None)
    try:
        await anext(stream)  # connection_state
        waiting = asyncio.ensure_future(_frames_until_quiet(stream))
        await asyncio.sleep(0.05)
        registry.replace_placements(winner, {"session-2": ROOM_A})
        frames = await waiting
    finally:
        await stream.aclose()

    assert ("room_released", {"room_id": ROOM_A, "session_id": "session-1"}) in frames
    assert [name for name, _ in frames].count("room_released") == 1


async def test_an_older_client_stream_is_not_sent_room_released() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer(sequence_base=0)
    loser = _open(
        registry, "loser", speaks=ROOM_RELEASED_PROTOCOL_REVISION - 1, scope="all"
    )
    winner = _open(
        registry, "winner", speaks=ROOM_RELEASED_PROTOCOL_REVISION, scope="all"
    )
    registry.replace_placements(loser, {"session-1": ROOM_A})
    stream = event_stream(conn=loser, registry=registry, buffer=buffer, approvals=None)
    try:
        await anext(stream)  # connection_state
        waiting = asyncio.ensure_future(_frames_until_quiet(stream))
        await asyncio.sleep(0.05)
        registry.replace_placements(winner, {"session-2": ROOM_A})
        frames = await waiting
    finally:
        await stream.aclose()

    assert "room_released" not in [name for name, _ in frames]
    assert (
        "subscription_changed",
        {"rooms": [], "reason": "subscription updated"},
    ) in frames

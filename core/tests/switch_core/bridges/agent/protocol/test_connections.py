"""Connection lifecycle, room slots and liveness (CHOO-1857)."""

from __future__ import annotations

import time

import pytest

from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_TTL_SECONDS,
    MAX_CONNECTIONS_PER_AGENT,
    PROTOCOL_VERSION,
    ConnectionRegistry,
    NoStreamAttachedError,
    ProtocolVersionError,
    RoomOccupiedError,
    TooManyConnectionsError,
    UnknownConnectionError,
)

AGENT = "agent-1"
OTHER_AGENT = "agent-2"
ROOM_A = "room-a"
ROOM_B = "room-b"


def _open(
    registry: ConnectionRegistry,
    connection_id: str,
    *,
    agent_id: str = AGENT,
    scope: str = "single",
    delivery_filter: str = "all",
    spawn_capable: bool = False,
    cursor: int = 0,
):
    return registry.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope=scope,  # type: ignore[arg-type]
        delivery_filter=delivery_filter,  # type: ignore[arg-type]
        spawn_capable=spawn_capable,
        cursor=cursor,
        protocol_version=PROTOCOL_VERSION,
    )


def test_open_is_idempotent_for_the_same_id() -> None:
    registry = ConnectionRegistry()
    first = _open(registry, "c1")
    second = _open(registry, "c1")

    assert first is second
    assert len(registry.for_agent(AGENT)) == 1


def test_reopening_bumps_the_generation_so_the_old_stream_can_stand_down() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    generation = conn.stream_generation

    _open(registry, "c1")
    assert conn.stream_generation == generation + 1


def test_another_agent_cannot_attach_to_a_connection_id() -> None:
    registry = ConnectionRegistry()
    _open(registry, "c1")

    with pytest.raises(UnknownConnectionError):
        _open(registry, "c1", agent_id=OTHER_AGENT)


def test_incompatible_protocol_is_refused() -> None:
    registry = ConnectionRegistry()
    with pytest.raises(ProtocolVersionError):
        registry.open(
            agent_id=AGENT,
            connection_id="c1",
            scope="single",
            delivery_filter="all",
            spawn_capable=False,
            cursor=0,
            protocol_version=PROTOCOL_VERSION + 1,
        )


def test_connection_cap_is_enforced_loudly() -> None:
    registry = ConnectionRegistry()
    for i in range(MAX_CONNECTIONS_PER_AGENT):
        _open(registry, f"c{i}")

    with pytest.raises(TooManyConnectionsError):
        _open(registry, "one-too-many")


# ── Liveness ────────────────────────────────────────────────────────────────


def test_losing_the_stream_does_not_kill_the_connection() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    registry.claim_room(conn, ROOM_A)

    registry.detach_stream(conn.id, conn.stream_generation)

    # Still alive, still holding its room: a brief drop must not cost the slot.
    assert registry.require(AGENT, "c1") is conn
    assert registry.holder_of(AGENT, ROOM_A) is conn


def test_a_beat_without_a_stream_is_rejected() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    registry.detach_stream(conn.id, conn.stream_generation)

    # The client is alive but receiving nothing. It must be told, not left
    # believing it is connected.
    with pytest.raises(NoStreamAttachedError):
        registry.beat(AGENT, "c1", 5)


def test_a_stale_heartbeat_kills_the_connection_even_with_a_stream() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    assert conn.stream_attached

    conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1

    assert registry.sweep() == [conn]
    with pytest.raises(UnknownConnectionError):
        registry.require(AGENT, "c1")


def test_a_superseded_stream_cannot_clear_the_flag_of_its_replacement() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    stale_generation = conn.stream_generation

    _open(registry, "c1")  # reattach; generation bumps
    registry.detach_stream(conn.id, stale_generation)

    assert conn.stream_attached


def test_beat_advances_the_cursor_but_never_rewinds_it() -> None:
    registry = ConnectionRegistry()
    _open(registry, "c1")

    assert registry.beat(AGENT, "c1", 7).cursor == 7
    assert registry.beat(AGENT, "c1", 3).cursor == 7


# ── Room slots ──────────────────────────────────────────────────────────────


def test_single_scope_holds_one_room_at_a_time() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1", scope="single")

    registry.claim_room(conn, ROOM_A)
    registry.claim_room(conn, ROOM_B)

    assert conn.rooms == {ROOM_B}


def test_a_second_connection_cannot_take_a_claimed_room() -> None:
    registry = ConnectionRegistry()
    first = _open(registry, "c1")
    registry.claim_room(first, ROOM_A)

    second = _open(registry, "c2")
    with pytest.raises(RoomOccupiedError):
        registry.claim_room(second, ROOM_A)


def test_takeover_evicts_the_incumbent() -> None:
    registry = ConnectionRegistry()
    first = _open(registry, "c1")
    registry.claim_room(first, ROOM_A)
    second = _open(registry, "c2")

    evicted = registry.claim_room(second, ROOM_A, takeover=True)

    assert evicted is first
    assert first.rooms == set()
    assert registry.holder_of(AGENT, ROOM_A) is second


def test_all_scope_covers_rooms_no_session_has_claimed() -> None:
    registry = ConnectionRegistry()
    daemon = _open(registry, "daemon", scope="all", delivery_filter="addressed")

    assert registry.covers(daemon, ROOM_A)
    assert registry.covers(daemon, ROOM_B)


def test_all_scope_goes_fully_dark_on_a_claimed_room() -> None:
    registry = ConnectionRegistry()
    daemon = _open(registry, "daemon", scope="all", delivery_filter="addressed")
    session = _open(registry, "session", scope="single")
    registry.claim_room(session, ROOM_A)

    assert not registry.covers(daemon, ROOM_A)
    assert registry.covers(daemon, ROOM_B)
    assert registry.covers(session, ROOM_A)
    assert not registry.covers(session, ROOM_B)


def test_coverage_returns_to_the_daemon_when_the_session_goes() -> None:
    registry = ConnectionRegistry()
    daemon = _open(registry, "daemon", scope="all")
    session = _open(registry, "session", scope="single")
    registry.claim_room(session, ROOM_A)
    assert not registry.covers(daemon, ROOM_A)

    registry.close("session", "session ended")

    assert registry.covers(daemon, ROOM_A)
    assert registry.holder_of(AGENT, ROOM_A) is daemon


def test_rooms_of_one_agent_do_not_block_another() -> None:
    registry = ConnectionRegistry()
    mine = _open(registry, "c1")
    registry.claim_room(mine, ROOM_A)

    theirs = _open(registry, "c2", agent_id=OTHER_AGENT)
    registry.claim_room(theirs, ROOM_A)

    assert registry.holder_of(AGENT, ROOM_A) is mine
    assert registry.holder_of(OTHER_AGENT, ROOM_A) is theirs

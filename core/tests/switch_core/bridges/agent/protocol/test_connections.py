"""Connection lifecycle, room slots and liveness (CHOO-1857)."""

from __future__ import annotations

import time

import pytest

from switch_core.bridges.agent.protocol.connections import (
    FENCED_PROTOCOL_REVISION,
    HEARTBEAT_TTL_SECONDS,
    MAX_CONNECTIONS_PER_AGENT,
    PROTOCOL_ACCEPTS,
    PROTOCOL_VERSION,
    ClientDeclaration,
    Closure,
    ConnectionRegistry,
    NoStreamAttachedError,
    ProtocolVersionError,
    RoomOccupiedError,
    SupersededConnectionError,
    TooManyConnectionsError,
    UnfencedBeatError,
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
    speaks: int | None = PROTOCOL_VERSION,
):
    return registry.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope=scope,  # type: ignore[arg-type]
        delivery_filter=delivery_filter,  # type: ignore[arg-type]
        spawn_capable=spawn_capable,
        cursor=cursor,
        declaration=ClientDeclaration(speaks=speaks),
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
            declaration=ClientDeclaration(speaks=PROTOCOL_VERSION + 1),
        )


def _open_declaring(
    registry: ConnectionRegistry, declaration: ClientDeclaration, *, cid: str = "c1"
):
    return registry.open(
        agent_id=AGENT,
        connection_id=cid,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=declaration,
    )


def test_a_client_that_declares_nothing_is_admitted_as_unknown() -> None:
    """Unknown is not incompatible.

    Refusing on silence would lock out every client built before there was
    anything to say, and Part 1 of CHOO-1865 refuses nobody.
    """
    registry = ConnectionRegistry()
    conn = _open_declaring(registry, ClientDeclaration())

    assert conn.declaration.declares_protocol is False
    assert conn.declaration.protocol_floor is None


def test_a_client_declaring_only_speaks_is_read_as_a_single_revision() -> None:
    """Which is exactly how the original exact-match check behaved."""
    declaration = ClientDeclaration(speaks=PROTOCOL_VERSION)

    assert declaration.protocol_floor == PROTOCOL_VERSION


def test_overlapping_ranges_are_admitted() -> None:
    registry = ConnectionRegistry()
    conn = _open_declaring(
        registry,
        ClientDeclaration(speaks=PROTOCOL_VERSION + 3, accepts=PROTOCOL_ACCEPTS),
    )

    assert conn is not None


def test_a_client_whose_ceiling_is_below_the_server_floor_is_refused() -> None:
    registry = ConnectionRegistry()
    with pytest.raises(ProtocolVersionError) as excinfo:
        _open_declaring(
            registry,
            ClientDeclaration(
                speaks=PROTOCOL_ACCEPTS - 1, accepts=PROTOCOL_ACCEPTS - 1
            ),
        )

    # The client is behind, so the client is what should move.
    assert excinfo.value.remedy == "update the Switch agent runtime"


def test_a_client_whose_floor_is_above_the_server_ceiling_is_refused() -> None:
    registry = ConnectionRegistry()
    with pytest.raises(ProtocolVersionError) as excinfo:
        _open_declaring(
            registry,
            ClientDeclaration(
                speaks=PROTOCOL_VERSION + 1, accepts=PROTOCOL_VERSION + 1
            ),
        )

    # The server is behind, so naming the runtime would send the user to
    # downgrade the side that was already right.
    assert excinfo.value.remedy == "update switch-core"


def test_a_reattach_replaces_the_declaration() -> None:
    """The connection outlives the socket; what is on the other end need not.

    A client can be upgraded and reattach to the same connection id.
    """
    registry = ConnectionRegistry()
    _open_declaring(
        registry, ClientDeclaration(speaks=PROTOCOL_VERSION, version="1.0.0")
    )
    conn = _open_declaring(
        registry, ClientDeclaration(speaks=PROTOCOL_VERSION, version="1.1.0")
    )

    assert conn.declaration.version == "1.1.0"


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

    registry.detach_stream(conn, conn.stream_generation)

    # Still alive, still holding its room: a brief drop must not cost the slot.
    assert registry.require(AGENT, "c1") is conn
    assert registry.holder_of(AGENT, ROOM_A) is conn


def test_a_beat_without_a_stream_is_rejected() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    registry.detach_stream(conn, conn.stream_generation)

    # The client is alive but receiving nothing. It must be told, not left
    # believing it is connected.
    with pytest.raises(NoStreamAttachedError):
        registry.beat(AGENT, "c1", 5, conn.stream_generation)


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
    registry.detach_stream(conn, stale_generation)

    assert conn.stream_attached


def test_beat_advances_the_cursor_but_never_rewinds_it() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    current = conn.stream_generation

    assert registry.beat(AGENT, "c1", 7, current).cursor == 7
    assert registry.beat(AGENT, "c1", 3, current).cursor == 7


def test_a_beat_for_a_superseded_incarnation_is_refused() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    displaced = conn.stream_generation

    _open(registry, "c1")  # the winner attaches; incarnation bumps

    with pytest.raises(SupersededConnectionError) as caught:
        registry.beat(AGENT, "c1", 0, displaced)

    assert caught.value.presented == displaced
    assert caught.value.current == displaced + 1


def test_a_refused_beat_leaves_the_winners_cursor_where_it_was() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    displaced = conn.stream_generation
    winner = _open(registry, "c1")
    registry.beat(AGENT, "c1", 7, winner.stream_generation)

    before = winner.cursor
    assert before == 7

    # The displaced client is further ahead than the winner — it was sent
    # events the winner never saw. Adopting that cursor would skip them.
    with pytest.raises(SupersededConnectionError):
        registry.beat(AGENT, "c1", 99, displaced)

    assert winner.cursor == before
    assert winner.beats == 1


def test_a_refused_beat_does_not_keep_the_connection_alive() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    displaced = conn.stream_generation
    winner = _open(registry, "c1")
    aging = time.monotonic() - (HEARTBEAT_TTL_SECONDS / 2)
    winner.last_beat = aging

    with pytest.raises(SupersededConnectionError):
        registry.beat(AGENT, "c1", 0, displaced)

    # The loser cannot hold the winner's connection open on its behalf: the
    # clock keeps running, so a winner that has gone quiet still lapses.
    assert winner.last_beat == aging


def test_a_beat_from_a_client_that_cannot_be_fenced_is_accepted() -> None:
    registry = ConnectionRegistry()
    _open(registry, "c1", speaks=None)
    _open(registry, "c1", speaks=None)

    # A client that declares nothing sends no incarnation. Unknown is not
    # superseded.
    assert registry.beat(AGENT, "c1", 4, None).cursor == 4


def test_a_client_declaring_the_revision_before_the_fence_ticks_unfenced() -> None:
    registry = ConnectionRegistry()
    _open(registry, "c1", speaks=FENCED_PROTOCOL_REVISION - 1)

    # The server still accepts revision 1, and that revision has no incarnation
    # to return, so its tick is taken as it always was. Refusing it would break
    # every client released before the fence rather than fencing it.
    assert registry.beat(AGENT, "c1", 4, None).cursor == 4


def test_a_holder_that_carries_an_incarnation_may_not_tick_without_one() -> None:
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    conn.cursor = 4

    # Otherwise the fence is a formality: a displaced client that never saw its
    # own incarnation — or one that would rather not be fenced — sends null and
    # is treated as the holder, which is what the incarnation exists to stop.
    with pytest.raises(UnfencedBeatError) as caught:
        registry.beat(AGENT, "c1", 99, None)

    assert caught.value.speaks == PROTOCOL_VERSION
    assert conn.cursor == 4
    assert conn.beats == 0


def test_what_a_connection_cannot_be_fenced_by_follows_its_current_holder() -> None:
    registry = ConnectionRegistry()
    _open(registry, "c1", speaks=None)

    # A reattach replaces the declaration, so an id first opened by a client
    # that could not be fenced stops being unfenceable the moment one that can
    # takes it over. Reading the fence off the id's history instead would leave
    # a permanent hole behind every old client that ever used it.
    _open(registry, "c1")

    with pytest.raises(UnfencedBeatError):
        registry.beat(AGENT, "c1", 4, None)


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

    registry.close(
        "session", Closure(code="closed", message="session ended", room_id=None)
    )

    assert registry.covers(daemon, ROOM_A)
    assert registry.holder_of(AGENT, ROOM_A) is daemon


def test_a_removal_takes_the_room_off_every_connection_of_that_agent() -> None:
    """A claim outlives the membership it was checked against.

    `require_room_member` runs when a room is claimed and never again, so a
    session that claimed a room the agent has since been removed from keeps
    covering it for the life of its stream.
    """
    registry = ConnectionRegistry()
    session = _open(registry, "session", scope="single")
    other = _open(registry, "other", scope="single")
    registry.claim_room(session, ROOM_A)
    registry.claim_room(other, ROOM_B)

    registry.release_room_everywhere(AGENT, ROOM_A)

    assert session.rooms == set()
    assert other.rooms == {ROOM_B}
    assert registry.claimant_of(AGENT, ROOM_A) is None


def test_a_removal_does_not_touch_another_agents_claim() -> None:
    registry = ConnectionRegistry()
    mine = _open(registry, "c1")
    theirs = _open(registry, "c2", agent_id=OTHER_AGENT)
    registry.claim_room(mine, ROOM_A)
    registry.claim_room(theirs, ROOM_A)

    registry.release_room_everywhere(AGENT, ROOM_A)

    assert mine.rooms == set()
    assert theirs.rooms == {ROOM_A}


def test_a_removal_reaches_a_connection_whose_heartbeat_has_lapsed() -> None:
    """A lapsed connection still holds its claim, and can be reconnected to."""
    registry = ConnectionRegistry()
    conn = _open(registry, "c1")
    registry.claim_room(conn, ROOM_A)
    conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
    assert registry.for_agent(AGENT) == []

    registry.release_room_everywhere(AGENT, ROOM_A)

    assert conn.rooms == set()


def test_rooms_of_one_agent_do_not_block_another() -> None:
    registry = ConnectionRegistry()
    mine = _open(registry, "c1")
    registry.claim_room(mine, ROOM_A)

    theirs = _open(registry, "c2", agent_id=OTHER_AGENT)
    registry.claim_room(theirs, ROOM_A)

    assert registry.holder_of(AGENT, ROOM_A) is mine
    assert registry.holder_of(OTHER_AGENT, ROOM_A) is theirs

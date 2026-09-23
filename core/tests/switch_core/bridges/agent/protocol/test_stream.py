"""SSE delivery: catch-up, live push, resume and the control events (CHOO-1857)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from switch_core import version as version_module
from switch_core.bridges.agent.protocol import stream as stream_module
from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_LAPSED,
    HEARTBEAT_TTL_SECONDS,
    PROTOCOL_ACCEPTS,
    PROTOCOL_VERSION,
    ClientDeclaration,
    Closure,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

AGENT = "agent-1"
ROOM_A = "room-a"
ROOM_B = "room-b"


def _message(body: str, *, addressed: bool = False, room: str = ROOM_A) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=addressed,
            sender="@u:s",
            sender_name="u",
            message_id=f"$evt-{body}",
            body=body,
            timestamp=0,
        ),
    )


def _parse(frame: bytes) -> tuple[str, dict[str, Any]]:
    """Split one SSE frame into (event name, data)."""
    text = frame.decode()
    name = ""
    data = "{}"
    for line in text.strip().splitlines():
        if line.startswith("event: "):
            name = line[len("event: ") :]
        elif line.startswith("data: "):
            data = line[len("data: ") :]
    return name, json.loads(data)


async def _take(stream, count: int, timeout: float = 2.0) -> list[tuple[str, dict]]:
    """Pull `count` non-keepalive frames off the stream."""
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


def _open(registry: ConnectionRegistry, **kw: Any):
    params: dict[str, Any] = {
        "agent_id": AGENT,
        "connection_id": kw.pop("connection_id", "c1"),
        "scope": "single",
        "delivery_filter": "all",
        "spawn_capable": False,
        "cursor": 0,
        "declaration": ClientDeclaration(speaks=PROTOCOL_VERSION),
        "expected_generation": None,
    }
    params.update(kw)
    return registry.open(**params)


async def test_first_frame_is_the_connection_state() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    ((name, data),) = await _take(stream, 1)

    assert name == "connection_state"
    assert data["connection_id"] == "c1"
    assert data["scope"] == "single"
    assert data["rooms"] == [ROOM_A]
    assert data["protocol"] == PROTOCOL_VERSION
    # The client returns this on every heartbeat; without it the server cannot
    # tell the holder of a connection from a client displaced from it.
    assert data["generation"] == conn.stream_generation


async def test_the_first_frame_declares_the_server(monkeypatch) -> None:
    """Version disclosure rides this frame, not an endpoint of its own.

    The stream is already authenticated, and nothing about the server's
    version is reachable without authenticating (CHOO-1865).
    """
    monkeypatch.setattr(version_module, "switch_core_version", lambda: "9.9.9")
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    ((_, data),) = await _take(stream, 1)

    assert data["server"] == {
        "version": "9.9.9",
        "contracts": {
            "agent-protocol": {
                "speaks": PROTOCOL_VERSION,
                "accepts": PROTOCOL_ACCEPTS,
            }
        },
    }


async def test_an_unreadable_server_version_is_null_not_a_placeholder(
    monkeypatch,
) -> None:
    """Null means unknown. A placeholder would read as a version we chose."""
    monkeypatch.setattr(version_module, "switch_core_version", lambda: None)
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    ((_, data),) = await _take(stream, 1)

    assert data["server"]["version"] is None


async def test_the_first_frame_echoes_what_the_client_declared() -> None:
    """So a declaration that failed to parse cannot pass unnoticed.

    Both sides otherwise believe it landed, which is worse than never having
    sent it.
    """
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(
        registry,
        declaration=ClientDeclaration(
            speaks=PROTOCOL_VERSION,
            accepts=PROTOCOL_ACCEPTS,
            artifact="agent-runtime",
            version="0.1.5",
        ),
    )

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    ((_, data),) = await _take(stream, 1)

    assert data["client"] == {
        "speaks": PROTOCOL_VERSION,
        "accepts": PROTOCOL_ACCEPTS,
        "artifact": "agent-runtime",
        "version": "0.1.5",
    }


async def test_an_undeclared_client_is_echoed_as_all_null() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry, declaration=ClientDeclaration())

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    ((_, data),) = await _take(stream, 1)

    assert data["client"] == {
        "speaks": None,
        "accepts": None,
        "artifact": None,
        "version": None,
    }


async def test_catch_up_then_live_delivery() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    # Queued before the stream opened: must be caught up, not skipped.
    buffer.enqueue(AGENT, ROOM_A, _message("before"))

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)
    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "before"

    # Appended while the stream is open: pushed without being asked for.
    async def append_soon() -> None:
        await asyncio.sleep(0.01)
        buffer.enqueue(AGENT, ROOM_A, _message("after"))

    task = asyncio.create_task(append_soon())
    live = await _take(stream, 1)
    await task

    assert live[0][1]["payload"]["body"] == "after"


async def test_sequence_number_is_carried_for_resume() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)
    seq = buffer.enqueue(AGENT, ROOM_A, _message("one"))

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][1]["sequence"] == seq
    assert conn.cursor == seq


async def test_resuming_from_a_cursor_skips_what_was_already_seen() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    first = buffer.enqueue(AGENT, ROOM_A, _message("seen"))
    buffer.enqueue(AGENT, ROOM_A, _message("missed"))

    conn = _open(registry, cursor=first)
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "missed"


async def test_expired_cursor_produces_a_gap_event_rather_than_silence() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer(max_events_per_agent=1)
    buffer.enqueue(AGENT, ROOM_A, _message("dropped"))
    buffer.enqueue(AGENT, ROOM_A, _message("kept"))

    conn = _open(registry, cursor=0)
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][0] == "gap"
    assert "re-read" in frames[1][1]["reason"]


async def test_events_for_rooms_the_connection_does_not_cover_are_skipped() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    buffer.enqueue(AGENT, ROOM_B, _message("elsewhere", room=ROOM_B))
    buffer.enqueue(AGENT, ROOM_A, _message("mine"))

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "mine"


async def test_addressed_filter_drops_ambient_chatter() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry, scope="all", delivery_filter="addressed")

    buffer.enqueue(AGENT, ROOM_A, _message("chatter"))
    buffer.enqueue(AGENT, ROOM_B, _message("wanted", addressed=True, room=ROOM_B))

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "wanted"


async def test_a_superseded_stream_is_told_it_was_evicted() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    await _take(stream, 1)

    # A second stream attaches to the same connection id.
    _open(registry)
    buffer.enqueue(AGENT, ROOM_A, _message("wake up"))

    frames = await _take(stream, 1)
    assert frames[0][0] == "evicted"
    # The code is what the displaced client acts on: reopening would itself be
    # a takeover, so this ending is terminal and must not be read as prose.
    assert frames[0][1]["code"] == "taken_over"


async def test_closing_the_connection_ends_the_stream_with_a_reason() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    await _take(stream, 1)

    registry.close(conn.id, HEARTBEAT_LAPSED)

    frames = await _take(stream, 1)
    assert frames[0][0] == "evicted"
    assert frames[0][1]["code"] == "heartbeat_lapsed"
    assert "heartbeat lapsed" in frames[0][1]["reason"]
    assert frames[0][1]["room_id"] is None


async def test_a_close_about_a_room_names_the_room_it_was_about() -> None:
    """A client that loses a connection over a room it declared must be told which."""
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    await _take(stream, 1)

    registry.close(
        conn.id,
        Closure(code="closed", message="the room is already held", room_id=ROOM_A),
    )

    ((name, data),) = await _take(stream, 1)
    assert name == "evicted"
    assert data["code"] == "closed"
    assert data["room_id"] == ROOM_A


async def test_subscription_change_is_announced() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    await _take(stream, 1)

    registry.claim_room(conn, ROOM_B)
    frames = await _take(stream, 1)
    assert frames[0][0] == "subscription_changed"
    assert sorted(frames[0][1]["rooms"]) == sorted([ROOM_A, ROOM_B])

    # And on the way out, which is how a supervisor learns a session left a
    # room rather than inferring it from a set that only ever grows.
    registry.release_room(conn, ROOM_A)
    frames = await _take(stream, 1)
    assert frames[0][0] == "subscription_changed"
    assert frames[0][1]["rooms"] == [ROOM_B]


async def test_stream_detaches_on_exit_without_killing_the_connection() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    await _take(stream, 1)
    await stream.aclose()

    assert not conn.stream_attached
    assert registry.get(conn.id) is conn


@pytest.mark.parametrize("scope", ["single", "all"])
async def test_two_connections_receive_the_same_event(scope: str) -> None:
    """Non-destructive reads: one reader must not steal from another."""
    registry = ConnectionRegistry()
    buffer = EventBuffer()

    session = registry.open(
        agent_id=AGENT,
        connection_id="session",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    registry.claim_room(session, ROOM_A)

    other_agent = registry.open(
        agent_id="agent-2",
        connection_id="other",
        scope=scope,  # type: ignore[arg-type]
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    registry.claim_room(other_agent, ROOM_A)

    buffer.enqueue(AGENT, ROOM_A, _message("shared"))
    buffer.enqueue("agent-2", ROOM_A, _message("shared"))

    a = event_stream(conn=session, registry=registry, buffer=buffer)
    b = event_stream(conn=other_agent, registry=registry, buffer=buffer)

    assert (await _take(a, 2))[1][1]["payload"]["body"] == "shared"
    assert (await _take(b, 2))[1][1]["payload"]["body"] == "shared"


async def test_resume_replays_buffered_events_for_a_room_claimed_at_open() -> None:
    """The reconnect case the whole design exists for.

    A client that drops and comes back declares its room when it reopens. If
    the room were only claimed after the stream started, catch-up would run
    first, skip those events as "not covered", and advance the cursor past
    them — losing exactly what resume is meant to recover.
    """
    registry = ConnectionRegistry()
    buffer = EventBuffer()

    seen = buffer.enqueue(AGENT, ROOM_A, _message("before the drop"))
    buffer.enqueue(AGENT, ROOM_A, _message("while disconnected"))

    conn = _open(registry, connection_id="c-resumed", cursor=seen)
    # Claimed before the stream is created, as the endpoint does.
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "while disconnected"


async def test_events_for_uncovered_rooms_do_not_block_the_cursor() -> None:
    """Skipping is deliberate for rooms this connection does not cover."""
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    buffer.enqueue(AGENT, ROOM_B, _message("someone else's room", room=ROOM_B))
    last = buffer.enqueue(AGENT, ROOM_A, _message("mine"))

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "mine"
    assert conn.cursor == last


async def test_a_cursor_from_before_a_restart_is_reported_not_ignored() -> None:
    """The buffer is in memory, so a restart resets the numbering.

    A client that comes back with a cursor from the previous process would
    otherwise sit quietly at a position that no longer means anything, looking
    caught up while its history has a hole in it.
    """
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    buffer.enqueue(AGENT, ROOM_A, _message("after the restart"))

    conn = _open(registry, cursor=4812)  # from a previous life
    registry.claim_room(conn, ROOM_A)

    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][0] == "gap"
    assert "restarted" in frames[1][1]["reason"]


class TestALapsedHeartbeatStopsDelivery:
    """A connection nothing considers alive must not keep receiving.

    Every presence reader filters on liveness, so a connection whose heartbeat
    has lapsed is invisible to all of them — while its socket happily keeps
    handing over events. That pairing is undetectable from either side: the
    client sees traffic and assumes it is healthy, the room is told the agent is
    offline. It is what produced "my connector isn't reporting in" while
    Switch Console was demonstrably receiving the same message and spawning a
    session from it.
    """

    async def test_the_stream_evicts_when_the_heartbeat_lapses(self) -> None:
        import time as _time

        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry)
        registry.claim_room(conn, ROOM_A)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        # Consume the opening frame while still healthy.
        await _take(stream, 1)

        conn.last_beat = _time.monotonic() - (HEARTBEAT_TTL_SECONDS + 1)
        buffer.enqueue(AGENT, ROOM_A, _message("should not arrive"))

        ((name, data),) = await _take(stream, 1)

        assert name == "evicted"
        assert data["code"] == "heartbeat_lapsed"
        assert "heartbeat" in data["reason"]

    async def test_the_connection_is_closed_not_merely_ignored(self) -> None:
        """Otherwise the room slot stays claimed by a connection that is gone."""
        import time as _time

        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry)
        registry.claim_room(conn, ROOM_A)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        await _take(stream, 1)
        conn.last_beat = _time.monotonic() - (HEARTBEAT_TTL_SECONDS + 1)
        await _take(stream, 1)

        assert registry.claimant_of(AGENT, ROOM_A) is None
        assert conn.closure is not None


class TestFilteredEventsDoNotSpinTheLoop:
    """A connection must not busy-loop over events its filter excludes.

    `read_from` does not return filtered-out events, so unlike events skipped
    for room coverage they cannot advance the cursor on their way past. Left
    behind them, the stream's "anything new?" check is permanently true and the
    generator spins at full speed instead of awaiting.

    That is not a slow stream, it is a stopped server: one spinning generator
    starves the event loop, so no heartbeat is processed, so every connection in
    the process is declared dead and reconnects — which is exactly what was
    observed, with `beats=0` on connections that had only just opened.
    """

    async def test_the_cursor_advances_past_events_the_filter_excludes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)

        # Unaddressed chatter: real events, none of them notifiable.
        for i in range(3):
            buffer.enqueue(AGENT, ROOM_A, _message(f"chatter-{i}", addressed=False))

        # Shorten the keepalive so "did it reach its wait?" is answered in
        # milliseconds. A spinning generator never yields one at any interval.
        monkeypatch.setattr(stream_module, "KEEPALIVE_INTERVAL_SECONDS", 0.05)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        await _take(stream, 1)  # connection_state
        await asyncio.wait_for(anext(stream), timeout=2.0)

        assert conn.cursor == buffer.head(AGENT)
        await stream.aclose()

    async def test_an_addressed_event_after_the_excluded_ones_still_arrives(
        self,
    ) -> None:
        """Advancing past the excluded events must not skip what follows."""
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)

        buffer.enqueue(AGENT, ROOM_A, _message("chatter", addressed=False))
        buffer.enqueue(AGENT, ROOM_A, _message("for-you", addressed=True))

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        frames = await _take(stream, 2)

        assert frames[1][0] == "message"
        assert frames[1][1]["payload"]["body"] == "for-you"
        await stream.aclose()


class TestAConnectionWithNoRoomDoesNotConsume:
    """A session connection must not burn through the buffer before it has a room.

    A session spawned to answer a message opens its connection *before* the
    session boots and calls connect_to_room. During that window it covers no
    room, so every event looks uncovered — and the skip path advances the
    cursor. Left to read, it consumes its way to the end of the buffer and the
    message it was started for is behind it by the time its room arrives.

    This is the last link in that chain: the spawn hand-off can pass the right
    cursor, the client can open at the right place, and the message is still
    lost here.
    """

    async def test_the_cursor_survives_the_wait_for_a_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stream_module, "KEEPALIVE_INTERVAL_SECONDS", 0.05)
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        # Opened at 0, like a session handed its trigger's position.
        conn = _open(registry, cursor=0)

        buffer.enqueue(AGENT, ROOM_A, _message("the trigger", addressed=True))

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        await _take(stream, 1)  # connection_state
        # Parked: a keepalive rather than the event, and no cursor movement.
        await asyncio.wait_for(anext(stream), timeout=2.0)

        assert conn.cursor == 0
        await stream.aclose()

    async def test_the_trigger_arrives_once_the_room_is_claimed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stream_module, "KEEPALIVE_INTERVAL_SECONDS", 0.05)
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, cursor=0)

        buffer.enqueue(AGENT, ROOM_A, _message("the trigger", addressed=True))

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        await _take(stream, 1)
        await asyncio.wait_for(anext(stream), timeout=2.0)  # parked

        # connect_to_room, arriving late as it does in practice.
        registry.claim_room(conn, ROOM_A)

        frames = await _take(stream, 2)
        assert frames[0][0] == "subscription_changed"
        assert frames[1][0] == "message"
        assert frames[1][1]["payload"]["body"] == "the trigger"
        await stream.aclose()

    async def test_an_all_scope_connection_is_not_parked(self) -> None:
        """A watcher holds no room by design and must keep receiving."""
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, scope="all", connection_id="watcher")

        buffer.enqueue(AGENT, ROOM_A, _message("hello", addressed=True))

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        frames = await _take(stream, 2)

        assert frames[1][0] == "message"
        await stream.aclose()


async def test_replaced_stream_cannot_capture_its_successors_generation() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    old = event_stream(conn=conn, registry=registry, buffer=buffer)
    _open(registry)
    assert await _take(old, 1) == []
    assert registry.beat(AGENT, conn.id, 0, conn.stream_generation).stream_attached


async def test_closed_stream_cannot_detach_a_recreated_connection() -> None:
    registry = ConnectionRegistry()
    buffer = EventBuffer()
    conn = _open(registry)
    old = event_stream(conn=conn, registry=registry, buffer=buffer)
    await anext(old)
    registry.close(conn.id, HEARTBEAT_LAPSED)
    replacement = _open(registry)
    assert replacement is not conn
    await old.aclose()
    assert registry.beat(
        AGENT, replacement.id, 0, replacement.stream_generation
    ).stream_attached


async def test_a_resumed_stream_does_not_replay_a_room_the_agent_was_removed_from() -> (
    None
):
    """The leak this stream had no way of its own to close.

    Membership is checked when a room is claimed and never again, and an
    `all`-scope connection covers every room no sibling has claimed, so the
    stream cannot re-derive who is in what — it holds no session to ask with.
    A supervisor reconnecting with a resumed cursor therefore replayed the
    whole retained tail of a room the agent had been removed from.

    What closes it is acting on the removal once, where it is known: the
    room's events leave the buffer and its claim is released, so there is
    nothing left for any reader to be handed. This asserts the property at the
    reader that has no other defence.
    """
    registry = ConnectionRegistry()
    buffer = EventBuffer()

    buffer.enqueue(AGENT, ROOM_A, _message("said before the removal"))
    buffer.enqueue(AGENT, ROOM_B, _message("still a member here", room=ROOM_B))

    # What a kick does, through the two calls `AgentClient.on_removed` makes.
    buffer.drop_room(AGENT, ROOM_A)
    registry.release_room_everywhere(AGENT, ROOM_A)

    # The supervisor comes back and resumes from before both events.
    conn = _open(registry, connection_id="c-resumed", scope="all", cursor=0)
    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "still a member here"


async def test_a_last_event_id_reconnect_does_not_replay_a_removed_room() -> None:
    """The resume a real client actually performs.

    An SSE client reconnects by sending back the `Last-Event-ID` it last saw;
    `_resolve_start_cursor` prefers it over `start_from` and the stream resumes
    from there. That is the path the removed room's retained tail would come
    back down, and it is the one a browser or an agent runtime takes without
    being asked — so it is worth pinning separately from an explicitly
    requested `start_from`.
    """
    registry = ConnectionRegistry()
    buffer = EventBuffer()

    seen = buffer.enqueue(AGENT, ROOM_A, _message("before the drop"))
    buffer.enqueue(AGENT, ROOM_A, _message("while it was still a member"))
    buffer.enqueue(AGENT, ROOM_B, _message("in the room it kept", room=ROOM_B))

    buffer.drop_room(AGENT, ROOM_A)
    registry.release_room_everywhere(AGENT, ROOM_A)

    # `seen` is what the client would send back as Last-Event-ID: a cursor from
    # while it was still in room A, resolved to exactly this by
    # `_resolve_start_cursor`.
    conn = _open(registry, connection_id="c-reconnect", scope="all", cursor=seen)
    stream = event_stream(conn=conn, registry=registry, buffer=buffer)
    frames = await _take(stream, 2)

    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "in the room it kept"


class TestWhatADeliveredEventSaysAboutItsRoom:
    """An agent is woken for addressed traffic; the chatter rides along with it.

    The count is per room and comes off the buffer, so the client renders what
    it is told rather than tallying what it happened to filter out.
    """

    async def test_a_delivered_event_carries_the_chatter_of_its_own_room(
        self,
    ) -> None:
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)
        registry.claim_room(conn, ROOM_B)

        buffer.enqueue(AGENT, ROOM_A, _message("chatter-1"))
        buffer.enqueue(AGENT, ROOM_A, _message("chatter-2"))
        buffer.enqueue(AGENT, ROOM_B, _message("elsewhere", room=ROOM_B))
        buffer.enqueue(AGENT, ROOM_A, _message("for you", addressed=True))
        buffer.enqueue(AGENT, ROOM_B, _message("also you", addressed=True, room=ROOM_B))

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        frames = await _take(stream, 3)
        await stream.aclose()

        assert frames[1][1]["missed"] == {"count": 2, "reason": None}
        assert frames[2][1]["missed"] == {"count": 1, "reason": None}

    async def test_chatter_the_stream_walked_past_is_still_counted(self) -> None:
        """The fast-forward moves the cursor, not the reader's watermark.

        Skipping unnotifiable events is what keeps the generator from spinning;
        it must not double as a claim that the agent has seen them.
        """
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)
        chatter = buffer.enqueue(AGENT, ROOM_A, _message("chatter"))

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        await _take(stream, 1)

        waiting = asyncio.ensure_future(_take(stream, 1))
        await asyncio.sleep(0.05)
        assert conn.cursor == chatter  # walked past rather than delivered

        buffer.enqueue(AGENT, ROOM_A, _message("for you", addressed=True))
        ((_, data),) = await waiting
        await stream.aclose()

        assert data["missed"]["count"] == 1

    async def test_a_room_claimed_after_the_connection_opened_counts_from_there(
        self,
    ) -> None:
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)

        buffer.enqueue(AGENT, ROOM_B, _message("before the claim", room=ROOM_B))
        buffer.enqueue(AGENT, ROOM_A, _message("for you", addressed=True))

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        await _take(stream, 2)  # connection_state, then the message in room A

        registry.claim_room(conn, ROOM_B)
        buffer.enqueue(AGENT, ROOM_B, _message("chatter", room=ROOM_B))
        buffer.enqueue(AGENT, ROOM_B, _message("for you", addressed=True, room=ROOM_B))
        frames = await _take(stream, 2)  # subscription_changed, then the message
        await stream.aclose()

        assert frames[1][1]["missed"] == {"count": 1, "reason": None}

    async def test_a_count_is_absent_rather_than_zero_after_a_restart(self) -> None:
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        conn = _open(registry, cursor=4812)  # from a previous life
        registry.claim_room(conn, ROOM_A)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        assert (await _take(stream, 2))[1][0] == "gap"

        buffer.enqueue(AGENT, ROOM_A, _message("for you", addressed=True))
        ((_, data),) = await _take(stream, 1)
        await stream.aclose()

        assert data["missed"]["count"] is None
        assert "restarted" in data["missed"]["reason"]


class TestAGapNamesTheRoomsThatLostEvents:
    """ "Something was dropped" is unactionable across a dozen rooms."""

    async def test_an_expired_cursor_names_them(self) -> None:
        registry = ConnectionRegistry()
        buffer = EventBuffer(max_events_per_agent=2)
        buffer.enqueue(AGENT, ROOM_A, _message("dropped"))
        buffer.enqueue(AGENT, ROOM_B, _message("dropped", room=ROOM_B))
        buffer.enqueue(AGENT, ROOM_A, _message("kept"))
        buffer.enqueue(AGENT, ROOM_B, _message("kept", room=ROOM_B))

        conn = _open(registry, cursor=0)
        registry.claim_room(conn, ROOM_A)
        registry.claim_room(conn, ROOM_B)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        frames = await _take(stream, 2)
        await stream.aclose()

        assert frames[1][0] == "gap"
        assert sorted(frames[1][1]["rooms"]) == [ROOM_A, ROOM_B]

    async def test_a_restart_names_the_rooms_the_connection_covers(self) -> None:
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        buffer.enqueue(AGENT, ROOM_A, _message("after the restart"))

        conn = _open(registry, cursor=4812)
        registry.claim_room(conn, ROOM_A)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        frames = await _take(stream, 2)
        await stream.aclose()

        assert frames[1][0] == "gap"
        assert frames[1][1]["rooms"] == [ROOM_A]
        assert frames[1][1]["all_rooms"] is True

    async def test_a_restart_says_the_loss_is_not_confined_to_them(self) -> None:
        """A watcher of every room names none, and its rooms arrive afterwards.

        Reporting only what the connection had claimed would leave every room
        its sessions go on to claim answering with a fresh zero, which is the
        restart made invisible in exactly the rooms the agent works in.
        """
        registry = ConnectionRegistry()
        buffer = EventBuffer()
        buffer.enqueue(AGENT, ROOM_A, _message("after the restart"))
        conn = _open(registry, scope="all", cursor=4812)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        frames = await _take(stream, 2)

        assert frames[1][0] == "gap"
        assert frames[1][1]["rooms"] == []
        assert frames[1][1]["all_rooms"] is True

        registry.claim_room(conn, ROOM_B)
        buffer.enqueue(AGENT, ROOM_B, _message("chatter", room=ROOM_B))
        buffer.enqueue(AGENT, ROOM_B, _message("for you", addressed=True, room=ROOM_B))
        delivered = await _take(stream, 3)  # subscription_changed, then both
        await stream.aclose()

        assert delivered[-1][1]["missed"]["count"] is None
        assert "restarted" in delivered[-1][1]["missed"]["reason"]

    async def test_a_dropped_event_gap_is_confined_to_the_rooms_it_names(self) -> None:
        registry = ConnectionRegistry()
        buffer = EventBuffer(max_events_per_agent=1)
        buffer.enqueue(AGENT, ROOM_A, _message("dropped"))
        buffer.enqueue(AGENT, ROOM_A, _message("kept"))

        conn = _open(registry, cursor=0)
        registry.claim_room(conn, ROOM_A)

        stream = event_stream(conn=conn, registry=registry, buffer=buffer)
        frames = await _take(stream, 2)
        await stream.aclose()

        assert frames[1][0] == "gap"
        assert frames[1][1]["all_rooms"] is False

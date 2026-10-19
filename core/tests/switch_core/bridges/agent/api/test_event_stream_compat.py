"""An old client keeps working against this server.

Agent runtimes up to 0.8.x connect over the Server-Sent Events stream and beat
with `POST /connection/beat`, declaring agent-protocol 6 (0.7.x) or 7 (0.8.0,
which added the hosted worker).
The WebSocket replaces both, and both are kept beside it for a compatibility
window (the expand half of expand/contract), so these drive the server the way
such a client does: open the stream, read events, beat, and lapse when it stops
beating. The stream encodes the same frames the socket sends, from the same
loop, so the rules themselves are tested once, on the frames.

Such a client keeps one number. Its stream reads the room's conversation as
well as the agent's own events, so the number it is handed with each event is
a ticket standing for the whole position after it.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.responses import StreamingResponse

from switch_core.artifacts import contract_range
from switch_core.bridges.agent.api.handlers import connection_beat, poll_events
from switch_core.bridges.agent.api.schemas import ConnectionBeatRequest
from switch_core.bridges.agent.api.session_reporter import SessionReporter
from switch_core.bridges.agent.protocol.agent_connections import (
    HEARTBEAT_TTL_SECONDS,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import TICKET_FLOOR, EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, room_source
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from tests.db_buffer import say, seed_member

AGENT_ID = "agent-1"
ROOM = "room-a"
# What agent-runtime 0.7.x declares: agent-protocol 6, accepting 1.
OLD_RUNTIME = {
    "protocol_version": 6,
    "protocol_accepts": 1,
    "client": "agent-runtime",
    "client_version": "0.7.2",
}


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent these streams are for, in the room they declare, so its
    events have a row to belong to and the room a conversation to read."""
    await seed_member(session_factory, AGENT_ID, ROOM)


class _Protocol:
    def __init__(self, event_buffer: EventBuffer) -> None:
        self.event_buffer = event_buffer
        self.connections = AgentConnectionRegistry()
        self.approval_outcomes = None
        self.sessions = SessionReporter(None)

    async def record_client_declaration(
        self, agent_id: str, connection_id: str, declaration: ClientDeclaration
    ) -> None:
        return None

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        return None


def _agent() -> Any:
    return SimpleNamespace(
        id=AGENT_ID,
        tenant_id=TENANT_ZERO_ID,
        metadata_={"known_agent_type": "claude-code"},
    )


def _message(body: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=ROOM,
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id=f"${body}",
            body=body,
            timestamp=0,
        ),
    )


async def _keep(protocol: _Protocol, body: str) -> int:
    """A message addressed to the agent, kept as one of its own events."""
    return await protocol.event_buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT_ID,
        ROOM,
        _message(body),
        room_seq=0,
        message_key=f"${body}",
    )


async def _open(protocol: _Protocol, **kw: Any) -> StreamingResponse:
    params: dict[str, Any] = {
        "accept": "text/event-stream",
        "connection_id": "c1",
        "rooms": ROOM,
        **OLD_RUNTIME,
        **kw,
    }
    resp = await poll_events(
        agent_id=AGENT_ID,
        agent=_agent(),
        protocol=protocol,  # type: ignore[arg-type]
        config=None,  # type: ignore[arg-type]
        **params,
    )
    assert isinstance(resp, StreamingResponse)
    return resp


class _Reader:
    """Reads a response body the way the old runtime's `readSse` did."""

    def __init__(self, body: AsyncIterator[Any]) -> None:
        self.body = body
        self.buffered = ""

    async def frame(self, timeout: float = 2.0) -> tuple[str, str | None, dict]:
        while "\n\n" not in self.buffered:
            chunk = await asyncio.wait_for(anext(self.body), timeout)
            self.buffered += chunk.decode() if isinstance(chunk, bytes) else chunk
        raw, self.buffered = self.buffered.split("\n\n", 1)
        event, seq, data = "message", None, None
        for line in raw.split("\n"):
            if line.startswith(":"):
                continue
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("id: "):
                seq = line[len("id: ") :]
            elif line.startswith("data: "):
                data = line[len("data: ") :]
        if data is None:
            return await self.frame(timeout)
        return event, seq, json.loads(data)

    async def close(self) -> None:
        await self.body.aclose()  # type: ignore[attr-defined]


async def _beat(protocol: _Protocol, cursor: int, generation: int | None) -> Any:
    return await connection_beat(
        AGENT_ID,
        ConnectionBeatRequest.model_validate(
            {"connection_id": "c1", "cursor": cursor, "generation": generation}
        ),
        SimpleNamespace(id=AGENT_ID),  # type: ignore[arg-type]
        protocol,  # type: ignore[arg-type]
    )


async def test_an_old_client_connects_receives_beats_and_lapses(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    stream = _Reader((await _open(protocol)).body_iterator)

    event, _, state = await stream.frame()
    assert event == "connection_state"
    assert state["rooms"] == [ROOM]
    generation = state["generation"]

    seq = await _keep(protocol, "hello")
    event, sent_id, data = await stream.frame()
    assert event == "message"
    assert data["payload"]["body"] == "hello"
    # A ticket, not the event's own number, and no position it would not read.
    assert sent_id is not None
    ticket = int(sent_id)
    assert ticket >= TICKET_FLOOR
    assert data["sequence"] == ticket
    assert "position" not in data

    # The beat carries the ticket, which is not read. It is answered with where
    # the connection stands: the last ticket sent and the position it stands for.
    beaten = await _beat(protocol, ticket, generation)
    assert beaten == {
        "ok": True,
        "rooms": [ROOM],
        "cursor": ticket,
        "position": {OWN_EVENTS: seq, room_source(ROOM): 0},
    }

    conn = protocol.connections.get("c1")
    assert conn is not None
    conn.last_beat = time.monotonic() - (HEARTBEAT_TTL_SECONDS + 1)
    await _keep(protocol, "not after a lapse")

    event, _, data = await stream.frame()
    assert event == "evicted"
    assert data["code"] == "heartbeat_lapsed"
    await stream.close()

    with pytest.raises(HTTPException) as caught:
        await _beat(protocol, ticket, generation)
    assert caught.value.status_code == 404


async def test_an_old_client_resumes_from_last_event_id(db_buffer: EventBuffer) -> None:
    """A number below the ticket floor is one of the agent's own events: what
    a client was handed before its stream read the conversation."""
    protocol = _Protocol(db_buffer)
    first = await _keep(protocol, "seen")
    await _keep(protocol, "missed")

    # The old runtime sent the cursor both ways; the header wins.
    stream = _Reader(
        (
            await _open(protocol, start_from="head", last_event_id=str(first))
        ).body_iterator
    )
    await stream.frame()
    event, _, data = await stream.frame()
    await stream.close()

    assert event == "message"
    assert data["payload"]["body"] == "missed"


async def test_an_old_client_resumes_from_the_ticket_it_was_handed(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The ticket holds its place in the room as well as in the agent's own
    events, so a reconnect with it is sent both what was said while it was
    away and what was kept for it."""
    protocol = _Protocol(db_buffer)
    stream = _Reader((await _open(protocol)).body_iterator)
    await stream.frame()
    await _keep(protocol, "seen")
    _, ticket, _ = await stream.frame()
    await stream.close()

    await say(session_factory, ROOM, "said while away")
    await _keep(protocol, "kept while away")

    stream = _Reader(
        (await _open(protocol, start_from="head", last_event_id=ticket)).body_iterator
    )
    await stream.frame()
    said = await stream.frame()
    kept = await stream.frame()
    await stream.close()

    assert said[2]["payload"]["body"] == "said while away"
    assert kept[2]["payload"]["body"] == "kept while away"


async def test_an_unknown_ticket_opens_with_a_gap(db_buffer: EventBuffer) -> None:
    """A ticket the server no longer holds (expired, or another server's)
    cannot be honoured. The stream opens where things are now and says so
    first, so the client re-reads its rooms rather than believing it is caught
    up."""
    protocol = _Protocol(db_buffer)
    lost = TICKET_FLOOR + 12345

    stream = _Reader((await _open(protocol, last_event_id=str(lost))).body_iterator)
    first, _, _ = await stream.frame()
    event, _, gap = await stream.frame()
    await stream.close()

    assert first == "connection_state"
    assert event == "gap"
    assert gap["from_sequence"] == lost
    assert gap["rooms"] == [ROOM]
    assert gap["all_rooms"] is True
    assert "no longer known" in gap["reason"]


async def test_the_number_a_gap_hands_an_old_client_resumes_where_it_left_it(
    db_buffer: EventBuffer,
) -> None:
    """The old runtime adopts a gap's `resumed_at` as its number. For a client
    reading the conversation too, that number is a ticket for where the stream
    resumed: sent back, it resumes there, rather than being read as the
    agent's own events from the start and replaying all of them."""
    protocol = _Protocol(db_buffer)
    await _keep(protocol, "before the gap")
    lost = TICKET_FLOOR + 12345

    stream = _Reader((await _open(protocol, last_event_id=str(lost))).body_iterator)
    await stream.frame()
    _, _, gap = await stream.frame()
    await stream.close()
    await _keep(protocol, "after the gap")

    stream = _Reader(
        (await _open(protocol, last_event_id=str(gap["resumed_at"]))).body_iterator
    )
    await stream.frame()
    event, _, data = await stream.frame()
    await stream.close()

    assert gap["resumed_at"] >= TICKET_FLOOR
    assert event == "message"
    assert data["payload"]["body"] == "after the gap"


async def test_closing_the_stream_detaches_it_and_keeps_the_connection(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    stream = _Reader((await _open(protocol)).body_iterator)
    await stream.frame()

    await stream.close()

    conn = protocol.connections.get("c1")
    assert conn is not None
    assert not conn.stream_attached
    assert protocol.connections.live_agents_by_transport() == {
        ("detached", "agent-runtime"): 1
    }


async def test_a_stream_attached_over_sse_is_reported_as_sse(
    db_buffer: EventBuffer,
) -> None:
    protocol = _Protocol(db_buffer)
    stream = _Reader((await _open(protocol)).body_iterator)
    await stream.frame()

    assert protocol.connections.live_agents_by_transport() == {
        ("sse", "agent-runtime"): 1
    }
    await stream.close()


async def test_a_client_that_moves_to_the_socket_is_reported_on_the_socket(
    db_buffer: EventBuffer,
) -> None:
    """The transport is the last attach's: an upgraded Console reattaching the
    same connection over the socket stops counting as an old client."""
    protocol = _Protocol(db_buffer)
    stream = _Reader((await _open(protocol)).body_iterator)
    await stream.frame()

    protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id="c1",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=8, accepts=1, artifact="agent-runtime"),
        expected_generation=None,
        transport="websocket",
    )

    assert protocol.connections.live_agents_by_transport() == {
        ("websocket", "agent-runtime"): 1
    }
    await stream.close()


async def test_a_refused_stream_is_counted_like_a_refused_socket(
    db_buffer: EventBuffer,
) -> None:
    registry = MetricsRegistry()
    install(registry)
    try:
        with pytest.raises(HTTPException) as caught:
            await _open(_Protocol(db_buffer), protocol_version=99, protocol_accepts=99)
    finally:
        uninstall()

    assert caught.value.status_code == 409
    refused = next(
        p for p in registry.collect() if p.name == "switch.agent.connections_refused"
    )
    assert [(dict(p.attributes), p.value) for p in refused.numbers] == [
        ({"reason": "protocol"}, 1.0)
    ]


# ── The declared ranges still meet ──────────────────────────────────────────


def _overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    """Whether two (speaks, accepts) ranges share a revision."""
    return a[1] <= b[0] and b[1] <= a[0]


# What the releases before the socket declare, on either side: agent-protocol
# 6 (agent-runtime 0.7.x, and switch-core before the hosted worker) and 7
# (agent-runtime 0.8.0, and switch-core with it).
BEFORE_THE_SOCKET = [(6, 1), (7, 1)]


@pytest.mark.parametrize("old", BEFORE_THE_SOCKET)
def test_an_old_runtime_and_this_server_share_a_revision(old: tuple[int, int]) -> None:
    server = contract_range("agent-protocol", "switch-core")

    assert _overlap(old, (server.speaks, server.accepts))


@pytest.mark.parametrize("old", BEFORE_THE_SOCKET)
def test_this_runtime_and_an_old_server_share_a_revision(old: tuple[int, int]) -> None:
    runtime = contract_range("agent-protocol", "agent-runtime")

    assert _overlap((runtime.speaks, runtime.accepts), old)


def test_this_runtime_and_this_server_share_the_newest_revision() -> None:
    server = contract_range("agent-protocol", "switch-core")
    runtime = contract_range("agent-protocol", "agent-runtime")

    assert runtime.speaks == server.speaks


@pytest.mark.parametrize("speaks", [6, 7])
def test_this_server_admits_an_old_runtime(speaks: int) -> None:
    registry = AgentConnectionRegistry()
    conn = registry.open(
        agent_id=AGENT_ID,
        connection_id="c1",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=speaks, accepts=1),
        expected_generation=None,
        transport="sse",
    )

    assert conn.stream_transport == "sse"

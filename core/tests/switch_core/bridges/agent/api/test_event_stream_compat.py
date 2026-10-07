"""An old client keeps working against this server.

Agent runtimes up to 0.8.x connect over the Server-Sent Events stream and beat
with `POST /connection/beat`, declaring agent-protocol 6 (0.7.x) or 7 (0.8.0,
which added the hosted worker).
The WebSocket replaces both, and both are kept beside it for a compatibility
window (the expand half of expand/contract), so these drive the server the way
such a client does: open the stream, read events, beat, and lapse when it stops
beating. The stream encodes the same frames the socket sends, from the same
loop, so the rules themselves are tested once, on the frames.
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
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

AGENT_ID = "agent-1"
ROOM = "room-a"
# What agent-runtime 0.7.x declares: agent-protocol 6, accepting 1.
OLD_RUNTIME = {
    "protocol_version": 6,
    "protocol_accepts": 1,
    "client": "agent-runtime",
    "client_version": "0.7.2",
}


class _Protocol:
    def __init__(self) -> None:
        self.event_buffer = EventBuffer(sequence_base=0)
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
    return SimpleNamespace(id=AGENT_ID, metadata_={"known_agent_type": "claude-code"})


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
        ConnectionBeatRequest(connection_id="c1", cursor=cursor, generation=generation),
        SimpleNamespace(id=AGENT_ID),  # type: ignore[arg-type]
        protocol,  # type: ignore[arg-type]
    )


async def test_an_old_client_connects_receives_beats_and_lapses() -> None:
    protocol = _Protocol()
    stream = _Reader((await _open(protocol)).body_iterator)

    event, _, state = await stream.frame()
    assert event == "connection_state"
    assert state["rooms"] == [ROOM]
    generation = state["generation"]

    seq = protocol.event_buffer.enqueue(AGENT_ID, ROOM, _message("hello"))
    event, sent_seq, data = await stream.frame()
    assert event == "message"
    assert sent_seq == str(seq)
    assert data["payload"]["body"] == "hello"

    beaten = await _beat(protocol, seq, generation)
    assert beaten == {"ok": True, "rooms": [ROOM], "cursor": seq}

    conn = protocol.connections.get("c1")
    assert conn is not None
    conn.last_beat = time.monotonic() - (HEARTBEAT_TTL_SECONDS + 1)
    protocol.event_buffer.enqueue(AGENT_ID, ROOM, _message("not after a lapse"))

    event, _, data = await stream.frame()
    assert event == "evicted"
    assert data["code"] == "heartbeat_lapsed"
    await stream.close()

    with pytest.raises(HTTPException) as caught:
        await _beat(protocol, seq, generation)
    assert caught.value.status_code == 404


async def test_an_old_client_resumes_from_last_event_id() -> None:
    protocol = _Protocol()
    first = protocol.event_buffer.enqueue(AGENT_ID, ROOM, _message("seen"))
    protocol.event_buffer.enqueue(AGENT_ID, ROOM, _message("missed"))

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


async def test_closing_the_stream_detaches_it_and_keeps_the_connection() -> None:
    protocol = _Protocol()
    stream = _Reader((await _open(protocol)).body_iterator)
    await stream.frame()

    await stream.close()

    conn = protocol.connections.get("c1")
    assert conn is not None
    assert not conn.stream_attached


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
        cursor=0,
        declaration=ClientDeclaration(speaks=speaks, accepts=1),
        expected_generation=None,
        transport="sse",
    )

    assert conn.stream_transport == "sse"

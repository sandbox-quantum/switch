"""The agent connection over one WebSocket: same frames as the event stream,
authenticated once, and a heartbeat the server drives.

Opening, fencing and room claims are shared with the SSE stream and tested
there; these cover what is particular to the socket.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket, WebSocketDisconnect

from switch_core.bridges.agent.api import handlers
from switch_core.bridges.agent.api.session_reporter import SessionReporter
from switch_core.bridges.agent.dependencies import get_config, get_protocol
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import Agent

AGENT_ID = "agent-1"
ROOM = "room-a"


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


class _AuthenticatedAs:
    """What the bearer-auth middleware leaves in scope for a valid token."""

    def __init__(self, app: ASGIApp, agent: Agent) -> None:
        self.app = app
        self.agent = agent

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope["agent"] = self.agent
        await self.app(scope, receive, send)


@pytest.fixture
def protocol() -> _Protocol:
    return _Protocol()


@pytest.fixture
def client(
    protocol: _Protocol, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    # Pings every 50 ms rather than every heartbeat interval.
    monkeypatch.setattr(handlers, "HEARTBEAT_INTERVAL_SECONDS", 0.05)
    app = FastAPI()
    app.include_router(handlers.router, prefix="/agents")
    app.dependency_overrides[get_protocol] = lambda: protocol
    app.dependency_overrides[get_config] = lambda: None
    agent = Agent(
        id=AGENT_ID, name="agent", metadata_={"known_agent_type": "claude-code"}
    )
    with TestClient(_AuthenticatedAs(app, agent)) as client:  # type: ignore[arg-type]
        yield client


def _url(**params: Any) -> str:
    query = {"connection_id": "c1", "protocol": PROTOCOL_VERSION, **params}
    return f"/agents/{AGENT_ID}/connection/ws?" + "&".join(
        f"{k}={v}" for k, v in query.items()
    )


def _next(ws: Any, event: str) -> dict[str, Any]:
    """The next message with this event name, skipping pings."""
    for _ in range(50):
        message = ws.receive_json()
        if message["event"] == event:
            return message
    raise AssertionError(f"no {event} frame")


def test_it_opens_like_the_event_stream(
    client: TestClient, protocol: _Protocol
) -> None:
    with client.websocket_connect(_url(scope="all")) as ws:
        state = ws.receive_json()

        assert state["event"] == "connection_state"
        assert state["data"]["connection_id"] == "c1"
        conn = protocol.connections.get("c1")
        assert conn is not None
        assert conn.stream_attached
        assert state["data"]["generation"] == conn.stream_generation


def test_events_arrive_with_their_sequence_number(
    client: TestClient, protocol: _Protocol
) -> None:
    with client.websocket_connect(_url(rooms=ROOM)) as ws:
        ws.receive_json()
        seq = protocol.event_buffer.enqueue(
            AGENT_ID,
            ROOM,
            AgentEvent(
                type="message",
                room_id=ROOM,
                payload=MessagePayload(
                    addressed=True,
                    sender="@u:s",
                    sender_name="u",
                    message_id="$evt-1",
                    body="hello",
                    timestamp=0,
                ),
            ),
        )

        message = _next(ws, "message")

        assert message["id"] == seq
        assert message["data"]["payload"]["body"] == "hello"


def test_the_server_pings_and_a_pong_counts_as_a_beat(
    client: TestClient, protocol: _Protocol
) -> None:
    with client.websocket_connect(_url()) as ws:
        ws.receive_json()
        conn = protocol.connections.get("c1")
        assert conn is not None
        beats_before = conn.beats

        _next(ws, "ping")
        ws.send_json({"type": "pong", "cursor": 0})
        _next(ws, "ping")  # the pong has been handled by the next ping

        assert conn.beats > beats_before


def test_a_refusal_is_sent_then_the_socket_closes_with_its_status(
    client: TestClient,
) -> None:
    with client.websocket_connect(_url(scope="everywhere")) as ws:
        refused = ws.receive_json()

        assert refused["event"] == "refused"
        assert refused["data"]["status"] == 400
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 4400


def test_closing_the_socket_detaches_the_stream(
    client: TestClient, protocol: _Protocol
) -> None:
    with client.websocket_connect(_url()) as ws:
        ws.receive_json()

    conn = protocol.connections.get("c1")
    assert conn is not None
    assert not conn.stream_attached


def test_a_socket_whose_connection_is_taken_over_is_told_so(
    client: TestClient, protocol: _Protocol
) -> None:
    """Final for the client that lost it: reconnecting would take the
    connection straight back off the winner."""
    with client.websocket_connect(_url()) as loser:
        loser.receive_json()
        with client.websocket_connect(_url()) as winner:
            winner.receive_json()

            evicted = _next(loser, "evicted")

            assert evicted["data"]["code"] == "taken_over"


def test_a_socket_the_server_closed_under_it_ends_cleanly(
    client: TestClient, protocol: _Protocol, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Uvicorn closes sockets itself on shutdown, and the next send raises
    RuntimeError rather than WebSocketDisconnect."""
    send_json = WebSocket.send_json

    async def closed_on_ping(self: WebSocket, data: Any, mode: str = "text") -> None:
        if data.get("event") == "ping":
            raise RuntimeError("Unexpected ASGI message 'websocket.send'")
        await send_json(self, data, mode)  # type: ignore[arg-type]

    monkeypatch.setattr(WebSocket, "send_json", closed_on_ping)
    with client.websocket_connect(_url()) as ws:
        ws.receive_json()
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()

    conn = protocol.connections.get("c1")
    assert conn is not None
    assert not conn.stream_attached


def test_a_stream_that_fails_closes_the_socket_as_an_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: Any
) -> None:
    async def failing(**kwargs: Any) -> AsyncGenerator[Any]:
        raise RuntimeError("approval resync failed")
        yield

    monkeypatch.setattr(handlers, "event_frames", failing)
    with client.websocket_connect(_url()) as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            _next(ws, "connection_state")

    assert closed.value.code == 1011
    assert "delivery failed" in caplog.text


async def test_a_cancelled_pump_closes_its_stream() -> None:
    """Cancelled while the outbox is full, the pump is not inside the stream,
    so only closing it runs the stream's cleanup there and then."""
    closed = asyncio.Event()

    async def frames() -> AsyncGenerator[Any]:
        try:
            while True:
                yield "frame"
        finally:
            closed.set()

    stream = frames()
    outbox: asyncio.Queue[Any] = asyncio.Queue(maxsize=1)
    pump = asyncio.create_task(handlers._pump_frames(stream, outbox))
    while not outbox.full():
        await asyncio.sleep(0)

    pump.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pump

    assert closed.is_set()

"""The agent connection over one WebSocket: same frames as the event stream,
authenticated once, and a heartbeat the server drives.

Opening, fencing and room claims are shared with the SSE stream and tested
there; these cover what is particular to the socket.

The app runs on the test client's own event loop, so its db-buffer has an
engine of its own that opens connections there, and anything a test queues
goes through the client's portal onto that loop.
"""

from __future__ import annotations

import asyncio
import functools
import time
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool
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
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, Agent
from switch_core.tenant_context import tenant_scope
from tests.db_buffer import db_buffer_on, seed_agent

AGENT_ID = "agent-1"
ROOM = "room-a"


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


class _AuthenticatedAs:
    """What the bearer-auth middleware leaves for a valid token: the agent in
    scope, and its tenant bound."""

    def __init__(self, app: ASGIApp, agent: Agent) -> None:
        self.app = app
        self.agent = agent

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope["agent"] = self.agent
        with tenant_scope(self.agent.tenant_id):
            await self.app(scope, receive, send)


@pytest.fixture
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent the socket is for, so its events have a row to belong to."""
    await seed_agent(session_factory, AGENT_ID)


@pytest.fixture
def protocol(postgres_schema: str, _agent_row: None) -> Iterator[_Protocol]:
    # No pool: a pooled connection belongs to the loop that opened it, and
    # this engine is used from the test client's loop, not the test's.
    engine = create_async_engine(postgres_schema, poolclass=NullPool)
    yield _Protocol(db_buffer_on(create_session_factory(engine)))
    asyncio.run(engine.dispose())


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
        id=AGENT_ID,
        name="agent",
        tenant_id=TENANT_ZERO_ID,
        metadata_={"known_agent_type": "claude-code"},
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
        # The 50 ms heartbeat can beat the stream's first read on a busy
        # machine, so a ping may come first; nothing else may.
        state = ws.receive_json()
        while state["event"] == "ping":
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
        seq = client.portal.call(  # type: ignore[union-attr]
            functools.partial(
                protocol.event_buffer.enqueue,
                TENANT_ZERO_ID,
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
                room_seq=0,
                message_key="$evt-1",
            )
        )

        message = _next(ws, "message")

        assert message["id"] == seq
        assert message["data"]["payload"]["body"] == "hello"
        # The client speaks positions, so it is told the event's place in its
        # source too.
        assert message["data"]["position"] == {OWN_EVENTS: seq}


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


def test_an_over_long_connection_id_is_refused(
    client: TestClient, protocol: _Protocol
) -> None:
    with client.websocket_connect(_url(connection_id="c" * 7900)) as ws:
        refused = ws.receive_json()

        assert refused["event"] == "refused"
        assert refused["data"]["status"] == 400
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 4400
    assert protocol.connections.get("c" * 7900) is None


def test_closing_the_socket_detaches_the_stream(
    client: TestClient, protocol: _Protocol
) -> None:
    with client.websocket_connect(_url()) as ws:
        ws.receive_json()

    conn = protocol.connections.get("c1")
    assert conn is not None
    # The stream detaches in its own cleanup, which the socket cancels rather
    # than awaits; closed straight after opening, that cleanup may still be
    # unwinding a read from the buffer when the socket is already gone.
    deadline = time.monotonic() + 2
    while conn.stream_attached and time.monotonic() < deadline:
        time.sleep(0.01)
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

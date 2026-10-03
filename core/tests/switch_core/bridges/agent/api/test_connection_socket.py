"""The agent connection over one WebSocket: same frames as the event stream,
authenticated once, and a heartbeat the server drives.

Opening, fencing and room claims are shared with the SSE stream and tested
there; these cover what is particular to the socket.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect

from switch_core.bridges.agent.api import handlers
from switch_core.bridges.agent.api.session_reporter import SessionReporter
from switch_core.bridges.agent.dependencies import get_protocol
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
        self.event_buffer = EventBuffer()
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

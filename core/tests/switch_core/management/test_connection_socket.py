"""The controller's connection over one WebSocket: the stream's frames down,
pongs up as beats.

What the stream carries, and what a beat does, are tested against Postgres in
`test_stream.py` through the same `attach_stream` and `record_beat` the socket
calls. These cover what is particular to the socket: framing, the ping the
server drives, and how refusals and evictions are told.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.dependencies import get_protocol
from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerTakenOverError,
    UnknownControllerConnectionError,
)
from switch_core.management import controller_routes
from switch_core.management.dependencies import (
    get_management,
    get_management_session_factory,
)

CONTROLLER = "controller-1"
PATH = f"/v1/controllers/{CONTROLLER}/connection/ws?connection_id=c1&generation=7"


class _AuthenticatedAs:
    """What the bearer middleware leaves in scope for a controller token."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope["controller"] = ControllerPrincipal(
            controller_id=CONTROLLER, owner_id="owner-1", tenant_id="tenant-1"
        )
        await self.app(scope, receive, send)


class _Calls:
    def __init__(self) -> None:
        self.frames: list[dict[str, Any]] = [
            {"event": "connection_state", "data": {"connection_id": "c1"}},
            {"event": "agent.attached", "data": {"agent_id": "a1", "from_seq": 4}},
        ]
        self.attach_refusal: Exception | None = None
        self.beat_refusal: Exception | None = None
        self.beats: list[dict[str, Any]] = []


@pytest.fixture
def calls() -> _Calls:
    return _Calls()


@pytest.fixture
def client(calls: _Calls, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # Pings every 50 ms rather than every heartbeat interval.
    monkeypatch.setattr(controller_routes, "HEARTBEAT_INTERVAL_SECONDS", 0.05)

    async def attach_stream(**kwargs: Any) -> AsyncGenerator[dict[str, Any]]:
        if calls.attach_refusal is not None:
            raise calls.attach_refusal

        async def frames() -> AsyncGenerator[dict[str, Any]]:
            for frame in calls.frames:
                yield frame
            while True:  # the stream stays open until the socket goes
                yield controller_routes.IDLE
                await _sleep()

        return frames()

    def record_beat(**kwargs: Any) -> list[str]:
        calls.beats.append(kwargs)
        if calls.beat_refusal is not None:
            raise calls.beat_refusal
        return ["a1"]

    monkeypatch.setattr(controller_routes, "attach_stream", attach_stream)
    monkeypatch.setattr(controller_routes, "record_beat", record_beat)
    app = FastAPI()
    app.include_router(controller_routes.router)
    app.dependency_overrides[get_protocol] = lambda: None
    app.dependency_overrides[get_management] = lambda: None
    app.dependency_overrides[get_management_session_factory] = lambda: None
    with TestClient(_AuthenticatedAs(app)) as test_client:
        yield test_client


async def _sleep() -> None:
    await asyncio.sleep(0.01)


def _until(socket: Any, event: str) -> dict[str, Any]:
    for _ in range(50):
        frame: dict[str, Any] = socket.receive_json()
        if frame["event"] == event:
            return frame
    raise AssertionError(f"no {event} frame")


def test_the_stream_comes_down_as_json_and_the_server_pings(client: TestClient) -> None:
    with client.websocket_connect(PATH) as socket:
        first = socket.receive_json()
        second = socket.receive_json()
        ping = _until(socket, "ping")

    assert first == {"event": "connection_state", "data": {"connection_id": "c1"}}
    assert second["event"] == "agent.attached"
    assert ping == {"event": "ping", "data": {}}


def test_a_pong_is_the_beat_with_every_agents_cursor(
    client: TestClient, calls: _Calls
) -> None:
    with client.websocket_connect(PATH) as socket:
        _until(socket, "ping")
        socket.send_json({"type": "pong", "cursors": {"a1": 9, "a2": -1, "a3": "x"}})
        _until(socket, "ping")

    assert calls.beats[0]["connection_id"] == "c1"
    assert calls.beats[0]["generation"] == 7
    # A cursor that is not a non-negative integer is left out, not trusted.
    assert calls.beats[0]["cursors"] == {"a1": 9}


def test_a_refused_beat_is_told_as_evicted_then_the_socket_closes(
    client: TestClient, calls: _Calls
) -> None:
    calls.beat_refusal = ControllerTakenOverError("c1")
    with client.websocket_connect(PATH) as socket:
        _until(socket, "ping")
        socket.send_json({"type": "pong", "cursors": {}})
        evicted = _until(socket, "evicted")
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()

    assert evicted["data"]["code"] == "taken_over"
    assert closed.value.code == 1000


def test_a_refused_attach_is_a_refused_frame_then_4000_plus_the_status(
    client: TestClient, calls: _Calls
) -> None:
    calls.attach_refusal = controller_routes._connection_refusal(
        UnknownControllerConnectionError("c1")
    )
    with client.websocket_connect(PATH) as socket:
        refused = socket.receive_json()
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()

    assert refused["event"] == "refused"
    assert refused["data"]["status"] == 404
    assert refused["data"]["detail"]["code"] == "unknown_connection"
    assert closed.value.code == 4404


def test_a_controller_speaking_protocol_1_is_refused(client: TestClient) -> None:
    with client.websocket_connect(
        PATH, headers={"Switch-Controller-Protocol": "1"}
    ) as socket:
        refused = socket.receive_json()
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()

    assert refused["data"]["detail"]["code"] == "protocol_unsupported"
    assert closed.value.code == 4426


def test_another_controllers_socket_is_forbidden(client: TestClient) -> None:
    with client.websocket_connect(
        "/v1/controllers/someone-else/connection/ws?connection_id=c1&generation=7"
    ) as socket:
        refused = socket.receive_json()
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()

    assert refused["data"]["detail"]["code"] == "forbidden"
    assert closed.value.code == 4403

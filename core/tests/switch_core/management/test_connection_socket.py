"""The controller's connection over one WebSocket: the stream's frames down,
pongs up as beats, and its agents' calls up and their answers down.

What the stream carries, what a beat does and what a call answers are tested
against Postgres in `test_stream.py` and `test_socket_calls.py`, through the
same `attach_stream`, `record_beat` and `socket_calls.answer` the socket uses.
These cover what is particular to the socket: framing, the ping the server
drives, how refusals and evictions are told, and how calls share the socket.
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
from switch_core.management import controller_routes, socket_calls
from switch_core.management.dependencies import (
    get_authenticator,
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
        self.answered: list[dict[str, Any]] = []
        # Released by a test to let the calls to `slow` finish.
        self.slow = asyncio.Event()


@pytest.fixture
def calls() -> _Calls:
    return _Calls()


@pytest.fixture
def client(calls: _Calls, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # Pings every 50 ms rather than every heartbeat interval.
    monkeypatch.setattr(controller_routes, "PING_INTERVAL_SECONDS", 0.05)

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

    async def record_beat(**kwargs: Any) -> list[str]:
        calls.beats.append(kwargs)
        if calls.beat_refusal is not None:
            raise calls.beat_refusal
        return ["a1"]

    async def answer(
        message: dict[str, Any], id_: str | int, **kwargs: Any
    ) -> dict[str, Any]:
        calls.answered.append(message)
        if message["operation"] == "slow":
            await calls.slow.wait()
        return {
            "event": "call.result",
            "data": {
                "id": id_,
                "status": 200,
                "body": {"result": message["operation"]},
            },
        }

    monkeypatch.setattr(controller_routes, "attach_stream", attach_stream)
    monkeypatch.setattr(controller_routes, "record_beat", record_beat)
    monkeypatch.setattr(socket_calls, "answer", answer)
    app = FastAPI()
    app.include_router(controller_routes.router)
    app.dependency_overrides[get_protocol] = lambda: None
    app.dependency_overrides[get_authenticator] = lambda: None
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


def _call(id_: Any, operation: str = "post_message") -> dict[str, Any]:
    return {
        "type": "call",
        "id": id_,
        "agent_id": "a1",
        "operation": operation,
        "arguments": {"body": "hi"},
        "room_id": "r1",
    }


def test_a_call_is_answered_on_the_socket_by_its_id(
    client: TestClient, calls: _Calls
) -> None:
    with client.websocket_connect(PATH) as socket:
        socket.send_json(_call("c-1"))
        answer = _until(socket, "call.result")

    assert answer == {
        "event": "call.result",
        "data": {"id": "c-1", "status": 200, "body": {"result": "post_message"}},
    }
    assert calls.answered == [_call("c-1")]


def test_a_slow_call_holds_up_neither_another_call_nor_the_beat(
    client: TestClient, calls: _Calls
) -> None:
    with client.websocket_connect(PATH) as socket:
        socket.send_json(_call(1, "slow"))
        socket.send_json(_call(2))
        first = _until(socket, "call.result")
        socket.send_json({"type": "pong", "cursors": {"a1": 3}})
        _until(socket, "ping")
        _until(socket, "ping")
        beats = len(calls.beats)
        calls.slow.set()
        second = _until(socket, "call.result")

    assert first["data"]["id"] == 2
    assert beats == 1
    assert second["data"]["id"] == 1


def test_a_call_over_the_limit_is_refused_without_running(
    client: TestClient, calls: _Calls, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(socket_calls, "MAX_CALLS_IN_FLIGHT", 1)
    with client.websocket_connect(PATH) as socket:
        socket.send_json(_call(1, "slow"))
        socket.send_json(_call(2))
        refused = _until(socket, "call.result")
        calls.slow.set()
        answered = _until(socket, "call.result")

    assert refused["data"]["id"] == 2
    assert refused["data"]["status"] == 429
    assert refused["data"]["body"]["error"]["code"] == "capacity_exceeded"
    assert refused["data"]["body"]["error"]["retryable"] is True
    assert answered["data"] == {"id": 1, "status": 200, "body": {"result": "slow"}}
    assert [call["id"] for call in calls.answered] == [1]


@pytest.mark.parametrize("id_", [None, True, "", "x" * 65, {"id": 1}])
def test_a_call_with_no_id_to_answer_by_is_dropped(
    client: TestClient, calls: _Calls, id_: Any
) -> None:
    with client.websocket_connect(PATH) as socket:
        socket.send_json(_call(id_))
        socket.send_json(_call("after"))
        answer = _until(socket, "call.result")

    assert answer["data"]["id"] == "after"
    assert [call["id"] for call in calls.answered] == ["after"]


async def test_an_answer_goes_out_before_the_frames_waiting() -> None:
    outbox = controller_routes._Outbox(2)
    await outbox.put_frame({"event": "agent.event", "data": {"n": 1}})
    await outbox.put_frame({"event": "agent.event", "data": {"n": 2}})
    third = asyncio.create_task(
        outbox.put_frame({"event": "agent.event", "data": {"n": 3}})
    )
    await asyncio.sleep(0)
    outbox.put_answer({"event": "call.result", "data": {"id": 1}})

    sent = [await outbox.get(timeout=1) for _ in range(4)]
    await third

    assert not third.cancelled()
    assert [frame["event"] if frame else None for frame in sent] == [
        "call.result",
        "agent.event",
        "agent.event",
        "agent.event",
    ]
    assert await outbox.get(timeout=0.01) is None

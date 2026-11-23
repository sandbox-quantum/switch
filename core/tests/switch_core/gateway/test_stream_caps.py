"""One caller and one process hold a bounded number of long-lived gateway
streams (`gateway/stream_caps.py`). A small Starlette app stands in for the
gateway's streams, driven over raw ASGI so a stream stays open for as long as
a test holds it."""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route, Router, WebSocketRoute
from starlette.types import Message
from starlette.websockets import WebSocket

from switch_core.gateway import stream_caps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.stream_caps import GatewayStreamCaps
from switch_core.keys import Keyring

_KEYRING = Keyring.parse("test:" + secrets.token_hex(32), legacy_secret=None)


def _session(user_id: str, tenant_id: str | None = None) -> str:
    return create_jwt(
        user_id,
        f"{user_id}@example.com",
        "user",
        _KEYRING,
        tenant_id,
        session_version=0,
        auth_time=datetime.now(UTC),
        session_id=f"session-{user_id}",
        identity_session=None,
    )


class _Gateway:
    """The gateway's streams: each sends a first frame and then stays open
    until its client goes, noting which ones are running."""

    def __init__(self) -> None:
        self.running: set[str] = set()
        self.started: list[str] = []
        self.app = Router(
            routes=[
                Route("/chats/events", self.feed),
                Route("/chats/activity/events", self.feed),
                Route("/rooms", self.rooms),
                WebSocketRoute("/changes/ws", self.socket),
            ]
        )

    async def feed(self, request: Request) -> Response:
        name = request.query_params["name"]
        self.started.append(name)
        if request.query_params.get("deny"):
            return JSONResponse({"detail": "Not signed in."}, status_code=401)

        async def frames() -> AsyncIterator[bytes]:
            self.running.add(name)
            try:
                yield b"event: ready\n\n"
                await asyncio.Event().wait()
            finally:
                self.running.discard(name)

        return StreamingResponse(frames(), media_type="text/event-stream")

    async def rooms(self, request: Request) -> Response:
        return JSONResponse({"rooms": []})

    async def socket(self, websocket: WebSocket) -> None:
        name = websocket.query_params["name"]
        self.started.append(name)
        await websocket.accept()
        self.running.add(name)
        try:
            await websocket.send_text("hello")
            await websocket.receive()
        finally:
            self.running.discard(name)


class _Conn:
    """One request or socket, driven by hand."""

    def __init__(
        self,
        app: Any,
        path: str,
        name: str,
        *,
        session: str | None = None,
        socket: bool = False,
        deny: bool = False,
    ) -> None:
        self.sent: list[Message] = []
        self.inbox: asyncio.Queue[Message] = asyncio.Queue()
        query = f"name={name}" + ("&deny=1" if deny else "")
        headers = [(b"cookie", f"switch_auth={session}".encode())] if session else []
        self.scope: dict[str, Any] = {
            "type": "websocket" if socket else "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "path": path,
            "raw_path": path.encode(),
            "root_path": "",
            "query_string": query.encode(),
            "headers": headers,
            "client": ("10.0.0.1", 5000),
            "server": ("test", 80),
            "scheme": "ws" if socket else "http",
        }
        if not socket:
            self.scope["method"] = "GET"
            self.scope["http_version"] = "1.1"
        else:
            self.inbox.put_nowait({"type": "websocket.connect"})
        self.task = asyncio.create_task(app(self.scope, self.inbox.get, self._send))

    async def _send(self, message: Message) -> None:
        self.sent.append(message)

    @property
    def status(self) -> int | None:
        for message in self.sent:
            if message["type"] == "http.response.start":
                status: int = message["status"]
                return status
        return None

    @property
    def headers(self) -> dict[str, str]:
        for message in self.sent:
            if message["type"] == "http.response.start":
                return {k.decode(): v.decode() for k, v in message["headers"]}
        return {}

    @property
    def ended(self) -> bool:
        return any(
            m["type"] == "http.response.body" and not m.get("more_body", False)
            for m in self.sent
        )

    @property
    def close_code(self) -> int | None:
        for message in self.sent:
            if message["type"] == "websocket.close":
                code: int = message["code"]
                return code
        return None

    @property
    def frames(self) -> list[str]:
        return [m["text"] for m in self.sent if m["type"] == "websocket.send"]

    async def leave(self) -> None:
        """The client goes away: the server stops the request's task."""
        self.task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await self.task


async def _until(condition: Any) -> None:
    for _ in range(400):
        if condition():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition never held")


def _caps(
    gateway: _Gateway, *, per_caller: int = 2, per_process: int = 100
) -> GatewayStreamCaps:
    return GatewayStreamCaps(
        gateway.app, per_caller=per_caller, per_process=per_process, keyring=_KEYRING
    )


@pytest.fixture(autouse=True)
def _close_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stream_caps, "EVICT_AFTER_S", 0.0)


async def test_a_new_stream_past_the_limit_closes_the_callers_oldest() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=2)
    ada = _session("ada")
    first = _Conn(caps, "/chats/events", "first", session=ada)
    await _until(lambda: "first" in gateway.running)
    second = _Conn(caps, "/chats/events", "second", session=ada)
    await _until(lambda: "second" in gateway.running)

    third = _Conn(caps, "/chats/events", "third", session=ada)
    await _until(lambda: "third" in gateway.running)
    await first.task

    assert gateway.running == {"second", "third"}
    assert first.status == 200
    assert first.ended, "the closed stream's body ends, so its client reconnects"
    assert third.status == 200
    assert caps.open == 2
    for conn in (second, third):
        await conn.leave()
    assert caps.open == 0


async def test_a_new_stream_is_refused_429_while_the_oldest_is_young(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(stream_caps, "EVICT_AFTER_S", 30.0)
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1)
    ada = _session("ada")
    first = _Conn(caps, "/chats/events", "first", session=ada)
    await _until(lambda: "first" in gateway.running)

    second = _Conn(caps, "/chats/events", "second", session=ada)
    await second.task

    assert second.status == 429
    assert 1 <= int(second.headers["retry-after"]) <= 30
    assert "too many" in json.loads(second.sent[-1]["body"])["detail"]
    assert gateway.running == {"first"}, "the reader on the first stream keeps it"
    assert caps.open == 1
    await first.leave()


async def test_a_refused_sign_in_closes_nothing_and_is_not_counted() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1)
    ada = _session("ada")
    first = _Conn(caps, "/chats/events", "first", session=ada)
    await _until(lambda: "first" in gateway.running)

    # A signed-out cookie still names ada, but the route refuses it.
    denied = _Conn(caps, "/chats/events", "denied", session=ada, deny=True)
    await denied.task

    assert denied.status == 401
    assert gateway.running == {"first"}
    assert caps.open == 1
    await first.leave()


async def test_each_kind_of_stream_has_its_own_limit() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1)
    ada = _session("ada")
    feed = _Conn(caps, "/chats/events", "feed", session=ada)
    activity = _Conn(caps, "/chats/activity/events", "activity", session=ada)
    changes = _Conn(caps, "/changes/ws", "changes", session=ada, socket=True)
    await _until(lambda: gateway.running == {"feed", "activity", "changes"})

    assert caps.open == 3
    for conn in (feed, activity, changes):
        await conn.leave()


async def test_one_caller_does_not_close_anothers_streams() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1)
    ada = _Conn(caps, "/chats/events", "ada", session=_session("ada"))
    await _until(lambda: "ada" in gateway.running)

    bob = _Conn(caps, "/chats/events", "bob", session=_session("bob"))
    await _until(lambda: "bob" in gateway.running)

    assert gateway.running == {"ada", "bob"}
    for conn in (ada, bob):
        await conn.leave()


async def test_one_person_in_two_workspaces_holds_a_limit_in_each() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1)
    here = _Conn(caps, "/chats/events", "here", session=_session("ada", "t-1"))
    await _until(lambda: "here" in gateway.running)

    there = _Conn(caps, "/chats/events", "there", session=_session("ada", "t-2"))
    await _until(lambda: "there" in gateway.running)

    assert gateway.running == {"here", "there"}
    for conn in (here, there):
        await conn.leave()


async def test_past_the_process_limit_a_stream_is_refused_503_before_the_app() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=5, per_process=2)
    held = [
        _Conn(caps, "/chats/events", f"held-{i}", session=_session(f"u{i}"))
        for i in range(2)
    ]
    await _until(lambda: len(gateway.running) == 2)

    refused = _Conn(caps, "/chats/events", "refused", session=_session("carol"))
    await refused.task

    assert refused.status == 503
    assert 2 <= int(refused.headers["retry-after"]) <= 10
    assert "refused" not in gateway.started
    for conn in held:
        await conn.leave()


async def test_streams_that_end_or_are_cancelled_give_their_place_back() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1, per_process=1)
    ada = _session("ada")
    first = _Conn(caps, "/chats/events", "first", session=ada)
    await _until(lambda: "first" in gateway.running)
    await first.leave()
    assert caps.open == 0

    # Cancelled before it was accepted, as when the server goes away.
    second = _Conn(caps, "/chats/events", "second", session=ada)
    second.task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second.task
    assert caps.open == 0

    third = _Conn(caps, "/chats/events", "third", session=ada)
    await _until(lambda: "third" in gateway.running)
    assert caps.open == 1
    await third.leave()
    assert caps.open == 0


async def test_a_socket_past_the_limit_closes_the_callers_oldest_with_4429() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1)
    ada = _session("ada")
    first = _Conn(caps, "/changes/ws", "first", session=ada, socket=True)
    await _until(lambda: "first" in gateway.running)

    second = _Conn(caps, "/changes/ws", "second", session=ada, socket=True)
    await _until(lambda: "second" in gateway.running)
    await first.task

    assert first.close_code == 4429
    assert gateway.running == {"second"}
    await second.leave()
    assert caps.open == 0


async def test_a_socket_past_the_process_limit_is_refused_the_way_console_reads() -> (
    None
):
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=5, per_process=1)
    held = _Conn(caps, "/changes/ws", "held", session=_session("ada"), socket=True)
    await _until(lambda: "held" in gateway.running)

    refused = _Conn(
        caps, "/changes/ws", "refused", session=_session("bob"), socket=True
    )
    await refused.task

    assert [m["type"] for m in refused.sent] == [
        "websocket.accept",
        "websocket.send",
        "websocket.close",
    ]
    frame = json.loads(refused.frames[0])
    assert frame["event"] == "refused"
    assert frame["data"]["status"] == 503
    assert refused.close_code == 4503
    assert "refused" not in gateway.started
    await held.leave()


async def test_other_requests_are_not_counted() -> None:
    gateway = _Gateway()
    caps = _caps(gateway, per_caller=1, per_process=1)
    held = _Conn(caps, "/chats/events", "held", session=_session("ada"))
    await _until(lambda: "held" in gateway.running)

    rooms = _Conn(caps, "/rooms", "rooms", session=_session("ada"))
    await rooms.task

    assert rooms.status == 200
    await held.leave()


def test_every_stream_it_counts_is_a_gateway_route() -> None:
    from switch_core.gateway.admission import STREAMS
    from switch_core.gateway.changes import router as changes
    from switch_core.gateway.chats import router as chats
    from switch_core.gateway.stream_caps import SOCKETS

    routes = {"/chats" + r.path for r in chats.routes} | {  # type: ignore[attr-defined]
        r.path  # type: ignore[attr-defined]
        for r in changes.routes
    }
    assert set(STREAMS) | set(SOCKETS) <= routes


async def test_inside_fastapi_a_refusal_and_a_close_reach_the_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The gateway is a FastAPI app with this as a middleware: a refusal
    raised from `send` comes back out through FastAPI's exception handling."""
    from fastapi import FastAPI

    gateway = _Gateway()
    app = FastAPI()
    app.add_api_route("/chats/events", gateway.feed)
    app.add_middleware(
        GatewayStreamCaps, per_caller=1, per_process=10, keyring=_KEYRING
    )
    ada = _session("ada")
    first = _Conn(app, "/chats/events", "first", session=ada)
    await _until(lambda: "first" in gateway.running)

    second = _Conn(app, "/chats/events", "second", session=ada)
    await _until(lambda: "second" in gateway.running)
    await first.task
    assert first.ended

    monkeypatch.setattr(stream_caps, "EVICT_AFTER_S", 30.0)
    third = _Conn(app, "/chats/events", "third", session=ada)
    await third.task
    assert third.status == 429
    assert gateway.running == {"second"}
    await second.leave()

"""The bot's realtime session, against a WebSocket server speaking DDP the
way Rocket.Chat does, and which process opens it.

The server here is a real socket on localhost; only what it says is scripted.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from websockets.asyncio.server import Server, ServerConnection, serve

from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.rocketchat import adapter as adapter_module
from switch_core.bridges.collaboration.rocketchat import realtime
from switch_core.bridges.collaboration.rocketchat.adapter import RocketChatAdapter
from switch_core.bridges.collaboration.rocketchat.realtime import (
    MY_MESSAGES,
    RealtimeSession,
)
from switch_core.outbound import OutboundPolicy, OutboundURLRefused
from tests.switch_core.bridges.collaboration.rocketchat_fakes import (
    BOT_ID,
    ROOM,
    FakeRocketChat,
    started_adapter,
)

TOKEN = "test-placeholder-token"


def _changed(stream: str, event: str, *args: Any) -> dict[str, Any]:
    return {
        "msg": "changed",
        "collection": stream,
        "id": "id",
        "fields": {"eventName": event, "args": list(args)},
    }


def _posted(message_id: str, text: str = "hi") -> dict[str, Any]:
    return _changed(
        "stream-room-messages",
        MY_MESSAGES,
        {
            "_id": message_id,
            "rid": ROOM,
            "msg": text,
            "u": {"_id": "ada-id", "username": "ada"},
        },
        {"roomParticipant": True, "roomType": "c", "roomName": "general"},
    )


class DdpServer:
    """Answers the handshake as Rocket.Chat does, then sends `script`."""

    def __init__(self) -> None:
        self.script: list[dict[str, Any]] = []
        self.received: list[dict[str, Any]] = []
        self.connections = 0
        self.open = 0
        self.hosts: list[str] = []
        self.refuse_login = False
        self.drop_after_script = False
        self.pongs = asyncio.Event()
        self._server: Server | None = None

    @property
    def url(self) -> str:
        assert self._server is not None
        port = next(iter(self._server.sockets)).getsockname()[1]
        return f"ws://127.0.0.1:{port}/websocket"

    async def __aenter__(self) -> DdpServer:
        self._server = await serve(self._serve, "127.0.0.1", 0)
        return self

    async def __aexit__(self, *_: object) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def _recv(self, socket: ServerConnection) -> dict[str, Any]:
        message: dict[str, Any] = json.loads(await socket.recv())
        self.received.append(message)
        return message

    async def _serve(self, socket: ServerConnection) -> None:
        self.connections += 1
        self.open += 1
        assert socket.request is not None
        self.hosts.append(socket.request.headers["Host"])
        try:
            await self._converse(socket)
        finally:
            self.open -= 1

    async def _converse(self, socket: ServerConnection) -> None:
        assert (await self._recv(socket))["msg"] == "connect"
        await socket.send(json.dumps({"msg": "connected", "session": "s"}))
        login = await self._recv(socket)
        # A server ping in the middle of the handshake must be answered too.
        await socket.send(json.dumps({"msg": "ping"}))
        if self.refuse_login or login["params"] != [{"resume": TOKEN}]:
            error = {"error": 403, "reason": "You've been logged out by the server."}
            await socket.send(
                json.dumps({"msg": "result", "id": login["id"], "error": error})
            )
            await socket.wait_closed()
            return
        await socket.send(
            json.dumps({"msg": "result", "id": login["id"], "result": {"id": BOT_ID}})
        )
        subs: list[str] = []
        while len(subs) < 2:
            message = await self._recv(socket)
            if message["msg"] == "pong":
                self.pongs.set()
            elif message["msg"] == "sub":
                subs.append(message["id"])
        for sub in subs:
            await socket.send(json.dumps({"msg": "ready", "subs": [sub]}))
        for event in self.script:
            await socket.send(json.dumps(event))
        if self.drop_after_script:
            return
        async for raw in socket:
            message = json.loads(raw)
            self.received.append(message)
            if message.get("msg") == "pong":
                self.pongs.set()


@pytest.fixture
async def server() -> AsyncIterator[DdpServer]:
    async with DdpServer() as running:
        yield running


@pytest.fixture(autouse=True)
def _quick_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(realtime, "_FIRST_RETRY_SECONDS", 0.01)
    monkeypatch.setattr(realtime, "_LAST_RETRY_SECONDS", 0.05)


def _ago(**delta: float) -> str:
    return (datetime.now(UTC) - timedelta(**delta)).isoformat().replace("+00:00", "Z")


async def _until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(5):
        while not condition():
            await asyncio.sleep(0.01)


class Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, list[Any]]] = []
        self.subscribed = 0

    async def event(self, stream: str, event: str, args: list[Any]) -> None:
        if args and isinstance(args[0], dict) and args[0].get("msg") == "explode":
            raise RuntimeError("a handler failed")
        self.events.append((stream, event, args))

    async def on_subscribed(self) -> None:
        self.subscribed += 1


async def _loopback(host: str, port: int) -> list[str]:
    return ["127.0.0.1"]


def _session(
    server: DdpServer, recorder: Recorder, token: str = TOKEN, url: str = ""
) -> RealtimeSession:
    return RealtimeSession(
        url=url or server.url,
        user_id=BOT_ID,
        token=token,
        ssl_context=None,
        resolve=_loopback,
        on_event=recorder.event,
        on_subscribed=recorder.on_subscribed,
    )


async def test_the_session_logs_in_subscribes_and_hands_over_events_in_order(
    server: DdpServer,
) -> None:
    server.script = [_posted("m1"), {"msg": "ping", "id": "p1"}, _posted("m2")]
    recorder = Recorder()
    session = _session(server, recorder)
    session.start()
    try:
        await _until(lambda: len(recorder.events) == 2)
        await _until(lambda: server.pongs.is_set())
    finally:
        await session.stop()

    subs = [m for m in server.received if m["msg"] == "sub"]
    assert [(s["name"], s["params"]) for s in subs] == [
        ("stream-room-messages", [MY_MESSAGES, False]),
        ("stream-notify-user", [f"{BOT_ID}/subscriptions-changed", False]),
    ]
    assert [args[0]["_id"] for _, _, args in recorder.events] == ["m1", "m2"]
    assert recorder.subscribed == 1
    assert {"msg": "pong", "id": "p1"} in server.received


async def test_a_failing_handler_does_not_stop_the_events_behind_it(
    server: DdpServer,
) -> None:
    server.script = [_posted("bad", text="explode"), _posted("good")]
    recorder = Recorder()
    session = _session(server, recorder)
    session.start()
    try:
        await _until(lambda: len(recorder.events) == 1)
    finally:
        await session.stop()
    assert recorder.events[0][2][0]["_id"] == "good"


async def test_a_dropped_connection_is_reopened_and_read_back_each_time(
    server: DdpServer,
) -> None:
    server.script = [_posted("m1")]
    server.drop_after_script = True
    recorder = Recorder()
    session = _session(server, recorder)
    session.start()
    try:
        await _until(lambda: server.connections >= 3 and recorder.subscribed >= 3)
    finally:
        await session.stop()


async def test_a_refused_login_is_said_loudly_and_retried(
    server: DdpServer, caplog: pytest.LogCaptureFixture
) -> None:
    recorder = Recorder()
    session = _session(server, recorder, token="revoked")
    session.start()
    try:
        await _until(lambda: server.connections >= 2)
    finally:
        await session.stop()
    assert recorder.subscribed == 0
    assert "refused to log the bot in" in caplog.text
    # The token is never written to the log.
    assert "revoked" not in caplog.text


async def test_stopping_closes_the_session(server: DdpServer) -> None:
    recorder = Recorder()
    session = _session(server, recorder)
    session.start()
    await _until(lambda: recorder.subscribed == 1)
    assert server.open == 1
    await session.stop()
    await _until(lambda: server.open == 0)
    await asyncio.sleep(0.1)
    assert server.connections == 1


async def test_the_socket_goes_to_the_address_that_was_checked(
    server: DdpServer,
) -> None:
    # A name that resolves nowhere: the session must connect to the address
    # its resolver allowed, not look the name up again for itself.
    port = server.url.split(":")[2].split("/")[0]
    url = f"ws://chat.example.invalid:{port}/websocket"
    recorder = Recorder()
    session = _session(server, recorder, url=url)
    session.start()
    try:
        await _until(lambda: recorder.subscribed == 1)
    finally:
        await session.stop()
    assert server.hosts == [f"chat.example.invalid:{port}"]


# ── Which process listens ────────────────────────────────────────────────────


@pytest.fixture
def pointed_at(
    server: DdpServer, monkeypatch: pytest.MonkeyPatch
) -> Callable[[], None]:
    def point() -> None:
        monkeypatch.setattr(adapter_module, "_websocket_url", lambda _: server.url)

    return point


async def test_a_quiet_copy_opens_no_socket_but_still_sends(
    server: DdpServer, pointed_at: Callable[[], None], monkeypatch: pytest.MonkeyPatch
) -> None:
    pointed_at()
    fake = FakeRocketChat()
    quiet = await started_adapter(fake, monkeypatch, listening=False)
    try:
        assert await quiet.send_message(ROOM, "coder", "from a quiet copy") is not None
        await asyncio.sleep(0.1)
        assert server.connections == 0
    finally:
        await quiet.stop()


async def test_the_holder_listens_and_the_next_holder_reads_back_the_gap(
    server: DdpServer, pointed_at: Callable[[], None], monkeypatch: pytest.MonkeyPatch
) -> None:
    pointed_at()
    fake = FakeRocketChat()
    # The checkpoint lives on the server, so a second process sees the first's.
    read: list[str] = []
    fake.on("subscriptions.read", lambda call: read.append(call.body["rid"]) or {})
    fake.on(
        "subscriptions.get",
        lambda _: {"update": [{"rid": ROOM, "t": "c", "ls": _ago(minutes=10)}]},
    )
    missed = {
        "_id": "missed",
        "rid": ROOM,
        "msg": "while handing over",
        "u": {"_id": "ada-id", "username": "ada"},
        "ts": _ago(minutes=9),
    }
    fake.on(
        "chat.syncMessages", lambda _: {"result": {"updated": [missed], "deleted": []}}
    )
    server.script = [_posted("live")]

    received: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        received.append(message)

    holder = await started_adapter(fake, monkeypatch, listening=True)
    holder._on_message = on_message
    try:
        await _until(lambda: {m.message_ref for m in received} == {"missed", "live"})
    finally:
        await holder.stop()
    assert server.connections == 1
    assert read == [ROOM, ROOM]

    # The bridge moves: the next holder reads back again and Switch, keyed on
    # each message's id, drops what it already has.
    received.clear()
    server.script = []
    next_holder = await started_adapter(fake, monkeypatch, listening=True)
    next_holder._on_message = on_message
    try:
        await _until(lambda: [m.message_ref for m in received] == ["missed"])
    finally:
        await next_holder.stop()
    assert server.connections == 2


async def test_the_socket_address_is_checked_against_the_outbound_policy(
    server: DdpServer, pointed_at: Callable[[], None], monkeypatch: pytest.MonkeyPatch
) -> None:
    pointed_at()
    fake = FakeRocketChat()
    checked: list[tuple[str, int]] = []

    async def refuse(self: OutboundPolicy, host: str, port: int) -> list[str]:
        checked.append((host, port))
        raise OutboundURLRefused("127.0.0.1 is a private address")

    monkeypatch.setattr(OutboundPolicy, "resolve", refuse)
    holder: RocketChatAdapter = await started_adapter(fake, monkeypatch, listening=True)
    try:
        await _until(lambda: len(checked) >= 2)
    finally:
        await holder.stop()
    port = int(server.url.split(":")[2].split("/")[0])
    assert checked[0] == ("127.0.0.1", port)
    assert server.connections == 0

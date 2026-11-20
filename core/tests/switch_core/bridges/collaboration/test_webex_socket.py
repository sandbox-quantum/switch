"""The Webex event socket against a real WebSocket server on localhost.

The device registry is faked over `httpx.MockTransport` and names a local
socket; the socket is a real `websockets` server speaking the frames Webex's
does. Trust is widened to that local address explicitly — by default the bot
token goes down no socket that is not on a Webex host, which is tested too.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from datetime import datetime
from typing import Any

import httpx
import pytest
from websockets.asyncio.server import ServerConnection, serve

from switch_core.bridges.collaboration.webex import socket as webex_socket
from switch_core.bridges.collaboration.webex.client import WebexClient
from switch_core.bridges.collaboration.webex.socket import (
    DEVICE_NAME,
    WDM_URL,
    WebexEventStream,
    is_webex_socket,
)

DEVICE_URL = f"{WDM_URL}/devices/dev-1"


def _local(url: str) -> bool:
    return url.startswith("ws://127.0.0.1:")


async def _until(check: Callable[[], bool], timeout: float = 5.0) -> None:
    async with asyncio.timeout(timeout):
        while not check():
            await asyncio.sleep(0.01)


def _activity_frame(frame_id: str, verb: str = "post") -> str:
    return json.dumps(
        {
            "id": frame_id,
            "data": {
                "eventType": "conversation.activity",
                "activity": {"id": f"activity-{frame_id}", "verb": verb},
            },
        }
    )


class Server:
    """A local socket that behaves like Webex's, scripted per connection."""

    def __init__(self) -> None:
        self.url = ""
        self.connections = 0
        self.received: list[dict[str, Any]] = []
        # One script per connection, in order; the last one repeats.
        self.scripts: list[Callable[[ServerConnection], Any]] = []

    async def handler(self, connection: ServerConnection) -> None:
        self.connections += 1
        script = self.scripts[min(self.connections, len(self.scripts)) - 1]
        reader = asyncio.create_task(self._read(connection))
        try:
            await script(connection)
        finally:
            reader.cancel()

    async def _read(self, connection: ServerConnection) -> None:
        async for frame in connection:
            self.received.append(json.loads(frame))

    def acks(self) -> list[str]:
        return [f["messageId"] for f in self.received if f.get("type") == "ack"]

    def authorizations(self) -> list[dict[str, Any]]:
        return [f for f in self.received if f.get("type") == "authorization"]


@pytest.fixture
async def server() -> AsyncIterator[Server]:
    fake = Server()
    async with serve(fake.handler, "127.0.0.1", 0) as running:
        port = next(iter(running.sockets)).getsockname()[1]
        fake.url = f"ws://127.0.0.1:{port}/"
        yield fake


@pytest.fixture(autouse=True)
def quick_reconnect(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(webex_socket, "_BACKOFF_FIRST", 0.01)


class Registry:
    """The device registry: lists, registers and deletes the bot's devices."""

    def __init__(self, socket_url: str, *, existing: bool = True) -> None:
        self.socket_url = socket_url
        self.devices: list[dict[str, Any]] = (
            [{"name": DEVICE_NAME, "url": DEVICE_URL, "webSocketUrl": socket_url}]
            if existing
            else []
        )
        self.registered = 0
        self.deleted: list[str] = []
        self.listed = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer bot-token"
        url = str(request.url)
        if request.method == "GET" and url == f"{WDM_URL}/devices":
            self.listed += 1
            if not self.devices:
                # What Webex answers for an account that has never had one.
                return httpx.Response(404, json={"message": "No devices found"})
            return httpx.Response(200, json={"devices": self.devices})
        if request.method == "POST" and url == f"{WDM_URL}/devices":
            self.registered += 1
            device = {
                "name": DEVICE_NAME,
                "url": f"{WDM_URL}/devices/dev-{self.registered + 1}",
                "webSocketUrl": self.socket_url,
            }
            self.devices = [device]
            return httpx.Response(200, json=device)
        if request.method == "DELETE":
            self.deleted.append(url)
            return httpx.Response(204)
        return httpx.Response(404)


class Heard:
    def __init__(self) -> None:
        self.activities: list[dict[str, Any]] = []
        self.opened: list[datetime | None] = []

    async def activity(self, activity: dict[str, Any]) -> None:
        if activity.get("verb") == "explode":
            raise RuntimeError("an unreadable event")
        self.activities.append(activity)

    async def connected(self, down_since: datetime | None) -> None:
        self.opened.append(down_since)


def _stream(
    registry: Registry, heard: Heard, *, trusts: Callable[[str], bool] = _local
) -> WebexEventStream:
    http = httpx.AsyncClient(transport=httpx.MockTransport(registry))
    return WebexEventStream(
        WebexClient("bot-token", http),
        "bot-token",
        on_activity=heard.activity,
        on_connected=heard.connected,
        trusts_socket=trusts,
    )


async def _hold(connection: ServerConnection) -> None:
    await connection.wait_closed()


async def test_the_socket_authorises_and_hands_on_each_activity(server: Server) -> None:
    async def script(connection: ServerConnection) -> None:
        await _until(lambda: bool(server.authorizations()))
        await connection.send(_activity_frame("f1"))
        await connection.send(
            json.dumps({"id": "f2", "data": {"eventType": "status.start_typing"}})
        )
        await connection.send(_activity_frame("f3", verb="explode"))
        await connection.send(_activity_frame("f4", verb="share"))
        await connection.wait_closed()

    server.scripts = [script]
    registry, heard = Registry(server.url), Heard()
    stream = _stream(registry, heard)
    stream.start()
    try:
        await _until(lambda: len(heard.activities) == 2)
        await _until(lambda: len(server.acks()) == 4)
    finally:
        await stream.stop()

    [auth] = server.authorizations()
    assert auth["data"] == {"token": "Bearer bot-token"}
    # Every frame is acknowledged, not only the ones handed on.
    assert server.acks() == ["f1", "f2", "f3", "f4"]
    # An event the handler fails on does not stop the ones after it.
    assert [a["verb"] for a in heard.activities] == ["post", "share"]
    # The existing device was reused rather than another one registered.
    assert registry.registered == 0
    assert heard.opened == [None]


async def test_a_dropped_socket_reconnects_and_says_when_it_went_down(
    server: Server,
) -> None:
    async def drop(connection: ServerConnection) -> None:
        await _until(lambda: bool(server.authorizations()))
        await connection.close(1011, "going away")

    server.scripts = [drop, _hold]
    heard = Heard()
    stream = _stream(Registry(server.url), heard)
    stream.start()
    try:
        await _until(lambda: len(heard.opened) == 2)
        assert stream.connected
    finally:
        await stream.stop()

    first, second = heard.opened
    assert first is None
    assert isinstance(second, datetime)
    assert server.connections == 2


async def test_a_socket_webex_turns_away_gets_a_fresh_device(server: Server) -> None:
    async def refuse(connection: ServerConnection) -> None:
        await connection.close(4400, "device unknown")

    server.scripts = [refuse, _hold]
    registry, heard = Registry(server.url), Heard()
    stream = _stream(registry, heard)
    stream.start()
    try:
        await _until(lambda: server.connections == 2)
        await _until(lambda: registry.registered == 1)
    finally:
        await stream.stop()


async def test_the_token_goes_down_no_socket_off_webex(server: Server) -> None:
    server.scripts = [_hold]
    registry, heard = Registry(server.url), Heard()
    stream = _stream(registry, heard, trusts=is_webex_socket)
    stream.start()
    try:
        # It keeps asking for a device, and never connects to what it is given.
        await _until(lambda: registry.listed + registry.registered >= 3)
    finally:
        await stream.stop()
    assert server.connections == 0
    assert heard.opened == []


def test_only_webex_hosts_are_trusted_with_the_token() -> None:
    assert is_webex_socket(
        "wss://mercury-connection-a.wbx2.com/v1/apps/wx2/registrations/x/messages"
    )
    assert not is_webex_socket("ws://mercury-connection-a.wbx2.com/x")
    assert not is_webex_socket("wss://wbx2.com.evil.example/x")
    assert not is_webex_socket("wss://127.0.0.1:443/")


async def test_withdrawing_removes_the_bots_device() -> None:
    registry, heard = Registry("wss://mercury.wbx2.com/x"), Heard()
    stream = _stream(registry, heard)
    await stream.forget_device()
    assert registry.deleted == [DEVICE_URL]


async def test_a_bot_with_no_device_yet_registers_one(server: Server) -> None:
    server.scripts = [_hold]
    registry, heard = Registry(server.url, existing=False), Heard()
    stream = _stream(registry, heard)
    stream.start()
    try:
        await _until(lambda: heard.opened == [None])
    finally:
        await stream.stop()
    assert registry.registered == 1


def _close_once_authorised(server: Server) -> Callable[[ServerConnection], Any]:
    """Accept the socket, wait for its authorisation, then close it."""

    async def script(connection: ServerConnection) -> None:
        opened = server.connections
        await _until(lambda: len(server.authorizations()) >= opened)
        await connection.close(1011, "going away")

    return script


async def _connections_in(server: Server, seconds: float) -> int:
    stream = _stream(Registry(server.url), Heard())
    stream.start()
    try:
        await asyncio.sleep(seconds)
    finally:
        await stream.stop()
    return server.connections


async def test_a_socket_webex_closes_at_once_keeps_backing_off(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Opening is not enough to start the backoff over: each reconnect lists
    # devices and reads back what was missed, so one Webex accepts and closes
    # straight away must not be retried every second.
    monkeypatch.setattr(webex_socket, "_STABLE_AFTER", 60.0)
    server.scripts = [_close_once_authorised(server)]
    assert await _connections_in(server, 0.5) < 12


async def test_a_socket_that_stayed_up_reconnects_quickly(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(webex_socket, "_STABLE_AFTER", 0.0)
    server.scripts = [_close_once_authorised(server)]
    assert await _connections_in(server, 0.5) >= 12

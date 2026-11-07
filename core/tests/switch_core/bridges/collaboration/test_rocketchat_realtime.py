"""The realtime client, against a real local WebSocket server speaking DDP."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from websockets.asyncio.client import ClientConnection, connect
from websockets.asyncio.server import ServerConnection, serve

from switch_core.bridges.collaboration.rocketchat import realtime
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)
from switch_core.bridges.collaboration.rocketchat.realtime import (
    RealtimeConnection,
    RealtimeEvent,
    RealtimeLoginRefused,
    RoomMessage,
    SubscriptionAdded,
    parse_event,
    websocket_url,
)
from switch_core.outbound import OutboundPolicy, OutboundURLRefused

BOT = "bot-id"
TOKEN = "good-token"


def _room_frame(message_id: str) -> dict[str, Any]:
    return {
        "msg": "changed",
        "collection": "stream-room-messages",
        "fields": {
            "eventName": "__my_messages__",
            "args": [
                {"_id": message_id, "rid": "room-1", "msg": "hi"},
                {"roomType": "p", "roomName": "ops", "roomParticipant": True},
            ],
        },
    }


class Ddp:
    """Just enough of a Rocket.Chat server's realtime side."""

    def __init__(self) -> None:
        self.connections: list[ServerConnection] = []
        self.logins: list[Any] = []
        self.subscriptions: list[list[Any]] = []
        self.pongs = 0
        self.ready = asyncio.Event()

    async def handle(self, socket: ServerConnection) -> None:
        self.connections.append(socket)
        async for raw in socket:
            frame = json.loads(raw)
            kind = frame.get("msg")
            if kind == "connect":
                await socket.send(json.dumps({"msg": "connected", "session": "s"}))
            elif kind == "method":
                [params] = frame["params"]
                self.logins.append(params)
                answer: dict[str, Any] = {"msg": "result", "id": frame["id"]}
                if params.get("resume") != TOKEN:
                    answer["error"] = {"error": 403, "reason": "You've been logged out"}
                await socket.send(json.dumps(answer))
            elif kind == "sub":
                self.subscriptions.append([frame["name"], frame["params"][0]])
                await socket.send(json.dumps({"msg": "ready", "subs": [frame["id"]]}))
                if len(self.subscriptions) % 2 == 0:
                    self.ready.set()
            elif kind == "pong":
                self.pongs += 1

    async def push(self, frame: dict[str, Any]) -> None:
        await self.connections[-1].send(json.dumps(frame))


@pytest.fixture
async def ddp() -> AsyncIterator[tuple[Ddp, str]]:
    server = Ddp()
    async with serve(server.handle, "127.0.0.1", 0) as running:
        port = next(iter(running.sockets)).getsockname()[1]
        yield server, f"ws://127.0.0.1:{port}/websocket"


async def _dial(url: str) -> ClientConnection:
    return await connect(url, ping_interval=None)


class Listener:
    def __init__(self) -> None:
        self.events: list[RealtimeEvent] = []
        self.connected = 0
        self.arrived = asyncio.Event()

    async def on_event(self, event: RealtimeEvent) -> None:
        self.events.append(event)
        self.arrived.set()

    async def on_connected(self) -> None:
        self.connected += 1
        self.arrived.set()

    async def wait(self) -> None:
        async with asyncio.timeout(3):
            await self.arrived.wait()
        self.arrived.clear()


def _connection(url: str, listener: Listener, token: str = TOKEN) -> RealtimeConnection:
    return RealtimeConnection(
        url=url,
        token=token,
        bot_id=BOT,
        on_event=listener.on_event,
        on_connected=listener.on_connected,
        dial=_dial,
    )


class TestAddress:
    @pytest.mark.parametrize(
        ("server", "expected"),
        [
            ("https://chat.example.test", "wss://chat.example.test/websocket"),
            ("http://localhost:3000", "ws://localhost:3000/websocket"),
            ("https://example.test/chat/", "wss://example.test/chat/websocket"),
        ],
    )
    def test_it_comes_from_the_server_address(self, server: str, expected: str) -> None:
        assert websocket_url(server) == expected


class TestParsing:
    def test_a_room_message_carries_its_room(self) -> None:
        event = parse_event(_room_frame("m1"), bot_id=BOT)
        assert isinstance(event, RoomMessage)
        assert event.message["_id"] == "m1"
        assert (event.room_type, event.room_name) == ("p", "ops")

    def test_being_added_to_a_room(self) -> None:
        frame = {
            "msg": "changed",
            "collection": "stream-notify-user",
            "fields": {
                "eventName": f"{BOT}/subscriptions-changed",
                "args": ["inserted", {"rid": "room-2"}],
            },
        }
        event = parse_event(frame, bot_id=BOT)
        assert isinstance(event, SubscriptionAdded)
        assert event.subscription["rid"] == "room-2"

    @pytest.mark.parametrize(
        "frame",
        [
            {"msg": "added"},
            {"msg": "changed", "collection": "stream-room-messages"},
            {"msg": "changed", "collection": "stream-room-messages", "fields": {}},
            {
                "msg": "changed",
                "collection": "stream-notify-user",
                "fields": {
                    "eventName": f"{BOT}/subscriptions-changed",
                    "args": ["removed", {"rid": "r"}],
                },
            },
            {
                "msg": "changed",
                "collection": "stream-notify-user",
                "fields": {
                    "eventName": "someone-else/subscriptions-changed",
                    "args": ["inserted", {"rid": "r"}],
                },
            },
        ],
    )
    def test_anything_else_is_ignored(self, frame: dict[str, Any]) -> None:
        assert parse_event(frame, bot_id=BOT) is None


class TestConnection:
    async def test_it_logs_in_with_the_token_and_subscribes(
        self, ddp: tuple[Ddp, str]
    ) -> None:
        server, url = ddp
        listener = Listener()
        connection = _connection(url, listener)
        await connection.start()
        await listener.wait()
        await connection.stop()
        assert server.logins == [{"resume": TOKEN}]
        assert server.subscriptions == [
            ["stream-room-messages", "__my_messages__"],
            ["stream-notify-user", f"{BOT}/subscriptions-changed"],
        ]
        assert listener.connected == 1

    async def test_a_refused_token_is_raised_from_start(
        self, ddp: tuple[Ddp, str]
    ) -> None:
        _, url = ddp
        with pytest.raises(RealtimeLoginRefused, match="logged out"):
            await _connection(url, Listener(), token="bad").start()

    async def test_events_arrive_in_order(self, ddp: tuple[Ddp, str]) -> None:
        server, url = ddp
        listener = Listener()
        connection = _connection(url, listener)
        await connection.start()
        await listener.wait()
        for ident in ("m1", "m2", "m3"):
            await server.push(_room_frame(ident))
        async with asyncio.timeout(3):
            while len(listener.events) < 3:
                await listener.wait()
        await connection.stop()
        assert [
            e.message["_id"] for e in listener.events if isinstance(e, RoomMessage)
        ] == ["m1", "m2", "m3"]

    async def test_a_ping_is_answered_while_an_event_is_being_handled(
        self, ddp: tuple[Ddp, str]
    ) -> None:
        server, url = ddp
        slow = asyncio.Event()
        listener = Listener()

        async def on_event(_: RealtimeEvent) -> None:
            await slow.wait()

        connection = RealtimeConnection(
            url=url,
            token=TOKEN,
            bot_id=BOT,
            on_event=on_event,
            on_connected=listener.on_connected,
            dial=_dial,
        )
        await connection.start()
        await server.push(_room_frame("m1"))
        await server.push({"msg": "ping"})
        async with asyncio.timeout(3):
            while server.pongs == 0:
                await asyncio.sleep(0.01)
        slow.set()
        await connection.stop()

    async def test_one_bad_event_does_not_stop_the_next(
        self, ddp: tuple[Ddp, str]
    ) -> None:
        server, url = ddp
        seen: list[str] = []
        done = asyncio.Event()

        async def on_event(event: RealtimeEvent) -> None:
            assert isinstance(event, RoomMessage)
            seen.append(event.message["_id"])
            if event.message["_id"] == "bad":
                raise RuntimeError("could not handle this one")
            done.set()

        async def on_connected() -> None:
            return None

        connection = RealtimeConnection(
            url=url,
            token=TOKEN,
            bot_id=BOT,
            on_event=on_event,
            on_connected=on_connected,
            dial=_dial,
        )
        await connection.start()
        await server.push(_room_frame("bad"))
        await server.push(_room_frame("good"))
        async with asyncio.timeout(3):
            await done.wait()
        await connection.stop()
        assert seen == ["bad", "good"]

    async def test_a_dropped_connection_comes_back_and_reads_back_again(
        self, ddp: tuple[Ddp, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server, url = ddp
        monkeypatch.setattr(realtime, "_BACKOFF_FIRST_SECONDS", 0.01)
        listener = Listener()
        connection = _connection(url, listener)
        await connection.start()
        await listener.wait()
        await server.connections[-1].close()
        async with asyncio.timeout(3):
            while listener.connected < 2:
                await listener.wait()
        await connection.stop()
        assert len(server.logins) == 2

    async def test_a_server_that_is_down_is_tried_again_rather_than_fatal(
        self, ddp: tuple[Ddp, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _, url = ddp
        monkeypatch.setattr(realtime, "_BACKOFF_FIRST_SECONDS", 0.01)
        attempts = 0

        async def flaky(address: str) -> ClientConnection:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError("connection refused")
            return await _dial(address)

        listener = Listener()
        connection = RealtimeConnection(
            url=url,
            token=TOKEN,
            bot_id=BOT,
            on_event=listener.on_event,
            on_connected=listener.on_connected,
            dial=flaky,
        )
        await connection.start()
        async with asyncio.timeout(3):
            while listener.connected == 0:
                await listener.wait()
        await connection.stop()
        assert attempts == 2

    async def test_a_failure_nothing_can_mend_is_raised_from_start(
        self, ddp: tuple[Ddp, str]
    ) -> None:
        _, url = ddp

        async def refused(_: str) -> ClientConnection:
            raise OutboundURLRefused("that address is not allowed")

        listener = Listener()
        connection = RealtimeConnection(
            url=url,
            token=TOKEN,
            bot_id=BOT,
            on_event=listener.on_event,
            on_connected=listener.on_connected,
            dial=refused,
        )
        async with asyncio.timeout(3):
            with pytest.raises(OutboundURLRefused):
                await connection.start()


class TestDialling:
    def _adapter(self, url: str, policy: str) -> RocketChatAdapter:
        adapter = RocketChatAdapter(
            config=RocketChatConnectionConfig.model_validate(
                {"server_url": url, "user_id": BOT, "access_token": TOKEN}
            )
        )
        adapter.set_outbound_policy(OutboundPolicy.parse(policy))
        return adapter

    async def test_every_address_of_a_name_is_tried(
        self, ddp: tuple[Ddp, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _, url = ddp
        port = url.rsplit(":", 1)[1].split("/")[0]
        policy = OutboundPolicy.parse("localhost")
        adapter = self._adapter(f"http://localhost:{port}", "localhost")

        async def both_stacks(_: OutboundPolicy, host: str, port: int) -> list[str]:
            return ["::1", "127.0.0.1"]

        monkeypatch.setattr(OutboundPolicy, "resolve", both_stacks)
        adapter.set_outbound_policy(policy)
        socket = await adapter._dial(f"ws://localhost:{port}/websocket")
        await socket.close()

    async def test_an_address_the_policy_refuses_is_not_dialled(self) -> None:
        adapter = self._adapter("http://127.0.0.1:1", "")
        with pytest.raises(OutboundURLRefused):
            await adapter._dial("ws://127.0.0.1:1/websocket")

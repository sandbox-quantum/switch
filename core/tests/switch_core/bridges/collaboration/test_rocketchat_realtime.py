"""The realtime client against a real WebSocket speaking DDP on localhost."""

from __future__ import annotations

import asyncio
import json
import ssl
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import pytest
import pytest_asyncio
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosedOK

from switch_core.bridges.collaboration.rocketchat import realtime as module
from switch_core.bridges.collaboration.rocketchat.realtime import (
    RealtimeError,
    RocketChatRealtime,
    _error_text,
)
from switch_core.outbound import OutboundPolicy

from .rocketchat_fakes import DdpServer, until

SUBSCRIPTIONS = [("stream-room-messages", "__my_messages__")]


@pytest_asyncio.fixture
async def server() -> AsyncIterator[DdpServer]:
    ddp = DdpServer()
    async with serve(ddp, "127.0.0.1", 0) as listening:
        ddp.port = listening.sockets[0].getsockname()[1]
        yield ddp


class Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, list[Any]]] = []
        self.ready = 0
        self.refused = 0

    def on_event(self, stream: str, event: str, args: list[Any]) -> None:
        self.events.append((stream, event, args))

    def on_ready(self) -> None:
        self.ready += 1

    def on_login_refused(self) -> None:
        self.refused += 1


def realtime_at(
    url: str, recorder: Recorder, *, verify_tls: bool = True
) -> RocketChatRealtime:
    return RocketChatRealtime(
        url=url,
        token="fixture-token",
        policy=OutboundPolicy.parse("127.0.0.0/8"),
        verify_tls=verify_tls,
        subscriptions=SUBSCRIPTIONS,
        on_event=recorder.on_event,
        on_ready=recorder.on_ready,
        on_login_refused=recorder.on_login_refused,
    )


def client_for(ddp: DdpServer, recorder: Recorder) -> RocketChatRealtime:
    return realtime_at(f"http://127.0.0.1:{ddp.port}", recorder)


async def running(
    client: RocketChatRealtime, check: Callable[[], Awaitable[None]]
) -> None:
    task = asyncio.create_task(client.run())
    try:
        await check()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.fixture(autouse=True)
def quick_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "_FIRST_RETRY_SECONDS", 0.01)
    monkeypatch.setattr(module, "_LAST_RETRY_SECONDS", 0.02)


async def test_it_logs_in_with_the_token_and_subscribes(server: DdpServer) -> None:
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: recorder.ready == 1)

    await running(client_for(server, recorder), check)
    login = next(f for f in server.received if f.get("method") == "login")
    assert login["params"] == [{"resume": "fixture-token"}]
    sub = next(f for f in server.received if f.get("msg") == "sub")
    assert sub["name"] == "stream-room-messages"
    assert sub["params"][0] == "__my_messages__"


async def test_it_only_says_ready_once_subscribed(server: DdpServer) -> None:
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        assert [f["msg"] for f in server.received] == ["connect", "method", "sub"]

    await running(client_for(server, recorder), check)


async def test_events_are_passed_on(server: DdpServer) -> None:
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        await server.push("stream-room-messages", "__my_messages__", [{"_id": "m"}])
        await until(lambda: bool(recorder.events))

    await running(client_for(server, recorder), check)
    assert recorder.events == [
        ("stream-room-messages", "__my_messages__", [{"_id": "m"}])
    ]


async def test_an_event_that_cannot_be_taken_is_logged_and_the_next_arrives(
    server: DdpServer, caplog: pytest.LogCaptureFixture
) -> None:
    recorder = Recorder()
    taken: list[Any] = []

    def on_event(stream: str, event: str, args: list[Any]) -> None:
        if args == ["bad"]:
            raise AttributeError("'str' object has no attribute 'get'")
        taken.append(args)

    client = client_for(server, recorder)
    client._on_event = on_event

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        await server.push("stream-room-messages", "__my_messages__", ["bad"])
        await server.push("stream-room-messages", "__my_messages__", [{"_id": "m"}])
        await until(lambda: bool(taken))

    await running(client, check)
    assert taken == [[{"_id": "m"}]]
    assert recorder.ready == 1
    assert "Could not take a Rocket.Chat realtime event" in caplog.text


async def test_a_frame_that_is_not_json_is_skipped(server: DdpServer) -> None:
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        await server.connections[-1].send("this is not json")
        await server.push("stream-room-messages", "__my_messages__", [{"_id": "m"}])
        await until(lambda: bool(recorder.events))

    await running(client_for(server, recorder), check)
    assert recorder.events == [
        ("stream-room-messages", "__my_messages__", [{"_id": "m"}])
    ]


async def test_it_answers_a_ping(server: DdpServer) -> None:
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        await server.connections[-1].send(json.dumps({"msg": "ping"}))
        await until(lambda: any(f["msg"] == "pong" for f in server.received))

    await running(client_for(server, recorder), check)


async def test_a_call_returns_its_result(server: DdpServer) -> None:
    recorder = Recorder()
    client = client_for(server, recorder)

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        assert await client.call("anything", ["x"]) == {"ok": True}

    await running(client, check)


async def test_an_answer_to_nothing_asked_is_ignored(server: DdpServer) -> None:
    recorder = Recorder()
    client = client_for(server, recorder)

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        unasked = {"msg": "result", "id": "999", "result": 1}
        await server.connections[-1].send(json.dumps(unasked))
        assert await client.call("anything", ["x"]) == {"ok": True}

    await running(client, check)


async def test_a_refused_call_raises(server: DdpServer) -> None:
    recorder = Recorder()
    client = client_for(server, recorder)

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        with pytest.raises(RealtimeError, match="denied"):
            await client.call("fails", [])

    await running(client, check)


async def test_a_call_the_server_never_answers_times_out(
    server: DdpServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "_CALL_TIMEOUT_SECONDS", 0.2)
    recorder = Recorder()
    client = client_for(server, recorder)

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        with pytest.raises(RealtimeError, match="No answer"):
            await client.call("silent", [])

    await running(client, check)


async def test_stopping_while_logging_in_cancels_the_login(
    server: DdpServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    server.ignore_login = True
    awaited: list[asyncio.Future[Any]] = []
    wait = asyncio.wait

    async def recording_wait(futures: Any, **options: Any) -> Any:
        awaited.extend(futures)
        return await wait(futures, **options)

    monkeypatch.setattr(module.asyncio, "wait", recording_wait)
    client = client_for(server, Recorder())
    task = asyncio.create_task(client.run())
    await until(lambda: any(f.get("method") == "login" for f in server.received))
    await asyncio.sleep(0.01)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    logging_in = awaited[-2:]
    assert all(step.done() for step in logging_in)
    assert all(step.cancelled() for step in logging_in)


async def test_a_call_with_no_connection_raises() -> None:
    client = client_for(DdpServer(), Recorder())
    assert client.connected is False
    with pytest.raises(RealtimeError):
        await client.call("anything", [])


class _ClosedSocket:
    async def send(self, data: str) -> None:
        raise ConnectionClosedOK(None, None)


async def test_a_call_on_a_connection_that_has_closed_is_a_realtime_error() -> None:
    client = client_for(DdpServer(), Recorder())
    client._socket = _ClosedSocket()  # type: ignore[assignment]
    with pytest.raises(RealtimeError):
        await client.call("anything", [])


async def test_a_dropped_connection_reconnects_and_reads_back(
    server: DdpServer,
) -> None:
    recorder = Recorder()
    client = client_for(server, recorder)

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        await server.connections[-1].close()
        await until(lambda: recorder.ready == 2)
        assert client.connected

    await running(client, check)
    assert len(server.connections) == 2


async def test_a_refused_login_is_reported_and_retried(server: DdpServer) -> None:
    server.refuse_login = True
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: recorder.refused >= 2)

    await running(client_for(server, recorder), check)
    assert recorder.ready == 0


async def test_a_login_that_is_never_answered_is_retried_not_called_a_refusal(
    server: DdpServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "_CALL_TIMEOUT_SECONDS", 0.2)
    server.ignore_login = True
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: len(server.connections) >= 2)

    await running(client_for(server, recorder), check)
    assert recorder.refused == 0


async def test_a_connection_dropped_during_login_is_retried_not_called_a_refusal(
    server: DdpServer,
) -> None:
    server.close_on_login = True
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: len(server.connections) >= 2)

    await running(client_for(server, recorder), check)
    assert recorder.refused == 0
    assert recorder.ready == 0


async def test_a_server_that_never_says_connected_is_retried(
    server: DdpServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "_CALL_TIMEOUT_SECONDS", 0.2)
    server.ignore_connect = True
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: len(server.connections) >= 2)

    await running(client_for(server, recorder), check)
    assert recorder.ready == 0


async def test_a_refused_subscription_is_not_ready(server: DdpServer) -> None:
    server.refuse_subscription = True
    recorder = Recorder()

    async def check() -> None:
        await until(lambda: len(server.connections) >= 2)

    await running(client_for(server, recorder), check)
    assert recorder.ready == 0


async def test_a_call_waiting_when_the_connection_drops_fails(
    server: DdpServer,
) -> None:
    recorder = Recorder()
    client = client_for(server, recorder)

    async def check() -> None:
        await until(lambda: recorder.ready == 1)
        server.ignore_login = True
        waiting = asyncio.create_task(client.call("login", []))
        await until(lambda: any(f.get("method") == "login" for f in server.received))
        await asyncio.sleep(0.01)
        await server.connections[-1].close()
        with pytest.raises(RealtimeError):
            await waiting

    await running(client, check)


async def test_an_address_the_policy_refuses_is_never_connected_to(
    server: DdpServer,
) -> None:
    recorder = Recorder()
    client = RocketChatRealtime(
        url=f"http://127.0.0.1:{server.port}",
        token="fixture-token",
        policy=OutboundPolicy.parse(""),
        verify_tls=True,
        subscriptions=SUBSCRIPTIONS,
        on_event=recorder.on_event,
        on_ready=recorder.on_ready,
        on_login_refused=recorder.on_login_refused,
    )

    async def check() -> None:
        await asyncio.sleep(0.05)

    await running(client, check)
    assert server.connections == []


async def test_an_address_that_cannot_be_reached_gives_way_to_the_next(
    server: DdpServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    dialled: list[str] = []
    connect = module.websockets.connect

    async def first_is_dead(url: str, **options: Any) -> Any:
        dialled.append(options["host"])
        if options["host"] == "127.0.0.2":
            raise OSError("no route to host")
        return await connect(url, **options)

    class TwoAddresses:
        async def resolve(self, host: str, port: int) -> list[str]:
            return ["127.0.0.2", "127.0.0.1"]

    monkeypatch.setattr(module.websockets, "connect", first_is_dead)
    recorder = Recorder()
    client = client_for(server, recorder)
    client._policy = TwoAddresses()  # type: ignore[assignment]

    async def check() -> None:
        await until(lambda: recorder.ready == 1)

    await running(client, check)
    assert dialled[:2] == ["127.0.0.2", "127.0.0.1"]


@pytest.mark.parametrize(
    ("verify_tls", "mode", "check_hostname"),
    [
        (True, ssl.CERT_REQUIRED, True),
        (False, ssl.CERT_NONE, False),
    ],
)
async def test_a_secure_connection_names_its_server_and_checks_it_as_configured(
    monkeypatch: pytest.MonkeyPatch,
    verify_tls: bool,
    mode: ssl.VerifyMode,
    check_hostname: bool,
) -> None:
    attempts: list[dict[str, Any]] = []

    async def connect(url: str, **options: Any) -> None:
        attempts.append({"url": url, **options})
        raise OSError("this test only looks at how the connection is made")

    monkeypatch.setattr(module.websockets, "connect", connect)
    client = realtime_at("https://127.0.0.1", Recorder(), verify_tls=verify_tls)

    async def check() -> None:
        await until(lambda: bool(attempts))

    await running(client, check)
    first = attempts[0]
    assert first["url"] == "wss://127.0.0.1/websocket"
    assert first["server_hostname"] == "127.0.0.1"
    assert first["ssl"].verify_mode == mode
    assert first["ssl"].check_hostname is check_hostname


@pytest.mark.parametrize(
    ("error", "text"),
    [
        ("plain text", "plain text"),
        ({"reason": "nope"}, "nope"),
        ({"message": "sorry"}, "sorry"),
    ],
)
def test_an_error_is_reported_by_its_text(error: Any, text: str) -> None:
    assert _error_text(error) == text
